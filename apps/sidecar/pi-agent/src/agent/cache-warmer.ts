/**
 * Prompt cache warmer（pi-main cache-warmer 的移植裁剪版）。
 *
 * 服务端前缀缓存的失效大头是**时间**：空闲超过 TTL，整段上下文按全价重算
 * （实测 61K prompt 的会话一次 miss 就是六万 token）。warmer 在每次真实请求后
 * 记住"这次请求"，在 TTL 的 90% 时刻用 maxTokens=1 原样重放一次，把缓存条目
 * 续住——重放不进 agent、不落转录、不进 usage 统计，只花一笔 cache-read 的钱。
 *
 * 与 pi-main 的差异：
 *  - TTL 只认 `model.promptCache.{short,long}`（秒），未声明的模型不暖
 *    （pi 同款，"cache lifetime unavailable"）——TTL 由模型设置声明，
 *    不猜常量，避免对未知端点瞎暖；
 *  - **provider 健康门控**（pi 没有）：滑动窗口统计最近 5 次真实请求的命中率，
 *    <50% 就停暖——`cn:hy4-preview` 这类"命中孤立、下一条立刻 miss"的网关
 *    会被自动禁用，不白花钱；命中率恢复（窗口滑出）后自动恢复；
 *  - **idle 相位不走美元门槛**：pi 的 0.15 续来概率 × $0.05 阈值意味着典型
 *    定价下 prompt 要 24 万 token 才达标，idle 形同虚设——改用规模门槛
 *    （prompt ≥ 8K）+ 健康门控；选 idle 即接受暖请求的 cache-read 开销；
 *  - 成本门槛在模型单价缺失（全 0）时退化为规模门槛（prompt ≥ 8K token）：
 *    自定义端点常不填单价，美元门槛会让 warmer 永远不跑。
 *
 * 生命周期：streamFn 每次会话请求 `start()`（replace 语义）；agent 收尾
 * `onAgentSettled()`（streaming 模式停止，idle 模式继续暖到 30 分钟）；
 * 会话驱逐/删除 `cancel()`。定时器全部 unref，进程退出无残留。
 */
import type {
  Api,
  AssistantMessage,
  Model,
  SimpleStreamOptions,
  TranscriptContext,
} from "@earendil-works/pi-ai";
import { logAt } from "../log";

export type CacheWarmingMode = "off" | "streaming" | "idle";

/** 模式默认 idle：观测到的 miss 全在跨轮空闲（6–15 分钟），streaming 模式盖不住 */
export const CACHE_WARMING_DEFAULT_MODE: CacheWarmingMode = "idle";

/** 期望节省低于该美元数就不暖（pi 同款；仅 streaming 相位使用） */
const MIN_EXPECTED_SAVINGS_USD = 0.05;
/** 流式/空闲两档的安全窗：超过即停（重放晚到 = 全价 cache write，不如不暖） */
const STREAMING_MAX_AGE_MS = 60 * 60_000;
const IDLE_MAX_AGE_MS = 30 * 60_000;
/** 在 TTL 的 90% 时刻重放，保留至少 10 秒余量 */
const WARM_DELAY_RATIO = 0.9;
const WARM_MIN_MARGIN_MS = 10_000;
/** 健康门控：最近 N 次真实请求的命中率下限 */
const HEALTH_WINDOW = 5;
const HEALTH_MIN_RATE = 0.5;
/** 单价未知时的规模门槛：prompt 低于它的会话不值得暖 */
const SIZE_GATE_TOKENS = 8_000;

export function resolveCacheWarmingMode(): CacheWarmingMode {
  const raw = (process.env.PI_CACHE_WARMING ?? "").trim().toLowerCase();
  return raw === "off" || raw === "streaming" || raw === "idle"
    ? raw
    : CACHE_WARMING_DEFAULT_MODE;
}

export type CacheWarmRequest = {
  model: Model<Api>;
  context: TranscriptContext;
  options: SimpleStreamOptions;
};

export type CacheWarmerDeps = {
  /** 重放通道：与生产同源的 streamSimple（绕过 agent 与转录） */
  streamSimple: (
    model: Model<Api>,
    context: TranscriptContext,
    options?: SimpleStreamOptions,
  ) => { result(): Promise<AssistantMessage> };
  /** 模式现读（每次决策都取，环境变更即时生效） */
  getMode: () => CacheWarmingMode;
  /** 时钟与定时器注入（单测用；默认走全局） */
  now?: () => number;
  scheduleTimer?: (fn: () => void, ms: number) => () => void;
};

type ActiveRun = CacheWarmRequest & {
  isCurrent: () => boolean;
  ttlMs: number;
  delayMs: number;
  startedAt: number;
  refreshDeadlineAt: number;
  abort: AbortController;
  phase: "streaming" | "idle";
  nextWarmAt: number;
  cancelTimer: () => void;
};

/** Anthropic 按预算推导 thinking 缓存键：非 adaptive 模型重放会换预算，不许重放 */
function isReplayable(model: Model<Api>, options: SimpleStreamOptions): boolean {
  if (model.api !== "anthropic-messages") return true;
  if (!options.reasoning) return true;
  const compat = (
    model as Model<"anthropic-messages"> & {
      compat?: { forceAdaptiveThinking?: boolean };
    }
  ).compat;
  return compat?.forceAdaptiveThinking === true;
}

export class CacheWarmer {
  private run?: ActiveRun;
  private inactiveReason = "waiting for first request";
  /** 最近 HEALTH_WINDOW 次真实请求（含冷启动）：健康门控的滑动窗口 */
  private health: { prompt: number; cacheRead: number }[] = [];
  /** 最近一次真实请求的 prompt 总量（成本/规模门槛用） */
  private lastPromptTokens = 0;

  constructor(private readonly deps: CacheWarmerDeps) {}

  /** 真实请求的 usage 观测（stream.ts message_end 喂入；错误/中止轮不计） */
  observeUsage(usage: { input?: number; cacheRead?: number; cacheWrite?: number } | null | undefined): void {
    if (!usage) return;
    const input = usage.input ?? 0;
    const cacheRead = usage.cacheRead ?? 0;
    const cacheWrite = usage.cacheWrite ?? 0;
    const prompt = input + cacheRead + cacheWrite;
    if (prompt <= 0) return;
    this.lastPromptTokens = prompt;
    this.health.push({ prompt, cacheRead });
    if (this.health.length > HEALTH_WINDOW) this.health.shift();
  }

  /** 每次会话请求调用（replace 语义）：记住请求并按 TTL 排暖 */
  start(request: CacheWarmRequest, isCurrent: () => boolean): void {
    this.clearRun();
    const mode = this.deps.getMode();
    if (mode === "off") {
      this.stop("cache warming disabled");
      return;
    }
    if (!isReplayable(request.model, request.options)) {
      this.stop("request cannot be replayed safely");
      return;
    }
    const ttlMs = this.resolveTtlMs(request);
    if (ttlMs === undefined) {
      this.stop("model has no promptCache TTL (set 缓存 TTL in model settings)");
      return;
    }
    const delayMs = Math.max(
      1,
      Math.floor(Math.min(ttlMs * WARM_DELAY_RATIO, ttlMs - WARM_MIN_MARGIN_MS)),
    );
    if (ttlMs <= WARM_MIN_MARGIN_MS) {
      this.stop("cache TTL too short to warm");
      return;
    }
    const now = this.now();
    this.run = {
      ...request,
      isCurrent,
      ttlMs,
      delayMs,
      startedAt: now,
      refreshDeadlineAt: 0,
      abort: new AbortController(),
      phase: "streaming",
      nextWarmAt: 0,
      cancelTimer: () => {},
    };
    this.schedule(this.run);
  }

  /** 一轮收尾：streaming 模式停止；idle 模式切相继续暖（30 分钟上限） */
  onAgentSettled(): void {
    const run = this.run;
    if (!run) return;
    if (this.deps.getMode() === "streaming") {
      this.stop("agent run settled");
      return;
    }
    run.phase = "idle";
    const deadline = run.startedAt + IDLE_MAX_AGE_MS;
    const now = this.deps.now?.() ?? Date.now();
    if (now >= deadline || run.nextWarmAt > deadline) {
      this.stop("30-minute idle safety limit reached");
    }
  }

  cancel(): void {
    this.stop("inactive");
  }

  get inactiveReasonText(): string {
    return this.inactiveReason;
  }

  // ------------------------------ 内部 ------------------------------

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private resolveTtlMs(request: CacheWarmRequest): number | undefined {
    const retention =
      request.options.cacheRetention === "long"
        ? "long"
        : process.env.PI_CACHE_RETENTION === "long"
          ? "long"
          : "short";
    const seconds = request.model.promptCache?.[retention];
    return typeof seconds === "number" && seconds > 0 ? seconds * 1000 : undefined;
  }

  private clearRun(): void {
    const run = this.run;
    if (!run) return;
    this.run = undefined;
    run.cancelTimer();
    run.abort.abort();
  }

  private stop(reason: string): void {
    this.clearRun();
    this.inactiveReason = reason;
  }

  private schedule(run: ActiveRun): void {
    const now = this.now();
    run.nextWarmAt = now + run.delayMs;
    // 定时器可能因休眠/阻塞晚点：留一半余量给迟到，晚到的重放多半是全价 write
    run.refreshDeadlineAt = run.nextWarmAt + Math.floor((run.ttlMs - run.delayMs) / 2);
    const maxAge = run.phase === "idle" ? IDLE_MAX_AGE_MS : STREAMING_MAX_AGE_MS;
    if (run.nextWarmAt > run.startedAt + maxAge || now >= run.startedAt + maxAge) {
      this.stop(run.phase === "idle" ? "30-minute idle safety limit reached" : "one-hour safety limit reached");
      return;
    }
    const timerFn = this.deps.scheduleTimer ?? ((fn: () => void, ms: number) => {
      const timer = setTimeout(fn, ms);
      timer.unref?.();
      return () => clearTimeout(timer);
    });
    run.cancelTimer = timerFn(() => void this.refresh(run), Math.max(0, run.nextWarmAt - now));
  }

  private validateRun(run: ActiveRun): boolean {
    if (this.run !== run) return false;
    if (this.deps.getMode() === "off") {
      this.stop("cache warming disabled");
      return false;
    }
    if (this.deps.getMode() === "streaming" && run.phase === "idle") {
      this.stop("agent run settled");
      return false;
    }
    if (!run.isCurrent()) {
      this.stop("conversation context changed");
      return false;
    }
    return true;
  }

  /** 健康门控：最近窗口命中率（样本不足 = 放行，交给后续窗口收敛） */
  private healthOk(): boolean {
    if (this.health.length < HEALTH_WINDOW) return true;
    const prompt = this.health.reduce((sum, h) => sum + h.prompt, 0);
    const cached = this.health.reduce((sum, h) => sum + h.cacheRead, 0);
    return prompt <= 0 || cached / prompt >= HEALTH_MIN_RATE;
  }

  /** 是否值得暖：
   *  - 健康门控（provider 命中率）一律先看；
   *  - streaming 相位：美元门槛（pi 同款公式，continuation probability = 1）；
   *  - idle 相位：**不走美元门槛**——pi 的 0.15 概率 × $0.05 阈值意味着典型
   *    定价下 prompt 要 24 万 token 才达标，idle 模式形同虚设。用户选 idle
   *    即接受暖请求的 cache-read 开销（上限 = 30 分钟 × 每 4.5 分钟一次），
     *    改用规模门槛（prompt ≥ 8K）+ 健康门控兜底。 */
  private worthWarming(run: ActiveRun): { ok: boolean; reason: string } {
    if (!this.healthOk()) {
      return { ok: false, reason: "provider cache hit rate below 50% (health gate)" };
    }
    const promptTokens = this.lastPromptTokens;
    if (promptTokens <= 0) return { ok: false, reason: "no prompt usage observed yet" };
    const rates = run.model.cost;
    const costKnown =
      rates.input > 0 || rates.output > 0 || rates.cacheRead > 0 || rates.cacheWrite > 0;
    if (run.phase === "idle") {
      return promptTokens >= SIZE_GATE_TOKENS
        ? { ok: true, reason: "idle size gate" }
        : { ok: false, reason: `idle: prompt ${promptTokens} < ${SIZE_GATE_TOKENS} tokens` };
    }
    if (!costKnown) {
      return promptTokens >= SIZE_GATE_TOKENS
        ? { ok: true, reason: "size gate" }
        : { ok: false, reason: `prompt ${promptTokens} < ${SIZE_GATE_TOKENS} tokens` };
    }
    const perMillion = (tokens: number, rate: number): number => (rate / 1_000_000) * tokens;
    const cacheHitCost = perMillion(promptTokens, rates.cacheRead);
    // miss 的代价：整段按全价 input 重算（有 cacheWrite 价的端点按写入价）
    const missUnitRate = rates.cacheWrite > 0 ? rates.cacheWrite : rates.input;
    const missCost = Math.max(0, perMillion(promptTokens, missUnitRate) - cacheHitCost);
    const warmCost = cacheHitCost + perMillion(1, rates.output);
    const expectedSavings = missCost - warmCost;
    return expectedSavings >= MIN_EXPECTED_SAVINGS_USD
      ? { ok: true, reason: `expected savings $${expectedSavings.toFixed(3)}` }
      : { ok: false, reason: `expected savings $${expectedSavings.toFixed(3)} below threshold` };
  }

  private async refresh(run: ActiveRun): Promise<void> {
    run.cancelTimer();
    if (!this.validateRun(run)) return;
    if (this.now() > run.refreshDeadlineAt) {
      this.stop("cache refresh deadline missed");
      return;
    }
    const verdict = this.worthWarming(run);
    if (!verdict.ok) {
      this.stop(verdict.reason);
      return;
    }
    try {
      const message: AssistantMessage = await this.deps
        .streamSimple(run.model, run.context, {
          ...run.options,
          // 不带 fetch 捕获：暖请求的响应不能写 run.retryCapture——它与真实
          // 请求并发时会把失败分类读到的 status 覆盖成 200
          fetch: undefined,
          maxTokens: 1,
          maxRetries: 0,
          signal: run.abort.signal,
        })
        .result();
      if (!this.validateRun(run)) return;
      const usage = message.usage;
      logAt(
        "event",
        `cache-warmer: warmed ${run.model.provider}/${run.model.id} ` +
          `cacheRead=${usage?.cacheRead ?? 0} prompt=${(usage?.input ?? 0) + (usage?.cacheRead ?? 0) + (usage?.cacheWrite ?? 0)}`,
      );
    } catch {
      // 保活是尽力而为：失败不影响主循环，也不再重排（下次真实请求会重新
      // start）。只在当前 run 仍是本人时才落 stop——start() 可能已替换成新
      // 请求（本请求被 abort 触发的拒绝会迟到），误 stop 会杀掉新定时器。
      if (this.run === run) this.stop("warm request failed");
      return;
    }
    if (this.run !== run) return;
    this.schedule(run);
  }
}
