// 本地新增（react-pi 迁移缺口2·检查点卡接回）：旧链路 pi-transport 的
// postTransform 管线在 start chunk 打影子仓库快照、finish/error 结算检查点卡
// （git 集成 M2）。新链路没有 per-request 流，改挂全局事件通道：
// TauriPiClient 在 agent_start / agent_end 帧上调本模块的 begin/settle。
//
// 锚点语义（与旧链路 messages.indexOf(lastUser) 对齐）：anchorIndex = 触发本轮
// 的 user 消息在渲染列表中的下标。渲染列表 = 转录的投影（assistant+toolResult
// 会合并成一条、隐藏 custom 不占位），不是转录下标——所以用与 UI 同一个投影
// 函数对「转录前缀（截至触发 user 消息）」投影一次，末项下标即锚点。快照在
// agent_start 时必已含触发消息（直发先落转录、排队项在引擎派发时落转录），
// 前缀计数不受后续流式合并影响，卡片渲染时两端口径一致。
//
// 刷新重挂桥（saveRunHash/loadRunHash，sessionStorage）：begin 打完快照即把
// {cwd, hash, anchor} 落盘；页面刷新后新实例错过 agent_start，settle 时台账
// 无条目则从桥上恢复补结算。begin 会先作废桥上残留（新 run 不能复用上轮基线）。
import { gitCheckpointCreate, gitCheckpointDiff } from "@/lib/git/git";
import { refreshGitStatus } from "@/lib/git/git-status";
import {
  loadRunHash,
  pushRunCheckpoint,
  saveRunHash,
} from "@/lib/pi/pi-checkpoints";
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
  ): Promise<{ files: { added: number; removed: number }[] } | null>;
  refreshStatus(cwd: string): void;
  resolveCwd(snapshot: PiThreadSnapshot): string | null;
  fetchSnapshot(sessionId: string): Promise<PiThreadSnapshot | undefined>;
  saveHash: typeof saveRunHash;
  loadHash: typeof loadRunHash;
  push: typeof pushRunCheckpoint;
}

export const defaultTurnCheckpointDeps = (): TurnCheckpointDeps => ({
  now: () => Date.now(),
  create: (cwd, tag) => gitCheckpointCreate(cwd, tag),
  diff: (cwd, hash) => gitCheckpointDiff(cwd, hash),
  refreshStatus: (cwd) => refreshGitStatus(cwd),
  resolveCwd: (snapshot) => snapshot.metadata.workspacePath ?? getWorkspace(),
  fetchSnapshot: async () => undefined, // 由 TauriPiClient 注入自有快照通道
  saveHash: saveRunHash,
  loadHash: loadRunHash,
  push: pushRunCheckpoint,
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
  if (last < 0) return null;
  const projected = projectPiThreadMessages({
    messages: messages.slice(0, last + 1),
    toolExecutions: {},
    runStatus: "idle",
    hostUiRequests: [],
  });
  return projected.length - 1;
};

/** 一轮的检查点在飞台账：promise 由 begin 同步登记（去重与 settle 等待都靠它） */
type RunCp = {
  promise: Promise<string | null>;
  /** 快照拉到后才回填；settle 在 promise 落定后读取，必已就绪 */
  cwd: string;
  anchor: number | null;
};

/** agent_start → 打快照 / agent_end → diff+落卡（全局观察者，缺口2） */
export class TurnCheckpointTracker {
  private readonly runs = new Map<string, RunCp>();
  private readonly deps: TurnCheckpointDeps;

  constructor(depsOverride?: Partial<TurnCheckpointDeps>) {
    this.deps = { ...defaultTurnCheckpointDeps(), ...depsOverride };
  }

  /** turn 真正开始（旧链路 start chunk 同机）：影子仓库快照，失败绝不阻断对话 */
  begin(sessionId: string): void {
    // 同 run 重复 agent_start（重试重放/合帧）不重打——新快照会漏掉
    // 「首次 agent_start → 重复帧」之间的改动
    if (this.runs.has(sessionId)) return;
    // 两段赋值：promise 的 async 链内要回填 entry.cwd/anchor（链体只会在
    // 赋值完成后才真正执行，同步块内无观察窗口）
    const entry: RunCp = { cwd: "", anchor: null, promise: Promise.resolve(null) };
    entry.promise = (async () => {
      const snapshot = await this.deps.fetchSnapshot(sessionId);
      if (!snapshot) return null;
      const cwd = this.deps.resolveCwd(snapshot);
      if (!cwd) return null;
      entry.cwd = cwd;
      entry.anchor = renderedIndexOfLastUser(snapshot.messages);
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
        });
      }
      return hash;
    })();
    this.runs.set(sessionId, entry);
    // 打不出快照/无 git 的 run 从台账摘除，别挡下一轮（settle 也会摘，双保险）
    void entry.promise.then((hash) => {
      if (!hash && this.runs.get(sessionId) === entry) this.runs.delete(sessionId);
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
      if (run) {
        hash = await run.promise;
        cwd = run.cwd;
        anchor = run.anchor;
      } else if (reuse) {
        hash = reuse.hash;
        cwd = reuse.cwd;
        anchor = reuse.anchorIndex ?? null;
      } else {
        return;
      }
      if (!hash) return;
      this.deps.refreshStatus(cwd);
      const d = await this.deps.diff(cwd, hash).catch((err) => {
        // 结算失败不弹窗打断对话，但必须留痕：静默吞错会让"卡去哪了"无从排查
        console.warn("[checkpoint] settle diff failed", String(err));
        return null;
      });
      if (!d || d.files.length === 0) return;
      let added = 0;
      let removed = 0;
      for (const f of d.files) {
        added += f.added;
        removed += f.removed;
      }
      this.deps.push(sessionId, anchor, {
        cwd,
        hash,
        files: d.files.length,
        added,
        removed,
      });
    })().catch(() => {});
  }
}

/** TauriPiClient 构造注入面（测试换记录型假件） */
export type TurnCheckpointObserver = Pick<TurnCheckpointTracker, "begin" | "settle">;
