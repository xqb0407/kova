"use client";

/**
 * 输入框的 `/` 指令与 `:chip[...]{...}` 指令芯片（移动端版，语义对齐桌面
 * apps/desktop/components/agent-thread/composer-commands.ts）：
 *
 * 桌面端把芯片渲染成输入框里的内联小胶囊（CodeMirror Decoration），文档里存的
 * 是序列化文本 `:type[label]{name=id}`；移动端输入框是原生 TextInput，没有内联
 * 装饰，所以插入的是**同一份序列化文本**（sidecar / 模型两边解析口径完全一致），
 * 芯片外观由输入框上方的芯片行承担——排成一行小胶囊，点 × 把该段文本从草稿里
 * 摘掉。视觉不同，行为与线上格式同规。
 *
 * 指令集：面板类（打开底部面板抽屉）、模式类（切会话模式：问答/计划/目标）。
 * 「打开浏览器面板」「文件树」「真终端」「Git」在移动端没有数据源，不收。
 */
import { openAgentPanel } from "@/lib/panels/agent-panel-sheet";
import { setSessionMode, type SessionMode } from "@/lib/pi/pi-session-mode";

export type SlashIconName =
  | "Activity"
  | "ListTodo"
  | "ClipboardList"
  | "MessageCircleQuestion"
  | "Target"
  | "Zap";

export type SlashCommandDef = {
  id: string;
  /** 菜单里显示的字面量（含前导斜杠） */
  label: string;
  description: string;
  icon: SlashIconName;
  run: (ctx: { threadId: string | undefined }) => void;
};

const switchMode = (threadId: string | undefined, mode: SessionMode) => {
  if (threadId) setSessionMode(threadId, mode);
};

export const SLASH_COMMANDS: readonly SlashCommandDef[] = [
  {
    id: "activity",
    label: "/activity",
    description: "打开活动面板：计划、文件变更、终端与引用",
    icon: "Activity",
    run: () => openAgentPanel(),
  },
  {
    id: "plan-panel",
    label: "/plan-panel",
    description: "打开计划面板（任务清单）",
    icon: "ListTodo",
    run: () => openAgentPanel(),
  },
  {
    id: "plan",
    label: "/plan",
    description: "切到计划模式：先出计划，批准后再实施",
    icon: "ClipboardList",
    run: ({ threadId }) => switchMode(threadId, "plan"),
  },
  {
    id: "ask",
    label: "/ask",
    description: "切到问答模式：只读工具，问问题就得到答案",
    icon: "MessageCircleQuestion",
    run: ({ threadId }) => switchMode(threadId, "ask"),
  },
  {
    id: "goal",
    label: "/goal",
    description: "切到目标模式：说一个目标，我跨轮把它做完",
    icon: "Target",
    run: ({ threadId }) => switchMode(threadId, "goal"),
  },
];

/* ------------------------------ 指令芯片 ------------------------------ */

/** 技能芯片文本：`:skill[名字]{name=skill:名字}`（桌面端 skillItem 同规） */
export const skillDirective = (name: string) => `:skill[${name}]{name=skill:${name}}`;

/** 子智能体芯片文本：`:agent[名字]{name=agent:名字}`（桌面端 @ 提及同规） */
export const agentDirective = (name: string) => `:agent[${name}]{name=agent:${name}}`;

/* --------------------------- 触发词（@ 与 /） --------------------------- */

export type TriggerMatch = {
  kind: "mention" | "slash";
  /** 触发符之后已输入的内容（过滤词） */
  query: string;
  /** 触发符在草稿里的下标（选中后从它开始替换） */
  index: number;
};

const WORD_TAIL_RE = /(^|\s)([@/])([^\s@/]*)$/u;

/**
 * 草稿末尾是否停在触发词上：`@子` → mention、`/pl` → slash。
 * 只在末尾匹配（用户在中间补字不该弹菜单），且触发符前必须是空白或行首。
 */
export function matchTrigger(text: string): TriggerMatch | null {
  const m = WORD_TAIL_RE.exec(text);
  if (!m || m.index === undefined) return null;
  const mark = m[2] ?? "";
  const query = m[3] ?? "";
  return {
    kind: mark === "@" ? "mention" : "slash",
    query,
    index: m.index,
  };
}
