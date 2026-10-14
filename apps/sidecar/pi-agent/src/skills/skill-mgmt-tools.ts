/**
 * 主代理的技能管理工具组：skills_list / skills_save / skills_delete。
 *
 * 与子智能体管理组（subagent-mgmt-tools）同款设计：执行体直接复用存储层
 * 函数（skills），让设置页有的一切语义——frontmatter 校验、层目录解析、
 * 同名覆盖与改名清理、开关残留清理——都长在同一处；改动后热重载
 * （reloadSkills 由 sessions 注入，避免模块环）。
 * 管理组挂在 Task 组旁边、不在 baseTools 里：delegate 按定义取工具时结构性
 * 拿不到它们。
 */
import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { logErr } from "../log";
import {
  compatHomeSkillsDir,
  compatWorkspaceSkillsDir,
  deleteSkillDoc,
  ensureSkillsLoaded,
  skillsSnapshot,
  saveSkillDoc,
  systemSkillsDir,
  workspaceSkillsDir,
  type SkillDraft,
} from "./skills";
import type { Running } from "../types";

export const SKILL_MGMT_TOOL_NAMES = {
  list: "skills_list",
  save: "skills_save",
  delete: "skills_delete",
} as const;

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }], details: undefined };
}

function errorResult(text: string) {
  return {
    content: [{ type: "text" as const, text: `错误：${text}` }],
    details: { error: text },
  };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * scope 参数：枚举 system（缺省）/ project。
 * "project" 映射到存储层的 workspace 层（<cwd>/.kova/skills/）；
 * 落盘路径由存储层函数自行解析，工具参数里没有也不该有路径字段。
 */
function resolveScope(
  scope: unknown,
): { ok: true; scope: "system" | "workspace" } | { ok: false; error: string } {
  if (scope === undefined || scope === null || scope === "") {
    return { ok: true, scope: "system" };
  }
  if (scope === "system") return { ok: true, scope };
  if (scope === "project") return { ok: true, scope: "workspace" };
  return {
    ok: false,
    error: 'scope 需为 "system"（默认，不传即可）或 "project"（生态目录 .agents/skills 只读，不可在此创建或删除）',
  };
}

/** scope 回执文案：存储层取值 → 工具对外口径（project） */
const SCOPE_ZH_STORED = { system: "系统级", workspace: "项目级" } as const;

const SCOPE_ZH = {
  workspace: "项目",
  "compat-workspace": "生态·项目",
  system: "系统",
  compat: "生态·用户",
  plugin: "插件",
} as const;

export function buildSkillMgmtTools(
  run: Running,
  reload: () => Promise<void>,
): AgentTool[] {
  const listTool: AgentTool = {
    name: SKILL_MGMT_TOOL_NAMES.list,
    label: "列出技能",
    description: [
      "列出四层技能目录（项目 / 生态·项目 / 系统 / 生态·用户）的全部技能：名称、描述、来源层、启用开关、是否被同名遮蔽、文件路径。",
      "想创建、更新或删除技能前先调用它：你会直接知道各层目录在哪、哪些名字已被占用，无需 read 文件系统去猜。",
    ].join("\n\n"),
    parameters: Type.Object({
      include_content: Type.Optional(
        Type.Boolean({
          description: "为 true 时附带每份技能的正文摘要（默认省略以控制输出量）",
        }),
      ),
    }),
    execute: async (_toolCallId, params) => {
      const p = (params ?? {}) as { include_content?: boolean };
      try {
        // 签名缓存下无变化零 IO；外部（设置页/手工）改动后此处拿到的是磁盘现值
        await ensureSkillsLoaded(run.cwd);
        const { entries, diagnostics } = skillsSnapshot(run.cwd);
        const lines: string[] = [
          `项目目录（本会话仓库，可编辑）：${workspaceSkillsDir(run.cwd)}`,
          `生态·项目目录（只读）：${compatWorkspaceSkillsDir(run.cwd)}`,
          `系统目录（本机所有工作区，可编辑）：${systemSkillsDir()}`,
          `生态·用户目录（只读）：${compatHomeSkillsDir()}`,
          "",
        ];
        for (const e of entries) {
          const parts: string[] = [];
          if (!e.enabled) parts.push("开关已关");
          if (e.shadowed) parts.push("被同名更高优先级技能遮蔽");
          if (!e.editable) parts.push("只读");
          if (e.disableModelInvocation) parts.push("不注入模型目录");
          const mark = parts.length > 0 ? `（${parts.join(" · ")}）` : "";
          lines.push(`- [${SCOPE_ZH[e.scope]}] ${e.name} — ${e.description}${mark}`);
          lines.push(`    ${e.path}`);
          if (p.include_content && e.content) {
            lines.push(`    content: ${e.content.slice(0, 400)}`);
          }
        }
        if (diagnostics.length > 0) {
          lines.push("", "加载诊断：");
          for (const d of diagnostics.slice(0, 10)) lines.push(`- ${d}`);
        }
        if (entries.length === 0) lines.push("（当前没有任何技能）");
        return textResult(lines.join("\n"));
      } catch (err) {
        return errorResult(errorMessage(err));
      }
    },
  };

  const saveTool: AgentTool = {
    name: SKILL_MGMT_TOOL_NAMES.save,
    label: "保存技能",
    description: [
      "创建或同名覆盖一份技能（SKILL.md 指令文档）；存储层校验通过后热生效，<available_skills> 目录下一轮即含它，模型按 description 判断是否读取正文。",
      "用这个工具而不是 write/edit 手写 Markdown——只有它会做 frontmatter 校验、同名文件清理并重载技能目录。",
      "存储位置由工具按 scope 自行决定（本工具没有路径参数）：缺省即系统级（system），存到应用数据目录、本机所有工作区生效；仅当技能与当前项目绑定（仓库规范、发布流程）时传 scope=project，写进项目目录 .kova/skills/，随仓库共享。",
      'description 是模型决定用不用这份技能的唯一依据，写清"什么时候用它"（含触发场景/关键词）；正文写给执行者看：步骤、约束、示例，只放模型不知道的内容。',
      "编辑改名：传 replace_name=旧名，旧文件一并清掉。生态目录（.agents/skills）只读，不接受在此保存。",
    ].join("\n\n"),
    parameters: Type.Object({
      scope: Type.Optional(
        Type.Union([Type.Literal("system"), Type.Literal("project")], {
          description: '"system"（缺省，应用数据目录，全局生效）或 "project"（当前项目仓库 .kova/skills/）；一般不用传',
        }),
      ),
      name: Type.String({ description: "技能名称，≤64 字符（同名 = 覆盖更新）" }),
      description: Type.String({
        description: "何时使用该技能（模型据此判断，≤1024 字符）",
      }),
      content: Type.String({ description: "技能正文（Markdown 指令文档，frontmatter 由工具生成，不用自己写）" }),
      disableModelInvocation: Type.Optional(
        Type.Boolean({
          description: "true = 不出现在模型技能目录（仅用户显式调用的命令型技能），默认 false",
        }),
      ),
      replace_name: Type.Optional(
        Type.String({ description: "改名时的旧技能名（据此删除本层旧文件）；新建或原名保存省略" }),
      ),
    }),
    execute: async (_toolCallId, params) => {
      const p = (params ?? {}) as {
        scope?: string;
        name?: string;
        description?: string;
        content?: string;
        disableModelInvocation?: boolean;
        replace_name?: string;
      };
      const resolved = resolveScope(p.scope);
      if (!resolved.ok) return errorResult(resolved.error);
      const { scope } = resolved;
      const draft: SkillDraft = {
        name: String(p.name ?? ""),
        description: String(p.description ?? ""),
        content: String(p.content ?? ""),
        ...(p.disableModelInvocation === true ? { disableModelInvocation: true } : {}),
      };
      const replaceName =
        typeof p.replace_name === "string" && p.replace_name.trim()
          ? p.replace_name.trim()
          : undefined;
      try {
        await saveSkillDoc(scope, draft, { cwd: run.cwd, ...(replaceName ? { replaceName } : {}) });
      } catch (err) {
        return errorResult(errorMessage(err));
      }
      try {
        await reload();
      } catch (err) {
        logErr("skill-mgmt: reload after save failed:", errorMessage(err));
      }
      const dir = scope === "system" ? systemSkillsDir() : workspaceSkillsDir(run.cwd);
      return textResult(
        `已保存（${SCOPE_ZH_STORED[scope]}）："${draft.name}" → ${dir}。已热重载，下一轮起该技能生效。`,
      );
    },
  };

  const deleteTool: AgentTool = {
    name: SKILL_MGMT_TOOL_NAMES.delete,
    label: "删除技能",
    description: [
      "删除一份系统级（缺省）或项目级技能文件（生态目录只读不可删）。只是停用请先与用户确认——用户可去设置页用开关停用而保留文件。",
      "删除即热生效：技能目录下一轮更新；不影响历史对话里已读过的内容。",
      "先 skills_list 确认 scope 与名称，别凭记忆删；删项目技能必须显式传 scope=project。",
    ].join("\n\n"),
    parameters: Type.Object({
      scope: Type.Optional(
        Type.Union([Type.Literal("system"), Type.Literal("project")], {
          description: '"system"（缺省）或 "project"；层级不确定时先 skills_list 查',
        }),
      ),
      name: Type.String({ description: "要删除的技能名称" }),
    }),
    execute: async (_toolCallId, params) => {
      const p = (params ?? {}) as { scope?: string; name?: string };
      const resolved = resolveScope(p.scope);
      if (!resolved.ok) return errorResult(resolved.error);
      const { scope } = resolved;
      const name = String(p.name ?? "");
      try {
        await deleteSkillDoc(scope, name, { cwd: run.cwd });
      } catch (err) {
        return errorResult(errorMessage(err));
      }
      try {
        await reload();
      } catch (err) {
        logErr("skill-mgmt: reload after delete failed:", errorMessage(err));
      }
      return textResult(
        `已删除（${SCOPE_ZH_STORED[scope]}）："${name}"。已热重载。`,
      );
    },
  };

  return [listTool, saveTool, deleteTool];
}
