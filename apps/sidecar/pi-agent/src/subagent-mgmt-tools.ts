/**
 * 主代理的子智能体管理工具组：subagents_list / subagents_save / subagents_delete。
 *
 * 执行体直接复用存储层函数（subagent-definitions），让设置页有的一切语义
 * ——schema 校验、层目录解析、内置重名冲突、跨层查重、改名清理、开关残留——
 * 都长在同一处；改动后热重载（reload 由 sessions 注入，避免模块环）。
 * 管理组挂在 Task 组旁边、不在 baseTools 里：delegate 按定义取工具时结构性
 * 拿不到它们（KNOWN_TOOLS 白名单是第一道，这是第二道）。
 */
import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { logErr } from "./log";
import {
  deleteSubagentDefinition,
  loadSubagentDefinitions,
  saveSubagentDefinition,
  systemSubagentsDir,
  workspaceSubagentsDir,
  type SubagentDraft,
  type SubagentScope,
} from "./subagent-definitions";
import type { Running } from "./types";

export const SUBAGENT_MGMT_TOOL_NAMES = {
  list: "subagents_list",
  save: "subagents_save",
  delete: "subagents_delete",
} as const;

const SCOPE_ZH: Record<SubagentScope, string> = {
  builtin: "内置",
  system: "系统级",
  workspace: "工作区级",
};

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

/** scope 参数守卫：返回 null 表示合法 */
function badScope(scope: unknown): string | null {
  return scope === "system" || scope === "workspace"
    ? null
    : 'scope 需为 "system" 或 "workspace"（内置定义只读，不可创建或删除，只能在设置页开关）';
}

export function buildSubagentMgmtTools(
  run: Running,
  reload: () => Promise<void>,
): AgentTool[] {
  const listTool: AgentTool = {
    name: SUBAGENT_MGMT_TOOL_NAMES.list,
    label: "列出子智能体",
    description: [
      "列出当前可委派的全部子智能体定义（内置 / 系统级 / 工作区级），含工具白名单、轮次与模型设置、启用与挂载状态、来源文件，以及各层存储目录。",
      "想创建、更新或删除定义前先调用它：你会直接知道文件住在哪、哪些名字已被占用，无需 read 文件系统去猜。",
    ].join("\n\n"),
    parameters: Type.Object({
      include_prompts: Type.Optional(
        Type.Boolean({
          description: "为 true 时附带每份定义的 prompt 正文摘要（默认省略以控制输出量）",
        }),
      ),
    }),
    execute: async (_toolCallId, params) => {
      const p = (params ?? {}) as { include_prompts?: boolean };
      try {
        const { entries, diagnostics } = await loadSubagentDefinitions({ cwd: run.cwd });
        const lines: string[] = [
          `系统级目录（本机所有工作区生效）：${systemSubagentsDir()}`,
          `工作区级目录（本会话）：${workspaceSubagentsDir(run.cwd)}`,
          "",
        ];
        for (const e of entries) {
          const parts = [`tools: [${e.tools.join(", ")}]`];
          if (e.maxTurns !== undefined) parts.push(`maxTurns: ${e.maxTurns}`);
          if (e.model) parts.push(`model: ${e.model}`);
          if (!e.enabled) parts.push("开关已关，未挂载");
          lines.push(
            `- [${SCOPE_ZH[e.scope]}] ${e.name} — ${e.description}（${parts.join(" · ")}）`,
          );
          if (e.path) lines.push(`    ${e.path}`);
          if (p.include_prompts && e.prompt) {
            lines.push(`    prompt: ${e.prompt.slice(0, 400)}`);
          }
        }
        if (diagnostics.length > 0) {
          lines.push("", "加载诊断：");
          for (const d of diagnostics.slice(0, 10)) lines.push(`- ${d}`);
        }
        if (lines.length === 0) lines.push("（当前没有任何定义）");
        return textResult(lines.join("\n"));
      } catch (err) {
        return errorResult(errorMessage(err));
      }
    },
  };

  const saveTool: AgentTool = {
    name: SUBAGENT_MGMT_TOOL_NAMES.save,
    label: "保存子智能体定义",
    description: [
      "创建或同名覆盖一份子智能体定义；存储层校验通过后热生效，下一轮 Task 即可委派它。",
      "用这个工具而不是 write/edit 手写 YAML 文件——只有它会做校验、跨层查重并重载工具目录。",
      "scope=system 存到应用数据目录（本机所有工作区生效，适合通用能力）；scope=workspace 写进本会话工作目录的 .xulux/subagents/，随仓库共享。",
      "delegate 的能力边界（写 prompt 时记住）：只能使用声明的工具白名单，共享会话工作目录，看不到用户与本对话，不能再次委派，唯一输出是最终报告。",
      'description 是主代理挑选委派对象的唯一依据，写清"什么时候用它"；prompt 写给执行者看：角色、方法、汇报格式。',
    ].join("\n\n"),
    parameters: Type.Object({
      scope: Type.String({ description: '"system"（应用数据目录）或 "workspace"（当前工作区仓库）' }),
      name: Type.String({
        description: "子智能体名称：字母/数字/汉字开头，可含字母、数字、汉字、空格、._-，≤64 字符",
      }),
      description: Type.String({ description: "何时委派它（一到两句，主代理据此选择）" }),
      tools: Type.Array(Type.String(), {
        description: 'delegate 工具白名单，仅限 ["bash","read","write","edit","glob","grep"]，按需最小授权',
      }),
      prompt: Type.String({ description: "子智能体的系统提示词正文" }),
      maxTurns: Type.Optional(
        Type.Number({ description: "轮次上限（正整数）；建议 30-60，缺省不限" }),
      ),
      model: Type.Optional(
        Type.String({ description: '固定 delegate 模型 "provider/modelId"；缺省继承会话模型' }),
      ),
    }),
    execute: async (_toolCallId, params) => {
      const p = (params ?? {}) as {
        scope?: string;
        name?: string;
        description?: string;
        tools?: string[];
        prompt?: string;
        maxTurns?: number;
        model?: string;
      };
      const scopeErr = badScope(p.scope);
      if (scopeErr) return errorResult(scopeErr);
      const scope = p.scope as "system" | "workspace";
      const draft: SubagentDraft = {
        name: String(p.name ?? ""),
        description: String(p.description ?? ""),
        tools: Array.isArray(p.tools) ? p.tools.map(String) : [],
        prompt: String(p.prompt ?? ""),
        ...(typeof p.maxTurns === "number" && Number.isFinite(p.maxTurns) && p.maxTurns >= 1
          ? { maxTurns: Math.floor(p.maxTurns) }
          : {}),
        ...(p.model ? { model: String(p.model) } : {}),
      };
      try {
        await saveSubagentDefinition(scope, draft, { cwd: run.cwd });
      } catch (err) {
        return errorResult(errorMessage(err));
      }
      try {
        await reload();
      } catch (err) {
        logErr("subagent-mgmt: reload after save failed:", errorMessage(err));
      }
      if (scope === "system") {
        return textResult(
          `已保存（系统级）："${draft.name}" → ${systemSubagentsDir()}。已热重载，下一轮 Task 可委派。`,
        );
      }
      return textResult(
        `已保存（工作区级）："${draft.name}" → ${workspaceSubagentsDir(run.cwd)}。已热重载，下一轮 Task 可委派。`,
      );
    },
  };

  const deleteTool: AgentTool = {
    name: SUBAGENT_MGMT_TOOL_NAMES.delete,
    label: "删除子智能体定义",
    description: [
      "删除一份系统级或工作区级子智能体定义（内置只读不可删；要停用内置请用户在设置页用开关）。",
      "删除即热生效：Task 列表下一轮更新；运行中的委派不受影响，跑完照常投递报告。",
      "先 subagents_list 确认 scope 与名称，别凭记忆删。",
    ].join("\n\n"),
    parameters: Type.Object({
      scope: Type.String({ description: '"system" 或 "workspace"' }),
      name: Type.String({ description: "要删除的定义名称" }),
    }),
    execute: async (_toolCallId, params) => {
      const p = (params ?? {}) as { scope?: string; name?: string };
      const scopeErr = badScope(p.scope);
      if (scopeErr) return errorResult(scopeErr);
      const scope = p.scope as "system" | "workspace";
      const name = String(p.name ?? "");
      try {
        await deleteSubagentDefinition(scope, name, { cwd: run.cwd });
      } catch (err) {
        return errorResult(errorMessage(err));
      }
      try {
        await reload();
      } catch (err) {
        logErr("subagent-mgmt: reload after delete failed:", errorMessage(err));
      }
      return textResult(
        `已删除（${scope === "system" ? "系统级" : "工作区级"}）："${name}"。已热重载。`,
      );
    },
  };

  return [listTool, saveTool, deleteTool];
}
