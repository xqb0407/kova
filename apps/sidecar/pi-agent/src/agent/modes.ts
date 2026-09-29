/**
 * 模式系统：
 * - agent：正常执行，工具全集 + plan_enter
 * - plan：只读勘察（read/glob/grep/bash/WebFetch/WebSearch/Question）+ plan_write/plan_exit
 *
 * 计划三件套：
 * - plan_enter：agent → plan，热换 systemPrompt/tools，立即推 planningState 让 UI 跟随
 * - plan_write：把计划 Markdown 写进当前会话计划文件（首写定名，之后整体覆盖；可与其他工具并批）
 * - plan_exit：HITL 退出——execute 内挂起等待用户批准（批准=回 agent 模式同一轮直接实施；
 *   拒绝=留在 plan 修改后再次申请）。模式级门控：不受 approvalLevel 影响，"完全访问"也要确认
 *
 * 规则：
 * - plan_enter / plan_exit 必须独占 assistant 消息的 tool call 批次（beforeToolCall 拦截）
 * - plan_enter 仅 agent 模式可用；plan_write / plan_exit 仅 plan 模式可用
 * - 切换不重建 Agent：热替换 agent.state.systemPrompt / agent.state.tools，并同步
 *   beforeToolCall 捕获的活循环上下文（run.loopContext），轮中切换本轮立即生效
 * - plan 模式只读是代码保证：write/edit 在 beforeToolCall 一律拦截（不依赖工具表
 *   新鲜度），计划文件只能由 plan_write 写到系统定好的路径，无需逐工具审批
 * - plan_exit：批准 = 回 agent 同轮实施；用户显式拒绝 = 删除计划文件 + abort 终止
 *   本轮；Stop/新 prompt 清理（settledBy=clear）= 按拒绝结算，文件保留、不额外 abort
 *
 * 计划文件持久化：首写落盘 `<cwd>/.kova/plans/plan-<标题>-<sessionId>-<时间>.md`
 * （选中了工作区 → <工作区>/.kova/plans/；未选 → run.cwd 兜底为用户主目录）。
 * 下一轮 plan_enter 重开时路径重置（新文件）；批准后路径保留，实施阶段可回读。
 */
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Type } from "typebox";
import { randomUUID } from "node:crypto";
import type {
  AgentTool,
  BeforeToolCallContext,
  BeforeToolCallResult,
} from "@earendil-works/pi-agent-core";
import { SYSTEM_PROMPT_CORE, environmentPromptBlock, systemPromptCore } from "../tools/tools";
import { kvSet, sessionPrefsSet } from "../storage/hostdb";
import { beginInteraction, settleInteraction } from "../sessions/pending-interactions";
import { SUBAGENT_MGMT_TOOL_NAMES } from "../subagent/subagent-mgmt-tools";
import { SKILL_MGMT_TOOL_NAMES } from "../skills/skill-mgmt-tools";
import { SKILL_USE_TOOL_NAME } from "../skills/skill-use-tool";
import { PLUGIN_MGMT_TOOL_NAMES } from "../plugins/plugin-mgmt-tools";
import { getAutomationPolicy, automationDenyReason } from "../automation/policy";
import { buildHookPayload, runHooks } from "./hooks";
import { personalizationPromptBlock } from "./personalization";
import { appModePromptBlock } from "./app-mode";
import type { ThemeRef } from "../design-md/store";
import { memoryPromptBlock } from "./memory";
import { mcpPromptBlock } from "../mcp/mcp-tools";
import { skillsPromptBlock } from "../skills/skills";
import { instructionsPromptBlock } from "./instructions";
import { sendEventChunk } from "../protocol/stream";
import type {
  ApprovalLevel,
  PlanningState,
  Running,
  SessionMode,
} from "../types";

/** 计划三件套工具名：enter = 进入；write = 写计划文件；exit = 申请退出（HITL） */
export const PLAN_TOOL_NAMES = {
  enter: "plan_enter",
  write: "plan_write",
  exit: "plan_exit",
} as const;

/** 三档字面量的宽松规整：库里的偏好值、协议消息、投影行都经这里收口。
 *  加枚举值时只改这一处——散落各处的 `x === "a" || x === "b"` 白名单是这类
 *  改动最典型的静默漏改点（新值不报错，只是被悄悄丢成旧档） */
export function normalizeSessionMode(raw: unknown): SessionMode {
  return raw === "plan" || raw === "ask" ? raw : "agent";
}

/** 问答档唯一的出口工具：模型调用它只是**提议**切回编码档，不自己切。
 *  切档会当场把系统提示词与工具表一起换重，那正是问答档要避免的事，所以这个
 *  决定权留给人（与 plan_exit 的 HITL 同一路子），前端渲染成 composer 上的一个 chip */
export const ASK_NEEDS_WORK_TOOL_NAME = "ask_needs_work";

/** 必须独占批次的模式切换工具（plan_write 是纯落盘动作，可并批） */
const MODE_EXCLUSIVE_TOOL_NAMES = new Set<string>([
  PLAN_TOOL_NAMES.enter,
  PLAN_TOOL_NAMES.exit,
  ASK_NEEDS_WORK_TOOL_NAME,
]);

/** 仅 plan 模式可用的工具 */
const PLAN_ONLY_TOOL_NAMES = new Set<string>([
  PLAN_TOOL_NAMES.write,
  PLAN_TOOL_NAMES.exit,
]);

/** plan 模式允许的工具：只读（含联网勘察 WebFetch/WebSearch）+ bash（承诺仅用于勘察，靠提示词约束）+ Question（规划正需要澄清提问）+ use_skill（加载技能指令，只读动作） */
const CONTRACT_TOOL_NAMES = new Set(["read", "glob", "grep", "bash", "WebFetch", "WebSearch", "Question", SKILL_USE_TOOL_NAME]);

/** 问答模式允许的工具：CONTRACT 去掉 bash。bash 能写工作区，留着就破了只读边界——
 *  问答档的安全保证是"结构性的"（工具表里根本没有写类工具），不是靠提示词自觉。
 *  保留 read/glob/grep 是因为"这个函数在哪调的""这个报错什么意思"这类问题
 *  必须能读代码才能答（对齐 Cursor 的 Ask / Claude Code 的 Manual 档：只读，非无工具） */
const ASK_TOOL_NAMES = new Set(
  [...CONTRACT_TOOL_NAMES].filter((n) => n !== "bash"),
);

/** 仅问答模式可用的出口工具（见 buildAskTools） */
const ASK_ONLY_TOOL_NAMES = new Set([ASK_NEEDS_WORK_TOOL_NAME]);

/** 问答模式结构性拦截的写类工具：工具表里已不下发，这里是第二道闸——
 *  轮中切换前模型可能仍带着旧 schema（与 plan 模式同一理由） */
const ASK_MODE_MUTATING_TOOLS = new Set(["write", "edit", "bash"]);

/* ------------------------------- 系统提示词 ------------------------------- */

const PLAN_MODE_PROMPT = [
  "You are operating in Plan mode. The deliverable of this mode is the session plan file, not a chat answer: research with the read-only tools, then call plan_write with the complete implementation plan in Markdown (written in the user's language), then call plan_exit to request approval.",
  "Project files cannot be modified in Plan mode — write/edit are blocked by the system, and plan_write stores the plan at a system-chosen path (you never pass a file path).",
  "If the user approves plan_exit, you are back in Agent mode — start implementing immediately. If rejected, this turn stops.",
].join("\n");

const AGENT_MODE_PROMPT =
  "You are operating in Agent mode: carry out the requested work with the available tools and report the result clearly. When a task is large or ambiguous, enter Plan mode via plan_enter to research and draft an implementation plan; the plan needs user approval via plan_exit before you implement.";
export { AGENT_MODE_PROMPT };

/** 问答模式的系统提示词：身份段换掉"coding agent"，纪律段只留"读—答—不动手"。
 *  静态核心里剔掉 taskTracking / subagents 两段（见 systemPromptCore）——那六行
 *  子代理说明和多轮委派纪律是"工程味"的主要来源，问答场景整段无意义 */
const ASK_MODE_PROMPT = [
  "You are operating in Ask mode. The user is asking a question and wants an answer, not work performed on their project.",
  "Answer directly. Read files when the answer genuinely depends on them, then reply in prose. Do not run commands, do not modify anything, and do not narrate a plan you are about to carry out.",
  "A question is not a task: never create a todo, never delegate to a subagent, never treat answering as the first step of a larger job.",
  "Project files cannot be modified in Ask mode — the system blocks it. If the request really does require changing the project, say so in one sentence and call ask_needs_work to offer switching to Agent mode; do not attempt the work yourself.",
].join("\n");

/** 问答档的静态核心取段：身份/纪律/沟通三段保留（纪律段里的读码与正确性仍然有用），
 *  任务追踪与子代理两段整段剔除 */
const ASK_CORE_SEGMENTS = ["identity", "discipline", "communication"] as const;

/** 环境事实段只用到模型的这三个字段；pi-ai 的 Model<Api> 结构兼容，调用侧直接传 */
export type PromptModelInfo = { provider: string; id: string; name?: string };

/**
 * 各模式完整系统提示 = 静态核心 + 模式附加段 + 个性化段 + 工作模式段 + 记忆段 + MCP 段 + 技能目录段 + 指令段 + 环境事实块
 * （日期/模型/OS/shell，末行是 cwd 行）。
 * 顺序保证缓存命中：静态核心在前（跨会话字节级一致），模式段夹中间（会话内
 * 切换时整段重排不可避免，但同一模式内前缀稳定），个性化/记忆段随设置变更热替换，
 * 工作模式段随全局 work/code/design 开关热替换（app-mode.ts，code 档为空串；
 * design 段随会话选中的设计主题增减一行主题句，正文由 use_design_theme 按需加载），
 * MCP 段随服务器配置变更热替换（无启用服务器时为空串），技能目录段只列生效技能的
 * name/description/location 三行元数据（正文模型按需 use_skill 加载，开关/遮蔽在
 * 缓存合并时裁决，随 reloadSkills 热替换），指令段读 AGENTS.md（全局 ~/.kova/AGENTS.md +
 * 工作区仓库根，每次组装同步读盘，改动随下一次重组生效），环境事实块永远在最尾；
 * 个性化段全默认、记忆关闭、无 MCP 服务器、无生效技能、无指令文件时各块为空串
 * （默认提示词与旧版字节级一致）。
 */
export function composeModeSystemPrompt(
  mode: SessionMode,
  cwd: string,
  model?: PromptModelInfo | null,
  designTheme?: ThemeRef | null,
): string {
  // 问答档换掉静态核心的取段（剔任务追踪与子代理），其余模式沿用全量核心——
  // 全量拼接与拆分前逐字节相同，缓存不变式不受影响
  const core = mode === "ask" ? systemPromptCore(ASK_CORE_SEGMENTS) : SYSTEM_PROMPT_CORE;
  const extra =
    mode === "plan" ? PLAN_MODE_PROMPT : mode === "ask" ? ASK_MODE_PROMPT : AGENT_MODE_PROMPT;
  return [
    core,
    extra,
    personalizationPromptBlock(),
    appModePromptBlock(designTheme),
    memoryPromptBlock(cwd),
    mcpPromptBlock(cwd),
    skillsPromptBlock(cwd),
    instructionsPromptBlock(cwd),
    environmentPromptBlock(cwd, model),
  ]
    .filter(Boolean)
    .join("\n\n");
}

/* --------------------------------- 工具集 --------------------------------- */

/** 问答档的出口工具：只发 chunk 提示前端弹 chip，不切模式、不写任何东西 */
function buildAskTools(run: Running): AgentTool[] {
  return [
    {
      name: ASK_NEEDS_WORK_TOOL_NAME,
      label: "Needs agent mode",
      description:
        "Tell the user this question actually requires changing the project, and offer to switch to Agent mode. Use this instead of attempting the work yourself when you are in Ask mode.",
      parameters: Type.Object({
        reason: Type.String({
          description: "One sentence on what the work would require, shown on the switch prompt",
        }),
      }),
      execute: async (args: unknown) => {
        const reason =
          typeof (args as { reason?: unknown })?.reason === "string"
            ? (args as { reason: string }).reason
            : "";
        sendEventChunk(
          run.threadId,
          { type: "data-askNeedsWork", data: { reason } },
          run.sessionId,
        );
        return textResult(
          "Switch prompt shown to the user. Stay in Ask mode and keep answering; do not retry the work.",
        );
      },
    } as unknown as AgentTool,
  ];
}

/** 按模式重建工具目录：agent = 基础 + Task 组 + plan_enter；plan = 只读子集 + plan_write/plan_exit；
 *  ask = 纯只读子集（无 bash）+ 出口工具，不带 plan 三件套与子代理组 */
export function toolsForMode(run: Running): AgentTool[] {
  if (run.mode === "ask") {
    return [
      ...run.baseTools.filter((t) => ASK_TOOL_NAMES.has(t.name)),
      ...buildAskTools(run),
    ];
  }
  const planTools = buildPlanTools(run);
  if (run.mode === "agent") {
    return [
      ...run.baseTools,
      ...run.subagentTools,
      ...planTools.filter((t) => t.name === PLAN_TOOL_NAMES.enter),
    ];
  }
  return [
    ...run.baseTools.filter((t) => CONTRACT_TOOL_NAMES.has(t.name)),
    ...planTools.filter((t) => t.name !== PLAN_TOOL_NAMES.enter),
  ];
}

function textResult(text: string, details?: unknown) {
  return { content: [{ type: "text" as const, text }], details };
}

/**
 * 文件名清洗：任何非文字/数字串（空白、破折号、全角标点、Windows 非法字符等）
 * 折叠为单个连字符，去掉首尾连接符，限长 60。
 * 如 “PRD WiFi 化 — 门店入口” → PRD-WiFi-化-门店入口
 */
function sanitizeFileName(input: string): string {
  return input
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

/** 时间戳：YYYYMMDD-HHmmss */
function fileTimestamp(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  );
}

/** Markdown 首个标题行做兜底标题（plan_write 未给 title 时） */
function firstHeading(markdown: string): string {
  const line = markdown.split(/\r?\n/).find((l) => /^#{1,6}\s/.test(l));
  return line ? line.replace(/^#+\s*/, "").trim() : "";
}

/**
 * 计划文件落盘：首写定名 `<cwd>/.kova/plans/plan-<标题>-<sessionId>-<时间>.md`，
 * 之后每次调用整体覆盖同一路径。run.cwd 由 sessions 解析（未选工作目录时
 * 兜底按会话隔离的任务子目录，见 sessions.ts taskSessionCwd），两种场景统一处理。
 * 失败直接抛出（工具调用失败对模型可见）。
 */
async function writePlanFile(
  run: Running,
  markdown: string,
  titleInput: string | undefined,
): Promise<string> {
  if (!run.planFilePath) {
    const title = (titleInput ?? "").trim() || firstHeading(markdown) || "untitled";
    run.planTitle = title;
    const name = [
      "plan",
      sanitizeFileName(title) || "untitled",
      run.sessionId,
      fileTimestamp(new Date()),
    ].join("-");
    run.planFilePath = join(run.cwd, ".kova", "plans", `${name}.md`);
  }
  await mkdir(dirname(run.planFilePath), { recursive: true });
  await writeFile(
    run.planFilePath,
    `# ${run.planTitle || "Plan"}\n\n${markdown}\n`,
    "utf8",
  );
  return run.planFilePath;
}

/** 计划三件套（构建时捕获 run 引用；run.agent 在构造后回填） */
function buildPlanTools(run: Running): AgentTool[] {
  const enterTool: AgentTool = {
    name: PLAN_TOOL_NAMES.enter,
    label: "Enter Plan Mode",
    description:
      "Switch this session into Plan mode: read-only research, write the implementation plan to the session plan file via plan_write, then request user approval with plan_exit. Must be the only tool call in your message.",
    parameters: Type.Object({}),
    execute: async () => {
      applyMode(run, "plan");
      // 新一轮规划：计划文件重置（首写重新定名）
      run.planFilePath = undefined;
      run.planTitle = undefined;
      emitPlanningState(run);
      return textResult(
        "Entered Plan mode. Inspect the workspace, write the plan with plan_write, then call plan_exit to request approval.",
      );
    },
  };

  const writeTool: AgentTool = {
    name: PLAN_TOOL_NAMES.write,
    label: "Write Plan",
    description:
      "Write the complete implementation plan (Markdown) to the session plan file, replacing any previous content. The first call fixes the file title; call again to revise. Must be in Plan mode before plan_exit can be approved.",
    parameters: Type.Object({
      markdown: Type.String({
        description: "Complete implementation plan in Markdown (files, behavior, validation steps)",
      }),
      title: Type.Optional(
        Type.String({ description: "Short plan title (only used when this is the first write)" }),
      ),
    }),
    execute: async (_id, params) => {
      const p = params as { markdown?: string; title?: string };
      const markdown = String(p.markdown ?? "");
      if (!markdown.trim()) throw new Error("markdown is required");
      const filePath = await writePlanFile(run, markdown, p.title);
      return textResult(`Plan written to ${filePath}`, {
        filePath,
        title: run.planTitle,
      });
    },
  };

  const exitTool: AgentTool = {
    name: PLAN_TOOL_NAMES.exit,
    label: "Exit Plan Mode",
    description:
      "Request switching back to Agent mode to implement the plan: presents the plan for user approval (HITL) and waits inline. If approved, this session returns to Agent mode — start implementing immediately. If rejected, this turn stops (the session stays in Plan mode for a follow-up message). Must be the only tool call in your message and plan_write must have been called first.",
    parameters: Type.Object({
      rationale: Type.String({
        description: "Why this plan is ready for approval (short summary shown to the user)",
      }),
    }),
    execute: async (toolCallId, params) => {
      const rationale = String((params as { rationale?: string }).rationale ?? "").trim();
      if (!run.planFilePath) {
        throw new Error(
          "No plan file yet — write the plan with plan_write before calling plan_exit.",
        );
      }
      // 审批卡展示用：以磁盘上的计划文件为准（单一事实源）
      let markdown = "";
      try {
        markdown = await readFile(run.planFilePath, "utf8");
      } catch {
        // 文件被外部删除等：卡片照常展示 rationale，不阻塞审批
      }
      const approvalId = randomUUID();
      const input = {
        rationale,
        title: run.planTitle ?? "",
        markdown,
        filePath: run.planFilePath,
      };
      // 挂起交互登记落行（§4）：先于推卡，崩溃窗口偏向可恢复一侧；
      // 带 sessionId 的发起帧进事件水印（§3，漏收 → 桌面回拉 list_pending）
      beginInteraction(run.threadId, {
        interactionId: approvalId,
        kind: "permission",
        anchorToolCallId: toolCallId,
        payload: { approvalId, toolCallId, toolName: PLAN_TOOL_NAMES.exit, input },
        createdAt: new Date().toISOString(),
      });
      sendEventChunk(
        run.threadId,
        {
          type: "data-toolApproval",
          data: { approvalId, toolCallId, toolName: PLAN_TOOL_NAMES.exit, input },
        },
        run.sessionId,
      );
      const approval = new Promise<boolean>((resolve) => {
        run.pendingToolApprovals.set(approvalId, {
          toolCallId,
          toolName: PLAN_TOOL_NAMES.exit,
          input,
          resolve,
        });
      });
      const entry = run.pendingToolApprovals.get(approvalId)!;
      const approved = await approval;
      if (!approved) {
        const explicit = entry.settledBy === "confirm";
        if (explicit) {
          // 用户点「拒绝并停止」：计划作废——删掉计划文件并重置路径（后续
          // plan_write 会重新定名），等同 Stop 终止本轮。
          // Stop/新 prompt 的清理（clear）不删：只是打断，计划仍是半成品可续改。
          await rm(run.planFilePath, { force: true }).catch(() => {});
          run.planFilePath = undefined;
          run.planTitle = undefined;
          run.agent.abort();
        }
        return textResult(
          explicit
            ? "User rejected the plan. The plan file was discarded. This turn is stopping; the session stays in Plan mode. Do not continue working."
            : "Plan approval was cleared (user stopped or sent a new request). Stay in Plan mode; the plan file is kept for revision.",
          { approved: false },
        );
      }
      applyMode(run, "agent");
      emitPlanningState(run);
      return textResult(
        `User approved the plan. You are back in Agent mode with the full tool set — implement the plan now. Plan file: ${run.planFilePath}`,
        { approved: true, filePath: run.planFilePath },
      );
    },
  };

  return [enterTool, writeTool, exitTool];
}

/* ------------------------------ beforeToolCall ------------------------------ */

/** 需要用户逐次确认的工具（有副作用的写操作）。
 *  子智能体/技能管理工具与 write 同级：save/delete 会改变后续会话可用的
 *  能力面，ask 模式逐次确认，auto-edit 模式与 write 一样豁免（AI 本就能用
 *  write 改这些文件，工具化是收紧而非扩权）。list 无副作用，不进审批。 */
export const APPROVAL_REQUIRED_TOOLS = new Set([
  "bash",
  "write",
  "edit",
  SUBAGENT_MGMT_TOOL_NAMES.save,
  SUBAGENT_MGMT_TOOL_NAMES.delete,
  SKILL_MGMT_TOOL_NAMES.save,
  SKILL_MGMT_TOOL_NAMES.delete,
  PLUGIN_MGMT_TOOL_NAMES.install,
  PLUGIN_MGMT_TOOL_NAMES.scaffold,
]);

/** plan 模式下结构性拦截的副作用工具（计划文件由 plan_write 自己落盘，不走这里、无需审批） */
const PLAN_MODE_MUTATING_TOOLS = new Set(["write", "edit"]);

/** 模式切换工具的批次独占与可用性校验（与参考实现一致） */
export function modeBeforeToolCall(
  run: Running,
  context: BeforeToolCallContext,
): BeforeToolCallResult | undefined {
  const toolCalls = (context.assistantMessage.content as Array<{ type?: string; name?: string }>)
    .filter((b) => b.type === "toolCall");
  const name = context.toolCall.name;
  const isPlanTool = MODE_EXCLUSIVE_TOOL_NAMES.has(name) || PLAN_ONLY_TOOL_NAMES.has(name);
  const exclusiveInBatch = toolCalls.some((b) =>
    MODE_EXCLUSIVE_TOOL_NAMES.has(b.name ?? ""),
  );
  if (exclusiveInBatch && toolCalls.length !== 1) {
    return {
      block: true,
      reason: `${[...MODE_EXCLUSIVE_TOOL_NAMES].join(", ")} must be the only tool call in the assistant message.`,
    };
  }
  // plan 模式只读是结构性保证：不依赖工具表是否新鲜（轮中切换前模型可能还带着
  // 旧 schema），write/edit 一律拦截；计划文件只能经 plan_write 落盘。
  if (run.mode === "plan" && PLAN_MODE_MUTATING_TOOLS.has(name)) {
    return {
      block: true,
      reason:
        "Plan mode cannot modify project files. Save the plan with plan_write (the path is chosen by the system), and implement after plan_exit is approved.",
    };
  }
  // 问答档只读同样是结构性的：工具表里本就不含写类工具，这里是轮中切换前的兜底
  if (run.mode === "ask" && ASK_MODE_MUTATING_TOOLS.has(name)) {
    return {
      block: true,
      reason:
        "Ask mode is read-only and cannot run commands or modify files. Answer the question with the read-only tools; if the request genuinely needs project changes, call ask_needs_work to offer switching to Agent mode.",
    };
  }
  if (name === ASK_NEEDS_WORK_TOOL_NAME && run.mode !== "ask") {
    return {
      block: true,
      reason: `${name} is available only in Ask mode.`,
    };
  }
  if (!isPlanTool) return undefined;
  // 无人值守自动化：plan_exit 的模式级 HITL 会永久挂起，禁止进入 plan 模式，
  // 从结构上让 plan_exit 不可达（agent 直接以当前档位执行）
  if (getAutomationPolicy(run.threadId)) {
    return {
      block: true,
      reason:
        "Unattended automation run: plan mode is unavailable (its HITL approval cannot be answered). Proceed directly under the current tool policy.",
    };
  }
  if (name === PLAN_TOOL_NAMES.enter && run.mode !== "agent") {
    return { block: true, reason: `${name} is available only in Agent mode.` };
  }
  if (PLAN_ONLY_TOOL_NAMES.has(name) && run.mode !== "plan") {
    return { block: true, reason: `${name} is available only in Plan mode.` };
  }
  return undefined;
}

/**
 * 逐工具审批钩子（sessions.ts 注册的最终 beforeToolCall）：
 * 先做模式门控，再按审批级别决定 bash/write/edit 是否等待用户确认——
 * ask = 全部确认；auto-edit = 编辑免确认、bash 仍确认；auto = 全免。
 * 挂起项记入 run.pendingToolApprovals 并经当前请求流推 data-toolApproval
 * chunk，await 到 tool_confirm（批准/拒绝）或清理（abort）后才放行/拦截。
 * plan_exit 的确认是模式级 HITL，不受审批级别影响，在其 execute 内自行挂起。
 */
export async function approvalBeforeToolCall(
  run: Running,
  context: BeforeToolCallContext,
): Promise<BeforeToolCallResult | undefined> {
  // 捕获本轮循环的活上下文：applyMode 据此在轮中热换工具表/系统提示词
  if (context.context) run.loopContext = context.context;
  const gated = modeBeforeToolCall(run, context);
  if (gated) return gated;
  // 无人值守自动化 turn：需审批的工具按档位即时裁决（read-only 全拒 /
  // workspace-write 拒 bash / full 放行），永不挂起等待前端 tool_confirm
  const autoPolicy = getAutomationPolicy(run.threadId);
  if (autoPolicy && APPROVAL_REQUIRED_TOOLS.has(context.toolCall.name)) {
    const allow =
      autoPolicy === "full" ||
      (autoPolicy === "workspace-write" && context.toolCall.name !== "bash");
    return allow
      ? undefined
      : { block: true, reason: automationDenyReason(autoPolicy, context.toolCall.name) };
  }
  if (run.approvalLevel === "auto") return undefined;
  if (!APPROVAL_REQUIRED_TOOLS.has(context.toolCall.name)) return undefined;
  if (run.approvalLevel === "auto-edit" && context.toolCall.name !== "bash") {
    return undefined;
  }

  // Claude Code 式 PermissionRequest 钩子：即将向用户弹审批，先给外部命令
  // 一次自动裁决机会（block → 拒绝并把 reason 回给模型；approve → 放行不弹窗）
  const hookDecision = await runHooks(
    "PermissionRequest",
    buildHookPayload({
      event: "PermissionRequest",
      sessionId: run.sessionId,
      threadId: run.threadId,
      toolName: context.toolCall.name,
      toolArgs: context.args,
    }),
  );
  if (hookDecision?.decision === "block") {
    return { block: true, reason: hookDecision.reason ?? "Denied by hook" };
  }
  if (hookDecision?.decision === "approve") return undefined;

  const approvalId = randomUUID();
  // 挂起交互登记落行 + 发起帧水印（同 plan_exit 审批，§3/§4）
  beginInteraction(run.threadId, {
    interactionId: approvalId,
    kind: "permission",
    anchorToolCallId: context.toolCall.id,
    payload: {
      approvalId,
      toolCallId: context.toolCall.id,
      toolName: context.toolCall.name,
      input: context.args ?? null,
    },
    createdAt: new Date().toISOString(),
  });
  sendEventChunk(
    run.threadId,
    {
      type: "data-toolApproval",
      data: {
        approvalId,
        toolCallId: context.toolCall.id,
        toolName: context.toolCall.name,
        input: context.args ?? null,
      },
    },
    run.sessionId,
  );
  const approved = await new Promise<boolean>((resolve) => {
    run.pendingToolApprovals.set(approvalId, {
      toolCallId: context.toolCall.id,
      toolName: context.toolCall.name,
      input: context.args ?? null,
      resolve,
    });
  });
  if (!approved) {
    return {
      block: true,
      reason: "User rejected this tool call. Ask how to proceed or adjust the approach.",
    };
  }
  return undefined;
}

/** 结算一条挂起审批（protocol 的 tool_confirm 调用）；返回是否存在 */
export function resolveToolApproval(run: Running, approvalId: string, approved: boolean): boolean {
  const pending = run.pendingToolApprovals.get(approvalId);
  if (!pending) return false;
  run.pendingToolApprovals.delete(approvalId);
  settleInteraction(approvalId, approved ? "approved" : "denied");
  pending.settledBy = "confirm";
  pending.resolve(approved);
  return true;
}

/** 清理全部挂起审批（按拒绝结算）：用户 Stop / 新 prompt 前的兜底（含 plan_exit） */
export function clearPendingToolApprovals(run: Running): void {
  for (const [approvalId, pending] of run.pendingToolApprovals) {
    settleInteraction(approvalId, "cancelled");
    pending.settledBy = "clear";
    pending.resolve(false);
  }
  run.pendingToolApprovals.clear();
}

/* ------------------------------ 模式切换与状态推送 ------------------------------ */

/**
 * 模式偏好落库（applyMode 末尾调用，覆盖 set_mode / plan_enter / plan_exit
 * 批准全部切换路径）：写会话偏好行 + kv「最近一次使用」（新会话初始模式取这份）。
 * 同步函数内 fire-and-forget：落库失败不影响模式切换本身。
 */
function persistModePrefs(run: Running): void {
  const prefs = { mode: run.mode, approvalLevel: run.approvalLevel };
  void sessionPrefsSet(run.sessionId, prefs).catch(() => {});
  void kvSet("pi.mode", JSON.stringify(prefs)).catch(() => {});
}

/** 计划状态只属于 plan 档：agent 与 ask 都是 inactive。写成显式映射而不是
 *  `mode === "agent" ? ...`，否则新增的第三档会静默继承 planning 态、被前端
 *  渲染成"正在计划"（枚举扩容最典型的塌陷点） */
const PLANNING_BY_MODE: Record<SessionMode, PlanningState> = {
  agent: "inactive",
  plan: "planning",
  ask: "inactive",
};

/** 切换模式：热替换 systemPrompt/tools 并推进计划状态（plan_write 的计划文件路径跨切换保留） */
export function applyMode(run: Running, mode: SessionMode): void {
  run.mode = mode;
  run.planning = PLANNING_BY_MODE[mode];
  const prompt = composeModeSystemPrompt(mode, run.cwd, run.agent.state.model, run.designTheme);
  const tools = toolsForMode(run);
  run.agent.state.systemPrompt = prompt;
  run.agent.state.tools = tools;
  // 轮中切换（plan_enter / plan_exit 批准）：循环每次请求都从上下文快照读
  // tools/systemPrompt，把 beforeToolCall 捕获的活上下文一并改写，
  // 本轮下一次请求即用新模式工具表，不必等下一次 prompt。
  if (run.loopContext) {
    run.loopContext.systemPrompt = prompt;
    run.loopContext.tools = tools;
  }
  persistModePrefs(run);
}

/** 当前模式状态的对外快照（响应/chunk 共用） */
export function planningPayload(run: Running): {
  mode: SessionMode;
  approvalLevel: ApprovalLevel;
  planning: PlanningState;
} {
  return {
    mode: run.mode,
    approvalLevel: run.approvalLevel,
    planning: run.planning,
  };
}

/** 经当前活跃请求流把模式状态推给前端（data-planningState chunk）；无活跃请求时丢弃 */
export function emitPlanningState(run: Running): void {
  // 带事件水印（设计文档 §3）：缺口回拉 get_planning_state
  sendEventChunk(
    run.threadId,
    { type: "data-planningState", data: planningPayload(run) },
    run.sessionId,
  );
}
