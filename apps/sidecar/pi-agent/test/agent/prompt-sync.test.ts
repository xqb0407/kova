import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  PROMPT_UPDATE_MARKER,
  isPromptBlockUpdateMessage,
  isPromptUpdateMessage,
} from "pi-protocol";
import {
  SYSTEM_PROMPT_BLOCK_KEYS,
  composeModeSystemPrompt,
  composeModeSystemPromptParts,
  composeRunPromptParts,
  drainPromptUpdates,
  queuePromptUpdates,
  renderPromptUpdate,
  rewriteRunPrompt,
  syncRunPrompt,
} from "../../src/agent/modes";
import type { Running } from "../../src/types";

const cwd = mkdtempSync(join(tmpdir(), "kova-prompt-sync-"));
afterAll(() => {
  rmSync(cwd, { recursive: true, force: true });
});

function makeRun(over: Partial<Running> = {}): Running {
  return {
    agent: {
      state: { messages: [{ role: "system", content: "old", timestamp: 0 }] },
    } as unknown as Running["agent"],
    threadId: "t-prompt-sync",
    sessionId: "s-prompt-sync",
    cwd,
    externalDirs: [],
    persistedSeq: 0,
    jsonlSeq: 0,
    compactionGeneration: 0,
    pendingOverflowRecovery: false,
    delegations: new Map(),
    stopRequested: false,
    mode: "agent",
    approvalLevel: "ask",
    appMode: "code",
    planning: "inactive",
    baseTools: [],
    subagentTools: [],
    pendingToolApprovals: new Map(),
    lastSeenAt: Date.now(),
    usagePending: 0,
    ...over,
  } as unknown as Running;
}

const headContent = (run: Running): string =>
  (run.agent.state.messages[0] as unknown as { content: string }).content;

describe("composeModeSystemPromptParts", () => {
  test("拼接结果与 composeModeSystemPrompt 逐字节一致（四档 × 三工作模式）", () => {
    for (const mode of ["agent", "plan", "ask", "goal"] as const) {
      for (const appMode of ["code", "work", "design"] as const) {
        const parts = composeModeSystemPromptParts(mode, cwd, appMode, null);
        expect(parts.prompt).toBe(composeModeSystemPrompt(mode, cwd, appMode, null));
        expect(Object.keys(parts.blocks)).toEqual([...SYSTEM_PROMPT_BLOCK_KEYS]);
        expect(
          SYSTEM_PROMPT_BLOCK_KEYS.map((key) => parts.blocks[key])
            .filter(Boolean)
            .join("\n\n"),
        ).toBe(parts.prompt);
      }
    }
  });
});

describe("syncRunPrompt", () => {
  test("基线：首次同步整体重写并建立 promptBlocks", () => {
    const run = makeRun();
    const result = syncRunPrompt(run);
    expect(result.rewritten).toBe(true);
    expect(run.promptBlocks).toBeDefined();
    expect(run.pendingPromptUpdates ?? []).toEqual([]);
    expect(headContent(run)).toBe(composeRunPromptParts(run).prompt);
  });

  test("无变化：不重写、不排队", () => {
    const run = makeRun();
    syncRunPrompt(run);
    const before = headContent(run);
    expect(syncRunPrompt(run)).toEqual({ changed: [], rewritten: false, updates: [] });
    expect(headContent(run)).toBe(before);
    expect(run.pendingPromptUpdates ?? []).toEqual([]);
  });

  test("只变 externalDirs：首条 system 不动，更新进队列", () => {
    const run = makeRun();
    syncRunPrompt(run);
    const before = headContent(run);
    run.externalDirs = [
      { label: "ext", path: join(cwd, "missing-ext") },
    ] as Running["externalDirs"];
    const result = syncRunPrompt(run);
    expect(result.rewritten).toBe(false);
    expect(result.changed).toContain("externalDirs");
    expect(headContent(run)).toBe(before);
    expect(run.pendingPromptUpdates?.some((u) => u.key === "externalDirs")).toBe(true);
    // 入队不等于已应用：drain（真正投递）后才写 promptBlocks
    expect(run.promptBlocks?.externalDirs).toBe("");
    const drained = drainPromptUpdates(run);
    expect(drained.some((u) => u.key === "externalDirs")).toBe(true);
    expect(run.promptBlocks?.externalDirs).toBe(
      composeRunPromptParts(run).blocks.externalDirs,
    );
  });

  test("只变 AGENTS.md：首条 system 不动，instructions 更新进队列", () => {
    const file = join(cwd, "AGENTS.md");
    rmSync(file, { force: true });
    try {
      const run = makeRun();
      syncRunPrompt(run); // 先在 AGENTS.md 不存在时建基线
      const before = headContent(run);
      writeFileSync(file, "# Project rules\nUse tabs.\n", "utf8");
      const result = syncRunPrompt(run);
      expect(result.rewritten).toBe(false);
      expect(result.changed).toContain("instructions");
      expect(headContent(run)).toBe(before);
      expect(run.pendingPromptUpdates?.some((u) => u.key === "instructions")).toBe(true);
    } finally {
      rmSync(file, { force: true });
    }
  });

  test("只变 MCP 服务器清单：首条 system 不动，mcp 更新进队列", () => {
    const prev = process.env.PI_MCP_CONFIG;
    const cfg = join(cwd, "system-mcp.json");
    const writeCfg = (names: string[]) =>
      writeFileSync(
        cfg,
        JSON.stringify({
          mcpServers: Object.fromEntries(names.map((n) => [n, { command: "echo" }])),
        }),
        "utf8",
      );
    process.env.PI_MCP_CONFIG = cfg;
    try {
      writeCfg(["alpha"]);
      const run = makeRun();
      syncRunPrompt(run); // 基线含 alpha 的 MCP 段
      expect(headContent(run)).toContain("- alpha");
      const before = headContent(run);

      writeCfg(["alpha", "beta"]);
      const result = syncRunPrompt(run);
      // mcp 是易变段：清单变化只排队尾更新，不重写首条 system（前缀缓存保住）
      expect(result.rewritten).toBe(false);
      expect(result.changed).toContain("mcp");
      expect(headContent(run)).toBe(before);
      expect(run.pendingPromptUpdates?.some((u) => u.key === "mcp")).toBe(true);
      const mcpUpdate = drainPromptUpdates(run).find((u) => u.key === "mcp");
      expect(mcpUpdate?.text).toContain("- beta");
    } finally {
      if (prev === undefined) delete process.env.PI_MCP_CONFIG;
      else process.env.PI_MCP_CONFIG = prev;
      rmSync(cfg, { force: true });
    }
  });

  test("待投递更新在块回退时被撤销，不会把模型带回旧值", () => {
    const run = makeRun();
    syncRunPrompt(run);
    run.externalDirs = [
      { label: "ext", path: join(cwd, "missing-ext") },
    ] as Running["externalDirs"];
    syncRunPrompt(run);
    expect(run.pendingPromptUpdates?.some((u) => u.key === "externalDirs")).toBe(true);

    // 投递前目录又删掉了：当前值回到 system 里的空值，pending 必须撤销
    run.externalDirs = [];
    const result = syncRunPrompt(run);
    expect(result.changed).toEqual([]);
    expect(run.pendingPromptUpdates?.some((u) => u.key === "externalDirs")).toBe(false);
  });

  test("critical 段变化（mode）：整体重写，清空待投递更新", () => {
    const run = makeRun();
    syncRunPrompt(run);
    run.pendingPromptUpdates = [{ key: "skills", text: "stale" }];
    run.mode = "plan";
    const result = syncRunPrompt(run);
    expect(result.rewritten).toBe(true);
    expect(result.changed).toContain("mode");
    expect(run.pendingPromptUpdates).toEqual([]);
    expect(headContent(run)).toContain("You are operating in Plan mode");
  });

  test("critical 重写丢掉待投递日期时，lastEnvDate 复位以便下一轮补发", () => {
    const run = makeRun();
    syncRunPrompt(run);
    run.pendingPromptUpdates = [{ key: "environment-date", text: "Today's date is 2026-10-31" }];
    run.lastEnvDate = "2026-10-31";
    run.mode = "plan";
    syncRunPrompt(run);
    expect(run.pendingPromptUpdates).toEqual([]);
    expect(run.lastEnvDate).toBeUndefined();
  });

  test("整体重写清掉旧的尾部更新消息并修正 persistedSeq，普通能力提醒保留", () => {
    const user = (content: string): AgentMessage =>
      ({ role: "user", content, timestamp: 1 }) as AgentMessage;
    const update = user(
      `[[capability-reminder]] <system-reminder>\n${PROMPT_UPDATE_MARKER} Updated system prompt section "available skills" (this replaces the earlier "available skills" section):\n\n<available_skills>old</available_skills>\n</system-reminder>`,
    );
    const date = user(
      `[[capability-reminder]] <system-reminder>\n${PROMPT_UPDATE_MARKER} Today's date is 2026-10-31\n</system-reminder>`,
    );
    const capability = user(
      "[[capability-reminder]] <system-reminder>\nstop repeating the failing call\n</system-reminder>",
    );
    const real = user("real question");
    const run = makeRun();
    syncRunPrompt(run); // 先建基线，下面的 mode 变化才会走 critical 整体重写
    const messages = run.agent.state.messages as unknown as AgentMessage[];
    messages.push(update, date, capability, real);
    run.persistedSeq = messages.length;
    run.mode = "plan";
    syncRunPrompt(run);

    expect(messages).toHaveLength(4); // system + date + capability + real
    expect(messages.some((m) => isPromptBlockUpdateMessage(m))).toBe(false);
    // 日期事实不在 system 里，整体重写必须保留它
    expect(messages.some((m) => isPromptUpdateMessage(m))).toBe(true);
    expect(JSON.stringify(messages)).toContain("Today's date is 2026-10-31");
    expect(JSON.stringify(messages)).toContain("stop repeating the failing call");
    expect(run.persistedSeq).toBe(4);
  });

  test("基线同时写 state 与 loopContext 首条", () => {
    const loopMessages = [{ role: "system", content: "loop-old", timestamp: 0 }];
    const run = makeRun();
    run.loopContext = { messages: loopMessages } as unknown as Running["loopContext"];
    syncRunPrompt(run);
    expect((loopMessages[0] as unknown as { content: string }).content).toBe(
      headContent(run),
    );
  });
});

describe("prompt update 队列", () => {
  test("renderPromptUpdate：非空/清空两种措辞", () => {
    expect(renderPromptUpdate("skills", "<available_skills>x</available_skills>")).toContain(
      'Updated system prompt section "available skills"',
    );
    expect(renderPromptUpdate("skills", "   ")).toContain("is now empty");
    // 日期不是段替换，加内层标记后原样投递（恢复上下文时据此过滤）
    expect(renderPromptUpdate("environment-date", "Today's date is 2026-10-31")).toBe(
      `${PROMPT_UPDATE_MARKER} Today's date is 2026-10-31`,
    );
    expect(
      renderPromptUpdate("skills", "<available_skills>x</available_skills>").startsWith(
        PROMPT_UPDATE_MARKER,
      ),
    ).toBe(true);
  });

  test("queuePromptUpdates 按 key 去重；drain 返回并清空", () => {
    const run = makeRun();
    queuePromptUpdates(run, [
      { key: "skills", text: "v1" },
      { key: "externalDirs", text: "d1" },
    ]);
    queuePromptUpdates(run, [{ key: "skills", text: "v2" }]);
    expect(run.pendingPromptUpdates).toEqual([
      { key: "skills", text: "v2" },
      { key: "externalDirs", text: "d1" },
    ]);
    expect(drainPromptUpdates(run)).toEqual([
      { key: "skills", text: "v2" },
      { key: "externalDirs", text: "d1" },
    ]);
    expect(run.pendingPromptUpdates).toEqual([]);
  });

  test("rewriteRunPrompt：整体重写并清空待投递更新", () => {
    const run = makeRun();
    run.pendingPromptUpdates = [{ key: "skills", text: "stale" }];
    rewriteRunPrompt(run);
    expect(run.pendingPromptUpdates).toEqual([]);
    expect(headContent(run)).toBe(composeRunPromptParts(run).prompt);
    expect(run.promptBlocks?.core).toBeTruthy();
  });
});
