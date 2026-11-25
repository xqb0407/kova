import { describe, test, expect, beforeAll } from "bun:test";
import {
  buildHookPayload,
  hookRunOptions,
  initHooks,
  matchingHooks,
  resetHooksForTest,
  runHooks,
  setHookConfigs,
  setHookSystemMessageSink,
  setHooksExecutorForTest,
  shellArgsFor,
  truncateHookText,
  type HookConfig,
  type HookPayload,
  type HookSystemMessage,
} from "../../src/agent/hooks";
import { kvGet } from "../../src/storage/hostdb";
import { initStorage } from "../../src/storage/storage";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const tmp = mkdtempSync(path.join(tmpdir(), "pi-agent-hooks-"));

beforeAll(() => {
  initStorage(path.join(tmp, "state.db"), path.join(tmp, "sessions"));
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
    // 显式 process：绝大多数用例用 execPath + args 验证 argv 直执行；
    // shell 语义由专门用例覆盖
    type: "process",
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

  test("SessionStart matcher 按 source 匹配，startup 兼容 create", async () => {
    await setHookConfigs([
      cfg({ id: "startup", event: "SessionStart", matcher: "startup" }),
      cfg({ id: "resume", event: "SessionStart", matcher: "^resume$" }),
      cfg({ id: "all", event: "SessionStart", matcher: "" }),
      cfg({ id: "create", event: "SessionStart", matcher: "create" }),
    ]);
    expect(matchingHooks("SessionStart", ["create", "startup"]).map((h) => h.id)).toEqual([
      "startup",
      "all",
      "create",
    ]);
    expect(matchingHooks("SessionStart", ["resume"]).map((h) => h.id)).toEqual(["resume", "all"]);
  });
});

describe("显式 shell 参数", () => {
  test("cmd/PowerShell 不按 -c 传参", () => {
    expect(shellArgsFor("/bin/bash", "echo hi")).toEqual(["-c", "echo hi"]);
    expect(shellArgsFor("C:\\Windows\\System32\\cmd.exe", "echo hi")).toEqual([
      "/d",
      "/s",
      "/c",
      "echo hi",
    ]);
    expect(shellArgsFor("powershell.exe", "Get-Date")).toEqual(["-Command", "Get-Date"]);
    expect(shellArgsFor("pwsh", "Get-Date")).toEqual(["-Command", "Get-Date"]);
  });
});

describe("payload 组包与截断", () => {  test("truncateHookText：字符串/对象序列化、超长截断", () => {
    expect(truncateHookText(undefined)).toBeUndefined();
    expect(truncateHookText("abc")).toBe("abc");
    expect(truncateHookText({ a: 1 })).toBe('{"a":1}');
    const long = truncateHookText("x".repeat(3000));
    expect(long!.length).toBeLessThanOrEqual(2000 + 12);
    expect(long!.endsWith("[truncated]")).toBe(true);
  });

  test("buildHookPayload：tool 事件带 tool、结果摘要截断、Stop 不带 tool", () => {
    const stop = buildHookPayload({
      event: "Stop",
      sessionId: "s",
      threadId: "t",
      turnId: "turn-1",
    });
    expect(stop.event).toBe("Stop");
    expect(stop.tool).toBeUndefined();
    expect(stop.result).toBeUndefined();
    // Codex hooks：turn id 同时给驼峰与 snake_case 别名
    expect(stop).toMatchObject({ turnId: "turn-1", turn_id: "turn-1" });

    const pre = buildHookPayload({
      event: "PreToolUse",
      sessionId: "s",
      toolName: "bash",
      toolArgs: { cmd: "ls" },
    });
    expect(pre.tool).toEqual({ name: "bash", args: { cmd: "ls" } });
    // Claude 生态扁平别名
    expect(pre).toMatchObject({
      hook_event_name: "PreToolUse",
      session_id: "s",
      tool_name: "bash",
      tool_input: { cmd: "ls" },
    });

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

  test("hookRunOptions：Codex 通用字段（model / permission_mode / transcript / 请求上下文）", async () => {
    const run = {
      cwd: "/ws",
      sessionId: "sess-h",
      mode: "agent" as const,
      approvalLevel: "auto-edit" as const,
      agent: { state: { model: { id: "gpt-5-codex" } } },
    };
    expect(hookRunOptions(run)).toMatchObject({
      workspace: "/ws",
      model: "gpt-5-codex",
      permissionMode: "acceptEdits",
    });
    expect(hookRunOptions({ ...run, mode: "plan" }).permissionMode).toBe("plan");
    expect(hookRunOptions({ ...run, approvalLevel: "auto" }).permissionMode).toBe(
      "bypassPermissions",
    );

    let captured: HookPayload | undefined;
    setHooksExecutorForTest(async (_hook, payload) => {
      captured = payload;
      return undefined;
    });
    await setHookConfigs([
      cfg({ id: "model-req", event: "PreModelRequest" }),
    ]);
    await runHooks(
      "PreModelRequest",
      buildHookPayload({
        event: "PreModelRequest",
        sessionId: "sess-h",
        threadId: "th",
        turnId: "turn-1",
      }),
      hookRunOptions(run, {
        model: "gpt-5-codex",
        attemptNumber: 1,
        requestId: "req-1",
        samplingKind: "sampling",
      }),
    );
    expect(captured).toMatchObject({
      model: "gpt-5-codex",
      permission_mode: "acceptEdits",
      attempt_number: 1,
      request_id: "req-1",
      kind: "sampling",
      thread_id: "th",
      turn_id: "turn-1",
    });
    expect(captured?.transcript_path).toContain("sess-h.jsonl");
  });
});

describe("决策解析与执行（注入 executor）", () => {
  test("runHooks 对 SessionStart 用 source 过滤（startup 兼容 create）", async () => {
    const ran: string[] = [];
    setHooksExecutorForTest(async (hook) => {
      ran.push(hook.id);
      return undefined;
    });
    await setHookConfigs([
      cfg({ id: "startup", event: "SessionStart", matcher: "startup" }),
      cfg({ id: "resume", event: "SessionStart", matcher: "resume" }),
    ]);
    await runHooks("SessionStart", {
      event: "SessionStart",
      sessionId: "s",
      timestamp: new Date().toISOString(),
      source: "create",
    });
    expect(ran).toEqual(["startup"]);
  });

  test("新事件 matcher：SubagentStop 名称 / PreCompact auto / Notification kind", async () => {
    const ran: string[] = [];
    setHooksExecutorForTest(async (hook) => {
      ran.push(hook.id);
      return undefined;
    });
    await setHookConfigs([
      cfg({ id: "fixer", event: "SubagentStop", matcher: "^fixer$" }),
      cfg({ id: "reviewer", event: "SubagentStop", matcher: "reviewer" }),
      cfg({ id: "auto", event: "PreCompact", matcher: "auto" }),
      cfg({ id: "manual", event: "PreCompact", matcher: "manual" }),
      cfg({ id: "perm", event: "Notification", matcher: "permission" }),
    ]);

    await runHooks("SubagentStop", {
      ...basePayload("SubagentStop"),
      subagent: { id: "d1", name: "fixer", status: "completed" },
    });
    expect(ran).toEqual(["fixer"]);

    ran.length = 0;
    await runHooks("PreCompact", {
      ...basePayload("PreCompact"),
      compaction: { trigger: "overflow", tokensBefore: 1000 },
    });
    expect(ran).toEqual(["auto"]);

    ran.length = 0;
    await runHooks("Notification", {
      ...basePayload("Notification"),
      notification: { kind: "permission" },
    });
    expect(ran).toEqual(["perm"]);
  });

  test("block 生效（并行执行，后续钩子仍会跑）", async () => {
    const ran: string[] = [];
    setHooksExecutorForTest(async (hook) => {
      ran.push(hook.id);
      if (hook.id === "blocker") return { decision: "block", reason: "no" };
      return undefined;
    });
    await setHookConfigs([cfg({ id: "first" }), cfg({ id: "blocker" }), cfg({ id: "never" })]);
    const decision = await runHooks("Stop", basePayload());
    expect(decision).toEqual({ decision: "block", reason: "no" });
    expect(ran).toEqual(["first", "blocker", "never"]);
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

  test("Claude 输出：permissionDecision deny/allow/ask", async () => {
    await useRealSpawn();
    const cc = (permissionDecision: string, reason?: string) =>
      `console.log(JSON.stringify({hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:${
        JSON.stringify(permissionDecision)
      }${reason !== undefined ? `,permissionDecisionReason:${JSON.stringify(reason)}` : ""}}}))`;

    await setHookConfigs([
      cfg({
        id: "cc-deny",
        event: "PreToolUse",
        command: process.execPath,
        args: ["-e", cc("deny", "cc says no")],
      }),
    ]);
    expect(await runHooks("PreToolUse", basePayload("PreToolUse"))).toEqual({
      decision: "block",
      reason: "cc says no",
    });

    await setHookConfigs([
      cfg({
        id: "cc-allow",
        event: "PreToolUse",
        command: process.execPath,
        args: ["-e", cc("allow")],
      }),
    ]);
    expect((await runHooks("PreToolUse", basePayload("PreToolUse")))?.decision).toBe("approve");

    await setHookConfigs([
      cfg({
        id: "cc-ask",
        event: "PreToolUse",
        command: process.execPath,
        args: ["-e", cc("ask")],
      }),
    ]);
    expect(await runHooks("PreToolUse", basePayload("PreToolUse"))).toBeUndefined();
  });

  test("Claude PermissionRequest 输出：decision.behavior allow/deny", async () => {
    await useRealSpawn();
    const cc = (behavior: string, message?: string) =>
      `console.log(JSON.stringify({hookSpecificOutput:{hookEventName:"PermissionRequest",decision:{behavior:${
        JSON.stringify(behavior)
      }${message !== undefined ? `,message:${JSON.stringify(message)}` : ""}}}}))`;

    await setHookConfigs([
      cfg({
        id: "cc-deny",
        event: "PermissionRequest",
        command: process.execPath,
        args: ["-e", cc("deny", "not this one")],
      }),
    ]);
    expect(await runHooks("PermissionRequest", basePayload("PermissionRequest"))).toEqual({
      decision: "block",
      reason: "not this one",
    });

    await setHookConfigs([
      cfg({
        id: "cc-allow",
        event: "PermissionRequest",
        command: process.execPath,
        args: ["-e", cc("allow")],
      }),
    ]);
    expect((await runHooks("PermissionRequest", basePayload("PermissionRequest")))?.decision).toBe(
      "approve",
    );
  });

  test("Claude 通用字段：continue:false → block+stop，systemMessage 透传", async () => {
    await useRealSpawn();
    await setHookConfigs([
      cfg({
        id: "halt",
        event: "PreToolUse",
        command: process.execPath,
        args: ["-e", `console.log(JSON.stringify({continue: false, reason: "halt now"}))`],
      }),
    ]);
    expect(await runHooks("PreToolUse", basePayload("PreToolUse"))).toEqual({
      decision: "block",
      reason: "halt now",
      stop: true,
    });

    await setHookConfigs([
      cfg({
        id: "warn",
        event: "PreToolUse",
        command: process.execPath,
        args: [
          "-e",
          `console.log(JSON.stringify({decision: "approve", systemMessage: "heads up"}))`,
        ],
      }),
    ]);
    expect(await runHooks("PreToolUse", basePayload("PreToolUse"))).toMatchObject({
      decision: "approve",
      systemMessage: "heads up",
    });
  });

  test("systemMessage 通过 sink 交给 UI 层", async () => {
    const seen: HookSystemMessage[] = [];
    try {
      await useRealSpawn(); // 先清测试缝，再装 sink（reset 会清掉 sink）
      setHookSystemMessageSink((message) => seen.push(message));
      await setHookConfigs([
        cfg({
          id: "warn",
          event: "Stop",
          command: process.execPath,
          args: ["-e", `console.log(JSON.stringify({systemMessage: "heads up"}))`],
        }),
      ]);
      await runHooks("Stop", basePayload());
      expect(seen).toEqual([
        {
          sessionId: "s-1",
          threadId: "t-1",
          event: "Stop",
          hookName: "h",
          text: "heads up",
        },
      ]);
    } finally {
      setHookSystemMessageSink(undefined);
    }
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
    await setHookConfigs([
      cfg({
        id: "bg",
        command: process.execPath,
        args: ["-e", "setTimeout(() => {}, 500)"],
        background: true,
      }),
    ]);
    const started = Date.now();
    expect(await runHooks("Stop", basePayload())).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(2000);
  }, 10000);

  test("后台钩子到超时仍会被杀（不会永远残留）", async () => {
    await useRealSpawn();
    const marker = path.join(tmp, `bg-timeout-${Date.now()}.txt`);
    rmSync(marker, { force: true });
    await setHookConfigs([
      cfg({
        id: "bg-timeout",
        command: process.execPath,
        args: [
          "-e",
          `setTimeout(() => require("fs").writeFileSync(${JSON.stringify(marker)}, "survived"), 1500)`,
        ],
        background: true,
        timeoutMs: 1000,
      }),
    ]);
    const started = Date.now();
    expect(await runHooks("Stop", basePayload())).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(1000);
    // 等过子进程原定写标记的时刻：若超时没杀，标记会出现
    await new Promise((r) => setTimeout(r, 1200));
    expect(existsSync(marker)).toBe(false);
  }, 10000);

  test("超时杀整棵进程树（孙进程不残留）", async () => {
    if (process.platform === "win32") return; // Windows 走 taskkill /T，Shell 语法不同
    await useRealSpawn();
    const marker = path.join(tmp, `pg-timeout-${Date.now()}.txt`);
    rmSync(marker, { force: true });
    await setHookConfigs([
      cfg({
        id: "pg-timeout",
        type: "shell",
        command: `(sleep 2; echo leaked > ${JSON.stringify(marker)}) & wait`,
        timeoutMs: 1000,
      }),
    ]);
    expect(await runHooks("Stop", basePayload())).toBeUndefined();
    // 等过孙进程原定写标记的时刻
    await new Promise((r) => setTimeout(r, 1600));
    expect(existsSync(marker)).toBe(false);
  }, 10000);

  test("未显式 type 时默认按 shell 解释整串命令", async () => {
    await useRealSpawn();
    const marker = path.join(tmp, `default-shell-${Date.now()}.txt`);
    rmSync(marker, { force: true });
    await setHookConfigs([
      {
        id: "default-shell",
        name: "default-shell",
        command: `echo kova-default > ${JSON.stringify(marker)}`,
        event: "Stop",
        enabled: true,
      },
    ]);
    expect(await runHooks("Stop", basePayload())).toBeUndefined();
    expect(readFileSync(marker, "utf8").trim()).toBe("kova-default");
  }, 10000);

  test("钩子以会话工作区为 cwd，payload/env 带 CLAUDE_PROJECT_DIR", async () => {
    await useRealSpawn();
    const ws = realpathSync(mkdtempSync(path.join(tmpdir(), "pi-agent-hook-ws-")));
    const marker = path.join(ws, "cwd.txt");
    await setHookConfigs([
      cfg({
        id: "cwd",
        command: process.execPath,
        args: [
          "-e",
          `const fs = require("fs");
           const d = JSON.parse(fs.readFileSync(0, "utf8"));
           fs.writeFileSync("cwd.txt", [process.cwd(), d.cwd, process.env.CLAUDE_PROJECT_DIR].join("\\n"));`,
        ],
      }),
    ]);
    expect(await runHooks("Stop", basePayload(), { workspace: ws })).toBeUndefined();
    expect(readFileSync(marker, "utf8").trim().split("\n")).toEqual([ws, ws, ws]);
  }, 10000);

  test("工作区目录尚未创建（惰性任务目录）时钩子仍能执行", async () => {
    await useRealSpawn();
    const missing = path.join(tmp, `not-created-${Date.now()}`, "session");
    const marker = path.join(tmp, `missing-ws-${Date.now()}.txt`);
    await setHookConfigs([
      cfg({
        id: "missing-ws",
        command: process.execPath,
        args: [
          "-e",
          `require("fs").writeFileSync(${JSON.stringify(marker)},
             process.cwd() + "\\n" + process.env.CLAUDE_PROJECT_DIR);`,
        ],
      }),
    ]);
    expect(await runHooks("Stop", basePayload(), { workspace: missing })).toBeUndefined();
    const [actualCwd, projectDir] = readFileSync(marker, "utf8").trim().split("\n");
    // spawn 不应因 cwd 不存在而失败；env 仍指向会话工作区，且不替会话建目录
    expect(actualCwd).not.toBe(missing);
    expect(projectDir).toBe(missing);
    expect(existsSync(missing)).toBe(false);
  }, 10000);

  test("spawn 失败（process 类型命令不存在）→ 放行不抛出", async () => {
    await useRealSpawn();
    await setHookConfigs([
      cfg({ id: "missing", type: "process", command: "definitely-not-a-command-xyz" }),
    ]);
    expect(await runHooks("Stop", basePayload())).toBeUndefined();
  });
});
