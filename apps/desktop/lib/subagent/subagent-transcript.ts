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
  /** 插入消息（SendMessage/对话页输入）：派活说明之后的 user 气泡 */
  followUp?: boolean;
};

/** sidecar boundedReport 的截断标记（同字面量；报告过长时卡片是头+尾） */
const REPORT_TRUNCATION_MARKER = "\n\n[subagent report truncated]\n\n";

/** 活动流的最后一条正文是否就是结算报告本身。精确相等覆盖常规报告；
 *  超长报告在卡片里是 head + marker + tail，用头尾匹配识别同一份内容。 */
function isReportEcho(text: string, report: string): boolean {
  const body = text.trim();
  const bounded = report.trim();
  if (!body || !bounded) return false;
  if (body === bounded) return true;
  const at = bounded.indexOf(REPORT_TRUNCATION_MARKER);
  if (at < 0) return false;
  const head = bounded.slice(0, at);
  const tail = bounded.slice(at + REPORT_TRUNCATION_MARKER.length);
  return (
    head.length > 0 &&
    tail.length > 0 &&
    body.startsWith(head) &&
    body.endsWith(tail)
  );
}

/** 从活动段里去掉报告回声。
 *
 *  找到全文最后一个 text 块（可能是多个连续 text 块拼成的同一条消息正文）；
 *  `lastReportText` 取的是最后一条**有文本**的 assistant 消息，所以报告正文
 *  前面可能还隔着只跑工具的轮次，必须跨段回找，不能只砍最后一段。 */
function dropReportEcho(
  out: SubagentTranscriptMessage[],
  report: string,
): void {
  if (!report.trim()) return;
  for (let i = out.length - 1; i >= 0; i--) {
    const message = out[i]!;
    if (message.role !== "assistant" || !message.blocks?.length) continue;
    let lastText = -1;
    for (let j = message.blocks.length - 1; j >= 0; j--) {
      const block = message.blocks[j]!;
      // 空的 text 块不更新 sidecar 的 lastReportText；跳过它继续回找
      if (block.kind === "text" && block.text.trim()) {
        lastText = j;
        break;
      }
    }
    if (lastText < 0) continue;
    const tailBlock = message.blocks[lastText]!;
    if (tailBlock.kind !== "text") continue;
    let start = lastText;
    let text = tailBlock.text;
    // 同一条 assistant 消息可以有多个连续 text 块，报告是它们的拼接
    while (start > 0) {
      const prev = message.blocks[start - 1]!;
      if (prev.kind !== "text") break;
      text = prev.text + text;
      start -= 1;
    }
    if (isReportEcho(text, report)) {
      message.blocks.splice(start, lastText - start + 1);
    }
    // 只看全文最后一个 text 块：更早的重复不是本次结算的报告来源
    return;
  }
}

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
    // 插入消息 = user 气泡（对话的另一半）：关闭当前 assistant 段，
    // 后续 delegate 输出开新段
    if (block.kind === "message") {
      current = null;
      out.push({ role: "user", at: block.at, text: block.text, followUp: true });
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
    // 报告正文本身就是最后一条有文本的 assistant 消息：运行期它作为普通
    // text 块流式展示，结算后 run.report 又取同一条消息。先去掉这段回声，
    // 再由底部“报告”卡片单独渲染，避免同一段内容出现两遍。
    dropReportEcho(out, run.report);
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
