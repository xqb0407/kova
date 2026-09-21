/**
 * 技能调用工具（use_skill）：按名字加载一份生效技能的正文指令。
 *
 * 渐进披露的"加载"半环：系统提示词只注入技能目录（name/description/location），
 * 模型判断任务匹配后经本工具取正文——取代裸 read SKILL.md，一来回执带技能目录
 * 路径（正文里的相对引用有了锚点），二来前端能把它渲染成专属的「调用技能」行。
 *
 * 可见性与目录严格一致：只认 activeSkills（遮蔽裁决 + 开关过滤后的生效集），
 * disableModelInvocation 的技能不出现在目录里、也不可经本工具调用——那是留给
 * 用户显式命令的。正文每次从磁盘现值读取（与 read 语义对齐：目录缓存只管
 * frontmatter 签名，正文改动不需要失效）。
 *
 * 挂 baseTools（只读动作，不进审批集）；plan 模式经 CONTRACT_TOOL_NAMES 保留。
 */
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import {
  ensureSkillsLoaded,
  normalizeSkillName,
  parseSkillDoc,
  skillsSnapshot,
} from "./skills";

export const SKILL_USE_TOOL_NAME = "use_skill";

/** 来源层中文标签（回执里标注技能出处，与 skills_list 口径一致） */
const SCOPE_ZH = {
  workspace: "项目",
  "compat-workspace": "生态·项目",
  system: "系统",
  compat: "生态·用户",
  plugin: "插件",
} as const;

function textResult(text: string, details?: unknown) {
  return { content: [{ type: "text" as const, text }], details };
}

function errorResult(text: string) {
  return {
    content: [{ type: "text" as const, text: `错误：${text}` }],
    details: { error: text },
  };
}

export function buildSkillUseTool(cwd: string): AgentTool {
  return {
    name: SKILL_USE_TOOL_NAME,
    label: "调用技能",
    description: [
      "按名称加载一份技能（SKILL.md 指令文档）的完整正文并返回。",
      "任务与 <available_skills> 中某条技能的 description 匹配时调用它，参数用目录里的 <name> 原文；不要改用 read 去读 <location>——本工具的回执额外带来源层与技能目录（正文中的相对路径按该目录解析）。",
      "只能加载目录里可见的技能：被开关停用、被同名遮蔽或标注不可模型调用的技能会报错并列出可用名。",
    ].join("\n"),
    parameters: Type.Object({
      name: Type.String({ description: "技能名称（<available_skills> 目录里的 <name> 原文）" }),
    }),
    execute: async (_toolCallId, params) => {
      const name = String((params as { name?: unknown })?.name ?? "").trim();
      if (!name) return errorResult("name 不能为空");
      try {
        // 签名缓存下无变化零 IO；外部（设置页/手工）改动后此处拿到的是磁盘现值
        await ensureSkillsLoaded(cwd);
      } catch {
        // 加载失败退化为读旧缓存快照，错误在下面的查找/读盘路径里体现
      }
      const { entries } = skillsSnapshot(cwd);
      const norm = normalizeSkillName(name);
      const hit = entries.find((e) => normalizeSkillName(e.name) === norm);
      if (!hit) {
        const visible = entries.filter((e) => e.enabled && !e.shadowed && !e.disableModelInvocation);
        const names = visible.map((e) => e.name).join("、") || "（当前没有可用技能）";
        return errorResult(`没有名为 "${name}" 的技能。当前可用：${names}`);
      }
      if (hit.shadowed) {
        return errorResult(`技能 "${hit.name}" 已被同名更高优先级技能遮蔽，不在模型目录中`);
      }
      if (!hit.enabled) {
        return errorResult(`技能 "${hit.name}" 的启用开关已关闭`);
      }
      if (hit.disableModelInvocation) {
        return errorResult(`技能 "${hit.name}" 标注为不可模型调用（仅供用户显式执行）`);
      }
      let raw: string;
      try {
        raw = readFileSync(hit.path, "utf8");
      } catch (err) {
        return errorResult(
          `读取技能文件失败：${err instanceof Error ? err.message : String(err)}`,
        );
      }
      const parsed = parseSkillDoc(raw, { fallbackName: hit.name });
      if (!parsed.ok) {
        return errorResult(`技能 "${hit.name}" 解析失败：${parsed.errors.join("；")}`);
      }
      const text = [
        `已加载技能 "${parsed.draft.name}"（${SCOPE_ZH[hit.scope]}）`,
        `技能文件：${hit.path}`,
        `技能目录：${dirname(hit.path)}（正文中的相对路径以此解析）`,
        "",
        parsed.draft.content,
      ].join("\n");
      return textResult(text, { name: parsed.draft.name, path: hit.path, scope: hit.scope });
    },
  };
}
