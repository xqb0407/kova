/**
 * 最小行为回归 e2e（独立进程、脚本化 provider，不进 bun test 套件——与
 * 成熟实现的 e2e harness 同形态）。
 *
 * 运行：bun run e2e-behavior/run.ts
 *
 * 脚本化 provider（mock catalog 的 streamSimple/completeSimple）回放固定对话，
 * 驱动**真实** agent 循环与**真实**工具执行，断言行为结果：
 *   1. 缩进偏差 edit → 降级命中且工具结果带 matched via 提示
 *   2. 长 turn 压缩 → runCompaction 成功、摘要落 checkpoint、回放自洽
 *   3. bash 被信号杀死 → 不谎报 timeout，报 terminated by signal
 *
 * 为什么独立进程：harness 用 mock.module 替换模型目录（进程级）。放进 bun test
 * 会把假 catalog 泄漏给同进程的其它测试文件（凭据类泄漏的同款污染），独立
 * 进程天然隔离——与 test:isolated 的哲学一致。
 */
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
// 看门狗：卡死场景（脚本消费错位导致 await 永不落定）强制退出并保留现场
setTimeout(() => {
  console.error("WATCHDOG TIMEOUT: harness hung; dump partial state and exit");
  process.exit(2);
}, 45_000).unref?.();
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mock } from "bun:test";
import type { Api, AssistantMessage, Model, ToolCall } from "@earendil-works/pi-ai";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai";

/* ---------------------------- 脚本化模型层 ---------------------------- */

const model = {
  id: "scripted",
  name: "scripted",
  api: "openai-completions",
  provider: "e2e",
  baseUrl: "",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 8_192,
} as unknown as Model<Api>;

type ScriptedTurn = {
  toolCalls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }>;
  text?: string;
};

const turnScript: ScriptedTurn[] = [];
let turnIndex = 0;

function usage() {
  return {
    input: 10,
    output: 20,
    cacheRead: 0,
    cacheWrite: 0,
    reasoning: 0,
    totalTokens: 30,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function partialOf(): AssistantMessage {
  return {
    role: "assistant",
    stopReason: "pending",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: usage(),
    timestamp: Date.now(),
  } as unknown as AssistantMessage;
}

/** 一次模型请求：按脚本产出事件流（真实循环消费并执行真实工具） */
function scriptedStream(): AssistantMessageEventStream {
  // 脚本耗尽 → 文本收尾轮（stop）：真实模型总会停，钳位重复最后一个工具调用
  // 会让循环永不终止（harness 实测 258+ 轮 bash 的教训）
  const turn =
    turnIndex < turnScript.length ? turnScript[turnIndex]! : { text: "(script exhausted — stopping)" };
  turnIndex += 1;
  console.error(`[e2e] scripted turn ${turnIndex}: tools=${turn.toolCalls?.map((c) => c.name).join(",") ?? "-"} text=${turn.text ? "yes" : "no"}`);
  const stream = new AssistantMessageEventStream();
  const partial = partialOf();
  const content: AssistantMessage["content"] = [];
  const blocks: AssistantMessage["content"] = [];
  let index = 0;
  const push = stream.push.bind(stream);
  queueMicrotask(() => {
    try {
      push({ type: "start", partial });
      if (turn.text) {
        const textBlock = { type: "text" as const, text: turn.text };
        // 与 pi proxy 同款：先写 partial.content 再发事件——循环从 partial
        // 累积工具调用，只发事件不改 partial 会让循环看不到工具（实测空转）
        partial.content = [...partial.content, textBlock];
        push({ type: "text_start", contentIndex: index, partial });
        push({ type: "text_delta", contentIndex: index, delta: turn.text, partial });
        push({ type: "text_end", contentIndex: index, content: turn.text, partial });
        content.push(textBlock);
        index += 1;
      }
      for (const call of turn.toolCalls ?? []) {
        const toolCall: ToolCall = {
          type: "toolCall",
          id: call.id,
          name: call.name,
          arguments: call.arguments,
        };
        partial.content = [...partial.content, toolCall];
        push({ type: "toolcall_start", contentIndex: index, partial });
        push({
          type: "toolcall_delta",
          contentIndex: index,
          delta: JSON.stringify(call.arguments),
          partial,
        });
        push({ type: "toolcall_end", contentIndex: index, toolCall, partial });
        content.push(toolCall);
        index += 1;
      }
      const finalMessage = {
        ...partial,
        content,
        stopReason: turn.toolCalls?.length ? "toolUse" : "stop",
        usage: usage(),
      } as unknown as AssistantMessage;
      push({
        type: "done",
        reason: turn.toolCalls?.length ? "toolUse" : "stop",
        message: finalMessage,
      } as never);
    } catch (error) {
      push({
        type: "error",
        reason: "error",
        error: { ...partialOf(), stopReason: "error", errorMessage: String(error) },
      } as never);
    }
  });
  return stream;
}

/** 压缩摘要请求（completeSimple）：按摘要脚本返回 */
const summaryScript: string[] = [];
let summaryIndex = 0;

const fakeCatalog = {
  getAvailable: async () => [model],
  getModel: () => model,
  getModels: () => [model],
  streamSimple: (_m: unknown, ctx?: { messages?: unknown[] }) => {
    const count = ctx?.messages?.length ?? 0;
    // 会话标题生成（session-title-summarize）是 1 消息的旁路请求：不消费
    // turn 脚本槽，直接给一个空 stop（标题内容对行为断言无关）
    if (count <= 1) {
      const stream = new AssistantMessageEventStream();
      const message = {
        role: "assistant",
        stopReason: "stop",
        content: [{ type: "text", text: "(title)" }],
        usage: usage(),
        timestamp: Date.now(),
      } as unknown as AssistantMessage;
      queueMicrotask(() => {
        stream.push({ type: "start", partial: message } as never);
        stream.push({ type: "done", reason: "stop", message } as never);
      });
      return stream;
    }
    console.error(`[e2e] streamSimple: ctxMessages=${count} consumes script slot ${turnIndex}`);
    return scriptedStream();
  },
  completeSimple: async () => {
    const text = summaryScript[Math.min(summaryIndex, summaryScript.length - 1)] ?? "SUMMARY";
    summaryIndex += 1;
    return {
      role: "assistant",
      stopReason: "stop",
      content: [{ type: "text", text }],
      usage: usage(),
      timestamp: Date.now(),
    } as unknown as AssistantMessage;
  },
};

// Proxy 兜底：harness 进程里其它目录消费面（遥测/图像生成等）一律 no-op，
// 避免为每个冷门方法补桩
const fakeCatalogProxy = new Proxy(fakeCatalog, {
  get(target, prop) {
    if (prop in target) return target[prop as keyof typeof target];
    return () => undefined;
  },
});

import * as catalogOriginal from "../src/model/catalog";
import * as catalogShimOriginal from "../src/model/model-catalog";

// 覆写 getModels/defaultModel，其余导出展开透传（消费面完整）。两层都要 mock：
// shim（model-catalog）是多数消费方的 import 面，catalog 是 shim 的重导出源。
// 注意 bun 的 mock.module 工厂必须返回纯对象——Proxy/命名空间对象不生效
// （实测探针：Proxy 工厂 trapHits=0，展开对象正常拦截）。
const overrideNamespace = (target: Record<string, unknown>) => ({
  ...target,
  getModels: () => fakeCatalogProxy,
  defaultModel: async () => model,
});

mock.module("../src/model/catalog", () => overrideNamespace(catalogOriginal as never));
mock.module("../src/model/model-catalog", () => overrideNamespace(catalogShimOriginal as never));

/* ---------------------------- 协议层与捕获 ---------------------------- */

const { initStorage } = await import("../src/storage/storage");
const { dispatchPrompt } = await import("../src/protocol/protocol");
const { resolveSession } = await import("../src/sessions/sessions");
const { runCompaction, defaultSummarize } = await import("../src/agent/context");
const { readCompaction } = await import("../src/sessions/transcript");
const { initCapabilities } = await import("../src/agent/assembly");
const { installLocalHost } = await import("../src/local-host");
const { clearTodoState } = await import("../src/todo/todo");

const tmp = mkdtempSync(join(tmpdir(), "kova-e2e-behavior-"));
const ws = join(tmp, "ws");
mkdirSync(ws, { recursive: true });
initStorage(join(tmp, "state.db"), join(tmp, "sessions"));
installLocalHost(); // hostTool(edit/bash/…) 的本地执行宿主（ACP 同款），不装会永挂
await initCapabilities();

const lines: string[] = [];
const origWrite = process.stdout.write.bind(process.stdout);
(process.stdout as unknown as { write: (c: unknown) => boolean }).write = (c: unknown) => {
  lines.push(String(c));
  return true;
};

let failures = 0;
function check(name: string, fn: () => boolean | Promise<boolean>): Promise<void> {
  return (async () => {
    try {
      const ok = await fn();
      origWrite(`${ok ? "PASS" : "FAIL"} ${name}\n`);
      if (!ok) failures += 1;
    } catch (error) {
      origWrite(`FAIL ${name}: ${error instanceof Error ? error.message : String(error)}\n`);
      failures += 1;
    }
  })();
}

const stdoutHas = (needle: string): boolean =>
  lines.some((line) => line.includes(needle));

/** 断言源用 run 的真实消息（工具结果文本），不耦合线上 chunk 形状 */
const toolResultTexts = (): string[] => {
  const messages = preRun.agent.state.messages as Array<{
    role?: string;
    toolName?: string;
    content?: unknown;
  }>;
  return messages
    .filter((m) => m.role === "toolResult")
    .map((m) => {
      const c = m.content;
      if (typeof c === "string") return c;
      return Array.isArray(c)
        ? c.map((b) => (b as { text?: string }).text ?? "").join("")
        : "";
    });
};

async function dispatch(text: string, reqId: string): Promise<void> {
  turnIndex = 0;
  console.error(`[e2e] dispatch ${reqId} start`);
  await dispatchPrompt(reqId, { type: "prompt", text, threadId: "th-e2e", cwd: ws });
  console.error(`[e2e] dispatch ${reqId} settled`);
}

// 预建 run 并切到完全访问：harness 没有人应答审批卡，默认 ask 档下
// edit/bash 会挂在 pendingInteraction 上永等（工具路径永不收尾）
const preRun = await resolveSession("th-e2e", undefined, ws);
preRun.approvalLevel = "auto";
// 关掉缓存保活：warmer 的 TTL 回放会真实调用 streamSimple，把脚本槽
// 悄悄消费掉（实测 turn 1 后 edit 脚本被暖缓存吃掉，模型拿到的是下一槽）
preRun.cacheWarmer = undefined;

/* ------------------------------- 场景 ------------------------------- */

// 场景 1：缩进偏差 edit → 降级命中（真实工具循环 + pi-edit-match 管线）
await check("edit 缩进偏差降级命中且输出 matched via", async () => {
  writeFileSync(join(ws, "code.ts"), "if (x) {\n    deep();\n}\n");
  turnScript.length = 0;
  turnScript.push(
    { toolCalls: [{ id: "c-read", name: "read", arguments: { file_path: "code.ts" } }] },
    {
      toolCalls: [
        {
          id: "c-edit",
          name: "edit",
          arguments: {
            file_path: "code.ts",
            old_string: "if (x) {\n  deep();\n}",
            new_string: "if (x) {\n    deep();\n    done();\n}",
          },
        },
      ],
    },
    { text: "edited" },
  );
  await dispatch("fix indentation", "e2e-edit");
  const results = toolResultTexts().join("\n");
  return (
    results.includes("matched via line_trimmed") &&
    readFileSync(join(ws, "code.ts"), "utf8") === "if (x) {\n    deep();\n    done();\n}\n"
  );
});

// 场景 2：bash 被信号杀死 → 不谎报 timeout
await check("bash 信号退出报 terminated by signal", async () => {
  turnScript.length = 0;
  turnScript.push({ toolCalls: [{ id: "c-sig", name: "bash", arguments: { command: "kill -TERM $$" } }] });
  await dispatch("run a self-terminating command", "e2e-sig");
  const results = toolResultTexts().join("\n");
  return results.includes("terminated by signal") && !results.includes("timeout after");
});

// 场景 3：长 turn 会话压缩 → 摘要落 checkpoint，回放自洽
await check("压缩：摘要落 checkpoint 且 run 上下文被替换", async () => {
  turnScript.length = 0;
  for (let i = 0; i < 6; i++) {
    turnScript.push({ toolCalls: [{ id: `c-bash-${i}`, name: "bash", arguments: { command: `echo step-${i}` } }] });
  }
  turnScript.push({ text: "all steps done" });
  await dispatch("run the steps", "e2e-compact");

  summaryScript.length = 0;
  summaryScript.push(
    "### In Progress\nNone\n### Blocked\nNone\n### Key Decisions\nRan six echo steps\n### Next Steps\nNone\n### Critical Context\nworkspace was the temp dir",
  );
  const run = await resolveSession("th-e2e");
  const outcome = await runCompaction(run, "manual", {
    summarize: defaultSummarize(model, undefined, fakeCatalog as never),
  });
  const cp = readCompaction(run.sessionId);
  return Boolean(outcome.ok && outcome.summarized) && Boolean(cp?.summary?.includes("Ran six echo steps"));
});

(process.stdout as unknown as { write: (c: unknown) => boolean }).write = origWrite;
clearTodoState("th-e2e");
rmSync(tmp, { recursive: true, force: true });
origWrite(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`}\n`);
process.exit(failures === 0 ? 0 : 1);
