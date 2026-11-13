/**
 * PTC 的 `run_code` 工具。
 *
 * 模型写一段 JavaScript async 函数体，在 QuickJS 里通过 `tools.<name>(args)`
 * 调用只读工具；只有脚本的返回值/输出回到模型，子调用结果只进 details。
 * 沙箱、prelude、声明渲染复用 `@earendil-works/pi-codemode`。
 */
import type {
  AgentTool,
  AgentToolResult,
  AgentToolUpdateCallback,
} from "@earendil-works/pi-agent-core";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import {
  CodemodeSandbox,
  renderDeclarations,
  toCodemodeIdentifier,
  type CodemodeJsonSchema,
  type CodemodeResult,
  type CodemodeTool,
} from "@earendil-works/pi-codemode";
import { num, obj, opt, str } from "@earendil-works/pi-schema";
import type { Running } from "../../types";
import { codemodeWorkerUrl, loadCodemodeWasm } from "../codemode-runtime";
import {
  createPtcChildBridge,
  PTC_READ_ONLY_TOOL_NAMES,
  ptcEnvelopeSchema,
  type PtcChildBridge,
  type PtcChildCall,
} from "./child-bridge";

export const RUN_CODE_TOOL_NAME = "run_code";

/** 脚本默认/最长墙钟；与 MiniMax 的 run_code 同口径。 */
export const PTC_DEFAULT_TIMEOUT_MS = 120_000;
export const PTC_MAX_TIMEOUT_MS = 3_600_000;
/** 单次脚本文本上限；Bun 的 JSON schema 与运行时各校验一次。 */
export const PTC_MAX_CODE_CHARS = 64 * 1024;
/** QuickJS 堆上限：sidecar 与主进程同机，失控脚本不能把整条链拖死。 */
const PTC_MEMORY_LIMIT_BYTES = 128 * 1024 * 1024;
/** 输出文本上限；超出保留头尾，图片不参与截断。 */
const PTC_MAX_OUTPUT_CHARS = 64 * 1024;
/** 工具声明超过这个长度就退化成「名字 + 一行描述」。 */
const PTC_MAX_DECLARATION_CHARS = 12_000;
/** 进程级沙箱并发：Kova 一侧可能一次并发多个 run_code，不能每个都起一个 128MB VM。 */
const PTC_MAX_CONCURRENT_SANDBOXES = 2;
const PTC_SANDBOX_WAIT_MS = 60_000;

let activeSandboxes = 0;
const sandboxWaiters: (() => void)[] = [];

/**
 * 申请一个沙箱槽位；等待时间计入 timeout_ms。返回时 activeSandboxes 已加一，
 * 调用方必须在 finally 里 releaseSandbox()。
 */
function acquireSandbox(
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<"ok" | "timeout" | "aborted"> {
  if (signal?.aborted) return Promise.resolve("aborted");
  if (activeSandboxes < PTC_MAX_CONCURRENT_SANDBOXES) {
    activeSandboxes++;
    return Promise.resolve("ok");
  }
  return new Promise((resolve) => {
    const settle = (result: "ok" | "timeout" | "aborted") => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      const index = sandboxWaiters.indexOf(grant);
      if (index >= 0) sandboxWaiters.splice(index, 1);
      resolve(result);
    };
    const grant = () => {
      // grant 与 abort 同帧竞态时不再白起一个 worker（~20ms spawn + wasm 实例化）
      if (signal?.aborted) {
        settle("aborted");
        return;
      }
      activeSandboxes++;
      settle("ok");
    };
    const onAbort = () => settle("aborted");
    const timer = setTimeout(
      () => settle("timeout"),
      Math.min(timeoutMs, PTC_SANDBOX_WAIT_MS),
    );
    sandboxWaiters.push(grant);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function releaseSandbox(): void {
  activeSandboxes = Math.max(0, activeSandboxes - 1);
  while (
    activeSandboxes < PTC_MAX_CONCURRENT_SANDBOXES &&
    sandboxWaiters.length > 0
  ) {
    sandboxWaiters.shift()?.();
  }
}

const runCodeSchema = obj({
  code: str({
    description:
      "Raw JavaScript async function body (not TypeScript, no markdown fence). " +
      "Call tools with `await tools.<name>(args)`, output with `text()`, `image()`, `console.log()`, or `return`.",
    minLength: 1,
    maxLength: PTC_MAX_CODE_CHARS,
  }),
  description: opt(
    str({
      description: "Short title for this run, shown in the tool card.",
      maxLength: 512,
    }),
  ),
  timeout_ms: opt(
    num({
      description: `Wall clock in milliseconds. Default ${PTC_DEFAULT_TIMEOUT_MS}, capped at ${PTC_MAX_TIMEOUT_MS}.`,
      minimum: 1,
    }),
  ),
});

export type RunCodeParams = {
  code: string;
  description?: string;
  timeout_ms?: number;
};

export interface RunCodePtcDetails {
  calls: PtcChildCall[];
  wallTimeMs: number;
  description: string;
  timeoutMs: number;
}

export interface RunCodeDetails {
  ptc: RunCodePtcDetails;
}

export type RunCodeTool = AgentTool<typeof runCodeSchema, RunCodeDetails>;

export function createRunCodeTool(run: Running): RunCodeTool {
  const description = buildDescription(run);
  return {
    name: RUN_CODE_TOOL_NAME,
    label: "Run Code",
    description,
    parameters: runCodeSchema,
    execute: async (toolCallId, params, signal, onUpdate) =>
      executeRunCode(run, toolCallId, params as RunCodeParams, signal, onUpdate),
  };
}

/**
 * `toolsForMode` 的入口：工具目录变化（记忆/知识库开关）后重建 description，
 * 但同一份目录复用同一个 AgentTool 对象。
 */
export function getRunCodeTool(run: Running): RunCodeTool {
  const signature = childToolSignature(run);
  if (!run.ptcTool || run.ptcToolSignature !== signature) {
    run.ptcTool = createRunCodeTool(run);
    run.ptcToolSignature = signature;
  }
  return run.ptcTool as RunCodeTool;
}

function childToolSignature(run: Running): string {
  // 名字 + 描述都进签名：描述变化（远程切换、提示词调整）时缓存的 run_code
  // 声明也要跟着重建，不能只比名字。
  return run.baseTools
    .filter((tool) => PTC_READ_ONLY_TOOL_NAMES.has(tool.name))
    .map((tool) => `${tool.name}\u0001${tool.description ?? ""}`)
    .join("\u0000");
}

async function executeRunCode(
  run: Running,
  toolCallId: string,
  params: RunCodeParams,
  signal: AbortSignal | undefined,
  onUpdate: AgentToolUpdateCallback<RunCodeDetails> | undefined,
): Promise<AgentToolResult<RunCodeDetails>> {
  const startedAt = performance.now();
  const description =
    typeof params.description === "string" && params.description.trim()
      ? params.description.trim()
      : "运行代码";
  const timeoutMs = resolveTimeout(params.timeout_ms);
  let bridge: PtcChildBridge | undefined;

  const details = (): RunCodeDetails => ({
    ptc: {
      calls: bridge?.snapshot() ?? [],
      wallTimeMs: performance.now() - startedAt,
      description,
      timeoutMs,
    },
  });
  const publish = () => onUpdate?.({ content: [], details: details() });

  if (!run.ptcEnabled) {
    return failedResult("PTC is disabled for this session.", details());
  }
  if (typeof params.code !== "string" || params.code.trim() === "") {
    return failedResult("The code argument must be a non-empty JavaScript string.", details());
  }
  if (params.code.length > PTC_MAX_CODE_CHARS) {
    return failedResult(
      `The code is ${params.code.length} characters, more than the ${PTC_MAX_CODE_CHARS}-character limit.`,
      details(),
    );
  }

  bridge = createPtcChildBridge({
    run,
    parentToolCallId: toolCallId,
    parentDescription: description,
    onChange: publish,
  });
  // 让卡片在第一个子调用之前就进入 running 态（计时从脚本开始算）。
  publish();

  // 等待槽位的时间也计入脚本 deadline；超时/abort 都不启动 worker。
  const waitStartedAt = performance.now();
  const admission = await acquireSandbox(signal, timeoutMs);
  const waitedMs = performance.now() - waitStartedAt;
  if (admission !== "ok") {
    bridge.finalize();
    return failedResult(
      admission === "aborted"
        ? "Script aborted while waiting for a free code sandbox."
        : `No code sandbox became free within ${PTC_SANDBOX_WAIT_MS / 1000} seconds. Retry after the running run_code calls finish.`,
      details(),
    );
  }

  let sandbox: CodemodeSandbox | undefined;
  let result: CodemodeResult;
  try {
    sandbox = new CodemodeSandbox({
      tools: bridge.tools,
      timeoutMs: Math.max(1, Math.round(timeoutMs - waitedMs)),
      memoryLimitBytes: PTC_MEMORY_LIMIT_BYTES,
      wasm: await loadCodemodeWasm(),
      workerUrl: codemodeWorkerUrl(),
    });
    result = await sandbox.execute(params.code, { signal });
  } catch (error) {
    bridge.finalize();
    const message = error instanceof Error ? error.message : String(error);
    return failedResult(`The code sandbox failed: ${message}`, details());
  } finally {
    try {
      await sandbox?.close();
    } catch {
      // close() 只负责请求 VM 停止；失败不应把已经拿到的脚本结果变成工具异常。
    } finally {
      releaseSandbox();
    }
  }

  bridge.finalize();
  const finalDetails = details();
  const content = buildContent(result, finalDetails.ptc.wallTimeMs);
  return {
    content,
    details: finalDetails,
    ...(result.ok ? {} : { isError: true }),
  };
}

function resolveTimeout(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) {
    return PTC_DEFAULT_TIMEOUT_MS;
  }
  return Math.min(PTC_MAX_TIMEOUT_MS, Math.max(1, Math.round(raw)));
}

function buildDescription(run: Running): string {
  const childTools = run.baseTools.filter((tool) =>
    PTC_READ_ONLY_TOOL_NAMES.has(tool.name),
  );
  const header = [
    "Run a JavaScript async function body in a QuickJS sandbox.",
    "PREFER this tool when the task needs several tool calls that follow a pattern: multiple independent searches or reads to combine, loops or pagination, filtering large results down to a summary, or chaining one call's output into the next. One direct tool call (or a plain parallel batch) that already answers the request is simpler — do not wrap it in run_code. Child results stay out of context, so batching here saves rounds and tokens.",
    "- Call tools with `await tools.<name>(args)`. The script cannot call `run_code` itself.",
    "- Each call resolves to `{ status, isError, output, data, images }` and does not throw on tool failure; check `isError`/`status`.",
    "- Output with `text(value)`, `image(value)`, `console.log(...)`, or `return value`. Only that output reaches the model; child results do not.",
    "- read/grep/glob/WebFetch/WebSearch may run in parallel; every other call runs one at a time.",
    "- No timers, network, filesystem, `fetch`, `process`, `require`, or modules. Only the tools below touch the outside world.",
    `- Limits: ${PTC_DEFAULT_TIMEOUT_MS / 1000}s default (\`timeout_ms\` up to ${PTC_MAX_TIMEOUT_MS}), 100 child calls, ${PTC_MAX_CODE_CHARS / 1024} KiB code, ${PTC_MEMORY_LIMIT_BYTES / 1024 / 1024} MiB heap.`,
  ].join("\n");

  if (childTools.length === 0) {
    return `${header}\n\nNo child tools are available; the script can only compute.`;
  }

  let declarations = "";
  try {
    const declarationTools: CodemodeTool[] = childTools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.parameters as CodemodeJsonSchema,
      outputSchema: ptcEnvelopeSchema(tool.outputSchema as CodemodeJsonSchema | undefined),
      execute: async () => undefined,
    }));
    declarations = renderDeclarations({ tools: declarationTools });
  } catch {
    declarations = "";
  }
  if (declarations === "" || declarations.length > PTC_MAX_DECLARATION_CHARS) {
    declarations = childTools
      .map(
        (tool) =>
          `- tools.${toCodemodeIdentifier(tool.name)}: ${firstLine(tool.description)}`,
      )
      .join("\n");
  }
  return `${header}\n\nTools:\n${declarations}`;
}

function firstLine(text: string): string {
  if (typeof text !== "string") return "";
  const line = text.split(/\r?\n/, 1)[0]?.trim() ?? "";
  return line.length > 160 ? `${line.slice(0, 159)}…` : line;
}

function buildContent(
  result: CodemodeResult,
  wallTimeMs: number,
): (TextContent | ImageContent)[] {
  const texts = result.output.filter(
    (item): item is Extract<(typeof result.output)[number], { type: "text" }> =>
      item.type === "text" && item.console !== true,
  );
  const consoleItems = result.output.filter(
    (item): item is Extract<(typeof result.output)[number], { type: "text" }> =>
      item.type === "text" && item.console === true,
  );
  const images = result.output.filter(
    (item): item is Extract<(typeof result.output)[number], { type: "image" }> =>
      item.type === "image",
  );
  const returned = result.ok && result.value !== undefined;
  const total = texts.length + (returned ? 1 : 0);
  const content: (TextContent | ImageContent)[] = [
    {
      type: "text",
      text: `${result.ok ? "Script completed" : "Script failed"}\nWall time ${(wallTimeMs / 1000).toFixed(1)} seconds\nOutput:\n`,
    },
  ];
  let index = 0;
  for (const item of texts) {
    index++;
    content.push({
      type: "text",
      text: total > 1 ? `==> text ${index}/${total} <==\n${item.text}` : item.text,
    });
  }
  if (result.ok && result.value !== undefined) {
    index++;
    content.push({
      type: "text",
      text:
        total > 1
          ? `==> text ${index}/${total} <==\n${valueText(result.value)}`
          : valueText(result.value),
    });
  }
  if (consoleItems.length > 0) {
    content.push({
      type: "text",
      text: `<console_output>\n${consoleItems.map((item) => item.text).join("\n")}\n</console_output>`,
    });
  }
  for (const image of images) {
    content.push({ type: "image", data: image.data, mimeType: image.mimeType });
  }
  if (!result.ok) {
    content.push({
      type: "text",
      text: `Script error:\n${formatError(result.error, result.calls)}`,
    });
  }
  return truncateContent(content);
}

function truncateContent(
  content: (TextContent | ImageContent)[],
): (TextContent | ImageContent)[] {
  const textChars = content.reduce(
    (sum, item) => sum + (item.type === "text" ? item.text.length : 0),
    0,
  );
  if (textChars <= PTC_MAX_OUTPUT_CHARS) return content;
  const combined = content
    .filter((item): item is TextContent => item.type === "text")
    .map((item) => item.text)
    .join("\n");
  const head = combined.slice(0, PTC_MAX_OUTPUT_CHARS / 2);
  const tail = combined.slice(-PTC_MAX_OUTPUT_CHARS / 2);
  const removed = combined.length - head.length - tail.length;
  return [
    {
      type: "text",
      text: `${head}\n\n[output truncated: ${Math.ceil(removed / 4)} tokens omitted]\n\n${tail}`,
    },
    ...content.filter((item): item is ImageContent => item.type === "image"),
  ];
}

function valueText(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function formatError(
  error: Extract<CodemodeResult, { ok: false }>["error"],
  calls: CodemodeResult["calls"],
): string {
  const head =
    error.kind === "script"
      ? error.stack ?? `${error.name ?? "Error"}: ${error.message}`
      : error.kind === "timeout"
        ? `Script timed out: ${error.message}`
        : error.kind === "aborted"
          ? `Script aborted: ${error.message}`
          : `Script sandbox failed: ${error.message}`;
  if (calls.length === 0) return head;
  const summary = calls
    .map((call) => `${call.name} (${call.status})`)
    .join(", ");
  return `${head}\n\nTool calls made before the failure (they are not undone): ${summary}`;
}

function failedResult(
  message: string,
  details: RunCodeDetails,
): AgentToolResult<RunCodeDetails> {
  return {
    content: [
      {
        type: "text",
        text: `Script failed\nWall time ${(details.ptc.wallTimeMs / 1000).toFixed(1)} seconds\nOutput:\n`,
      },
      { type: "text", text: `Script error:\n${message}` },
    ],
    details,
    isError: true,
  };
}
