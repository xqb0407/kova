/**
 * 编辑检查点查询与逐文件回滚命令（条目所有权层，见 checkpoint/store.ts 头注释）。
 * 桌面检查点卡展开时拉 checkpoint_status 匹配逐文件行，给"有安全边界"的文件
 * 挂单文件回滚；checkpoint_diff 供审阅视图按需读原文对。整轮撤销仍走影子仓库
 * （Electron git_checkpoint_restore），两条路互不依赖。
 *
 * 应答一律带 files/rel 等结构化字段；store 的门面已吃掉异常返回空值——
 * 检查点不可见（无 git/无权限/坏目录）时卡片自然退化为现状（只有整轮撤销）。
 */
import type { CommandHandler } from "../command";
import { send } from "../stream";
import {
  checkpointDiff,
  checkpointStatus,
  checkpointUndo,
} from "../../checkpoint/store";
import { hasConcurrentTurn, isTurnShared } from "../../sessions/registry";

export const handlers: Record<string, CommandHandler> = {
  checkpoint_status: async (reqId, msg) => {
    const sessionId = String(msg.sessionId ?? "");
    const cwd = String(msg.cwd ?? "");
    const turnId = String(msg.turnId ?? "");
    if (!sessionId || !cwd || !turnId) {
      send({
        id: reqId,
        type: "checkpoint_status",
        sessionId,
        turnId,
        shared: false,
        files: [],
      });
      return;
    }
    const files = await checkpointStatus(sessionId, cwd, turnId);
    // shared = 本轮与同工作区其它会话并发过：影子仓库整仓 diff 不可归因，
    // 桌面据此只展示本会话结构化编辑的文件并禁用整轮撤销。历史标记之外，
    // 再看一眼"此刻仍有同 cwd 活跃轮"——覆盖 settle 晚于 agent_end、另一
    // 会话刚启动的边界窗口。
    send({
      id: reqId,
      type: "checkpoint_status",
      sessionId,
      cwd,
      turnId,
      shared:
        isTurnShared(sessionId, turnId) || hasConcurrentTurn(sessionId, cwd),
      files,
    });
  },

  checkpoint_diff: async (reqId, msg) => {
    const sessionId = String(msg.sessionId ?? "");
    const cwd = String(msg.cwd ?? "");
    const turnId = String(msg.turnId ?? "");
    const rel = String(msg.rel ?? "");
    const root = typeof msg.root === "string" ? msg.root : undefined;
    const diff =
      sessionId && cwd && turnId && rel
        ? await checkpointDiff(sessionId, cwd, turnId, rel, root)
        : null;
    send({
      id: reqId,
      type: "checkpoint_diff",
      sessionId,
      turnId,
      rel,
      ...(root ? { root } : {}),
      ...(diff
        ? {
            original: diff.original,
            current: diff.current,
            binary: diff.binary,
            tooLarge: diff.tooLarge,
            exact: diff.exact,
          }
        : { error: "no-diff" }),
    });
  },

  checkpoint_undo: async (reqId, msg) => {
    const sessionId = String(msg.sessionId ?? "");
    const cwd = String(msg.cwd ?? "");
    const turnId = String(msg.turnId ?? "");
    const rel = String(msg.rel ?? "");
    const root = typeof msg.root === "string" ? msg.root : undefined;
    const result =
      sessionId && cwd && turnId && rel
        ? await checkpointUndo(sessionId, cwd, turnId, rel, root)
        : { error: "no-checkpoint" };
    if ("error" in result) {
      send({
        id: reqId,
        type: "checkpoint_undone",
        sessionId,
        turnId,
        rel,
        ...(root ? { root } : {}),
        ok: false,
        error: result.error,
      });
    } else {
      send({
        id: reqId,
        type: "checkpoint_undone",
        sessionId,
        turnId,
        rel: result.rel,
        root: result.root,
        ok: true,
      });
    }
  },
};
