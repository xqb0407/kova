"use client";

import { unstable_defaultDirectiveFormatter } from "@assistant-ui/core";

/**
 * 自定义命令芯片（与 :commit/:code 同一指令家族）：
 * - **插入**（composer `/` 菜单选中自定义命令）：`:command[/init]{name=command:init}`
 *   —— CM 的 directiveChipPlugin 按 DIRECTIVE_RE 通用模式渲染成高亮芯片，
 *   参数由用户在芯片后续写；
 * - **发送展开**（ThreadController.buildPiSendInput 调本模块）：芯片 →
 *   `/name` 纯文本，sidecar 的命令展开入口（runTurnBody expandCommand）吃的
 *   就是这个形状；未命中的指令原样回写，不吞用户输入。
 */

export const COMMAND_DIRECTIVE_TYPE = "command";

/** 命令名 → 芯片文本；非法字符直接剔除（label/id 都不能含 ]、换行） */
export function buildCommandDirective(name: string): string {
  const safe = name.replace(/[[\]\r\n\s]/gu, "");
  if (!safe) return "";
  return unstable_defaultDirectiveFormatter.serialize({
    type: COMMAND_DIRECTIVE_TYPE,
    label: `/${safe}`,
    id: `${COMMAND_DIRECTIVE_TYPE}:${safe}`,
  });
}

/** 指令 id → 命令名；不合法返回 null（不猜、不吞用户输入） */
export function parseCommandDirectiveId(id: string): string | null {
  const match = /^command:([A-Za-z][\w-]*)$/u.exec(id);
  return match ? match[1]! : null;
}

/** 发送前展开：文本里的 `:command[...]` 芯片 → `/name`；其它指令原样保留 */
export function expandCommandDirectives(text: string): string {
  // 快路径：纯文本打字最常见的分支，不跑正则
  if (!text.includes(":command[")) return text;
  const segments = unstable_defaultDirectiveFormatter.parse(text);
  let out = "";
  let changed = false;
  for (const segment of segments) {
    if (segment.kind === "text") {
      out += segment.text;
      continue;
    }
    if (segment.type === COMMAND_DIRECTIVE_TYPE) {
      const name = parseCommandDirectiveId(segment.id);
      if (name) {
        out += `/${name}`;
        changed = true;
        continue;
      }
    }
    // 原样回写（formatter 的序列化与源文本可精确回环）：不吞任何用户输入
    out += unstable_defaultDirectiveFormatter.serialize({
      type: segment.type,
      label: segment.label,
      id: segment.id,
    });
  }
  return changed ? out : text;
}
