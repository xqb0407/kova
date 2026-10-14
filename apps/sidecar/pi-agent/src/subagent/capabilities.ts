/**
 * 能力解析：把一份子代理定义解析成"它实际拿到什么"。
 *
 * 五个维度的解析各守一条纪律——**未声明即不可达**。不是"给了再拒绝"，
 * 而是定义里没写的东西根本不会出现在它的工具表和提示词里。这样模型看不见
 * 不存在的能力，也就不会去试；试了也只会拿到一句明确的"你没有这个"。
 *
 * 解析顺序即提示词目录顺序（§6）：技能 → 知识源 → MCP → 记忆。
 * 段序稳定是有意义的：同一份定义每次委派产出的提示词字节一致，
 * provider 侧的 prompt cache 才命中。
 */
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { buildMcpTool } from "../mcp/mcp-tools";
import { formatSkillsForSystemPrompt } from "@earendil-works/pi-agent-core";
import { loadMcpServers } from "../mcp/mcp-config";
import { ensureSkillsLoaded, skillsSnapshot } from "../skills/discovery";
import { buildKnowledgeTool } from "./knowledge";
import { buildSubagentMemoryTools, subagentMemoryDir, subagentMemoryPromptBlock } from "./memory";
import type { SubagentDefinition } from "./subagent-definitions";
import type { ApprovalLevel } from "../types";

/** 一个子代理本次委派实际拿到的能力（工具表 + 提示词目录块） */
export type ResolvedCapabilities = {
  tools: AgentTool[];
  /** 追加到 system prompt 的能力目录块；各维度未声明时对应段整体省略 */
  promptBlock: string;
  /** 解析诊断（技能不存在、glob 匹配不到文件等），交给活动流展示 */
  diagnostics: string[];
};

/**
 * 技能目录：只列定义声明的那些。
 *
 * 未列出的技能**连目录行都不出现**——正文更是永不预加载。这与主代理
 * 的渐进式披露同构，只是集合更小：子代理的上下文比主代理紧得多。
 */
function skillsBlock(
  definition: SubagentDefinition,
  cwd: string,
  diagnostics: string[],
): { block: string; toolNames: string[] } {
  const declared = definition.skills;
  if (!declared?.length) return { block: "", toolNames: [] };
  const active = skillsSnapshot(cwd).activeSkills;
  const wanted = new Map(active.map((s) => [s.name, s]));
  const picked: typeof active = [];
  for (const name of declared) {
    const hit = wanted.get(name);
    if (hit) picked.push(hit);
    else diagnostics.push(`[${definition.name}] skill "${name}" is not available in this workspace`);
  }
  if (picked.length === 0) return { block: "", toolNames: [] };
  // formatSkillsForSystemPrompt 需要 skills 已预热；委派路径上早于任何委派发生
  return {
    block: formatSkillsForSystemPrompt(picked),
    toolNames: ["use_skill"],
  };
}

/** 知识源目录：每源一行，正文不进提示词 */
function knowledgeBlock(
  definition: SubagentDefinition,
): { block: string; sources: NonNullable<SubagentDefinition["knowledge"]> } {
  const sources = definition.knowledge ?? [];
  if (sources.length === 0) return { block: "", sources };
  const lines = sources.map((s) => `- ${s.name} (${s.path})`);
  return { block: `<knowledge_sources>\n${lines.join("\n")}\n</knowledge_sources>`, sources };
}

/** MCP 允许列表：只列服务器名，工具面留给 mcp 网关自己 discover */
function mcpBlock(
  definition: SubagentDefinition,
): { block: string; servers: string[] } {
  const servers = definition.mcpServers ?? [];
  if (servers.length === 0) return { block: "", servers };
  return {
    block: `<allowed_mcp_servers>\n${servers.join("\n")}\n</allowed_mcp_servers>`,
    servers,
  };
}

/**
 * 解析一份定义的完整能力集。
 *
 * 声明了 mcp.servers 但当前一个服务器都没启用/配置时，仍然挂网关——
 * 否则模型会以为"MCP 能力不存在"，而真相是"配置还没到位"，
 * 两者的下一步动作完全不同（后者该让用户去设置页配服务器）。
 */
export async function resolveSubagentCapabilities(
  definition: SubagentDefinition,
  cwd: string,
  baseTools: readonly AgentTool[],
  /** 父线程 id：MCP 审批卡转发到这里（子代理自己挂起的卡没人能看见） */
  parentThreadId: string,
  /** 父会话审批档位（闭包）：MCP 网关按它决定是否逐次审批。子代理跑在父会话的
   *  授权范围内，不因是子代理就拿到更宽松的一档 */
  getApprovalLevel?: () => ApprovalLevel,
): Promise<ResolvedCapabilities> {
  const diagnostics: string[] = [];
  const tools: AgentTool[] = [];
  const blocks: string[] = [];

  // 技能目录读的是同步缓存：冷缓存会返回空档，于是 skills 白名单静默失效
  // （子代理看不到任何技能，且没有任何报错）。会话物化时通常已预热过，
  // 但那是隐式依赖——签名未变时这里零 IO，不预热才需要担心。
  await ensureSkillsLoaded(cwd);

  // 1) 声明的基础工具：按规范注册名精确匹配会话工具表。
  //    声明名已在解析期归一（WebFetch 不是 webfetch），这里不做大小写变换。
  for (const name of definition.tools) {
    const tool = baseTools.find((t) => t.name === name);
    if (tool) tools.push(tool);
    else diagnostics.push(`[${definition.name}] tool "${name}" is not available in this session`);
  }

  // 2) 技能：目录 + use_skill（正文按需加载）
  const skills = skillsBlock(definition, cwd, diagnostics);
  if (skills.block) {
    blocks.push(skills.block);
    for (const name of skills.toolNames) {
      const tool = baseTools.find((t) => t.name === name);
      if (tool && !tools.some((t) => t.name === name)) tools.push(tool);
      else if (!tool) diagnostics.push(`[${definition.name}] use_skill is unavailable; skills cannot be loaded`);
    }
  }

  // 3) 知识源：目录 + kb_search（仅 files 类；mcp 类走下面的网关）
  const knowledge = knowledgeBlock(definition);
  if (knowledge.block) blocks.push(knowledge.block);
  if (knowledge.sources.length > 0) {
    tools.push(buildKnowledgeTool(cwd, knowledge.sources));
  }

  // 4) MCP：作用域化网关。allowedNames 用定义里声明的原始名单而非
  //    实际可用的，这样拒绝文案能告诉模型"你被授权了这些"而不是
  //    "当前没有任何服务器"。
  const mcp = mcpBlock(definition);
  if (mcp.servers.length > 0) {
    const { enabledBy } = await loadMcpServers(cwd);
    const missing = mcp.servers.filter((s) => enabledBy.get(s) !== true);
    if (missing.length > 0) {
      diagnostics.push(
        `[${definition.name}] MCP server(s) not enabled or unconfigured: ${missing.join(", ")}`,
      );
    }
    blocks.push(mcp.block);
    // threadId 传父线程：子代理在后台跑、自己挂起的审批卡没有 UI 承载，
    // 卡片必须出现在用户真正在看的那个会话里（§5）。
    // 审批档位同样继承父会话：子代理跑在父会话的授权范围内，
    // 不该因为是子代理就拿到更宽松的一档
    tools.push(
      buildMcpTool(
        cwd,
        parentThreadId,
        {
          allowedServers: mcp.servers,
          allowedNames: mcp.servers,
        },
        getApprovalLevel,
      ),
    );
  }

  // 5) 记忆：私有/共享命名空间 + 三件套
  const mode = definition.memory ?? "none";
  if (mode !== "none") {
    const dir = subagentMemoryDir(mode, cwd, definition.name);
    blocks.push(subagentMemoryPromptBlock(dir));
    tools.push(...buildSubagentMemoryTools(dir, definition.name));
  }

  return { tools, promptBlock: blocks.filter((b) => b.trim()).join("\n\n"), diagnostics };
}