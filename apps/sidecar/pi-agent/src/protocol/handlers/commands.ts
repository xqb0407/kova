/**
 * 自定义命令 handlers：清单水合（composer `/` 菜单）与保存/删除（设置 → 命令）。
 * 事实源在 commands/commands.ts（三层发现 + 落盘）；保存/删除应答都带刷新后的
 * 清单（与技能 handlers 同款：改完即见，不靠前端二次拉取）。
 */
import { send } from "../stream";
import {
  commandsSnapshot,
  deleteCommandDoc,
  saveCommandDoc,
} from "../../commands/commands";
import type { CommandHandler } from "../command";

/** cwd 字段收敛：缺省/空串回 undefined（清单退化为全局 + 内置） */
function cwdOf(msg: Record<string, unknown>): string | undefined {
  const cwd = typeof msg.cwd === "string" && msg.cwd.trim() ? msg.cwd.trim() : undefined;
  return cwd;
}

function sendSnapshot(reqId: string, cwd: string | undefined): void {
  send({ id: reqId, type: "commands", commands: commandsSnapshot(cwd) });
}

export const handlers: Record<string, CommandHandler> = {
  // 自定义命令清单（composer `/` 菜单）：cwd 由前端随请求带（当前工作区），
  // 缺省只列全局层与内置命令
  get_commands: async (reqId, msg) => {
    sendSnapshot(reqId, cwdOf(msg));
  },

  save_command: async (reqId, msg) => {
    const scope = msg.scope === "workspace" ? "workspace" : msg.scope === "global" ? "global" : null;
    if (!scope) throw new Error('save_command: scope must be "workspace" or "global"');
    const cwd = cwdOf(msg);
    if (scope === "workspace" && !cwd) {
      throw new Error("save_command: workspace scope requires cwd");
    }
    await saveCommandDoc({
      scope,
      name: String(msg.name ?? ""),
      ...(typeof msg.description === "string" ? { description: msg.description } : {}),
      ...(typeof msg.argumentHint === "string" ? { argumentHint: msg.argumentHint } : {}),
      body: String(msg.body ?? ""),
      ...(cwd ? { cwd } : {}),
      ...(typeof msg.replaceName === "string" && msg.replaceName.trim()
        ? { replaceName: msg.replaceName.trim() }
        : {}),
    });
    sendSnapshot(reqId, cwd);
  },

  delete_command: async (reqId, msg) => {
    const scope = msg.scope === "workspace" ? "workspace" : msg.scope === "global" ? "global" : null;
    if (!scope) throw new Error('delete_command: scope must be "workspace" or "global"');
    const cwd = cwdOf(msg);
    if (scope === "workspace" && !cwd) {
      throw new Error("delete_command: workspace scope requires cwd");
    }
    await deleteCommandDoc({
      scope,
      name: String(msg.name ?? ""),
      ...(cwd ? { cwd } : {}),
    });
    sendSnapshot(reqId, cwd);
  },
};
