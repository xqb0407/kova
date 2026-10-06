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
import { fileTimestamp, sanitizeFileName } from "./artifact-naming";
import { kvSet, sessionPrefsSet } from "../storage/hostdb";
import { beginInteraction, settleInteraction } from "../sessions/pending-interactions";
import { SUBAGENT_MGMT_TOOL_NAMES } from "../subagent/subagent-mgmt-tools";
import { SKILL_MGMT_TOOL_NAMES } from "../skills/skill-mgmt-tools";
import { DESIGN_THEME_MGMT_TOOL_NAMES } from "../design-md/mgmt-tools";
import { SKILL_USE_TOOL_NAME } from "../skills/skill-use-tool";
import { PLUGIN_MGMT_TOOL_NAMES } from "../plugins/plugin-mgmt-tools";
import { getAutomationPolicy, automationDenyReason } from "../automation/policy";
import {
  isPathBearingWrite,
  writeTargetInsideWorkspace,
  writeTargetPath,
} from "./workspace-boundary";
import {
  commandMatchesRules,
  displayRoot,
  isWriteRootAllowed,
  loadWriteRoots,
  matchingWriteRoot,
  rememberCommand,
  rememberWriteRoot,
} from "../permissions/write-roots";
import { setLeadingSystemMessage } from "./context";
import { logErr } from "../log";
import { buildHookPayload, runHooks } from "./hooks";
import { personalizationPromptBlock } from "./personalization";
import { appModePromptBlock, type AppMode } from "./app-mode";
import type { ThemeRef } from "../design-md/store";
import { memoryPromptBlock } from "./memory";
import { mcpPromptBlock } from "../mcp/mcp-tools";
import { skillsPromptBlock } from "../skills/skills";
import { instructionsPromptBlock } from "./instructions";
import { sendEventChunk } from "../protocol/stream";
import { displayPath } from "../tools/open-file-tool";
import {
  GOAL_TOOL_NAMES,
  isContractUnsettled,
  isGoalToolName,
  type Goal,
} from "../goal/goal-state";
import { buildGoalTools, getGoal, markGoalWorkSeen, pauseGoalOnModeExit } from "../goal/goal";
import { GOAL_MODE_PROMPT, goalPromptBlock } from "../goal/prompt";
import { isWorkflowToolName, WORKFLOW_TOOL_NAMES } from "../workflow/plan-state";
import { buildWorkflowTools } from "../workflow/tools";
import { pauseWorkflowOnModeExit } from "../workflow/workflow";
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

/** 四档字面量的宽松规整:库里的偏好值、协议消息、投影行都经这里收口。
 *  加枚举值时只改这一处——散落各处的 `x === "a" || x === "b"` 白名单是这类
 *  改动最典型的静默漏改点(新值不报错,只是被悄悄丢成旧档) */
export function normalizeSessionMode(raw: unknown): SessionMode {
  return raw === "plan" || raw === "ask" || raw === "goal" || raw === "workflow" ? raw : "agent";
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
  GOAL_TOOL_NAMES.propose,
  GOAL_TOOL_NAMES.complete,
  GOAL_TOOL_NAMES.blocked,
  WORKFLOW_TOOL_NAMES.propose,
  WORKFLOW_TOOL_NAMES.runPlaybook,
]);

/** 仅 plan 模式可用的工具 */
const PLAN_ONLY_TOOL_NAMES = new Set<string>([
  PLAN_TOOL_NAMES.write,
  PLAN_TOOL_NAMES.exit,
]);

/** 仅 goal 模式可用的出口工具（见 goal/goal.ts） */
const GOAL_ONLY_TOOL_NAMES = new Set<string>([
  GOAL_TOOL_NAMES.propose,
  GOAL_TOOL_NAMES.complete,
  GOAL_TOOL_NAMES.blocked,
]);

/**
 * 目标协商阶段的只读边界：验收标准还没定下来时，这一轮的产出是契约不是代码。
 *
 * 只拦 write/edit 而不拦 bash，与 plan 档同一取舍：「测试跑不跑得起来」这类判断
 * 正是拟定可验证标准的前提，把 bash 一并封掉会让模型只能提出没法验证的标准。
 */
const GOAL_NEGOTIATION_MUTATING_TOOLS = new Set(["write", "edit"]);

/**
 * 不进「这条目标动过手」台账的工具：它们不改变工作区的任何状态，因此不能作为
 * goal_complete 完成声明的依据。Question 是唯一一个——模型问完用户什么也没做，
 * 下一轮照样得真干活才能标完成。
 */
const GOAL_WORK_EXEMPT_TOOLS = new Set(["Question"]);

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

/** 工作流档结构性拦截：只拦写类（plan 档同款取舍——bash 用于勘察，靠提示词约束用途） */
const WORKFLOW_MODE_MUTATING_TOOLS = new Set(["write", "edit"]);

/* ------------------------------- 系统提示词 ------------------------------- */

const PLAN_MODE_PROMPT = [
  "You are operating in Plan mode. The deliverable of this mode is the session plan file, not a chat answer: research with the read-only tools, then call plan_write with the complete implementation plan in Markdown (written in the user's language), then call plan_exit to request approval.",
  "Project files cannot be modified in Plan mode — write/edit are blocked by the system, and plan_write stores the plan at a system-chosen path (you never pass a file path).",
  "If the user approves plan_exit, you are back in Agent mode — start implementing immediately. If rejected, this turn stops.",
].join("\n");

const AGENT_MODE_PROMPT =
  "You are operating in Agent mode: carry out the requested work with the available tools and report the result clearly. When a task is large or ambiguous, enter Plan mode via plan_enter to research and draft an implementation plan; the plan needs user approval via plan_exit before you implement.";
export { AGENT_MODE_PROMPT };

/**
 * 工作流模式的系统提示词:编排器只拟剧本,不干活。
 *
 * 提示词刻意只讲「怎么拟一份好剧本」:步骤切分、谁上、结果怎么流——不教它委派
 * 细节(那是 Task 组的事,这档根本没有 Task)也不讲执行纪律(执行是执行器的事)。
 * 提案被驳回时,驳回意见出现在 proposalFeedback 相关的提案结果文本里,模型据此重提。
 */
const WORKFLOW_MODE_PROMPT = [
  "You are operating in Workflow mode: your only deliverable is a workflow PLAN the runtime executes — you never do the work yourself, and you cannot see step results.",
  "First inspect the workspace with the read-only tools (read/glob/grep, ls/git via bash) if the request depends on facts you do not have; call subagents_list when you need to know which subagent definitions exist. Then call workflow_propose_plan with the complete plan.",
  "Step kinds: delegate runs one subagent on a self-contained brief (add foreach.from to run it once per line of an upstream result, with {{item}} in the prompt); gate runs a literal shell command and branches on its exit code — reach for it wherever a command can decide, and never build the command from a variable; verify puts an upstream result in front of adversarial reviewers; the single synthesize step weaves upstream results ({{step-key}} references) into the final report.",
  "Steps with no dependsOn between them run concurrently — add dependencies only for real data flow. A step that may fail without dooming the run can set onFail:\"skip\".",
  "Write {{args.name}} placeholders for values that should change when this plan is re-run (a month range, an output dir, a threshold). Saving the run as a playbook turns every placeholder into a parameter the user can set — concrete values you bake in stay baked in.",
  "When a saved playbook already fits the request (workflow_run_playbook lists them with their parameters and when-to-use), run it by name instead of re-planning. To build a bigger plan out of saved playbooks, use kind:\"playbook\" steps (use.playbook) — they are inlined into your plan at proposal time.",
  "Write titles, phases and step prompts in the user's language.",
  "A request to design/plan/orchestrate a workflow — including 「帮我设计一个工作流」, a pre-filled design instruction, or any decomposable job — MEANS: call workflow_propose_plan. The plan card is the design the user reviews; never deliver the plan as a prose answer or a design document, and never stop to ask about ambiguity first — propose your best interpretation and let the user correct it by rejecting the card with feedback. Only genuine questions and chit-chat (what can you do, explain X) get a direct answer.",
  "A playbook is not a scheduled task: cron/定时任务 belongs to the automation feature; this mode's deliverable is the workflow plan card.",
  "After workflow_propose_plan is accepted you must stop: the user confirms the plan (including every gate command), then the runtime executes it and delivers the report. If the user rejects or comments, revise and propose again.",
].join("\n");

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
 * 工作模式段随会话生效档（composeModeSystemPrompt 的 appMode 入参 = run.appMode，
 * 会话级偏好列 ?? 全局默认，见 app-mode.ts；code 档为空串；design 段随会话选中的
 * 设计主题增减一行主题句，正文由 use_design_theme 按需加载），
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
  appMode: AppMode,
  model?: PromptModelInfo | null,
  designTheme?: ThemeRef | null,
  goal?: Goal | null,
): string {
  // 问答档换掉静态核心的取段（剔任务追踪与子代理），其余模式沿用全量核心——
  // 全量拼接与拆分前逐字节相同，缓存不变式不受影响
  const core = mode === "ask" ? systemPromptCore(ASK_CORE_SEGMENTS) : SYSTEM_PROMPT_CORE;
  const extra =
    mode === "plan"
      ? PLAN_MODE_PROMPT
      : mode === "ask"
        ? ASK_MODE_PROMPT
        : mode === "goal"
          ? GOAL_MODE_PROMPT
          : mode === "workflow"
            ? WORKFLOW_MODE_PROMPT
            : AGENT_MODE_PROMPT;
  return [
    core,
    extra,
    // 目标块紧贴模式段：它是「当前这一轮为什么要接着干」的动态盘面，跟在模式身份
    // 后面比塞到尾部更贴近模型对该段的归属感。目标文本本身是用户输入，进系统
    // 提示词意味着它与指令同级——见 prompt.ts 的信任边界说明。
    //
    // 纪律：**系统头必须跨轮字节稳定**（服务端前缀缓存以系统消息为界，动一个字节
    // 整段对话缓存全废——goal 档曾把每轮 +1 的轮次计数放进来，实测 439/442 个请求
    // cacheRead=0）。任何每轮会变的字段（计数、时间、进度）一律走尾部注入。
    mode === "goal" ? goalPromptBlock(goal ?? null) : "",
    personalizationPromptBlock(),
    appModePromptBlock(appMode, designTheme),
    memoryPromptBlock(cwd),
    mcpPromptBlock(cwd),
    skillsPromptBlock(cwd),
    instructionsPromptBlock(cwd),
    environmentPromptBlock(cwd, model),
  ]
    .filter(Boolean)
    .join("\n\n");
}

/**
 * 按 run 重排系统提示词的统一入口。存在的理由是目标块：composeModeSystemPrompt
 * 需要目标盘面入参，若各调用点各写一遍，早晚有一处（换模型、改记忆、设置项热替换
 * ……）忘了传，症状是「目标还在跑但模型突然不知道自己在干什么」——提示词静默少一段，
 * 不报错、只降级。所有基于 run 的重排走这里，漏传就编译不过。
 *
 * model 刻意保持「不传即不写模型段」的既有语义：调用点原本只有换模型那条显式传入
 * 模型信息，其余各处省略；这里不做 run.agent.state.model 的兜底，否则会在
 * 重排时把模型信息塞进原本为空的尾段，改变提示词字节、打破缓存前缀不变式。
 */
export function composeRunPrompt(run: Running, model?: PromptModelInfo | null): string {
  return composeModeSystemPrompt(
    run.mode,
    run.cwd,
    run.appMode,
    model,
    run.designTheme,
    run.mode === "goal" ? getGoal(run.threadId) : undefined,
  );
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
 *  ask = 纯只读子集（无 bash）+ 出口工具，不带 plan 三件套与子代理组；
 *  goal = 基础全集 + Task 组 + 按契约阶段给的出口工具，不带 plan 三件套；
 *  workflow = 只读勘察子集 + 按协商阶段给的提案工具（编排器不干活,活是执行器的） */
export function toolsForMode(run: Running): AgentTool[] {
  if (run.mode === "ask") {
    return [
      ...run.baseTools.filter((t) => ASK_TOOL_NAMES.has(t.name)),
      ...buildAskTools(run),
    ];
  }
  if (run.mode === "workflow") {
    return [
      ...run.baseTools.filter((t) => CONTRACT_TOOL_NAMES.has(t.name)),
      // 编排器写 delegate 步骤前要能查到子代理定义名:只放只读的 list
      // (save/delete 是配置变更,不进口)
      ...run.subagentTools.filter((t) => t.name === SUBAGENT_MGMT_TOOL_NAMES.list),
      ...buildWorkflowTools(run),
    ];
  }
  // 目标档拿完整工具集（含 write/edit/bash），不含 plan 三件套：目标模式的价值是
  // 「放手做完」，给它只读工具就退化成 plan 了。出口工具挂在工具表上而不是临到收尾
  // 才动态插——模式切换本就是整表重建的既有路径，不必为它另立一套 schema 抖动面。
  //
  // 契约阶段是例外：验收标准没定下来时这一轮只读（buildGoalTools 只给 propose），
  // 写类工具由 modeBeforeToolCall 另外拦一道——工具表是快照，轮中变档时模型手里
  // 可能还带着旧 schema
  if (run.mode === "goal") {
    return [...run.baseTools, ...run.subagentTools, ...buildGoalTools(run)];
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

/**
 * 目标契约阶段变化后重建工具表（建目标 / 提议 / 确认 / 驳回 / 跳过之后）。
 *
 * 存在的理由：`run.agent.state.tools` 只在会话物化、rebind 与几个设置项 reload
 * 时重建，`dispatchPrompt` 全程不碰它。而「用户第一句话就是目标」这条路径是在
 * dispatch 过程里建目标的——不在这里补一次，协商轮拿到的仍是上一阶段的表，
 * goal_propose_criteria 根本不在里面（模型只能空转到协商计数耗尽）。
 *
 * 与 reloadMemoryTools 同款：state 与 loopContext 一起换，轮中经 loopContext
 * 立即生效。非 goal 档直接返回——工具表不由契约阶段决定。
 */
export function refreshGoalToolset(run: Running): void {
  if (run.mode !== "goal") return;
  const tools = toolsForMode(run);
  run.agent.state.tools = tools;
  if (run.loopContext) run.loopContext.tools = tools;
}

/**
 * 工作流协商阶段变化后重建工具表(syncWorkflowOnUserPrompt 建「编排中」运行之后
 * 调用,理由与 refreshGoalToolset 全同:这条路径在 dispatch 过程里建运行,
 * 不补这次,提案轮拿到的表里根本没有 workflow_propose_plan)。
 */
export function refreshWorkflowToolset(run: Running): void {
  if (run.mode !== "workflow") return;
  const tools = toolsForMode(run);
  run.agent.state.tools = tools;
  if (run.loopContext) run.loopContext.tools = tools;
}

function textResult(text: string, details?: unknown) {
  return { content: [{ type: "text" as const, text }], details };
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
 *
 * 命名函数（sanitizeFileName / fileTimestamp）落在 artifact-naming.ts：
 * 目标产物要用它们，而从本文件导出会绕成 modes → goal → goal-artifact → modes 的环。
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

/**
 * 把计划文件推到用户眼前的右侧面板：复用 open_file 的 data-panelOpen 帧，
 * 「文件」标签走磁盘实时读取（同文件树点击）。计划写完与申请审批两处都发，
 * 保证 plan_exit 挂起等待时用户已能看到计划原文。
 */
function emitPlanPanelOpen(run: Running): void {
  if (!run.planFilePath) return;
  sendEventChunk(
    run.threadId,
    {
      type: "data-panelOpen",
      data: { type: "file", path: displayPath(run.cwd, run.planFilePath), cwd: run.cwd },
    },
    run.sessionId,
  );
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
      // 写完即开面板：用户无需手动点行查看计划（修订覆盖后同样重开/刷新）
      emitPlanPanelOpen(run);
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
      // 申请审批：先确保面板展示计划原文，再弹审批卡（用户看后决定）
      emitPlanPanelOpen(run);
      sendEventChunk(
        run.threadId,
        {
          type: "data-toolApproval",
          data: { approvalId, toolCallId, toolName: PLAN_TOOL_NAMES.exit, input },
        },
        run.sessionId,
      );
      // plan_exit 没有「记住」可言（计划审批不是路径授权），第三个按钮不出现在这张卡上
      const approval = new Promise<{ approved: boolean }>((resolve) => {
        run.pendingToolApprovals.set(approvalId, {
          toolCallId,
          toolName: PLAN_TOOL_NAMES.exit,
          input,
          resolve,
        });
      });
      const entry = run.pendingToolApprovals.get(approvalId)!;
      const { approved } = await approval;
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
 *  子智能体/技能/设计主题管理工具与 write 同级：save/delete 会改变后续会话可用的
 *  能力面（主题还会热换活动会话的提示词），ask 模式逐次确认，auto-edit 模式与 write
 *  一样豁免（AI 本就能用 write 改这些文件，工具化是收紧而非扩权）。list 无副作用，
 *  不进审批。 */
export const APPROVAL_REQUIRED_TOOLS = new Set([
  "bash",
  "write",
  "edit",
  SUBAGENT_MGMT_TOOL_NAMES.save,
  SUBAGENT_MGMT_TOOL_NAMES.delete,
  SKILL_MGMT_TOOL_NAMES.save,
  SKILL_MGMT_TOOL_NAMES.delete,
  DESIGN_THEME_MGMT_TOOL_NAMES.save,
  DESIGN_THEME_MGMT_TOOL_NAMES.delete,
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
  const isPlanTool =
    MODE_EXCLUSIVE_TOOL_NAMES.has(name) || PLAN_ONLY_TOOL_NAMES.has(name);
  const isGoalTool = GOAL_ONLY_TOOL_NAMES.has(name);
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
  // 工作流档的编排器只拟剧本不干活:工具表里没有写类工具,这里是轮中切换前的兜底。
  // bash 放行(勘察同 plan 档——模型需要 ls/git status 这类只读命令来摸清现状,
  // 实机反馈里"查子代理定义"这一步就是靠它),write/edit 结构性拦
  if (run.mode === "workflow" && WORKFLOW_MODE_MUTATING_TOOLS.has(name)) {
    return {
      block: true,
      reason:
        "Workflow mode plans the work; it does not perform it. Inspect with read-only tools, then call workflow_propose_plan — the runtime executes the confirmed plan.",
    };
  }
  // 目标契约还没落定（协商中 / 已提议等用户确认）：这一轮只读。与 plan/ask 同款
  // 结构性保证，不依赖工具表或提示词是否新鲜。只在**目标已存在**时生效——goal 档下
  // 空白消息不建目标（syncGoalOnUserPrompt 跳过），那一轮是普通请求，不该被这条拦住
  //
  // 判据必须覆盖 proposed：模型可以在同一轮里先提交标准（独占批次）再继续用后续
  // 批次动手——只拦 pending 的话，「等用户确认期间不改文件」就只是提示词里的一句话
  const goal = run.mode === "goal" ? getGoal(run.threadId) : undefined;
  if (goal && GOAL_NEGOTIATION_MUTATING_TOOLS.has(name) && isContractUnsettled(goal.acceptance)) {
    return {
      block: true,
      reason:
        "The acceptance criteria for this goal are not settled yet, so this turn is read-only. " +
        "Inspect the workspace, then call goal_propose_criteria with the criteria that define done. " +
        "Implementation starts only after the user confirms them.",
    };
  }
  if (name === ASK_NEEDS_WORK_TOOL_NAME && run.mode !== "ask") {
    return {
      block: true,
      reason: `${name} is available only in Ask mode.`,
    };
  }
  // 工作流提案工具的档位校验:轮中切档时模型可能还带着 workflow 档的旧 schema
  if (isWorkflowToolName(name) && run.mode !== "workflow") {
    return {
      block: true,
      reason: `${name} is available only in Workflow mode.`,
    };
  }
  // 目标出口工具的档位校验：轮中切档时模型可能还带着 goal 档的旧 schema，
  // agent 档收到 goal_complete 不能当作完成（那轮的语义根本不是目标循环）
  if (isGoalTool && run.mode !== "goal") {
    return {
      block: true,
      reason: `${name} is available only in Goal mode.`,
    };
  }
  if (!isPlanTool && !isGoalTool) return undefined;
  // 无人值守自动化：plan_exit 的模式级 HITL 会永久挂起，禁止进入 plan 模式，
  // 从结构上让 plan_exit 不可达（agent 直接以当前档位执行）。
  // 工作流同理:提案后的确认卡片没人点,proposed 会永远挂着——一并挡掉
  if (getAutomationPolicy(run.threadId)) {
    return {
      block: true,
      reason: isGoalTool
        ? "Unattended automation run: goal mode is unavailable (its autonomous loop keeps spending tokens with nobody there to stop it). Finish the work directly under the current tool policy."
        : "Unattended automation run: plan mode is unavailable (its HITL approval cannot be answered). Proceed directly under the current tool policy.",
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
 * ask = 全部确认；workspace-write = 工作区内的 write/edit 免确认、其余确认；
 * auto-edit = 编辑免确认、bash 仍确认；auto = 全免。
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
  /** 本次审批若点了「允许并记住」，要写进本机清单的那条根 */
  let rememberRoot: string | undefined;
  /** 同上，但记的是 bash 的整条命令（逐字相等） */
  let rememberCmd: string | undefined;
  /** 项目层声明、且覆盖本次目标的根（只用于卡上那句说明，不参与任何判定） */
  let declaredRoot: string | undefined;
  const gated = modeBeforeToolCall(run, context);
  if (gated) return gated;
  // 模式门控放行之后才记账：被拦下的调用不算「动过手」。目标模式的这条台账是
  // goal_complete 完成声明的前提（见 goal/goal.ts 的对账硬门）——没有它，模型
  // 可以只靠一段总结就把目标标成完成，而全程没有任何可验证的动作。
  //
  // 问询类工具不算：Question 只是把问题抛回给用户，它本身不产生任何可被验收
  // 标准核对的状态，把它记成「干过活」等于给纯提问的轮次发一张完成许可证
  if (run.mode === "goal" && !isGoalToolName(context.toolCall.name) && !GOAL_WORK_EXEMPT_TOOLS.has(context.toolCall.name)) {
    markGoalWorkSeen(run);
  }
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
  // workspace-write：工作区内 + 清单内的 write/edit 免确认。
  // 判不了就是不放行——bash 与配置类工具在这里一律落到下面的挂起审批
  if (run.approvalLevel === "workspace-write" && isPathBearingWrite(context.toolCall.name)) {
    if (writeTargetInsideWorkspace(context.toolCall.name, context.args, run.cwd)) {
      return undefined;
    }
    const target = writeTargetPath(context.toolCall.name, context.args, run.cwd);
    if (target) {
      const roots = await loadWriteRoots(run.cwd);
      if (isWriteRootAllowed(target, roots.effective)) return undefined;
      // 「允许并记住」要记哪条根：目标落在项目声明的根里就记那一条（正是该项目
      // 请求的、也够宽），否则记目标文件所在目录（与用户看到的写入路径一致）
      declaredRoot = matchingWriteRoot(target, roots.declared);
      rememberRoot = declaredRoot ?? dirname(target);
    }
  }
  // bash：参数里判不出写目标，只能用「记住命令前缀」这一条路（与 Claude Code 的
  // `Bash(pnpm add *)` 同形态）。命中即免确认；没命中照常问，卡上给「允许并记住这条命令」。
  // 前缀的安全性靠 commandMatchesRules 里的逐段校验 + 反重定向/命令替换守卫兜住
  if (
    run.approvalLevel === "workspace-write" &&
    context.toolCall.name === "bash" &&
    typeof (context.args as { command?: unknown })?.command === "string"
  ) {
    const command = String((context.args as { command?: unknown }).command).trim();
    if (command) {
      const { commands } = await loadWriteRoots(run.cwd);
      if (commandMatchesRules(command, commands)) return undefined;
      rememberCmd = command;
    }
  }
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
  // 说明只讲「项目请求了什么」；记不记由用户按哪个按钮决定
  const note = declaredRoot
    ? `这个项目在 .kova/permissions.json 里请求放行 ${displayRoot(declaredRoot, run.cwd)}；点「允许并记住」会把它写进你的 .kova/permissions.local.json`
    : // bash 在 workspace-write 档下每次都问，而卡上没有「允许并记住」（无法判断它写到哪）。
    // 不解释的话用户只会觉得"点了也没记住"——这行就是回答那个疑问的
      run.approvalLevel === "workspace-write" && context.toolCall.name === "bash"
      ? "命令写到哪判不出来，所以这一档下每条命令都要确认。点「允许并记住这类命令」记下命令词前缀（如 pnpm add *），换参数也命中；带重定向或命令替换的仍会问。"
      : undefined;
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
      ...(note ? { note } : {}),
      ...(rememberRoot || rememberCmd ? { canRemember: true } : {}),
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
        ...(note ? { note } : {}),
        ...(rememberRoot || rememberCmd ? { canRemember: true } : {}),
      },
    },
    run.sessionId,
  );
  // 三个按钮：拒绝 / 允许 / 允许并记住。前两者只影响这一次，第三个才会落清单
  const { approved, remember } = await new Promise<{
    approved: boolean;
    remember: boolean;
  }>((resolve) => {
    run.pendingToolApprovals.set(approvalId, {
      toolCallId: context.toolCall.id,
      toolName: context.toolCall.name,
      input: context.args ?? null,
      resolve,
      ...(rememberRoot ? { rememberRoot, cwd: run.cwd } : {}),
      ...(rememberCmd ? { rememberCommand: rememberCmd, cwd: run.cwd } : {}),
    });
  });
  if (!approved) {
    return {
      block: true,
      reason: "User rejected this tool call. Ask how to proceed or adjust the approach.",
    };
  }
  // 记在「同意之后」：拒绝或单纯允许都不该在盘上留下任何东西。
  // 落盘失败**不能让这次调用失败**——用户批准的是"执行"，记住只是附带的账；
  // 因为记不上而拦住执行是本末倒置（而且卡片已经消失，用户只会看到工具莫名报错）。
  // 所以这里吞掉异常并记日志：症状退化为"下次还会问"，日志里有原因
  try {
    if (remember && rememberRoot) await rememberWriteRoot(run.cwd, rememberRoot);
    if (remember && rememberCmd) await rememberCommand(run.cwd, rememberCmd);
  } catch (err) {
    logErr("permissions: failed to remember the approved rule:", err);
  }
  return undefined;
}

/**
 * 结算一条挂起审批（protocol 的 tool_confirm 调用）；返回是否存在。
 * remember = 用户点的是「允许并记住」（只对带可写根上下文的审批有意义）。
 */
export function resolveToolApproval(
  run: Running,
  approvalId: string,
  approved: boolean,
  remember = false,
): boolean {
  const pending = run.pendingToolApprovals.get(approvalId);
  if (!pending) return false;
  run.pendingToolApprovals.delete(approvalId);
  settleInteraction(approvalId, approved ? "approved" : "denied");
  pending.settledBy = "confirm";
  pending.resolve({ approved, remember: approved && remember });
  return true;
}

/** 清理全部挂起审批（按拒绝结算）：用户 Stop / 新 prompt 前的兜底（含 plan_exit） */
export function clearPendingToolApprovals(run: Running): void {
  for (const [approvalId, pending] of run.pendingToolApprovals) {
    settleInteraction(approvalId, "cancelled");
    pending.settledBy = "clear";
    pending.resolve({ approved: false, remember: false });
  }
  run.pendingToolApprovals.clear();
}

/* ------------------------------ 模式切换与状态推送 ------------------------------ */

/**
 * 模式偏好落库（applyMode 末尾调用，覆盖 set_mode / plan_enter / plan_exit
 * 批准全部切换路径）：写会话偏好行 + kv「最近一次使用」（新会话初始模式取这份）。
 * 同步函数内 fire-and-forget：落库失败不影响模式切换本身。
 *
 * 导出给目标验收标准确认那条路径复用（确认契约时一并改这条目标的权限档）：
 * 偏好只有这一个写入口，多开一条早晚漂。
 */
export function persistModePrefs(run: Running): void {
  const prefs = { mode: run.mode, approvalLevel: run.approvalLevel };
  // 落库失败必须留痕：这份偏好是"重新物化 run 时读回哪一档"的唯一依据，写不进去
  // 就意味着「用户切了完全访问、下次重建却回到旧档」——而 .catch(() => {}) 让这种
  // 症状看起来像"模式自己变了"，无从排查
  void sessionPrefsSet(run.sessionId, prefs).catch((err) => {
    logErr(`mode prefs persist failed (session=${run.sessionId}):`, err);
  });
  void kvSet("pi.mode", JSON.stringify(prefs)).catch((err) => {
    logErr("mode prefs kv persist failed:", err);
  });
}

/** 计划状态只属于 plan 档：其余各档都是 inactive。写成显式映射而不是
 *  `mode === "agent" ? ...`，否则新增档会静默继承 planning 态、被前端
 *  渲染成"正在计划"（枚举扩容最典型的塌陷点） */
const PLANNING_BY_MODE: Record<SessionMode, PlanningState> = {
  agent: "inactive",
  plan: "planning",
  ask: "inactive",
  goal: "inactive",
  workflow: "inactive",
};

/**
 * 切换模式：热替换 systemPrompt/tools 并推进计划状态（plan_write 的计划文件路径跨切换保留）。
 *
 * 离开 goal 档时顺手暂停目标：自治循环的续跑判定被 run.mode === "goal" 门着
 * （stream.ts 的 turn_end 分支），切走之后循环既不会续、也走不到任何兜底停机逻辑，
 * 目标会永远挂在 active 上——条上写着「进行中」，实际没有任何东西在跑。放在这里
 * 而不是 set_mode handler，理由同 composeRunPrompt：模式变更的单一收口点，
 * 将来多一条改模式的路径也不会漏。
 */
export function applyMode(run: Running, mode: SessionMode): void {
  if (run.mode === "goal" && mode !== "goal") pauseGoalOnModeExit(run);
  if (run.mode === "workflow" && mode !== "workflow") pauseWorkflowOnModeExit(run);
  run.mode = mode;
  run.planning = PLANNING_BY_MODE[mode];
  const prompt = composeRunPrompt(run);
  const tools = toolsForMode(run);
  // 0.99 迁移：state.systemPrompt 只读（转录首条 system 消息的回放），热换走
  // setLeadingSystemMessage；loopContext 亦无 systemPrompt 字段，改其 messages 首条
  setLeadingSystemMessage(run.agent.state.messages, prompt);
  run.agent.state.tools = tools;
  // 轮中切换（plan_enter / plan_exit 批准）：循环每次请求都从上下文快照读
  // tools/systemPrompt，把 beforeToolCall 捕获的活上下文一并改写，
  // 本轮下一次请求即用新模式工具表，不必等下一次 prompt。
  if (run.loopContext) {
    setLeadingSystemMessage(run.loopContext.messages, prompt);
    run.loopContext.tools = tools;
  }
  persistModePrefs(run);
}

/**
 * 把档位扶正到 goal——「让这条目标继续跑」这个动作的前提。
 *
 * 目标只能在 goal 档跑：续跑判定被 `run.mode === "goal"` 门着（stream.ts 的 turn_end
 * 分支），工具表与系统提示词也由档位决定。所以任何「继续这条目标」的入口都得先保证
 * 档位对——否则补起的那一轮是个**没有目标工具**的普通对话，跑完不会有任何东西再续，
 * 而条上写着「进行中」：明明有 active 目标却没人驱动它，是这套机制里最难查的一类谎报
 * （没有异常、没有报错，只有一条永远不动的呼吸绿点）。
 *
 * 走到这里的都是用户明确要求「继续这个目标」的动作（常驻条的继续、确认标准、
 * 驳回重谈、改目标），所以扶正档位是他们要的，不是替他做主。
 *
 * @returns 是否发生了档位切换——调用方据此通知对端刷新模式胶囊
 *          （applyMode 自己只推 data-planningState，那条帧需要活跃请求才送得出去）
 */
export function ensureGoalMode(run: Running): boolean {
  if (run.mode === "goal") return false;
  applyMode(run, "goal");
  return true;
}

/**
 * 把档位扶正到 workflow——「确认/恢复这条运行」动作的前提,与 ensureGoalMode 同款
 * 理由:运行的状态机由 run.mode === "workflow" 门着,档位不对的确认轮是普通对话。
 */
export function ensureWorkflowMode(run: Running): boolean {
  if (run.mode === "workflow") return false;
  applyMode(run, "workflow");
  return true;
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
