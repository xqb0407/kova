/**
 * ACP 翻译层（纯映射，集中放这里便于单测/升级协议时对照）：
 * - ACP prompt content blocks → 内部 prompt 文本 + attachments
 * - 内部 UIMessageChunk → ACP session/update
 * - 工具名 → ACP ToolKind / title / locations / diff content
 * - todo → ACP plan
 *
 * 不在这里发 JSON-RPC：所有 update 通过注入的 sendUpdate 回调发出，
 * 由 agent.ts 绑定到 AgentSideConnection.sessionUpdate。
 */
import { basename, isAbsolute, join } from "node:path";
import type * as acp from "@agentclientprotocol/sdk";

type SessionUpdate = acp.SessionNotification["update"];
type ToolCallContent = acp.ToolCallContent;
type ToolKind = acp.ToolKind;
type ToolCallStatus = acp.ToolCallStatus;

export type PromptAttachment = {
  name: string;
  mimeType: string;
  data: string;
};

export type ParsedPrompt = {
  text: string;
  attachments: PromptAttachment[];
};

const MAX_INLINE_IMAGE_BYTES = 2 * 1024 * 1024;
const MAX_WRITE_CONTENT_PREVIEW = 64 * 1024;
const MAX_PLAN_MARKDOWN = 64 * 1024;
/** tool_call 里的 diff 只做展示；超大编辑不把两份全文再塞一遍 wire */
const MAX_DIFF_TOTAL_CHARS = 128 * 1024;

/** ACP content blocks → 内部 prompt 文本 + 图片附件 */
export function parsePromptContent(
  blocks: readonly acp.ContentBlock[],
  cwd: string,
): ParsedPrompt {
  const texts: string[] = [];
  const attachments: PromptAttachment[] = [];
  let imageIndex = 0;

  const pushImage = (data: string, mimeType: string, name?: string) => {
    const b64 = data.startsWith("data:") ? data.slice(data.indexOf(",") + 1) : data;
    if (!b64) return;
    if (Buffer.byteLength(b64, "base64") > MAX_INLINE_IMAGE_BYTES) {
      texts.push(
        `[image omitted: ${name ?? "inline image"} is larger than 2MiB; downscale it and resend]`,
      );
      return;
    }
    imageIndex += 1;
    const ext = mimeType.split("/")[1]?.split(";")[0] ?? "png";
    attachments.push({
      name: name?.trim() || `image-${imageIndex}.${ext}`,
      mimeType: mimeType || "image/png",
      data: b64,
    });
  };

  for (const block of blocks) {
    switch (block.type) {
      case "text":
        if (block.text?.trim()) texts.push(block.text);
        break;
      case "image":
        pushImage(block.data, block.mimeType, block.uri ? basename(block.uri) : undefined);
        break;
      case "audio":
        texts.push("[audio content is not supported by this agent; ignored]");
        break;
      case "resource_link":
        texts.push(
          `[resource link: ${block.name}${block.title ? ` — ${block.title}` : ""} (${block.uri})]`,
        );
        break;
      case "resource": {
        const resource = block.resource;
        if (resource && typeof resource === "object" && "text" in resource) {
          texts.push(`\n[resource: ${resource.uri}]\n${resource.text ?? ""}`);
        } else if (resource && typeof resource === "object" && "blob" in resource) {
          const mime = resource.mimeType ?? "application/octet-stream";
          if (mime.startsWith("image/")) {
            pushImage(resource.blob ?? "", mime, basename(resource.uri ?? "resource"));
          } else {
            texts.push(`[embedded resource omitted: ${resource.uri} (${mime})]`);
          }
        }
        break;
      }
    }
  }

  return { text: texts.join("\n").trim(), attachments };
}

/** 模型/工具的原始 input 里提取文件路径（相对 cwd 解析） */
export function locationsForInput(
  input: unknown,
  cwd: string,
): acp.ToolCallLocation[] {
  if (!input || typeof input !== "object") return [];
  const record = input as Record<string, unknown>;
  const raw = [record.file_path, record.path, record.abs_path, record.filePath].find(
    (v): v is string => typeof v === "string" && v.trim().length > 0,
  );
  if (!raw) return [];
  const path = isAbsolute(raw) ? raw : join(cwd, raw);
  return [{ path }];
}

export function toolKindFor(toolName: string, input?: unknown): ToolKind {
  const name = toolName.toLowerCase();
  if (name === "bash" || name === "task_output" || name === "task_stop") return "execute";
  if (name === "read") return "read";
  if (name === "write" || name === "edit") return "edit";
  if (name === "glob" || name === "grep" || name === "search_external_files") return "search";
  if (name === "webfetch" || name === "websearch") return "fetch";
  if (name === "plan_enter" || name === "plan_exit") return "switch_mode";
  if (name === "todo") return "think";
  if (name === "task" || name.startsWith("task_")) return "other";
  return "other";
}

function textOf(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n…[truncated]` : text;
}

export function toolTitleFor(toolName: string, input: unknown): string {
  const record =
    input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  const path =
    typeof record.file_path === "string"
      ? record.file_path
      : typeof record.path === "string"
        ? record.path
        : "";
  switch (toolName) {
    case "bash": {
      const command = typeof record.command === "string" ? record.command : "";
      const first = command.split("\n")[0]?.trim() ?? "";
      return first ? `Run: ${truncate(first, 80)}` : "Run command";
    }
    case "read":
      return path ? `Read ${path}` : "Read file";
    case "write":
      return path ? `Write ${path}` : "Write file";
    case "edit":
      return path ? `Edit ${path}` : "Edit file";
    case "glob":
      return typeof record.pattern === "string" ? `Find ${record.pattern}` : "Find files";
    case "grep":
      return typeof record.pattern === "string" ? `Search ${record.pattern}` : "Search files";
    case "WebFetch":
      return typeof record.url === "string" ? `Fetch ${record.url}` : "Fetch URL";
    case "WebSearch":
      return typeof record.query === "string" ? `Search web: ${record.query}` : "Search web";
    case "Task":
      return typeof record.description === "string"
        ? `Delegate: ${truncate(record.description, 60)}`
        : "Delegate task";
    case "mcp": {
      const server = typeof record.server === "string" ? record.server : "";
      const tool = typeof record.tool === "string" ? record.tool : "";
      return server && tool ? `MCP ${server}.${tool}` : "MCP tool call";
    }
    case "todo":
      return "Update task list";
    case "plan_enter":
      return "Enter plan mode";
    case "plan_exit":
      return typeof record.title === "string" && record.title
        ? `Approve plan: ${record.title}`
        : "Approve plan";
    default:
      return toolName;
  }
}

/** 工具调用首次出现时的 content（diff / 写入预览 / 说明） */
export function toolCallContentFor(
  toolName: string,
  input: unknown,
  cwd: string,
): ToolCallContent[] | undefined {
  const record =
    input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  if (toolName === "edit") {
    const path =
      typeof record.file_path === "string"
        ? isAbsolute(record.file_path)
          ? record.file_path
          : join(cwd, record.file_path)
        : "";
    if (
      path &&
      typeof record.old_string === "string" &&
      typeof record.new_string === "string" &&
      record.old_string.length + record.new_string.length <= MAX_DIFF_TOTAL_CHARS
    ) {
      return [
        {
          type: "diff",
          path,
          oldText: record.old_string,
          newText: record.new_string,
        },
      ];
    }
  }
  if (toolName === "write" && typeof record.content === "string") {
    const content = truncate(record.content, MAX_WRITE_CONTENT_PREVIEW);
    return [{ type: "content", content: { type: "text", text: content } }];
  }
  if (toolName === "plan_exit") {
    const markdown = typeof record.markdown === "string" ? record.markdown : "";
    const rationale = typeof record.rationale === "string" ? record.rationale : "";
    const text = [rationale, truncate(markdown, MAX_PLAN_MARKDOWN)]
      .filter(Boolean)
      .join("\n\n");
    if (text) return [{ type: "content", content: { type: "text", text } }];
  }
  return undefined;
}

function parseDataUrl(src: unknown): { data: string; mimeType: string } | null {
  if (typeof src !== "string") return null;
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(src);
  if (match) return { mimeType: match[1], data: match[2] };
  // 约定上也允许裸 base64；没有 mime 时按 png 兜底
  if (/^[A-Za-z0-9+/=\s]+$/.test(src) && src.length > 32) {
    return { mimeType: "image/png", data: src };
  }
  return null;
}

type ToolResultState = {
  text: string;
  images: { data: string; mimeType: string }[];
  status: ToolCallStatus;
};

export type StreamTranslatorOptions = {
  sessionId: string;
  cwd: string;
  /** 会话当前模式：避免每轮首条 data-planningState 重复发 current_mode_update */
  initialMode?: string;
  /** 会话内部切换模式（plan 审批通过等）：agent 用它同步 entry.lastMode，
   *  否则下一次 configOptions 重建会按旧模式回下发 */
  onModeChange?: (mode: string) => void;
  sendUpdate: (update: SessionUpdate) => void | Promise<void>;
  onPermission: (data: ToolApprovalData) => void | Promise<void>;
  onQuestion: (data: Record<string, unknown>) => void | Promise<void>;
  onInteractionResolved: (data: Record<string, unknown>) => void | Promise<void>;
};

export type ToolApprovalData = {
  approvalId: string;
  toolCallId: string;
  toolName: string;
  input: unknown;
  note?: string;
  canRemember?: boolean;
};

/**
 * 一次 prompt 内的流式翻译器：维护工具调用公告/结果/图片状态，
 * 保证 ACP 客户端看到的顺序与内容与内部一致。
 */
export class StreamTranslator {
  private announced = new Map<string, { name: string; input: unknown }>();
  private results = new Map<string, ToolResultState>();
  private lastMode: string | null = null;

  constructor(private readonly opts: StreamTranslatorOptions) {
    this.lastMode = opts.initialMode ?? null;
  }

  /** 权限请求前预告 tool_call（若尚未公告）；供 agent 的权限处理调用 */
  async ensureToolCall(data: ToolApprovalData): Promise<void> {
    const content = toolCallContentFor(data.toolName, data.input, this.opts.cwd);
    const note = data.note?.trim();
    const merged: ToolCallContent[] | undefined =
      note || content
        ? [
            ...(note
              ? [{ type: "content", content: { type: "text", text: note } } as ToolCallContent]
              : []),
            ...(content ?? []),
          ]
        : undefined;
    const already = this.announced.has(data.toolCallId);
    this.announced.set(data.toolCallId, { name: data.toolName, input: data.input });
    if (already) {
      // tool-input-available 可能已经先到（agent-core 的 start 事件早于
      // beforeToolCall 的挂起），此时用 update 把状态明确改成 pending，
      // 让用户看到"正在等待授权"而不是"已经在跑"。
      await this.opts.sendUpdate({
        sessionUpdate: "tool_call_update",
        toolCallId: data.toolCallId,
        title: toolTitleFor(data.toolName, data.input),
        kind: toolKindFor(data.toolName, data.input),
        status: "pending",
        rawInput:
          data.input && typeof data.input === "object"
            ? (data.input as Record<string, unknown>)
            : undefined,
        locations: locationsForInput(data.input, this.opts.cwd),
        ...(merged?.length ? { content: merged } : {}),
      });
      return;
    }
    await this.opts.sendUpdate({
      sessionUpdate: "tool_call",
      toolCallId: data.toolCallId,
      title: toolTitleFor(data.toolName, data.input),
      kind: toolKindFor(data.toolName, data.input),
      status: "pending",
      rawInput:
        data.input && typeof data.input === "object"
          ? (data.input as Record<string, unknown>)
          : undefined,
      locations: locationsForInput(data.input, this.opts.cwd),
      ...(merged?.length ? { content: merged } : {}),
    });
  }

  /** 授权通过后把工具行从 pending 推进到 in_progress */
  async markToolRunning(toolCallId: string): Promise<void> {
    await this.opts.sendUpdate({
      sessionUpdate: "tool_call_update",
      toolCallId,
      status: "in_progress",
    });
  }

  /** 权限被拒/取消后把工具行收成失败态 */
  async failToolCall(toolCallId: string, reason: string): Promise<void> {
    await this.opts.sendUpdate({
      sessionUpdate: "tool_call_update",
      toolCallId,
      status: "failed",
      content: [{ type: "content", content: { type: "text", text: reason } }],
    });
  }

  async handle(chunk: Record<string, unknown>): Promise<void> {
    const type = typeof chunk.type === "string" ? chunk.type : "";
    switch (type) {
      case "text-delta": {
        const delta = typeof chunk.delta === "string" ? chunk.delta : "";
        if (delta) {
          await this.opts.sendUpdate({
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: delta },
          });
        }
        break;
      }
      case "reasoning-delta": {
        const delta = typeof chunk.delta === "string" ? chunk.delta : "";
        if (delta) {
          await this.opts.sendUpdate({
            sessionUpdate: "agent_thought_chunk",
            content: { type: "text", text: delta },
          });
        }
        break;
      }
      case "tool-input-available": {
        const toolCallId = String(chunk.toolCallId ?? "");
        const toolName = String(chunk.toolName ?? "");
        const input = chunk.input;
        if (!toolCallId) break;
        const already = this.announced.get(toolCallId);
        this.announced.set(toolCallId, { name: toolName, input });
        const content = toolCallContentFor(toolName, input, this.opts.cwd);
        if (already) {
          await this.opts.sendUpdate({
            sessionUpdate: "tool_call_update",
            toolCallId,
            status: "in_progress",
            title: toolTitleFor(toolName, input),
            kind: toolKindFor(toolName, input),
            rawInput:
              input && typeof input === "object"
                ? (input as Record<string, unknown>)
                : undefined,
            locations: locationsForInput(input, this.opts.cwd),
            ...(content?.length ? { content } : {}),
          });
        } else {
          await this.opts.sendUpdate({
            sessionUpdate: "tool_call",
            toolCallId,
            title: toolTitleFor(toolName, input),
            kind: toolKindFor(toolName, input),
            status: "in_progress",
            rawInput:
              input && typeof input === "object"
                ? (input as Record<string, unknown>)
                : undefined,
            locations: locationsForInput(input, this.opts.cwd),
            ...(content?.length ? { content } : {}),
          });
        }
        break;
      }
      case "tool-output-available": {
        const toolCallId = String(chunk.toolCallId ?? "");
        if (!toolCallId) break;
        const text = textOf(chunk.output);
        const prev = this.results.get(toolCallId);
        const state: ToolResultState = {
          text,
          images: prev?.images ?? [],
          status: "completed",
        };
        this.results.set(toolCallId, state);
        await this.sendToolResult(toolCallId, state);
        break;
      }
      case "tool-output-error": {
        const toolCallId = String(chunk.toolCallId ?? "");
        if (!toolCallId) break;
        const text = typeof chunk.errorText === "string" ? chunk.errorText : "tool call failed";
        const state: ToolResultState = { text, images: [], status: "failed" };
        this.results.set(toolCallId, state);
        await this.sendToolResult(toolCallId, state);
        break;
      }
      case "data-image": {
        const data = chunk.data;
        if (!data || typeof data !== "object") break;
        const imageData = data as {
          src?: unknown;
          mimeType?: unknown;
          toolCallId?: unknown;
        };
        const parsed = parseDataUrl(imageData.src);
        if (!parsed) break;
        const toolCallId =
          typeof imageData.toolCallId === "string" ? imageData.toolCallId : "";
        if (toolCallId) {
          const prev = this.results.get(toolCallId) ?? {
            text: "",
            images: [],
            status: "completed" as ToolCallStatus,
          };
          prev.images.push(parsed);
          this.results.set(toolCallId, prev);
          await this.sendToolResult(toolCallId, prev);
        } else {
          await this.opts.sendUpdate({
            sessionUpdate: "agent_message_chunk",
            content: {
              type: "image",
              data: parsed.data,
              mimeType: parsed.mimeType || String(imageData.mimeType ?? "image/png"),
            },
          });
        }
        break;
      }
      case "data-todo": {
        const tasks = Array.isArray((chunk.data as { tasks?: unknown } | undefined)?.tasks)
          ? ((chunk.data as { tasks: unknown[] }).tasks as Record<string, unknown>[])
          : [];
        const entries = tasks
          .filter((task) => task?.status !== "deleted")
          .map((task) => ({
            content: String(task.subject ?? task.activeForm ?? task.id ?? "task"),
            priority: "medium" as const,
            status:
              task.status === "in_progress"
                ? ("in_progress" as const)
                : task.status === "completed"
                  ? ("completed" as const)
                  : ("pending" as const),
          }));
        await this.opts.sendUpdate({ sessionUpdate: "plan", entries });
        break;
      }
      case "data-planningState": {
        const data = chunk.data as { mode?: unknown } | undefined;
        const mode = typeof data?.mode === "string" ? data.mode : "";
        if (!mode) break;
        const acpMode = mode === "plan" ? "plan" : mode === "ask" ? "ask" : "agent";
        if (acpMode !== this.lastMode) {
          this.lastMode = acpMode;
          this.opts.onModeChange?.(acpMode);
          await this.opts.sendUpdate({
            sessionUpdate: "current_mode_update",
            currentModeId: acpMode,
          });
        }
        break;
      }
      case "data-toolApproval": {
        const data = chunk.data as ToolApprovalData | undefined;
        if (data?.approvalId && data.toolCallId) await this.opts.onPermission(data);
        break;
      }
      case "data-question": {
        const data = chunk.data;
        if (data && typeof data === "object") {
          await this.opts.onQuestion(data as Record<string, unknown>);
        }
        break;
      }
      case "data-interactionResolved": {
        const data = chunk.data;
        if (data && typeof data === "object") {
          await this.opts.onInteractionResolved(data as Record<string, unknown>);
        }
        break;
      }
      case "data-askNeedsWork": {
        const reason = textOf((chunk.data as { reason?: unknown } | undefined)?.reason ?? "");
        await this.opts.sendUpdate({
          sessionUpdate: "agent_message_chunk",
          content: {
            type: "text",
            text: `\n\n[Ask mode suggests switching to Agent mode${reason ? `: ${reason}` : "."}]\n`,
          },
        });
        break;
      }
      default:
        // data-compaction / data-retry / data-panelOpen / data-goal-state /
        // data-queue-state / start / start-step / finish-step 等：ACP 无对应
        // 通道或对编辑器无意义，忽略。
        break;
    }
  }

  /** prompt 结束时把仍 announced 但无结果的工具收成失败，避免客户端永久转圈 */
  async finishPending(): Promise<void> {
    for (const [toolCallId, info] of this.announced) {
      if (this.results.has(toolCallId)) continue;
      this.results.set(toolCallId, {
        text: "No result recorded (the turn ended before this tool returned).",
        images: [],
        status: "failed",
      });
      await this.sendToolResult(toolCallId, this.results.get(toolCallId)!);
      void info;
    }
  }

  private async sendToolResult(
    toolCallId: string,
    state: ToolResultState,
  ): Promise<void> {
    const content: ToolCallContent[] = [];
    if (state.text) {
      content.push({
        type: "content",
        content: { type: "text", text: truncate(state.text, 256 * 1024) },
      });
    }
    for (const image of state.images) {
      content.push({
        type: "content",
        content: { type: "image", data: image.data, mimeType: image.mimeType },
      });
    }
    await this.opts.sendUpdate({
      sessionUpdate: "tool_call_update",
      toolCallId,
      status: state.status,
      ...(content.length ? { content } : {}),
    });
  }
}

/** 权限卡片选项（agent 侧调用） */
export function permissionOptionsFor(
  toolName: string,
  canRemember: boolean | undefined,
): acp.PermissionOption[] {
  const allowRememberLabel =
    toolName === "bash"
      ? "允许并记住这类命令"
      : toolName === "mcp"
        ? "允许并记住这个工具"
        : "允许并记住";
  return [
    { optionId: "allow_once", name: "批准", kind: "allow_once" },
    ...(canRemember && toolName !== "plan_exit"
      ? [
          {
            optionId: "allow_always",
            name: allowRememberLabel,
            kind: "allow_always" as const,
          },
        ]
      : []),
    { optionId: "reject_once", name: "拒绝", kind: "reject_once" },
  ];
}

/** 权限卡里的 rawInput 摘要：大文件内容不重复塞进权限帧 */
export function permissionInputFor(toolName: string, input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object") return {};
  const record = input as Record<string, unknown>;
  if (toolName === "plan_exit") {
    return {
      ...record,
      markdown:
        typeof record.markdown === "string"
          ? truncate(record.markdown, MAX_PLAN_MARKDOWN)
          : record.markdown,
    };
  }
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (typeof value === "string" && value.length > 4096) {
      out[key] = `${value.slice(0, 4096)}\n…[${value.length} chars truncated for permission preview]`;
    } else {
      out[key] = value;
    }
  }
  return out;
}
