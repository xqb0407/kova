/**
 * tool-budget 能力：把超限的工具文本输出外置为 artifact，回填一条可恢复的
 * 回执；图片等非文本块原样保留。
 *
 * 失败策略：artifact 写失败不让工具调用失败——降级为头尾预览，并在回执里
 * 明确告知"持久化失败"，模型仍能拿到关键上下文。
 */
import type { AfterToolCallContext, AfterToolCallResult } from "@earendil-works/pi-agent-core";
import { logErr } from "../../../log";
import {
  sliceUtf8,
  writeToolArtifact,
  type ToolArtifact,
} from "../../../sessions/artifact-store";
import type { Capability } from "../contracts";
import { readCapabilityParams } from "../settings";

export type ToolBudgetOptions = {
  readonly writeArtifact?: typeof writeToolArtifact;
  readonly defaultMaxInlineBytes?: number;
};

/** grep 工具对单文件有 512KB 上限；更大的 artifact 不能建议用 grep 检索。 */
const GREP_SAFE_BYTES = 512 * 1024;
const ERROR_HEAD_CHARS = 4_096;

type TextBlock = { readonly type: "text"; readonly text: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTextBlock(block: { readonly type: string }): block is TextBlock {
  return block.type === "text";
}

function positiveInteger(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : fallback;
}

/** 头尾预览按字节预算切（UTF-8 安全）：文案与限额口径一致，CJK 不再超上限。 */
function headTail(text: string, maxBytes: number): string {
  const buffer = Buffer.from(text, "utf8");
  const headBytes = Math.floor(maxBytes / 2);
  const tailBytes = maxBytes - headBytes;
  const head = sliceUtf8(buffer, 0, headBytes);
  const tail = sliceUtf8(buffer, buffer.length - tailBytes, buffer.length);
  return `${head}\n…[middle omitted]\n${tail}`;
}

function mergeDetails(
  details: unknown,
  budget: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const base = isRecord(details)
    ? details
    : details === undefined
      ? {}
      : { original_details: details };
  return { ...base, tool_output_budget: budget };
}

function buildReceipt(input: {
  readonly toolName: string;
  readonly artifact: ToolArtifact;
  readonly originalBytes: number;
  readonly limit: number;
  readonly isError: boolean;
  readonly head: string;
}): string {
  const readStrategy =
    input.originalBytes > GREP_SAFE_BYTES
      ? "This artifact exceeds the grep tool's 512 KiB per-file limit; use read with offset/limit."
      : "Read strategy: search this artifact with grep, or read it with offset/limit; do not load it whole.";
  return [
    "[Tool output externalized]",
    `Tool: ${input.toolName}`,
    `Artifact: ${input.artifact.reference}`,
    `Original bytes: ${input.originalBytes} (inline limit ${input.limit})`,
    input.artifact.truncated ? "Note: the artifact itself was truncated at the storage cap." : "",
    readStrategy,
    input.isError && input.head
      ? `Head of the error output:\n${input.head}`
      : "",
    "Treat this receipt as a pointer, not as evidence.",
  ]
    .filter(Boolean)
    .join("\n");
}

export function toolBudgetCapability(options: ToolBudgetOptions = {}): Capability {
  const writeArtifact = options.writeArtifact ?? writeToolArtifact;
  const defaultLimit = options.defaultMaxInlineBytes ?? 32 * 1024;

  return {
    id: "tool-budget",
    title: "Externalize oversized tool output",
    defaultEnabled: false,
    install(host) {
      host.onToolAfter(async (context, snapshot) => {
        const params = readCapabilityParams("tool-budget");
        const limit = positiveInteger(params.maxInlineBytes, defaultLimit);
        const perTool = isRecord(params.perTool) ? params.perTool : {};
        const toolLimit = positiveInteger(perTool[context.toolCall.name], limit);

        const blocks = context.result.content;
        const textBlocks = blocks.filter(isTextBlock);
        if (textBlocks.length === 0) return undefined;

        const text = textBlocks.map((block) => block.text).join("\n");
        const originalBytes = Buffer.byteLength(text, "utf8");
        if (originalBytes <= toolLimit) return undefined;

        const media = blocks.filter((block) => !isTextBlock(block));
        const artifactInput = {
          sessionId: snapshot.sessionId,
          turnId: snapshot.turnId,
          toolCallId: context.toolCall.id,
          toolName: context.toolCall.name,
          text,
        };

        try {
          const artifact = await writeArtifact(artifactInput);
          const receipt = buildReceipt({
            toolName: context.toolCall.name,
            artifact,
            originalBytes,
            limit: toolLimit,
            isError: context.isError,
            head: context.isError ? text.slice(0, ERROR_HEAD_CHARS) : "",
          });
          return {
            content: [{ type: "text", text: receipt }, ...media],
            details: mergeDetails(context.result.details, {
              externalized: true,
              fallback: false,
              original_bytes: originalBytes,
              reference: artifact.reference,
              truncated: artifact.truncated,
            }),
          } satisfies AfterToolCallResult;
        } catch (error) {
          logErr("capability:tool-budget: artifact write failed:", error);
          const notice =
            `\n\n[tool output truncated: ${originalBytes} bytes exceeded ${toolLimit}; ` +
            "artifact storage failed]\n\n";
          return {
            content: [
              {
                type: "text",
                text: `${headTail(text, Math.min(toolLimit, 4096))}${notice}`,
              },
              ...media,
            ],
            details: mergeDetails(context.result.details, {
              externalized: false,
              fallback: true,
              original_bytes: originalBytes,
            }),
          } satisfies AfterToolCallResult;
        }
      }, 100);
    },
  };
}
