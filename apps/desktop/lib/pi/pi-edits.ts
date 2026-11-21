"use client";

/**
 * 编辑检查点的桌面侧门面（条目所有权层，sidecar checkpoint/store.ts）。
 * 卡片展开时按 (sessionId, cwd, turnId) 拉本轮「结构化编辑所有权」清单，
 * 与影子仓库 diff 的行按 rel 匹配：只有 undoable 的文件才挂单文件回滚按钮。
 *
 * turnId = 触发本轮的 prompt requestId（pi-client-base 的 sessionTurn 台账）；
 * 老会话/恢复桥里缺 turnId 的条目返回空 Map——卡片自然退化为现状（只有整轮撤销），
 * 一切失败静默降级，绝不把检查点故障传染到对话。
 */
import { piRequest, type PiResponse } from "./pi-bridge";

/** 应答类型 = pi-bridge 判别联合里登记的两个 checkpoint 变体（单一事实源） */
type StatusRes = Extract<PiResponse, { type: "checkpoint_status" }>;
type UndoneRes = Extract<PiResponse, { type: "checkpoint_undone" }>;

export type TurnEdit = StatusRes["files"][number];

export type TurnEditMap = Map<string, TurnEdit>;

/** 本轮编辑归属查询结果：edits = 逐文件所有权；shared = 与同工作区其它会话
 *  并发过（共享影子快照不可归因，卡片只展示本会话编辑的文件且禁用整轮撤销） */
export type TurnEditStatus = { edits: TurnEditMap; shared: boolean };

const EMPTY_MAP: TurnEditMap = new Map();

/** 检查点记录的查找键：主根按 rel（与影子仓库 diff 行同键），附加根按 root+NUL+rel */
export function turnEditKey(root: string | undefined, rel: string): string {
  return root ? `${root}\u0000${rel}` : rel;
}

/** 该编辑是否落在会话主根（cwd）。旧 sidecar 没有 primary 字段时按 root 回退。 */
export function isPrimaryTurnEdit(edit: TurnEdit, cwd: string): boolean {
  if (edit.primary === true) return true;
  if (edit.primary === false) return false;
  return !edit.root || edit.root === cwd;
}

/**
 * 拉本轮编辑归属 + 共享判定。查询失败按 shared 处理：宁可少出一张卡，
 * 也不把同工作区其它会话的改动当成自己的（sidecar 不可达时 editsSummary
 * 同样失败，卡片自然不出现）。
 */
export async function fetchTurnEditStatus(
  sessionId: string,
  cwd: string,
  turnId: string | null | undefined,
): Promise<TurnEditStatus> {
  if (!sessionId || !cwd || !turnId) return { edits: EMPTY_MAP, shared: false };
  try {
    // 超时不传：checkpoint_status 未登记慢命令，预算就是通道地板 15s；
    // 显式写 8s 只会被抬到预算并每次打一条 WARN（见 pi-channel.ts）
    const res = await piRequest<StatusRes>({ type: "checkpoint_status", sessionId, cwd, turnId });
    const list = Array.isArray(res.files) ? res.files : [];
    const map: TurnEditMap = new Map();
    for (const f of list) map.set(turnEditKey(f.root, f.rel), f);
    return { edits: map, shared: res.shared === true };
  } catch (err) {
    // 查询失败按共享处理（见函数注释）；留痕便于排查"卡去哪了"
    console.warn(
      "[checkpoint] turn status query failed; failing closed (shared)",
      String(err),
    );
    return { edits: EMPTY_MAP, shared: true };
  }
}

export async function fetchTurnEdits(
  sessionId: string,
  cwd: string,
  turnId: string | null | undefined,
): Promise<TurnEditMap> {
  return (await fetchTurnEditStatus(sessionId, cwd, turnId)).edits;
}

export async function undoTurnEdit(
  sessionId: string,
  cwd: string,
  turnId: string,
  rel: string,
  root?: string,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await piRequest<UndoneRes>(
      {
        type: "checkpoint_undo",
        sessionId,
        cwd,
        turnId,
        rel,
        ...(root ? { root } : {}),
      },
      15000,
    );
    return {
      ok: res.ok === true,
      error: typeof res.error === "string" ? res.error : undefined,
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** sidecar 拒绝码 → 用户可读文案（store.ts opUndo 的 error 枚举） */
export function turnEditUndoError(code: string | undefined): string {
  switch (code) {
    case "changed-after":
      return "该文件在编辑后又被手动或其它途径改动过，为避免误伤已拒绝单文件回滚。";
    case "no-boundary":
      return "缺少编辑前基线（改动来源不明），只能走整轮撤销。";
    case "skipped":
      return "文件过大未录快照，只能走整轮撤销。";
    case "symlink":
      return "路径含符号链接，已拒绝写回。";
    case "snapshot-lost":
      return "基线快照已丢失（检查点被清理？），只能走整轮撤销。";
    case "no-checkpoint":
      return "本会话没有检查点记录。";
    default:
      return `回滚失败：${code ?? "未知错误"}`;
  }
}
