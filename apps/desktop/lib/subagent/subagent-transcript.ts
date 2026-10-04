import type { SubagentBlock, SubagentRunState } from "./subagent-runs";

/**
 * 子智能体面板「对话列表」的纯数据投影：把 delegate 的活动块序列切成
 * 一条条消息（user / assistant），供 subagent-conversation 直接渲染。
 *
 * 分段规则：`turn` 块是段边界（每轮一条 assistant 消息），段内按原顺序
 * 保留 thinking / text / tool 块；末条报告（status 非运行中且有 report）
 * 单独成一条 assistant 消息。纯函数、不碰 React，边界可单测。
 *
 * 会话角色映射（需求）：派活说明 = user（主会话用户消息的视觉），
 * 子智能体的轮次输出与报告 = assistant（主会话 AI 消息的视觉）。
 */
export type SubagentTranscriptMessage = {
  role: "user" | "assistant";
  /** 展示用时间戳（ms）：user = run.startedAt；assistant = 该段起始/完成时间 */
  at?: number;
  /** user: 任务说明；assistant 报告段: 报告正文 */
  text?: string;
  /** assistant: 该轮内容块（报告段为空） */
  blocks?: SubagentBlock[];
  /** assistant: 该段归属的轮次号（由 turn 块边界携带；报告段无） */
  turn?: number;
  /** 末条报告段标记 */
  report?: boolean;
};

export function buildSubagentTranscript(
  run: SubagentRunState,
  brief?: string,
): SubagentTranscriptMessage[] {
  const out: SubagentTranscriptMessage[] = [
    { role: "user", at: run.startedAt, text: brief },
  ];

  let current: SubagentTranscriptMessage | null = null;
  for (const block of run.blocks) {
    if (block.kind === "turn") {
      current = { role: "assistant", at: block.at, blocks: [], turn: block.n };
      out.push(current);
      continue;
    }
    // 异常事件序（turn_start 丢失）：按首块时间补一个无轮号的隐式段
    if (!current) {
      current = { role: "assistant", at: blockStart(block), blocks: [] };
      out.push(current);
    }
    current.blocks!.push(block);
  }

  if (run.status !== "running" && run.report) {
    out.push({ role: "assistant", at: run.completedAt, text: run.report, report: true });
  }

  // 空段（连续 turn 边界夹出的空 assistant）不渲染
  return out.filter(
    (m) => m.role === "user" || m.report || (m.blocks?.length ?? 0) > 0,
  );
}

/** 非 turn 块的起始时间（隐式分段时间戳用） */
function blockStart(block: SubagentBlock): number | undefined {
  switch (block.kind) {
    case "thinking":
    case "text":
      return block.startedAt;
    case "tool":
      return block.at;
    default:
      return undefined;
  }
}

export type SubagentToolBlock = Extract<SubagentBlock, { kind: "tool" }>;

/** 一轮内容里的渲染单元：连续 tool 块并成一个组（视图层折叠），其余块各自成单元 */
export type SubagentContentUnit =
  | { kind: "block"; block: SubagentBlock }
  | { kind: "tools"; tools: SubagentToolBlock[] };

/** 把一轮的块序列切成渲染单元：相邻 tool 块合并（单元素也算一组，视图自行决定是否折叠） */
export function groupSubagentContent(blocks: SubagentBlock[]): SubagentContentUnit[] {
  const out: SubagentContentUnit[] = [];
  let tools: SubagentToolBlock[] | null = null;
  for (const block of blocks) {
    if (block.kind === "tool") {
      if (!tools) {
        tools = [];
        out.push({ kind: "tools", tools });
      }
      tools.push(block);
      continue;
    }
    tools = null;
    out.push({ kind: "block", block });
  }
  return out;
}
