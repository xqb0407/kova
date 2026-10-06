/**
 * 增量投影（projectPiThreadMessagesShared + PiProjectionCache）的回归。
 *
 * 背景：流式期间每个动画帧都会重算一次投影（Rust 侧 20ms 合帧 → 前端 rAF 合帧，
 * 见 ThreadController 的 scheduleProjectedMessageFlush）。原实现每帧从零重建整份
 * 转录，成本随转录线性增长——实测 2800 条消息时单帧 24ms，已超过 16.7ms 的帧
 * 预算，「任务跑很久 + 消息很多」于是必然卡顿。增量投影只重投影变过的尾部。
 *
 * 本文件两部分：
 *  1. 正确性：与全量投影做差分对拍。增量是纯优化，任何一帧的输出都必须与全量
 *     逐字一致——这是这份测试的主要价值。
 *  2. 成本：前缀按对象身份复用（确定性断言）+ 每帧成本的量级护栏。
 */
import { describe, expect, it } from "bun:test";
import {
  createPiProjectionCache,
  projectPiThreadMessages,
  projectPiThreadMessagesShared,
  type PiProjectionInput,
} from "./messageProjection";
import type {
  PiAgentMessage,
  PiAssistantMessage,
  PiHostUiRequest,
  PiToolCall,
  PiToolResultMessage,
} from "../types";
import type { PiThreadState } from "./threadState";

/** 取输出消息首个文本 part 的正文（断言辅助，免去散落的断言转换） */
const firstText = (m: { content: unknown }): string => {
  const parts = m.content as readonly { type?: string; text?: string }[];
  return parts[0]?.text ?? "";
};

const usage = {
  input: 10,
  output: 20,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 30,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const user = (text: string, seq: number): PiAgentMessage => ({
  role: "user",
  content: text,
  timestamp: seq,
  __seq: seq,
});

const assistant = (
  content: PiAssistantMessage["content"],
  seq: number,
): PiAssistantMessage => ({
  role: "assistant",
  content,
  api: "anthropic-messages",
  provider: "anthropic",
  model: "claude",
  usage,
  stopReason: "stop",
  timestamp: seq,
  __seq: seq,
});

const toolResult = (
  toolCallId: string,
  text: string,
  seq: number,
): PiToolResultMessage => ({
  role: "toolResult",
  toolCallId,
  toolName: "read",
  content: [{ type: "text", text }],
  isError: false,
  timestamp: seq,
  __seq: seq,
});

const toolCall = (id: string, name: string, args: object): PiToolCall => ({
  type: "toolCall",
  id,
  name,
  arguments: args as Record<string, unknown>,
});

/**
 * 转录 fixture：按 reducer 的**真实身份语义**演进输入，而不是伪造「每次都全新
 * 对象」这种理想输入。
 *  - 数组：每次改动换新身份（threadState.replaceAt 的 slice+赋值）
 *  - 已落盘的消息对象：跨帧保持同一引用
 *  - 正在流式的那条：**同一对象就地改写**（pi-client-base 的 applyStreamDelta）
 *  - toolExecutions / hostUiRequests：整体换新身份（threadState 的 upsert 语义）
 */
class Transcript {
  messages: PiAgentMessage[] = [];
  toolExecutions: PiThreadState["toolExecutions"] = {};
  hostUiRequests: PiHostUiRequest[] = [];
  runStatus: PiThreadState["runStatus"] = "idle";
  private seq = 0;

  private nextSeq(): number {
    this.seq += 1;
    return this.seq;
  }

  appendUser(text: string): void {
    this.messages = [...this.messages, user(text, this.nextSeq())];
  }

  /** message_start：新起一条 assistant（append），并把它交给流式就地改写 */
  startAssistant(): PiAssistantMessage {
    const message = assistant([], this.nextSeq());
    this.messages = [...this.messages, message];
    this.runStatus = "running";
    return message;
  }

  /** 流式文本增量：就地改写 accumulator 的消息对象，数组换新身份 */
  streamText(message: PiAssistantMessage, delta: string): void {
    const block = message.content[0];
    if (block?.type === "text") block.text += delta;
    else message.content.push({ type: "text", text: delta });
    this.replaceMessage(message);
  }

  /** toolcall_end：就地换掉 content 槽位里的块 */
  endToolCall(message: PiAssistantMessage, call: PiToolCall): void {
    const index = message.content.findIndex(
      (p) => p.type === "toolCall" && p.id === call.id,
    );
    if (index >= 0) message.content[index] = call;
    else message.content.push(call);
    this.replaceMessage(message);
  }

  appendToolResult(toolCallId: string, text: string): void {
    this.messages = [
      ...this.messages,
      toolResult(toolCallId, text, this.nextSeq()),
    ];
  }

  appendCustom(display: boolean, seq: number): void {
    this.messages = [
      ...this.messages,
      { role: "custom", customType: "note", content: "x", display, timestamp: seq },
    ];
  }

  appendAutoContinue(text: string): void {
    this.messages = [
      ...this.messages,
      user(`[[auto-continue]] ${text}`, this.nextSeq()),
    ];
  }

  /** tool_execution_update：整体换新身份的台账 */
  setToolExecution(
    toolCallId: string,
    partialResult: unknown,
    status: PiThreadState["toolExecutions"][string]["status"],
  ): void {
    this.toolExecutions = {
      ...this.toolExecutions,
      [toolCallId]: { toolCallId, partialResult, status },
    };
  }

  setRequests(requests: PiHostUiRequest[]): void {
    this.hostUiRequests = requests;
  }

  endRun(): void {
    this.runStatus = "idle";
  }

  /** 转录被截短（reloadMessage / 快照收缩） */
  truncateTo(length: number): void {
    this.messages = this.messages.slice(0, length);
  }

  /** 中途替换一条消息（不信不走的路径，但必须不串味） */
  replaceAt(index: number, message: PiAgentMessage): void {
    const next = this.messages.slice();
    next[index] = message;
    this.messages = next;
  }

  input(): PiProjectionInput {
    return {
      messages: this.messages,
      toolExecutions: this.toolExecutions,
      runStatus: this.runStatus,
      hostUiRequests: this.hostUiRequests,
    };
  }

  /** 换掉数组里那条消息的槽位（对象本身不变）——对齐 threadState.replaceAt */
  private replaceMessage(message: PiAgentMessage): void {
    const index = this.messages.indexOf(message);
    if (index < 0) return;
    const next = this.messages.slice();
    next[index] = message;
    this.messages = next;
  }
}

/** 一帧一步地对拍：每一步增量结果都必须与全量投影逐字一致 */
const walk = (steps: ((t: Transcript) => void)[]): number => {
  const transcript = new Transcript();
  const cache = createPiProjectionCache();
  let previous: readonly ReturnType<typeof projectPiThreadMessages>[number][] = [];
  let frames = 0;

  const check = (label: string) => {
    const input = transcript.input();
    const expected = projectPiThreadMessages(input);
    const actual = projectPiThreadMessagesShared(input, previous, cache);
    expect(actual, label).toEqual(expected);
    previous = actual;
    frames++;
  };

  check("初始");
  for (const [index, step] of steps.entries()) {
    step(transcript);
    check(`第 ${index} 步`);
  }
  expect(frames).toBe(steps.length + 1);
  return frames;
};

describe("增量投影：与全量投影对拍", () => {
  it("完整一轮：提问 → 流式正文 → 工具调用 → 结果落盘 → 收尾", () => {
    walk([
      (t) => {
        const m = t.appendUser("帮我看看这个文件");
        void m;
      },
      (t) => {
        const m = t.startAssistant();
        t.streamText(m, "先读一下");
      },
      (t) => {
        const m = t.messages[t.messages.length - 1] as PiAssistantMessage;
        t.streamText(m, "文件内容。");
      },
      (t) => {
        const m = t.messages[t.messages.length - 1] as PiAssistantMessage;
        t.endToolCall(m, toolCall("c1", "read", { path: "/a.ts" }));
      },
      (t) => t.setToolExecution("c1", "partial output", "running"),
      (t) => t.setToolExecution("c1", "partial output longer", "running"),
      (t) => t.appendToolResult("c1", "完整输出"),
      (t) => {
        const m = t.startAssistant();
        t.streamText(m, "读完了");
      },
      (t) => t.endRun(),
    ]);
  });

  it("多轮长会话：每轮都走一遍流式与工具", () => {
    const steps: ((t: Transcript) => void)[] = [];
    for (let turn = 0; turn < 6; turn++) {
      steps.push((t) => {
        t.appendUser(`第 ${turn} 轮`);
      });
      steps.push((t) => {
        const m = t.startAssistant();
        t.streamText(m, `回答 ${turn} `);
      });
      steps.push((t) => {
        const m = t.messages[t.messages.length - 1] as PiAssistantMessage;
        t.streamText(m, "继续");
        t.endToolCall(m, toolCall(`c${turn}`, "bash", { cmd: "ls" }));
      });
      steps.push((t) => t.setToolExecution(`c${turn}`, "tmp", "running"));
      steps.push((t) => t.appendToolResult(`c${turn}`, `输出 ${turn}`));
      steps.push((t) => {
        const m = t.startAssistant();
        t.streamText(m, "收尾");
        t.endRun();
      });
    }
    walk(steps);
  });

  it("就地改写：同一对象身份下追加文本，收尾段必须重投影（不复用）", () => {
    const transcript = new Transcript();
    const cache = createPiProjectionCache();
    transcript.appendUser("问题");
    const message = transcript.startAssistant();

    let previous = projectPiThreadMessagesShared(transcript.input(), [], cache);
    transcript.streamText(message, "第一段");
    previous = projectPiThreadMessagesShared(transcript.input(), previous, cache);

    // 消息对象身份没变（就地改写），身份扫描发现不了——靠「收尾段永不复用」兜住
    expect(firstText(previous[1]!)).toBe("第一段");

    transcript.streamText(message, "，第二段");
    const after = projectPiThreadMessagesShared(
      transcript.input(),
      previous,
      cache,
    );
    expect(firstText(after[1]!)).toBe("第一段，第二段");
    expect(firstText(after[1]!)).toEqual(
      firstText(projectPiThreadMessages(transcript.input())[1]!),
    );
  });

  it("转录被截短：新的收尾段重投影，isLast 状态跟着走", () => {
    const transcript = new Transcript();
    const cache = createPiProjectionCache();
    transcript.appendUser("一");
    const m1 = transcript.startAssistant();
    transcript.streamText(m1, "答一");
    transcript.endRun();
    transcript.appendUser("二");
    transcript.runStatus = "running";
    const m2 = transcript.startAssistant();
    transcript.streamText(m2, "答二");

    let previous = projectPiThreadMessagesShared(transcript.input(), [], cache);
    expect(previous).toHaveLength(4);

    // 截到第一轮结束：第 2 段（"答一"）在新转录里成了收尾段，且此刻 runStatus
    // 仍是 running → status 必须是 running，绝不能沿用旧的 complete
    transcript.truncateTo(2);
    previous = projectPiThreadMessagesShared(transcript.input(), previous, cache);
    expect(previous).toHaveLength(2);
    expect(previous).toEqual(projectPiThreadMessages(transcript.input()));
    expect(previous[1]!.status).toEqual({ type: "running" });
  });

  it("中途替换一条消息：从该处起重投影（不串味）", () => {
    const transcript = new Transcript();
    const cache = createPiProjectionCache();
    transcript.appendUser("一");
    const m1 = transcript.startAssistant();
    transcript.streamText(m1, "答一");
    transcript.endRun();
    transcript.appendUser("二");
    const m2 = transcript.startAssistant();
    transcript.streamText(m2, "答二");

    let previous = projectPiThreadMessagesShared(transcript.input(), [], cache);
    transcript.replaceAt(1, assistant([{ type: "text", text: "改过的答一" }], 99));
    previous = projectPiThreadMessagesShared(transcript.input(), previous, cache);
    expect(previous).toEqual(projectPiThreadMessages(transcript.input()));
    expect(firstText(previous[1]!)).toBe("改过的答一");
  });

  it("审批出现与撤销：含活工具调用的段重投影", () => {
    const transcript = new Transcript();
    const cache = createPiProjectionCache();
    transcript.appendUser("跑一下");
    const m = transcript.startAssistant();
    transcript.streamText(m, "需要确认");
    transcript.endToolCall(m, toolCall("c1", "bash", { cmd: "rm -rf" }));

    let previous = projectPiThreadMessagesShared(transcript.input(), [], cache);
    expect(previous[1]!.status).not.toEqual({
      type: "requires-action",
      reason: "interrupt",
    });

    transcript.setRequests([
      {
        id: "req-1",
        toolCallId: "c1",
        kind: "approval",
      } as unknown as PiHostUiRequest,
    ]);
    previous = projectPiThreadMessagesShared(transcript.input(), previous, cache);
    expect(previous).toEqual(projectPiThreadMessages(transcript.input()));

    transcript.setRequests([]);
    previous = projectPiThreadMessagesShared(transcript.input(), previous, cache);
    expect(previous).toEqual(projectPiThreadMessages(transcript.input()));
  });

  it("隐藏的 custom 行与自动续跑哨兵行：跳过但不破坏分段边界", () => {
    let m!: PiAssistantMessage;
    walk([
      (t) => {
        t.appendUser("开头");
      },
      (t) => {
        m = t.startAssistant();
        t.streamText(m, "答");
      },
      (t) => t.appendCustom(false, 100),
      (t) => t.appendAutoContinue("继续"),
      // 哨兵行被跳过且不 flush、隐藏 custom 行 flush 但不产出——组还开着，
      // 紧接着对同一条 assistant 继续就地改写，正好压住这两条与分段边界的关系
      (t) => t.streamText(m, "续写"),
      (t) => t.appendCustom(true, 101),
      (t) => {
        t.appendUser("结尾");
      },
    ]);
  });
});

describe("增量投影：复用与成本", () => {
  /** 造一份长转录（每轮 = user + assistant(含工具调用) + toolResult） */
  const buildLongTranscript = (turns: number, bytesPerOutput: number) => {
    const transcript = new Transcript();
    for (let turn = 0; turn < turns; turn++) {
      transcript.appendUser(`第 ${turn} 轮`);
      const m = transcript.startAssistant();
      if (bytesPerOutput > 0) m.content.push({ type: "text", text: "说明" });
      transcript.endToolCall(m, toolCall(`c${turn}`, "read", { path: `/f${turn}` }));
      transcript.appendToolResult(
        `c${turn}`,
        `输出 ${turn}\n`.padEnd(bytesPerOutput, "x"),
      );
      transcript.endRun();
    }
    return transcript;
  };

  it("流式只改尾部：前缀消息按对象身份复用（下游不重渲的依据）", () => {
    const transcript = buildLongTranscript(60, 0);
    const cache = createPiProjectionCache();
    const before = projectPiThreadMessagesShared(transcript.input(), [], cache);

    // 起一条新 assistant 并在其中流式输出——只有收尾段该变
    const m = transcript.startAssistant();
    transcript.streamText(m, "新的回答");
    const after = projectPiThreadMessagesShared(transcript.input(), before, cache);

    expect(after).toEqual(projectPiThreadMessages(transcript.input()));
    // 除末段外全部是同一批对象：没有重建，shareProjectedThreadMessages 也直接判等。
    // 新起的 assistant 并入末尾那组（组会把相邻 assistant + toolResult 合起来），
    // 所以长度不变、变化的只有末条
    expect(after).toHaveLength(before.length);
    for (let i = 0; i < before.length - 1; i++) {
      expect(after[i], `第 ${i} 条`).toBe(before[i] as never);
    }
  });

  it("每帧成本不随转录长度线性增长", () => {
    const framesFor = (turns: number) => {
      const transcript = buildLongTranscript(turns, 6000);
      const cache = createPiProjectionCache();
      let previous = projectPiThreadMessagesShared(transcript.input(), [], cache);
      const m = transcript.startAssistant();

      // 200 帧尾部流式（就地改写 + 数组换身份），只计增量路径
      const start = performance.now();
      for (let i = 0; i < 200; i++) {
        transcript.streamText(m, `${i} `);
        previous = projectPiThreadMessagesShared(transcript.input(), previous, cache);
      }
      return (performance.now() - start) / 200;
    };

    framesFor(20); // 预热（JIT / Shiki 之外的纯计算）
    const short = framesFor(20);
    const long = framesFor(400);

    // 全量投影在 400 轮时约 20ms+（见优化前的实测），增量应当远离那量级。
    // 断言用「长转录不显著贵于短转录」的相对口径，避免绑死机器性能。
    expect(long).toBeLessThan(Math.max(short, 0.2) * 10);
    expect(long).toBeLessThan(3);
  });
});
