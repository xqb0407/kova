/**
 * 【手工实测脚本，不进 CI】prompt cache 命中率与 warmer 策略的真实端点探测。
 *
 * 用法（仓库根）：
 *   PI_CACHE_WARMING=off bun apps/sidecar/pi-agent/scripts/cache-probe.ts \
 *     --model custom-agnes/agnes-3.0-flash [--ttl 300] [--tokens 20000] [--repeat 3]
 *
 * 四段流程（对齐 warmer 的设计假设，逐段给 PASS/FAIL 结论）：
 *   R1 冷启动          → 预期 cacheRead=0（基线写入）
 *   R2 立即重放        → 预期 cacheRead ≈ R1 prompt（端点确实有前缀缓存）
 *   --repeat N 重放采样 → 量化路由稳定性（孤立命中模式 = 网关分片，客户端无解）
 *   R3 越过 TTL 后重放 → cacheRead=0 则确认驱逐（TTL 属实）
 *   暖请求 + R4        → 越过 TTL 后仍命中 ⇒ warmer 策略在该端点有效
 *
 * 请求与生产同源：模型目录/凭据走同一套 storage 初始化，选项带
 * session 亲和头与 prompt_cache_key（直接复用 thinking.ts 的两个构造器）。
 */
import { parseArgs } from "node:util";
import { homedir } from "node:os";
import { join } from "node:path";
import { initStorage } from "../src/storage/storage";
import { loadCustomProviders, applyModelOverrides, initCurrentModelKey } from "../src/model/model-catalog";
import { getModels } from "../src/model/catalog";
import {
  makePromptCacheKeyPayloadHook,
  makeSessionAffinityHeaders,
} from "../src/model/thinking";
import type { TranscriptContext, SimpleStreamOptions } from "@earendil-works/pi-ai";

const SESSION_ID = `cache-probe-${Date.now()}`;

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    model: { type: "string" },
    ttl: { type: "string" },
    tokens: { type: "string", default: "20000" },
    repeat: { type: "string", default: "3" },
    "data-dir": { type: "string" },
    "api-key": { type: "string" },
    "api-key-env": { type: "string" },
  },
});

const modelKey = values.model ?? "";
if (!modelKey.includes("/")) {
  console.error(
    "用法: --model provider/model [--ttl 秒] [--tokens 20000] [--repeat 3] [--data-dir 目录]\n" +
      "      [--api-key 明文 | --api-key-env 环境变量名]（凭据在系统钥匙串加密，脚本读不到）",
  );
  process.exit(1);
}
const [providerId, modelId] = modelKey.split("/", 2);

// 与 sidecar 入口同款装配：默认指向 dev 渠道数据目录
const dataDir =
  values["data-dir"] ??
  join(homedir(), "Library", "Application Support", "com.kova.assistant.dev");
initStorage(join(dataDir, "state.db"), join(dataDir, "sessions"));
await loadCustomProviders();
await applyModelOverrides();
await initCurrentModelKey();

const model = getModels().getModel(providerId, modelId);
if (!model) {
  console.error(`模型不存在: ${modelKey}（检查 provider/model 拼写与启用状态）`);
  process.exit(1);
}
// getModel 收窄后仍被闭包捕获：探测流程里模型不变，非空断言安全
const probedModel = model;

// TTL：--ttl 覆盖 > 模型声明 > 报错退出（warmer 只对声明过的模型工作）
const declaredShort = model.promptCache?.short;
const ttlSeconds = values.ttl ? Number(values.ttl) : declaredShort;
if (!ttlSeconds || ttlSeconds <= 0) {
  console.error(
    `模型未声明 promptCache TTL（当前: ${JSON.stringify(model.promptCache ?? null)}）。` +
      `先在 设置→模型→属性 里填「缓存 TTL·短」（秒），或用 --ttl 覆盖。`,
  );
  process.exit(1);
}
const ttlMs = ttlSeconds * 1000;

// 确定性大前缀（同字节重复块，~4 字符/token 估算）
const targetTokens = Number(values.tokens) || 20000;
const block = "The quick brown fox jumps over the lazy dog. Pack my box with five dozen liquor jugs. ";
const prefixText = block.repeat(Math.ceil((targetTokens * 4) / block.length));

// TranscriptContext 带 nominal brand（运行时不存在）：脚本侧用断言构造。
// runtime 的 normalizeContext 还会读 systemPrompt/tools（probe 不带工具表）
const asContext = (messages: unknown): TranscriptContext =>
  ({ messages, tools: [] }) as unknown as TranscriptContext;

const baseMessages: { role: "user" | "system"; content: string }[] = [
  { role: "system", content: `You are a cache probe. Memorize the reference corpus.\n\n${prefixText}` },
  { role: "user", content: "Reply with the single word: ready." },
];

const headers = makeSessionAffinityHeaders(SESSION_ID);
const onPayload = makePromptCacheKeyPayloadHook(SESSION_ID);
// 凭据在系统钥匙串加密（master.key.safe，普通进程解不开）：明文 key 走参数/环境变量
const apiKey =
  values["api-key"] ??
  (values["api-key-env"] ? process.env[values["api-key-env"]] : undefined);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Usage = { input: number; cacheRead: number; cacheWrite: number };
const results: { label: string; usage: Usage; prompt: number; hitPct: number }[] = [];

async function send(label: string, messages: { role: "user" | "system"; content: string }[], maxTokens?: number): Promise<void> {
  const context = asContext(messages);
  const options: SimpleStreamOptions = {
    sessionId: SESSION_ID,
    maxTokens: maxTokens ?? 512,
    maxRetries: 0,
    ...(apiKey ? { apiKey } : {}),
    ...(Object.keys(headers).length ? { headers } : {}),
    onPayload,
  };
  const started = Date.now();
  const message = await getModels()
    .streamSimple(probedModel, context, options)
    .result();
  if (message.stopReason === "error" || message.errorMessage) {
    const errText = message.errorMessage ?? "?";
    console.error(
      `[${label}] 请求失败: stopReason=${message.stopReason} error=${errText}` +
        (errText.includes("401") || errText.includes("令牌")
          ? "\n  提示：凭据在系统钥匙串加密，脚本读不到——用 --api-key <明文> 或 --api-key-env <环境变量名> 传入。"
          : ""),
    );
    process.exit(1);
  }
  const usage = {
    input: message.usage?.input ?? 0,
    cacheRead: message.usage?.cacheRead ?? 0,
    cacheWrite: message.usage?.cacheWrite ?? 0,
  };
  if (usage.input === 0 && usage.cacheRead === 0 && usage.cacheWrite === 0) {
    console.error(
      `[${label}] usage 全 0 且无错误：provider 未上报用量（stopReason=${message.stopReason}）`,
    );
  }
  const prompt = usage.input + usage.cacheRead + usage.cacheWrite;
  const hitPct = prompt > 0 ? (usage.cacheRead / prompt) * 100 : 0;
  results.push({ label, usage, prompt, hitPct });
  console.log(
    `[${label}] ${((Date.now() - started) / 1000).toFixed(1)}s prompt=${prompt} ` +
      `input=${usage.input} cacheRead=${usage.cacheRead} cacheWrite=${usage.cacheWrite} hit=${hitPct.toFixed(1)}%` +
      (maxTokens === 1 ? " (warm: maxTokens=1)" : ""),
  );
}

const followUp = (text: string) => [...baseMessages, { role: "user" as const, content: text }];

console.log(
  `探测 ${modelKey}：ttl=${ttlSeconds}s 前缀≈${targetTokens}tok repeat=${values.repeat} sessionId=${SESSION_ID}`,
);

// R1 冷启动
await send("R1-cold", followUp("Say one."));
const r1 = results[0];

// R2 立即重放 + repeat 采样
const repeat = Math.max(1, Number(values.repeat) || 1);
for (let i = 0; i < repeat; i++) {
  await send(`R2-hit#${i + 1}`, followUp(`Repeat check ${i + 1}. Say two.`));
}
const hits = results.slice(1, 1 + repeat);
const hitRatio = hits.filter((h) => h.usage.cacheRead > 0).length / hits.length;

// R3 越过 TTL
console.log(`... 等待 ${(ttlMs * 1.2 - 0) / 1000}s 越过 TTL ...`);
await sleep(ttlMs * 1.2 + 5_000);
await send("R3-expired", followUp("TTL check. Say three."));

// 暖请求（重进 TTL 窗口）→ 越过 TTL → R4
console.log(`... 重新写入缓存，等待 ${ttlSeconds}s 后验证 warmer 策略 ...`);
await send("W-warm", followUp("Rewrite cache. Say four."), 1);
await sleep(ttlMs * 1.2 + 5_000);
await send("R4-after-warm", followUp("Warm check. Say five."));

// ------------------------------ 报告 ------------------------------
console.log("\n===== 结论 =====");
const verdict = (ok: boolean, pass: string, fail: string) =>
  console.log(`${ok ? "PASS" : "FAIL"} ${ok ? pass : fail}`);

const r2 = hits[0];
verdict(r2.usage.cacheRead > 0, "端点支持前缀缓存（R2 命中）", "R2 未命中：端点可能不支持前缀缓存");
verdict(
  hitRatio >= 0.5,
  `重放采样命中率 ${(hitRatio * 100).toFixed(0)}%：路由稳定`,
  `重放采样命中率 ${(hitRatio * 100).toFixed(0)}%：路由不稳定（网关分片/不亲和），warmer 健康门控会停用`,
);
const r3 = results.find((r) => r.label === "R3-expired")!;
verdict(
  r3.usage.cacheRead === 0,
  `越过 TTL 后确实驱逐（TTL≈${ttlSeconds}s 属实）`,
  `越过 TTL 后仍命中 ${r3.usage.cacheRead}：实际 TTL 比 ${ttlSeconds}s 长，可把模型 TTL 调大`,
);
const r4 = results.find((r) => r.label === "R4-after-warm")!;
verdict(
  r4.usage.cacheRead > 0,
  "warmer 策略有效：暖请求把缓存续过了 TTL",
  "暖请求没能续住缓存：检查端点是否对 maxTokens=1 请求正常写缓存",
);
console.log(`\n冷启动基线 R1 prompt=${r1.prompt}（cacheRead=${r1.usage.cacheRead}）`);
console.log(`会话 id（供日志对账）: ${SESSION_ID}`);
