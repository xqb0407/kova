// 本地新增（react-pi 迁移缺口2·检查点卡接回）：旧链路 pi-transport 的
// postTransform 管线在 start chunk 打影子仓库快照、finish/error 结算检查点卡
// （git 集成 M2）。新链路没有 per-request 流，改挂全局事件通道：
// DesktopPiClient 在 agent_start / agent_end 帧上调本模块的 begin/settle。
//
// 锚点语义（与旧链路 messages.indexOf(lastUser) 对齐）：anchorIndex = 触发本轮
// 的 user 消息在渲染列表中的下标。渲染列表 = 转录的投影（assistant+toolResult
// 会合并成一条、隐藏 custom 不占位），不是转录下标——所以用与 UI 同一个投影
// 函数对「转录前缀（截至触发 user 消息）」投影一次，末项下标即锚点。
// ⚠ agent_start 早于本轮 user 行落盘（core 先 emit agent_start 再 message_end
// →persist），begin 快照可能缺触发行、锚到上一轮。因此锚点在 settle 重算：
// begin 只记 baselineLastSeq（快照内最大 seq）与 triggerSeq（快照末条恰为
// 本轮 user 行时的 seq），settle 按它们在最新转录里重定位（见 resolveTurnAnchor），
// 并产出稳定 anchorMessageId（pi-msg:<seq>）——渲染端优先按 id 匹配，
// compaction/model-change 分隔线插入、截断导致的下标漂移不再影响锚点。
//
// 刷新重挂桥（saveRunHash/loadRunHash，sessionStorage）：begin 打完快照即把
// {cwd, hash, 锚点} 落盘；页面刷新后新实例错过 agent_start，settle 时台账
// 无条目则从桥上恢复补结算。begin 会先作废桥上残留（新 run 不能复用上轮基线）。
import { gitCheckpointCreate, gitCheckpointDiff } from "@/lib/git/git";
import { refreshGitStatus } from "@/lib/git/git-status";
import {
  clearRunCheckpointsForSession,
  loadRunHash,
  pushRunCheckpoint,
  saveRunHash,
} from "@/lib/pi/pi-checkpoints";
import {
  fetchTurnEditStatus,
  isPrimaryTurnEdit,
  type TurnEditMap,
  type TurnEditStatus,
} from "@/lib/pi/pi-edits";
import { getWorkspace } from "@/lib/workspace/workspace-store";
import { projectPiThreadMessages } from "./runtime/messageProjection";
import type { PiAgentMessage, PiThreadSnapshot } from "./types";

/** 依赖注入面：真实实现走 git/检查点 store/工作区 store，测试换假件 */
export interface TurnCheckpointDeps {
  now(): number;
  create(cwd: string, tag: string): Promise<string | null>;
  diff(
    cwd: string,
    hash: string,
    opts?: { paths?: readonly string[]; snapshot?: boolean },
  ): Promise<{
    files: {
      path?: string;
      oldPath?: string | null;
      added: number;
      removed: number;
    }[];
  } | null>;
  refreshStatus(cwd: string): void;
  resolveCwd(snapshot: PiThreadSnapshot): string | null;
  fetchSnapshot(sessionId: string): Promise<PiThreadSnapshot | undefined>;
  saveHash: typeof saveRunHash;
  loadHash: typeof loadRunHash;
  push: typeof pushRunCheckpoint;
  /** 条目所有权层：本轮逐文件编辑 + shared（同工作区并发）判定。
   *  可选——旧测试假件/旧链路缺它时按 legacy 全仓 diff 结算。 */
  turnStatus?(
    sessionId: string,
    cwd: string,
    turnId: string | null,
  ): Promise<TurnEditStatus>;
  /** 影子仓库没有改动（或快照失败）时，从条目所有权层取本轮全部编辑聚合；
   *  主根/附加根都算——gitignored 文件的编辑只在所有权层里可见。 */
  editsSummary(
    sessionId: string,
    cwd: string,
    turnId: string | null,
  ): Promise<{ files: number; added: number; removed: number } | null>;
}

/** 一轮全部逐文件编辑的聚合（主根 + 附加根，按 root+rel 去重） */
export function editsSummaryOf(
  edits: TurnEditMap,
): { files: number; added: number; removed: number } | null {
  let files = 0;
  let added = 0;
  let removed = 0;
  const seen = new Set<string>();
  for (const edit of edits.values()) {
    const key = `${edit.root ?? ""}\u0000${edit.rel}`;
    if (seen.has(key)) continue;
    seen.add(key);
    files += 1;
    if (edit.additions > 0) added += edit.additions;
    if (edit.deletions > 0) removed += edit.deletions;
  }
  return files > 0 ? { files, added, removed } : null;
}

/** 结算时定格的归属文件清单（含改名旧路径）：后续按它过滤 diff/产物，
 *  同工作区其它会话在结算之后改/新增的文件不会混进本轮卡片。 */
function settlePathList(
  files: readonly { path?: string; oldPath?: string | null }[],
): string[] {
  const out = new Set<string>();
  for (const file of files) {
    if (file.path) out.add(file.path);
    if (file.oldPath) out.add(file.oldPath);
  }
  return [...out];
}

export const defaultTurnCheckpointDeps = (): TurnCheckpointDeps => ({
  now: () => Date.now(),
  create: (cwd, tag) => gitCheckpointCreate(cwd, tag),
  diff: (cwd, hash, opts) => gitCheckpointDiff(cwd, hash, opts),
  refreshStatus: (cwd) => refreshGitStatus(cwd),
  resolveCwd: (snapshot) => snapshot.metadata.workspacePath ?? getWorkspace(),
  fetchSnapshot: async () => undefined, // 由 DesktopPiClient 注入自有快照通道
  saveHash: saveRunHash,
  loadHash: loadRunHash,
  push: pushRunCheckpoint,
  turnStatus: (sessionId, cwd, turnId) =>
    fetchTurnEditStatus(sessionId, cwd, turnId),
  editsSummary: async (sessionId, cwd, turnId) => {
    const status = await fetchTurnEditStatus(sessionId, cwd, turnId);
    return editsSummaryOf(status.edits);
  },
});

/**
 * 触发本轮的 user 消息的渲染列表下标；转录里没有 user 消息（罕见）返回 null
 * （卡片兜底渲染在列表末尾，与旧链路 anchorIndex=null 同语义）。
 */
export const renderedIndexOfLastUser = (
  messages: readonly PiAgentMessage[],
): number | null => {
  let last = -1;
  for (let i = 0; i < messages.length; i++) {
    if (messages[i]?.role === "user") last = i;
  }
  return renderedIndexOfUserAt(messages, last);
};

/**
 * 渲染列表里第 targetIndex 条消息的下标（投影前缀口径，与 UI 同一投影函数）。
 * targetIndex 非法或不是 user 行返回 null。检查点 anchor 的唯一换算出口：
 * begin（旧行为）与 settle（重算）共用，保证两端口径一致。
 */
export const renderedIndexOfUserAt = (
  messages: readonly PiAgentMessage[],
  targetIndex: number,
): number | null => {
  if (targetIndex < 0 || targetIndex >= messages.length) return null;
  if (messages[targetIndex]?.role !== "user") return null;
  const projected = projectPiThreadMessages({
    messages: messages.slice(0, targetIndex + 1),
    toolExecutions: {},
    runStatus: "idle",
    hostUiRequests: [],
  });
  return projected.length - 1;
};

/** 转录行 __seq（sidecar 快照透传；在飞行没有） */
const seqOfMessage = (message: PiAgentMessage): number | undefined => {
  const seq = (message as { __seq?: unknown }).__seq;
  return typeof seq === "number" ? seq : undefined;
};

const maxTranscriptSeq = (messages: readonly PiAgentMessage[]): number | null => {
  let max: number | null = null;
  for (const message of messages) {
    const seq = seqOfMessage(message);
    if (seq !== undefined && (max === null || seq > max)) max = seq;
  }
  return max;
};

/**
 * settle 时重算本轮触发 user 行的锚点。begin 的 anchor 在 agent_start 算，而
 * agent_start 早于本轮 user 行落盘（core 先 emit agent_start 再 message_end→
 * persist），begin 快照可能缺触发行、锚到上一轮。settle 时转录必已含触发行：
 *  1. begin 快照末条就是本轮 user 行（已落盘带 seq）→ 按 seq 精确重定位，
 *     compaction/model-change 分隔线插入导致的下标漂移也一并修正；
 *  2. 否则触发行在 begin 之后才落盘 → 取 baseline 之后**第一条** user 行
 *     （steer/并入注入行晚于触发行落盘，不会抢锚）；
 *  3. 兜底：触发行是隐藏行（goal 续跑的内部注入，快照按前缀过滤）时 1/2 都
 *     找不到——整段 goal 在渲染列表里同属一个轮，锚 = 最后一条可见 user 行。
 * 定位不到（快照里没有任何 user 行）返回 null，调用方回落 begin 值。
 */
const resolveTurnAnchor = (
  messages: readonly PiAgentMessage[],
  run: { triggerSeq: number | null; baselineLastSeq: number | null },
): { anchorIndex: number; anchorMessageId: string | undefined } | null => {
  let target = -1;
  if (run.triggerSeq !== null) {
    target = messages.findIndex(
      (message) => message.role === "user" && seqOfMessage(message) === run.triggerSeq,
    );
  }
  const baseline = run.baselineLastSeq;
  if (target < 0 && baseline !== null) {
    target = messages.findIndex((message) => {
      if (message.role !== "user") return false;
      const seq = seqOfMessage(message);
      return seq !== undefined && seq > baseline;
    });
  }
  if (target < 0) {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i]?.role === "user") {
        target = i;
        break;
      }
    }
  }
  if (target < 0) return null;
  const anchorIndex = renderedIndexOfUserAt(messages, target);
  if (anchorIndex === null) return null;
  const seq = seqOfMessage(messages[target]);
  return {
    anchorIndex,
    anchorMessageId: seq !== undefined ? `pi-msg:${seq}` : undefined,
  };
};

/** 一轮的检查点在飞台账：promise 由 begin 同步登记（去重与 settle 等待都靠它） */
type RunCp = {
  promise: Promise<string | null>;
  /** 快照拉到后才回填；settle 在 promise 落定后读取，必已就绪 */
  cwd: string;
  anchor: number | null;
  /**
   * begin 快照末条是本轮 user 行时记录的转录 seq：该行就是触发行（user 行落盘
   * 后、assistant 响应前不会有别的行），settle 可按它精确重定位。
   */
  triggerSeq: number | null;
  /** begin 快照里已落盘的最大转录 seq：触发行晚于 begin 落盘时，settle 取
   *  baseline 之后第一条 user 行定位触发行。 */
  baselineLastSeq: number | null;
  /** 触发本轮的 prompt requestId（条目所有权层查询键；可为 null——老调用方） */
  turnId: string | null;
};

/**
 * 当前渲染轮的检查点基线：同一渲染轮的续段（goal 续跑等触发行被隐藏的形态）
 * 复用首段基线做 diff，卡片内容相对本轮起点累计；新渲染轮（可见 user 行开轮）
 * 覆写基线。
 *
 * 为什么在 settle 比对而不是 begin：agent_start 时"goal 续跑"与"委派 resume"
 * 的快照形态完全一致（两者的触发 user 行都还没落盘），begin 无法区分；settle
 * 时转录已完备——锚点解析落在本轮触发行上，与上一段锚 id 相同即同渲染轮。
 */
type TurnBase = {
  /** 首段 run 的影子仓库快照 hash：同轮续段 diff 的基线（累计口径） */
  hash: string;
  cwd: string;
  /** 渲染轮触发 user 行的稳定 id（pi-msg:<seq>）；settle 解析后回写 */
  anchorMessageId?: string;
  /** 同轮各续段累计的归属路径（shared 作用域用；非 shared 不筛） */
  ownPaths?: string[];
};

/** agent_start → 打快照 / agent_end → diff+落卡（全局观察者，缺口2） */
export class TurnCheckpointTracker {
  private readonly runs = new Map<string, RunCp>();
  /** 当前渲染轮基线（见 TurnBase）：同轮续段累计 diff，新轮覆写 */
  private readonly turnBase = new Map<string, TurnBase>();
  private readonly deps: TurnCheckpointDeps;

  constructor(depsOverride?: Partial<TurnCheckpointDeps>) {
    this.deps = { ...defaultTurnCheckpointDeps(), ...depsOverride };
  }

  /** turn 真正开始（旧链路 start chunk 同机）：影子仓库快照，失败绝不阻断对话 */
  begin(sessionId: string, turnId: string | null = null): void {
    // 同 run 重复 agent_start（重试重放/合帧）不重打——新快照会漏掉
    // 「首次 agent_start → 重复帧」之间的改动
    if (this.runs.has(sessionId)) return;
    // 两段赋值：promise 的 async 链内要回填 entry.cwd/anchor（链体只会在
    // 赋值完成后才真正执行，同步块内无观察窗口）
    const entry: RunCp = {
      cwd: "",
      anchor: null,
      triggerSeq: null,
      baselineLastSeq: null,
      turnId,
      promise: Promise.resolve(null),
    };
    entry.promise = (async () => {
      const snapshot = await this.deps.fetchSnapshot(sessionId);
      if (!snapshot) return null;
      const cwd = this.deps.resolveCwd(snapshot);
      if (!cwd) return null;
      entry.cwd = cwd;
      entry.anchor = renderedIndexOfLastUser(snapshot.messages);
      // 触发行识别 + baseline：agent_start 时本轮 user 行要么已落盘（=快照
      // 末条，带 seq），要么还没落盘（baseline 之后才出现）。settle 据此重算。
      const last = snapshot.messages.at(-1);
      const lastSeq = last && last.role === "user" ? seqOfMessage(last) : undefined;
      entry.triggerSeq = typeof lastSeq === "number" ? lastSeq : null;
      entry.baselineLastSeq = maxTranscriptSeq(snapshot.messages);
      // 桥上残留（上次刷新未结算）作废：agent_start 是新 run，复用会把
      // 上轮基线算进本轮 diff
      this.deps.saveHash(sessionId, null);
      const hash = await this.deps
        .create(cwd, `agent:${sessionId}:${this.deps.now()}`)
        .catch((err) => {
          console.warn("[checkpoint] create failed", String(err));
          return null;
        });
      if (hash) {
        this.deps.saveHash(sessionId, {
          cwd,
          hash,
          anchorIndex: entry.anchor,
          ...(entry.triggerSeq !== null
            ? { anchorMessageId: `pi-msg:${entry.triggerSeq}` }
            : {}),
          ...(turnId ? { turnId } : {}),
        });
      }
      return hash;
    })();
    this.runs.set(sessionId, entry);
    // 打不出快照（无 cwd）的 run 从台账摘除；有 cwd 但影子快照失败
    // （非 git 主目录）要留到 settle——附加根可能仍有逐文件检查点。
    void entry.promise.then((hash) => {
      if (!hash && !entry.cwd && this.runs.get(sessionId) === entry) {
        this.runs.delete(sessionId);
      }
    });
  }

  /** run 结束（含 aborted/error：半途改动也需要 keep/revert 出口）：
   *  diff 快照→当前，有改动才落检查点条目；fire-and-forget */
  settle(sessionId: string): void {
    const run = this.runs.get(sessionId);
    this.runs.delete(sessionId);
    // 复用路径（刷新重挂）先读后清；同步清桥对齐旧链路 settleCheckpoint 的结算刻
    const persisted = run ? null : this.deps.loadHash(sessionId);
    this.deps.saveHash(sessionId, null);
    if (!run && !persisted) return;
    // 供 async 闭包消费（TS 跨闭包不收窄，先落本地量）
    const reuse = run ? null : persisted;
    void (async () => {
      let hash: string | null;
      let cwd: string;
      let anchor: number | null;
      let anchorMessageId: string | undefined;
      let turnId: string | null;
      /** 同渲染轮此前续段已上报的归属路径（shared 作用域累计用） */
      let cumulativePaths: string[] = [];
      /** 本段对应的渲染轮基线（结算末尾回写 ownPaths，供后续续段累计） */
      let turnBaseForSettle: TurnBase | undefined;
      if (run) {
        hash = await run.promise;
        cwd = run.cwd;
        anchor = run.anchor;
        turnId = run.turnId;
        // 锚点重算：begin 的 anchor 在 agent_start 算，可能早于本轮 user 行
        // 落盘而锚到上一轮。settle 时转录必已含触发行，按 begin 记录的
        // triggerSeq / baseline 重定位；定位不到（快照失败等）回落 begin 值。
        if (cwd) {
          const fresh = await this.deps
            .fetchSnapshot(sessionId)
            .catch(() => undefined);
          const resolved = fresh ? resolveTurnAnchor(fresh.messages, run) : null;
          if (resolved) {
            anchor = resolved.anchorIndex;
            anchorMessageId = resolved.anchorMessageId;
          } else if (run.triggerSeq !== null) {
            anchorMessageId = `pi-msg:${run.triggerSeq}`;
          }
          // 同渲染轮续段（goal 续跑等触发行隐藏的形态）：解析出的锚 id 与
          // 上一段相同 → diff 复用上一段基线，卡片内容相对本轮起点累计，
          // 不再"后段覆盖前段、内容丢失"；新渲染轮（委派 resume / 溢出恢复
          // 以可见 user 行开轮）→ 覆写基线，各轮各卡。
          const base = this.turnBase.get(sessionId);
          const sameTurn =
            resolved?.anchorMessageId !== undefined &&
            base !== undefined &&
            base.cwd === cwd &&
            base.anchorMessageId === resolved.anchorMessageId;
          if (sameTurn && base) {
            hash = base.hash;
            // 同轮续段：shared 作用域要累计前序段的归属路径，否则卡片只显示
            // 最后一段编辑的文件（diff 本身是累计口径）
            cumulativePaths = base.ownPaths ?? [];
            turnBaseForSettle = base;
          } else if (resolved && hash) {
            const created: TurnBase = {
              hash,
              cwd,
              ...(anchorMessageId ? { anchorMessageId } : {}),
            };
            this.turnBase.set(sessionId, created);
            turnBaseForSettle = created;
          }
        }
      } else if (reuse) {
        hash = reuse.hash;
        cwd = reuse.cwd;
        anchor = reuse.anchorIndex ?? null;
        anchorMessageId = reuse.anchorMessageId ?? undefined;
        turnId = reuse.turnId ?? null;
      } else {
        return;
      }
      // 条目所有权层：本轮结构化编辑（会话归属证据）+ shared（同工作区并发）。
      // 影子仓库按工作目录共享：并发会话的整仓 diff 混着对方的改动，卡片只
      // 保留本会话 write/edit 上报的主根文件，并禁用整轮撤销（参考实现 shared
      // 语义："shared reviews require successful edit evidence"）。
      const ownership = turnId
        ? await this.deps
            .turnStatus?.(sessionId, cwd, turnId)
            .catch(() => null)
        : null;
      const shared = ownership?.shared === true;
      const ownPrimaryPaths = ownership
        ? [
            ...new Set(
              [...ownership.edits.values()]
                .filter((edit) => isPrimaryTurnEdit(edit, cwd))
                .map((edit) => edit.rel),
            ),
          ]
        : [];
      // shared 作用域 = 同渲染轮各续段归属路径的并集（非 shared 不筛 diff）
      const scopedPaths = shared
        ? [...new Set([...cumulativePaths, ...ownPrimaryPaths])]
        : [];
      // 落卡时使用的归属路径：shared 用作用域并集；非 shared 只在无快照兜底时
      // 用本轮编辑清单（正常路径 diff 已是全仓，不需要筛）
      const evidencePaths = shared ? scopedPaths : ownPrimaryPaths;

      // 影子快照失败（非 git 主目录等）时，附加根的逐文件检查点仍可能有效：
      // 用空 hash 落卡，卡片隐藏整轮撤销，只保留逐文件回滚入口。
      if (!hash) {
        const ext = await this.deps
          .editsSummary(sessionId, cwd, turnId)
          .catch(() => null);
        if (!ext) return;
        this.deps.push(
          sessionId,
          { anchorIndex: anchor, anchorMessageId },
          {
            cwd,
            hash: "",
            files: ext.files,
            added: ext.added,
            removed: ext.removed,
            turnId,
            // shared 轮次即使没有主根证据也显式写 []（语义 = 不展示影子仓库
            // 文件）；非 shared 只在有盘点时写
            ...(shared || evidencePaths.length > 0
              ? { paths: evidencePaths }
              : {}),
            ...(shared ? { shared: true } : {}),
          },
        );
        return;
      }
      // 共享快照 + 本会话主根没有编辑证据：没有可归因的文件。宁可不显示，
      // 也不把全仓 diff 里别人的改动当成自己的；附加根编辑仍可聚合。
      if (shared && scopedPaths.length === 0) {
        const ext = await this.deps
          .editsSummary(sessionId, cwd, turnId)
          .catch(() => null);
        if (!ext) return;
        this.deps.push(
          sessionId,
          { anchorIndex: anchor, anchorMessageId },
          {
            cwd,
            hash: "",
            files: ext.files,
            added: ext.added,
            removed: ext.removed,
            turnId,
            paths: [],
            shared: true,
          },
        );
        return;
      }
      this.deps.refreshStatus(cwd);
      // 共享轮次把 diff 限定到本会话编辑过的路径：卡片内容只碰自己的文件；
      // 非共享轮次保留整仓 diff（bash/脚本兜底），snapshot=true 在结算刻
      // 存档整轮 patch——后续展开列表不再覆盖它。
      const d = await this.deps
        .diff(
          cwd,
          hash,
          shared ? { paths: scopedPaths } : { snapshot: true },
        )
        .catch((err) => {
          // 结算失败不弹窗打断对话，但必须留痕：静默吞错会让"卡去哪了"无从排查
          console.warn("[checkpoint] settle diff failed", String(err));
          return null;
        });
      // cwd 没有任何改动时，仍可能只改了项目附加根：向条目所有权层取一次
      // 外部编辑聚合。没有外部编辑才真正跳过（避免每轮都出空卡）。
      let files = 0;
      let added = 0;
      let removed = 0;
      let paths: string[] | undefined;
      if (d && d.files.length > 0) {
        files = d.files.length;
        for (const f of d.files) {
          added += f.added;
          removed += f.removed;
        }
        // 归属清单在结算刻定格：之后同工作区其它会话再改/新增文件，展开卡片
        // 和产物页签也只按这份清单过滤，不会把别人后来的产物算进本轮。
        paths = shared ? scopedPaths : settlePathList(d.files);
      } else {
        const ext = await this.deps
          .editsSummary(sessionId, cwd, turnId)
          .catch(() => null);
        if (!ext) return;
        files = ext.files;
        added = ext.added;
        removed = ext.removed;
        paths = shared ? scopedPaths : undefined;
      }
      // 回写本渲染轮的归属路径：后续续段若转 shared，可累计本段已确认的清单
      // （非 shared 段记全量结算清单；本段无路径时记编辑证据）
      if (turnBaseForSettle) {
        turnBaseForSettle.ownPaths = paths ?? ownPrimaryPaths;
      }
      this.deps.push(
        sessionId,
        { anchorIndex: anchor, anchorMessageId },
        {
          cwd,
          hash,
          files,
          added,
          removed,
          turnId,
          ...(paths && paths.length > 0 ? { paths } : {}),
          ...(shared ? { shared: true } : {}),
        },
      );
    })().catch(() => {});
  }

  /**
   * 会话删除/换代清理：丢掉渲染轮基线（其引用的影子快照随会话作废），并把
   * 该会话已结算的检查点卡从宿主机内存与持久层一并清掉——卡片属于会话历史，
   * 会话行删了不能留（localStorage 不随标签页销毁，必须显式清）。
   * 可选观察面——测试假件只实现 begin/settle 时不受影响。
   */
  forgetSession(sessionId: string): void {
    this.turnBase.delete(sessionId);
    clearRunCheckpointsForSession(sessionId);
  }
}

/** DesktopPiClient 构造注入面（测试换记录型假件） */
export type TurnCheckpointObserver = Pick<
  TurnCheckpointTracker,
  "begin" | "settle"
> & { forgetSession?(sessionId: string): void };
