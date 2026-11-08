/**
 * autoVerify 回归门：触发条件、上限、互斥（goal/automation）、开关、每轮重置、
 * 哨兵前缀。maybeVerifyFollowUp 是纯判定函数（不真派 run），全部行为级直测。
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  AUTO_VERIFY_MAX_CONTINUES,
  AUTO_VERIFY_PREFIX,
  editedFilesThisTurn,
  getAutoVerifyConfig,
  maybeVerifyFollowUp,
  resetAutoVerifyConfigForTest,
  setAutoVerifyConfig,
} from "../../src/agent/verify-run";
import { registerAutomationThread, unregisterAutomationThread } from "../../src/automation/policy";
import type { Running } from "../../src/types";

const tmps: string[] = [];
afterEach(() => {
  resetAutoVerifyConfigForTest();
});

function makeRun(overrides: Partial<Running> = {}): Running {
  return {
    threadId: "t-verify",
    mode: "agent",
    ...overrides,
  } as unknown as Running;
}

function userMsg(text: string): AgentMessage {
  return { role: "user", content: text, timestamp: 1 } as AgentMessage;
}

function toolResult(name: string, isError = false, text = "ok"): AgentMessage {
  return {
    role: "toolResult",
    toolCallId: `c-${name}-${isError ? "err" : "ok"}`,
    toolName: name,
    content: [{ type: "text", text }],
    isError,
    timestamp: 2,
  } as AgentMessage;
}

describe("autoVerify 触发条件", () => {
  test("开关关闭（默认）：不注入", () => {
    expect(getAutoVerifyConfig().enabled).toBe(false);
    const run = makeRun();
    const messages = [userMsg("go"), toolResult("write")];
    expect(maybeVerifyFollowUp(run, messages)).toBeUndefined();
  });

  test("开关开启 + 本轮成功 write：注入 verify followUp", () => {
    setAutoVerifyConfig({ enabled: true });
    const run = makeRun();
    const messages = [userMsg("go"), toolResult("write")];
    const msg = maybeVerifyFollowUp(run, messages);
    expect(msg).toBeDefined();
    expect((msg as { content: string }).content).toContain(AUTO_VERIFY_PREFIX);
    expect((msg as { content: string }).content).toContain("只读验证");
    expect((msg as { role: string }).role).toBe("user");
    // 计数器推进
    expect(run.verifyContinues).toBe(1);
  });

  test("本轮无 write/edit 成功结果（只有 read / isError write）：不注入", () => {
    setAutoVerifyConfig({ enabled: true });
    const run = makeRun();
    expect(
      maybeVerifyFollowUp(run, [userMsg("go"), toolResult("read"), toolResult("write", true)]),
    ).toBeUndefined();
  });

  test("goal 模式互斥：goal 有验收闭环", () => {
    setAutoVerifyConfig({ enabled: true });
    const run = makeRun({ mode: "goal" });
    expect(maybeVerifyFollowUp(run, [userMsg("go"), toolResult("write")])).toBeUndefined();
  });

  test("automation 线程强制 off（无人值守不叠加后台轮）", () => {
    setAutoVerifyConfig({ enabled: true });
    const threadId = "t-verify-auto";
    registerAutomationThread(threadId, "workspace-write");
    try {
      const run = makeRun({ threadId });
      expect(maybeVerifyFollowUp(run, [userMsg("go"), toolResult("write")])).toBeUndefined();
    } finally {
      unregisterAutomationThread(threadId);
    }
  });

  test("上限：同一用户轮内达 AUTO_VERIFY_MAX_CONTINUES 后不再注入", () => {
    setAutoVerifyConfig({ enabled: true });
    const run = makeRun();
    const messages = [userMsg("go"), toolResult("write")];
    for (let i = 0; i < AUTO_VERIFY_MAX_CONTINUES; i++) {
      expect(maybeVerifyFollowUp(run, messages)).toBeDefined();
    }
    expect(run.verifyContinues).toBe(AUTO_VERIFY_MAX_CONTINUES);
    expect(maybeVerifyFollowUp(run, messages)).toBeUndefined();
  });

  test("重置：verifyContinues 归零后重新注入（模拟新用户轮）", () => {
    setAutoVerifyConfig({ enabled: true });
    const run = makeRun();
    run.verifyContinues = AUTO_VERIFY_MAX_CONTINUES;
    expect(maybeVerifyFollowUp(run, [userMsg("go"), toolResult("write")])).toBeUndefined();
    run.verifyContinues = 0; // prompt-pipeline 每用户轮置 0
    expect(maybeVerifyFollowUp(run, [userMsg("go"), toolResult("write")])).toBeDefined();
  });
});

describe("editedFilesThisTurn", () => {
  test("只统计本轮（最后一条真实用户消息之后）的成功 write/edit", () => {
    setAutoVerifyConfig({ enabled: true });
    const messages = [
      userMsg("first turn"),
      toolResult("write"), // 上一轮的：不计
      userMsg("second turn"),
      toolResult("edit"),
      toolResult("write", true), // isError：不计
    ];
    const edited = editedFilesThisTurn(messages);
    expect(edited.size).toBe(1); // edit 计入，上一轮 write 与 isError 不计
  });

  test("verify 注入自身的 user 消息不算新一轮（前缀识别）", () => {
    const messages = [
      userMsg("go"),
      toolResult("write"),
      userMsg(`${AUTO_VERIFY_PREFIX}验证上一轮修改`), // verify 注入
      toolResult("edit"),
    ];
    const edited = editedFilesThisTurn(messages);
    // 两轮结果都在同一用户轮语义内（verify 前缀不切轮）
    expect(edited.size).toBe(2);
  });

  test("isError write 不计入触发集", () => {
    const messages = [userMsg("go"), toolResult("write", true)];
    expect(editedFilesThisTurn(messages).size).toBe(0);
  });
});

describe("AUTO_VERIFY_PREFIX 哨兵", () => {
  test("注入消息以哨兵开头（UI 投影过滤依据）", () => {
    setAutoVerifyConfig({ enabled: true });
    const run = makeRun();
    const msg = maybeVerifyFollowUp(run, [userMsg("go"), toolResult("write")]) as {
      content: string;
    };
    expect(msg.content.startsWith(AUTO_VERIFY_PREFIX)).toBe(true);
  });
});

describe("Stop 中断防护", () => {
  test("stopRequested 轮不注入（用户 Stop 意图优先；残留 followUp 会插队）", () => {
    setAutoVerifyConfig({ enabled: true });
    const run = makeRun({ stopRequested: true });
    expect(maybeVerifyFollowUp(run, [userMsg("go"), toolResult("write")])).toBeUndefined();
  });

  test("stopRequested 与计数上限无关：即使未达上限也拦", () => {
    setAutoVerifyConfig({ enabled: true });
    const run = makeRun({ stopRequested: true, verifyContinues: 0 });
    expect(maybeVerifyFollowUp(run, [userMsg("go"), toolResult("edit")])).toBeUndefined();
  });
});
