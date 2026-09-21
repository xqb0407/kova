import { describe, test, expect, beforeAll } from "bun:test";
import {
  buildHookPayload,
  initHooks,
  matchingHooks,
  resetHooksForTest,
  runHooks,
  setHookConfigs,
  setHooksExecutorForTest,
  truncateHookText,
  type HookConfig,
  type HookPayload,
} from "./hooks";
import { initLocalStorage, kvGet } from "../storage/hostdb";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const tmp = mkdtempSync(path.join(tmpdir(), "pi-agent-hooks-"));

beforeAll(() => {
  initLocalStorage(path.join(tmp, "state.db"));
});

function basePayload(event: HookPayload["event"] = "Stop"): HookPayload {
  return {
    event,
    sessionId: "s-1",
    threadId: "t-1",
    timestamp: new Date().toISOString(),
  };
}

function cfg(overrides: Partial<HookConfig>): HookConfig {
  return {
    id: "h",
    name: "h",
    command: "true",
    event: "Stop",
    enabled: true,
    ...overrides,
  };
}

/** 清掉 executor 注入并重建空配置，让 runHooks 走真实 spawn */
async function useRealSpawn() {
  resetHooksForTest();
  await initHooks();
}

describe("配置持久化", () => {
  test("setHookConfigs 落 kv、剔除非法条目、initHooks 恢复", async () => {
    await setHookConfigs([
      cfg({ id: "a", name: "合法" }),
      { foo: "bar" } as unknown as HookConfig,
      cfg({ id: "b", name: "禁用", enabled: false }),
    ]);
    const raw = await kvGet("pi.hooks");
    expect(raw?.value).toBeDefined();
    expect(JSON.parse(raw!.value)).toHaveLength(2);

    resetHooksForTest();
    expect(matchingHooks("Stop")).toHaveLength(0);
    await initHooks();
    expect(matchingHooks("Stop").map((h) => h.id)).toEqual(["a"]);
  });
});

describe("事件与 matcher 过滤", () => {
  test("只匹配同事件且启用的钩子", async () => {
    await setHookConfigs([
      cfg({ id: "stop", event: "Stop" }),
      cfg({ id: "disabled", event: "Stop", enabled: false }),
      cfg({ id: "pre", event: "PreToolUse" }),
    ]);
    expect(matchingHooks("Stop").map((h) => h.id)).toEqual(["stop"]);
    expect(matchingHooks("PreToolUse")).toHaveLength(1);
  });

  test("matcher 逗号分隔 = 精确工具名列表", async () => {
    await setHookConfigs([cfg({ id: "multi", event: "PreToolUse", matcher: "Write, Edit, Bash" })]);
    expect(matchingHooks("PreToolUse", "Bash")).toHaveLength(1);
    expect(matchingHooks("PreToolUse", "Bash2")).toHaveLength(0);
    expect(matchingHooks("PreToolUse", "edit")).toHaveLength(0);
  });

  test("matcher：正则、空匹配全部、非法正则按字面比较；非 tool 事件忽略 matcher", async () => {
    await setHookConfigs([
      cfg({ id: "bash", event: "PreToolUse", matcher: "^bash$" }),
      cfg({ id: "edit-ish", event: "PreToolUse", matcher: "edit" }),
      cfg({ id: "all", event: "PreToolUse", matcher: "" }),
      cfg({ id: "stop-matcher", event: "Stop", matcher: "bash" }),
      cfg({ id: "bad-re", event: "PreToolUse", matcher: "([" }),
    ]);
    expect(matchingHooks("PreToolUse", "bash").map((h) => h.id)).toEqual(["bash", "all"]);
    expect(matchingHooks("PreToolUse", "edit_file").map((h) => h.id)).toEqual(["edit-ish", "all"]);
    expect(matchingHooks("PreToolUse", "([").map((h) => h.id)).toEqual(["all", "bad-re"]);
    expect(matchingHooks("Stop", "bash").map((h) => h.id)).toEqual(["stop-matcher"]);
  });
});

describe("payload 组包与截断", () => {
  test("truncateHookText：字符串/对象序列化、超长截断", () => {
    expect(truncateHookText(undefined)).toBeUndefined();
    expect(truncateHookText("abc")).toBe("abc");
    expect(truncateHookText({ a: 1 })).toBe('{"a":1}');
    const long = truncateHookText("x".repeat(3000));
    expect(long!.length).toBeLessThanOrEqual(2000 + 12);
    expect(long!.endsWith("[truncated]")).toBe(true);
  });

  test("buildHookPayload：tool 事件带 tool、结果摘要截断、Stop 不带 tool", () => {
    const stop = buildHookPayload({ event: "Stop", sessionId: "s", threadId: "t" });
    expect(stop.event).toBe("Stop");
    expect(stop.tool).toBeUndefined();
    expect(stop.result).toBeUndefined();

    const pre = buildHookPayload({
      event: "PreToolUse",
      sessionId: "s",
      toolName: "bash",
      toolArgs: { cmd: "ls" },
    });
    expect(pre.tool).toEqual({ name: "bash", args: { cmd: "ls" } });

    const post = buildHookPayload({
      event: "PostToolUseFailure",
      sessionId: "s",
      toolName: "bash",
      isError: true,
      resultSummary: "e".repeat(3000),
    });
    expect(post.result?.isError).toBe(true);
    expect(post.result?.summary!.endsWith("[truncated]")).toBe(true);
  });
});

describe("决策解析与执行（注入 executor）", () => {
  test("block 立即返回且短路后续钩子", async () => {
    const ran: string[] = [];
    setHooksExecutorForTest(async (hook) => {
      ran.push(hook.id);
      if (hook.id === "blocker") return { decision: "block", reason: "no" };
      return undefined;
    });
    await setHookConfigs([cfg({ id: "first" }), cfg({ id: "blocker" }), cfg({ id: "never" })]);
    const decision = await runHooks("Stop", basePayload());
    expect(decision).toEqual({ decision: "block", reason: "no" });
    expect(ran).toEqual(["first", "blocker"]);
  });

  test("无 block 时返回首个 approve", async () => {
    setHooksExecutorForTest(async (hook) =>
      hook.id === "second" ? { decision: "approve" } : undefined,
    );
    await setHookConfigs([cfg({ id: "first" }), cfg({ id: "second" }), cfg({ id: "third" })]);
    expect((await runHooks("Stop", basePayload()))?.decision).toBe("approve");
  });

  test("全部放行返回 undefined；matcher 不命中的决策钩子不执行", async () => {
    let ran = 0;
    setHooksExecutorForTest(async (hook) => {
      ran += 1;
      return hook.id === "read-only" ? { decision: "block" } : undefined;
    });
    await setHookConfigs([
      cfg({ id: "read-only", event: "PreToolUse", matcher: "^read$" }),
      cfg({ id: "any", event: "PreToolUse", matcher: "" }),
    ]);
    expect(
      await runHooks("PreToolUse", { ...basePayload("PreToolUse"), tool: { name: "bash" } }),
    ).toBeUndefined();
    expect(ran).toBe(1);
  });
});

describe("真实 spawn 冒烟", () => {
  test("exit 0 无 stdout JSON → 无决策", async () => {
    await useRealSpawn();
    await setHookConfigs([cfg({ id: "ok", command: "true" })]);
    expect(await runHooks("Stop", basePayload())).toBeUndefined();
  });

  test("exit 2 → block，reason 取 stderr", async () => {
    await useRealSpawn();
    await setHookConfigs([
      cfg({
        id: "deny",
        event: "PreToolUse",
        command: process.execPath,
        args: ["-e", `console.error("denied by policy"); process.exit(2)`],
      }),
    ]);
    expect(await runHooks("PreToolUse", basePayload("PreToolUse"))).toEqual({
      decision: "block",
      reason: "denied by policy",
    });
  });

  test("exit 0 + stdout JSON decision=approve", async () => {
    await useRealSpawn();
    await setHookConfigs([
      cfg({
        id: "allow",
        event: "PreToolUse",
        command: process.execPath,
        args: ["-e", `console.log(JSON.stringify({decision: "approve", reason: "ok"}))`],
      }),
    ]);
    expect(await runHooks("PreToolUse", basePayload("PreToolUse"))).toEqual({
      decision: "approve",
      reason: "ok",
    });
  });

  test("stdin JSON 负载可达子进程（exit 2 回传事件名证明 round-trip）", async () => {
    await useRealSpawn();
    await setHookConfigs([
      cfg({
        id: "echo-stdin",
        command: process.execPath,
        args: [
          "-e",
          `const d = JSON.parse(require("fs").readFileSync(0, "utf8"));
           if (d.event === "Stop" && d.sessionId === "s-1") process.exit(2);
           process.exit(0);`,
        ],
      }),
    ]);
    expect((await runHooks("Stop", basePayload()))?.decision).toBe("block");
  });

  test("超时 kill 后放行（timeoutMs 钳到下限 1s）", async () => {
    await useRealSpawn();
    await setHookConfigs([
      cfg({
        id: "slow",
        command: process.execPath,
        args: ["-e", `setInterval(() => {}, 1000)`],
        timeoutMs: 1,
      }),
    ]);
    const started = Date.now();
    expect(await runHooks("Stop", basePayload())).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(5000);
  }, 10000);

  test("shell 类型经 shell -c 解释（支持重定向/管道语法）", async () => {
    await useRealSpawn();
    await setHookConfigs([
      cfg({ id: "sh", type: "shell", command: `echo "denied" >&2; exit 2` }),
    ]);
    expect(await runHooks("Stop", basePayload())).toEqual({
      decision: "block",
      reason: "denied",
    });
  });

  test("后台运行立即返回，决策被丢弃且不阻塞", async () => {
    await useRealSpawn();
    await setHookConfigs([cfg({ id: "bg", command: "sleep 5", background: true })]);
    const started = Date.now();
    expect(await runHooks("Stop", basePayload())).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(2000);
  }, 10000);

  test("spawn 失败（命令不存在）→ 放行不抛出", async () => {
    await useRealSpawn();
    await setHookConfigs([cfg({ id: "missing", command: "definitely-not-a-command-xyz" })]);
    expect(await runHooks("Stop", basePayload())).toBeUndefined();
  });
});
