/**
 * 单轮超长（一轮的上千个步骤被并成一条消息）的回归。
 *
 * 背景：投影会把一轮里连续的 assistant + toolResult 合并成**一条**消息，所以
 * 「一个任务跑了上千步」= 一条消息里上千个 part。这里是那条路径的性能与正确性
 * 钉子，重点是重复检测不得退化成 O(调用数 × part 数)。
 *
 * 为什么必须钉住：重复检测是兜底逻辑（防上游漏出同一 assistant 的两份拷贝导致
 * @assistant-ui 的 toolCallId 键控查找表 Duplicate key 崩溃），正常数据里根本
 * 不会走到。它原先写成对整组 parts 的线性 findIndex，代价却要每个工具调用都付
 * 一次——于是长轮变成二次复杂度，而且没有任何测试会失败，只是越来越卡。
 */
import { describe, expect, it } from "bun:test";
import {
  MAX_PARTS_PER_OUTPUT,
  createPiProjectionCache,
  projectPiThreadMessages,
  projectPiThreadMessagesShared,
  type PiProjectionInput,
} from "./messageProjection";
import { packTurnSlot, parseTurnSlot } from "@/lib/panels/message-turns";
import type {
  PiAgentMessage,
  PiAssistantMessage,
  PiToolCall,
  PiToolResultMessage,
  PiUserMessage,
} from "../types";

const usage = {
  input: 1000,
  output: 200,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 1200,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const user = (i: number): PiUserMessage => ({
  role: "user",
  content: `第 ${i} 轮`,
  timestamp: 1_700_000_000_000 + i * 1000,
  __seq: i,
});

const toolCall = (id: string, name: string, args: object): PiToolCall => ({
  type: "toolCall",
  id,
  name,
  arguments: args as Record<string, unknown>,
});

const assistant = (
  seq: number,
  content: PiAssistantMessage["content"],
): PiAssistantMessage => ({
  role: "assistant",
  content,
  api: "anthropic-messages",
  provider: "anthropic",
  model: "claude",
  usage,
  stopReason: "stop",
  timestamp: 1_700_000_000_000 + seq * 1000,
  __seq: seq,
});

const toolResult = (
  seq: number,
  toolCallId: string,
  text: string,
): PiToolResultMessage => ({
  role: "toolResult",
  toolCallId,
  toolName: "read",
  content: [{ type: "text", text }],
  isError: false,
  timestamp: 1_700_000_000_000 + seq * 1000,
  __seq: seq,
});

/** 单轮 N 步：一条 user 后面 N × (assistant + toolResult)，全部并入同一组 */
const oneTurn = (steps: number): PiAgentMessage[] => {
  const out: PiAgentMessage[] = [user(0)];
  let seq = 0;
  for (let s = 0; s < steps; s++) {
    // 调用的 id 必须先落到局部变量：toolResult(++seq, `c${seq}`) 里 ++seq 先求值，
    // 结果行的 id 会领先一步，与调用对不上（这条 fixture 曾经就是这么错的）
    const callId = `c${s}`;
    out.push(
      assistant(++seq, [
        { type: "thinking", thinking: "想".padEnd(200, "考") },
        { type: "text", text: `步骤 ${s}。`.padEnd(300, "字") },
        toolCall(callId, "read", { path: `/f${s}` }),
      ]),
    );
    out.push(toolResult(++seq, callId, `输出 ${s}\n`.padEnd(3000, "x")));
  }
  return out;
};

const mkInput = (messages: PiAgentMessage[]): PiProjectionInput => ({
  messages,
  toolExecutions: {},
  runStatus: "running",
  hostUiRequests: [],
});

/** 取输出消息的 content parts（断言辅助，免去散落的 readonly 转换） */
const contentParts = (m: {
  content: unknown;
}): { type: string; toolCallId?: string; args?: { s?: number }; result?: string }[] =>
  m.content as { type: string; toolCallId?: string; args?: { s?: number } }[];

const partCount = (steps: number): number => {
  const out = projectPiThreadMessages(mkInput(oneTurn(steps)));
  return (out[out.length - 1]!.content as unknown[]).length;
};

describe("单轮超长：按 part 数切块", () => {
  it("超过上限就切块：part 总量守恒，每块不超过上限（可越界一步）", () => {
    const STEPS = 100; // 每步 3 个 part（thinking + text + toolCall）
    const out = projectPiThreadMessages(mkInput(oneTurn(STEPS)));
    const chunks = out.slice(1); // out[0] 是 user
    expect(out[0]!.role).toBe("user");
    expect(chunks.length).toBeGreaterThan(1);
    // 切点在「新一步的 assistant 消息」上，所以一块最多越界一步的 part 数
    for (const c of chunks) {
      expect((c.content as unknown[]).length).toBeLessThanOrEqual(
        MAX_PARTS_PER_OUTPUT + 3,
      );
    }
    // 切块不丢内容
    const total = chunks.reduce(
      (n, c) => n + (c.content as unknown[]).length,
      0,
    );
    expect(total).toBe(STEPS * 3);
  });

  it("切块不切断 tool-call 与它的结果行（配对必须还在同一块里）", () => {
    const out = projectPiThreadMessages(mkInput(oneTurn(400)));
    const chunks = out.slice(1);
    expect(chunks.length).toBeGreaterThan(1);
    const ids: string[] = [];
    for (const c of chunks) {
      for (const p of contentParts(c)) {
        if (p.type !== "tool-call") continue;
        ids.push(p.toolCallId!);
        // 结果行必须配上了：切点如果落在「调用之后、结果之前」，这里会是 undefined
        expect(p.result, `tool-call ${p.toolCallId} 丢了结果`).toBeDefined();
      }
    }
    // 所有工具调用都在，没有重复也没有遗漏
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toHaveLength(400);
  });

  it("只有最后一块是轮末（否则操作栏/产物卡/检查点会重复挂）", () => {
    const out = projectPiThreadMessages(mkInput(oneTurn(400)));
    const messages = out as unknown as Parameters<typeof packTurnSlot>[0];
    const slots = out.map((m) =>
      parseTurnSlot(packTurnSlot(messages, String(m.id))),
    );
    const turnEnds = slots.filter((s) => s?.isTurnEnd).length;
    expect(turnEnds).toBe(1);
    // 轮末正是最后一块
    expect(slots[slots.length - 1]?.isTurnEnd).toBe(true);
  });

  it("短轮不切块（阈值不影响正常对话）", () => {
    const out = projectPiThreadMessages(mkInput(oneTurn(5)));
    expect(out).toHaveLength(2);
    expect(partCount(5)).toBe(15);
  });

  it("增量投影在切块后的长轮上仍与全量逐字一致", () => {
    const input = mkInput(oneTurn(300));
    const cache = createPiProjectionCache();
    const full = projectPiThreadMessages(mkInput(oneTurn(300)));
    const incremental = projectPiThreadMessagesShared(input, [], cache);
    expect(incremental).toEqual(full);
  });

  it("重复检测仍然正确：同组同 toolCallId 只留一份，后到状态胜出", () => {
    const out = projectPiThreadMessages(
      mkInput([
        assistant(1, [toolCall("dup", "bash", { command: "ls" })]),
        assistant(2, [
          toolCall("dup", "bash", { command: "pwd" }),
          toolCall("other", "read", { path: "a" }),
        ]),
      ]),
    );
    expect(out).toHaveLength(1);
    const parts = contentParts(out[0]!);
    expect(parts).toHaveLength(2);
    expect(parts[0]).toMatchObject({ toolCallId: "dup" });
    expect(parts[1]).toMatchObject({ toolCallId: "other" });
    // 后到的那份（command: pwd）胜出
    expect((parts[0] as unknown as { args: { command: string } }).args.command).toBe(
      "pwd",
    );
  });

  it("重复检测正确性：跨 200 步的大组里，重复项替换后下标表仍然对得上", () => {
    // 长组里插入一次重复：前半 100 步唯一，然后重复第 1 步的 id，
    // 之后继续追加唯一 id——验证替换 + 表重建后，后续工具调用仍能正确入表
    const messages: PiAgentMessage[] = [user(0)];
    let seq = 0;
    for (let s = 0; s < 100; s++) {
      messages.push(assistant(++seq, [toolCall(`c${s}`, "read", { s })]));
    }
    // 重复 c0（会触发 filter 重建表），而后继续追加 c100..c120
    messages.push(assistant(++seq, [toolCall("c0", "read", { s: 999 })]));
    for (let s = 100; s < 120; s++) {
      messages.push(assistant(++seq, [toolCall(`c${s}`, "read", { s })]));
    }
    // 再重复一次 c119，确认重建后的表依然可用
    messages.push(assistant(++seq, [toolCall("c119", "read", { s: -1 })]));
    messages.push(toolResult(++seq, "c5", "结果 5"));

    const out = projectPiThreadMessages(mkInput(messages));
    const parts = contentParts(out[out.length - 1]!);
    const ids = parts.map((p) => p.toolCallId);
    // c0..c99 + c100..c119 = 120 个唯一 id（c0、c119 各被重复替换掉一份），无重复
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toHaveLength(120);
    // 后到状态胜出
    expect(parts.find((p) => p.toolCallId === "c0")?.args?.s).toBe(999);
    expect(parts.find((p) => p.toolCallId === "c119")?.args?.s).toBe(-1);
    // 配对结果照常落到对应工具行
    expect(parts.find((p) => p.toolCallId === "c5")).toMatchObject({
      type: "tool-call",
      result: "结果 5",
    });
  });

  it("投影成本随 part 数线性增长（不得退回二次）", () => {
    const msPerProjection = (steps: number): number => {
      const input = mkInput(oneTurn(steps));
      projectPiThreadMessages(input); // 预热
      const iters = steps >= 800 ? 5 : 10;
      const t0 = performance.now();
      for (let i = 0; i < iters; i++) projectPiThreadMessages(input);
      return (performance.now() - t0) / iters;
    };

    msPerProjection(50);
    const small = msPerProjection(200); // 600 part
    const large = msPerProjection(1600); // 4800 part，part 数是 8 倍

    // 线性应约 8×；二次会是 64×。取 20× 作护栏（留足机器抖动余量），
    // 退化回线性扫描时这里是 8.7× 实测值 → 必然触线。
    expect(large).toBeLessThan(Math.max(small, 0.05) * 20);
    // 绝对量级护栏：4800 part 的整轮投影不该超过 4ms（修复前实测 11.0ms）
    expect(large).toBeLessThan(4);
  });
});
