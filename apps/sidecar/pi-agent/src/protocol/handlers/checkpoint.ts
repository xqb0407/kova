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

export const handlers: Record<string, CommandHandler> = {
  checkpoint_status: async (reqId, msg) => {
    const sessionId = String(msg.sessionId ?? "");
    const cwd = String(msg.cwd ?? "");
    const turnId = String(msg.turnId ?? "");
    if (!sessionId || !cwd || !turnId) {
      send({ id: reqId, type: "checkpoint_status", sessionId, turnId, files: [] });
      return;
    }
    const files = await checkpointStatus(sessionId, cwd, turnId);
    send({ id: reqId, type: "checkpoint_status", sessionId, cwd, turnId, files });
  },

  checkpoint_diff: async (reqId, msg) => {
    const sessionId = String(msg.sessionId ?? "");
    const cwd = String(msg.cwd ?? "");
    const turnId = String(msg.turnId ?? "");
    const rel = String(msg.rel ?? "");
    const diff =
      sessionId && cwd && turnId && rel
        ? await checkpointDiff(sessionId, cwd, turnId, rel)
        : null;
    send({
      id: reqId,
      type: "checkpoint_diff",
      sessionId,
      turnId,
      rel,
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
    const result =
      sessionId && cwd && turnId && rel
        ? await checkpointUndo(sessionId, cwd, turnId, rel)
        : { error: "no-checkpoint" };
    if ("error" in result) {
      send({ id: reqId, type: "checkpoint_undone", sessionId, turnId, rel, ok: false, error: result.error });
    } else {
      send({ id: reqId, type: "checkpoint_undone", sessionId, turnId, rel, ok: true });
    }
  },
};
