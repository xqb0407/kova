// vendored from assistant-ui `@assistant-ui/react-pi@0.0.25` (MIT) —
// https://github.com/assistant-ui/assistant-ui/tree/main/packages/react-pi
// 保留上游文件名与结构以便对照上游 cherry-pick；改动需在此注明：
// vendored path: src/messageProjection.ts（runtime/ 子目录对应上游 src/runtime/）
// 本地改动：
// - 工具结果 image 块不再转 modelContent file parts，改为镜像 sidecar
//   image-parts.ts 闸门（2MiB 上限 / mime 白名单 / 降级占位 notices）投影为
//   data part（name "image"，PiImagePartData）——与旧链路直播 chunk 及刷新
//   后的历史重建同构，UI 图廊（group-images）据此认亲渲染（2026-10-01 缺图修复）
// - projectAssistantInto 合并相邻 text block 为一个 text part（2026-10-01 分行修复）：
//   上游 provider 在流式期间会按 chunk 递增 contentIndex（reasoning/tool_calls
//   交替时另起 text block，见 openai-completions 的 getContentIndex），同一段回答
//   会以多个相邻 text block 到达。一个 block 一个 part 时，UI 侧 groupBy 对 text
//   返回 []（不分组），每个 part 渲染成独立的 <MarkdownText />，在 flex-col gap-2
//   容器里表现为"几个字一行、流结束才合并成一段"
// - 稳定消息 id（2026-10-01 闪没修复）：转录行 seq（sidecar thread_snapshot 透传的
//   __seq）优先做 id 锚点，在飞/未落盘消息按独立前缀的 index 回退；此前纯下标 id 会
//   随任意转录行先落盘整体漂移——React key 重挂、turnKey（=轮首消息 id）孤儿化（折叠
//   态与耗时台账全失效），或与尾部乐观消息撞号被外部 store 按"重复 id 保留最后"吞掉
//   一条（发送时"闪一下消失"）。乐观消息自带 __optimisticId（pi-optimistic:${n}），
//   与转录 id 永不碰撞。
// - 长度截断续跑哨兵过滤 + 最终中止标记（2026-10-02 气泡泄漏修复）：带
//   [[auto-continue]] 前缀的 user 行（sidecar 自动续跑注入，pi-protocol 单源
//   判定 isAutoContinueMessage）不再渲染成用户提问气泡——thread_snapshot 直出
//   原生行不过 sidecar 的 UI 投影，此前漏到气泡。跳过时不 flush：直播上连续
//   assistant 轮本就并入同组，保持「刷新=直播」同构。快照行的 __truncationStopped
//   标注（sidecar isTruncationStoppedRow：预算耗尽的截断轮）转成
//   data-truncation-stopped part，AssistantMessage 渲染「任务已中止」分隔线
//   （stopped-marker 同款机制）。

/**
 * Pure projection of the canonical Pi transcript (`PiAgentMessage[]`) into
 * assistant-ui's `ThreadMessageLike[]` / `ExportedMessageRepository`.
 *
 * Design:
 * - Each Pi *turn* is one assistant message (text/thinking/toolCall parts). A
 *   multi-step run is several assistant messages interleaved with `toolResult`
 *   messages. We MERGE a maximal run of assistant + toolResult messages into a
 *   single assistant `ThreadMessageLike`, with one `ThreadStep` per turn and
 *   `parentId` linking each turn's parts to its step (so chain-of-thought + tool
 *   work group visually).
 * - `toolResult` messages are paired into their `tool-call` part by
 *   `toolCallId` (parallel tools finish out of source order — pairing is by id,
 *   not position).
 * - Live streaming tool output (`toolExecutions[id].partialResult`) fills a
 *   tool-call's `result`, flagged `isPreliminary` while the tool still runs,
 *   until the final `toolResult` message lands.
 * - Tool-associated host-UI requests project onto the tool-call's `approval`
 *   (`approvalForRequest`). Free-standing requests stay on the side channel
 *   (not projected here).
 * - Every other Pi role (`bashExecution`, `custom`, `branchSummary`,
 *   `compactionSummary`, unknown) becomes a standalone `DataMessagePart`.
 *
 * Browser-safe; imports no `@earendil-works/*` packages.
 */

import { ExportedMessageRepository } from "@assistant-ui/react-native";
import type {
  ThreadMessageLike,
} from "@assistant-ui/react-native";
import { isAutoContinueMessage } from "pi-protocol";
import { approvalForRequest, splitHostUiRequests } from "./hostUi";
import type { PiThreadState } from "./threadState";
import type {
  PiAgentMessage,
  PiAssistantMessage,
  PiBashExecutionMessage,
  PiBranchSummaryMessage,
  PiCompactionSummaryMessage,
  PiCustomMessage,
  PiHostUiRequest,
  PiToolResultContent,
  PiToolResultMessage,
  PiUserContent,
  PiUserMessage,
} from "../types";

type ContentPart = Exclude<ThreadMessageLike["content"], string>[number];
type ToolCallPart = Extract<ContentPart, { type: "tool-call" }>;
type Step = NonNullable<
  NonNullable<ThreadMessageLike["metadata"]>["steps"]
>[number];
type ProjectedAttachment = NonNullable<ThreadMessageLike["attachments"]>[number];

export interface PiProjectionInput {
  messages: readonly PiAgentMessage[];
  toolExecutions: PiThreadState["toolExecutions"];
  runStatus: PiThreadState["runStatus"];
  hostUiRequests: readonly PiHostUiRequest[];
}

/** 稳定 id 锚点：sidecar 快照透传的转录行 __seq / 前端乐观消息的 __optimisticId */
type StableIdAnchor = { __seq?: number; __optimisticId?: string };

const seqOf = (anchor: StableIdAnchor | undefined): number | undefined =>
  typeof anchor?.__seq === "number" ? anchor.__seq : undefined;

// seq 空间（落盘后单调不变）优先；在飞消息没有 seq，退回**独立前缀**的下标——
// 独立前缀保证回退 id 绝不与别处已落盘行的 seq id 撞号（seq 与下标号段重叠）。
const messageId = (anchor: StableIdAnchor | undefined, index: number) =>
  anchor?.__optimisticId ??
  (seqOf(anchor) !== undefined
    ? `pi-msg:${seqOf(anchor)}`
    : `pi-msg-idx:${index}`);
const stepId = (anchor: StableIdAnchor | undefined, index: number) =>
  seqOf(anchor) !== undefined
    ? `pi-step:${seqOf(anchor)}`
    : `pi-step-idx:${index}`;

const toDataUrl = (data: string, mimeType: string) =>
  /^data:/i.test(data) ? data : `data:${mimeType};base64,${data}`;

const createdAtOf = (message: { timestamp?: number }): Date =>
  new Date(typeof message.timestamp === "number" ? message.timestamp : 0);

// —— 工具结果图片闸门（镜像 sidecar image-parts.ts，唯一事实源在 sidecar）——
// 投影只加 UI 通道：image 块按 sidecar 同款语义转 data part（快照 = 刷新后同构），
// 越界/白名单外/空数据的图不进线，改为结果文本尾部一行占位提示，绝不静默吞图。

/** data part 名：UI 侧 makeAssistantDataUI("image") 按名认领渲染 */
const IMAGE_PART_NAME = "image";

/** 单图原始字节上限（≈2MiB），与 sidecar IMAGE_INLINE_MAX_BYTES 同值 */
const IMAGE_INLINE_MAX_BYTES = 2 * 1024 * 1024;

/** 允许内联的栅格格式；svg 整体挡掉（可含外链与可欺骗绘制） */
const IMAGE_MIME_ALLOWED = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

/** MIME 归一 + 白名单判定；不合法/不在白名单返回 null */
const normalizeMime = (mime: unknown): string | null => {
  if (typeof mime !== "string") return null;
  const m = mime.trim().toLowerCase();
  // 部分服务器发 image/jpg（非规范拼写），归一到 jpeg
  const canon = m === "image/jpg" ? "image/jpeg" : m;
  return IMAGE_MIME_ALLOWED.has(canon) ? canon : null;
};

/** 工具图片 data part 的 data 形状（镜像 pi-bridge.ts PiImagePartData） */
type PiImagePartData = {
  src: string;
  mimeType: string;
  bytes: number;
  toolCallId: string | null;
  toolName?: string;
  alt?: string;
};

export interface ProjectedImage {
  /** 稳定 id：`img-<toolCallId>-<图块序号>`；快照与流式同值 */
  id: string;
  data: PiImagePartData;
}

const projectToolResult = (
  content: readonly PiToolResultContent[] | undefined,
  ctx: { toolCallId: string | null },
): { result?: string; images: ProjectedImage[] } => {
  if (!content) return { images: [] };
  // 保留 sidecar 拼装语义：非文本块贡献空段（join 出空行），结果文本与
  // 旧链路（sidecar projectToolResult 的 output）逐字一致
  let result = content
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("\n");
  const notices: string[] = [];
  const images: ProjectedImage[] = [];
  // alt 取第一个非空文本块首行（工具侧约定的 headline）
  const alt = content
    .map((part) => (part.type === "text" ? part.text.trim() : ""))
    .find((t) => t.length > 0)
    ?.split("\n")[0]
    ?.slice(0, 120);
  let imgIndex = 0;
  for (const part of content) {
    if (part.type !== "image") continue;
    const index = imgIndex++;
    const b64 = part.data.trim();
    const mime = normalizeMime(part.mimeType);
    if (!mime) {
      const label = part.mimeType.trim() || "未知类型";
      notices.push(`[图片未展示：不支持的类型 ${label}（仅 png/jpeg/gif/webp）]`);
      continue;
    }
    if (!b64) {
      notices.push(`[图片未展示：${mime} 数据为空]`);
      continue;
    }
    const bytes = Math.floor((b64.length * 3) / 4); // base64 长度近似解码后字节，免解码
    if (bytes > IMAGE_INLINE_MAX_BYTES) {
      notices.push(
        `[图片未展示：约 ${(bytes / (1024 * 1024)).toFixed(1)} MiB，超过 ${(IMAGE_INLINE_MAX_BYTES / (1024 * 1024)).toFixed(1)} MiB 内联上限]`,
      );
      continue;
    }
    images.push({
      id: `img-${ctx.toolCallId ?? "direct"}-${index}`,
      data: {
        src: `data:${mime};base64,${b64}`,
        mimeType: mime,
        bytes,
        toolCallId: ctx.toolCallId,
        ...(alt ? { alt } : {}),
      },
    });
  }
  if (notices.length) {
    result = result.trim() ? `${result}\n${notices.join("\n")}` : notices.join("\n");
  }
  return { result, images };
};

const readToolResultContent = (
  value: unknown,
): readonly PiToolResultContent[] | undefined => {
  if (value == null) return undefined;
  const content = (value as { content?: unknown }).content;
  if (!Array.isArray(content)) return undefined;
  return content.filter(
    (part): part is PiToolResultContent =>
      typeof part === "object" &&
      part !== null &&
      (((part as { type?: unknown }).type === "text" &&
        typeof (part as { text?: unknown }).text === "string") ||
        ((part as { type?: unknown }).type === "image" &&
          typeof (part as { data?: unknown }).data === "string" &&
          typeof (part as { mimeType?: unknown }).mimeType === "string")),
  );
};

/** 并入当前轮（steer）注入消息的哨兵前缀（镜像 sidecar transcript.ts
 *  STEER_PREFIX，唯一事实源在 sidecar；改动需两处同步）。转录/事件流原样携带
 *  落盘，投影层剥前缀并补 data-steeredNote 标记 part——user-message.tsx 检测到
 *  该 part 在气泡上方渲染「已并入当前回复」徽标（stopped-marker 同款机制）。
 *  直播 message_start 与 thread_snapshot 直出都走本投影，一处修复两条路径
 *  （旧链路的剥前缀在历史重建侧，react-pi 新链曾以裸前缀上屏）。 */
const STEER_PREFIX = "[[queued-steer]] ";

/** 本地改动（UI 格式回归）：user 消息的 image 块投成 attachments——附件卡
 * 在气泡外渲染（UserMessageAttachments / MessagePrimitive.Attachments），与旧
 * AI SDK 链路（pi-thread-adapter 的 file part → attachments）同款形态。
 * 缩略图数据源 useAttachmentSrc 只认 attachment.content 里的 image 内容 part，
 * 故 content 用 [{type:"image", image: dataURL}]；命名对齐 sidecar
 * transcript.ts 的 image-N.ext（jpeg 归一 jpg）。传 attachmentIdPrefix 才走
 * 附件模式；不传保持 image 内容 part 内联（custom 消息是 assistant 角色，
 * fromThreadMessageLike 只允许 user 消息带 attachments）。 */
const projectUserContent = (
  content: PiUserMessage["content"],
  attachmentIdPrefix?: string,
): { parts: ContentPart[]; attachments: ProjectedAttachment[] } => {
  const parts: ContentPart[] = [];
  const attachments: ProjectedAttachment[] = [];
  const blocks: readonly PiUserContent[] =
    typeof content === "string" ? [{ type: "text", text: content }] : content;
  let imgSeq = 0;
  for (const part of blocks) {
    if (part.type === "image") {
      const mime = part.mimeType || "image/png";
      if (attachmentIdPrefix === undefined) {
        parts.push({ type: "image", image: toDataUrl(part.data, mime) });
      } else {
        imgSeq += 1;
        const ext = mime.split("/")[1] ?? "png";
        const filename = `image-${imgSeq}.${ext === "jpeg" ? "jpg" : ext}`;
        attachments.push({
          id: `${attachmentIdPrefix}-att-${imgSeq}`,
          type: "image",
          name: filename,
          contentType: mime,
          status: { type: "complete" },
          content: [
            {
              type: "image",
              image: toDataUrl(part.data, mime),
              filename,
            },
          ],
        });
      }
    } else if (part.type === "text") {
      parts.push({ type: "text", text: part.text });
    }
  }
  const first = parts[0];
  if (first?.type === "text" && first.text.startsWith(STEER_PREFIX)) {
    const stripped = first.text.slice(STEER_PREFIX.length);
    if (stripped) parts[0] = { ...first, text: stripped };
    else parts.shift();
    parts.unshift({ type: "data", name: "steeredNote", data: {} });
  }
  return { parts, attachments };
};

const dataPart = (
  name: string,
  data: Record<string, unknown>,
): ContentPart => ({
  type: "data",
  name,
  data,
});

/** Build the toolCallId → result pairing map across the whole transcript so
 * out-of-order parallel results pair correctly. */
const buildToolResultMap = (messages: readonly PiAgentMessage[]) => {
  const map = new Map<
    string,
    { result?: string; images: ProjectedImage[]; isError: boolean; details: unknown }
  >();
  for (const message of messages) {
    if (message.role !== "toolResult") continue;
    const m = message as PiToolResultMessage;
    map.set(m.toolCallId, {
      ...projectToolResult(readToolResultContent({ content: m.content }), {
        toolCallId: m.toolCallId,
      }),
      isError: m.isError,
      details: m.details,
    });
  }
  return map;
};

type GroupAccumulator = {
  firstIndex: number;
  /** 组锚点消息（首条 assistant）：合并消息的 id 由它的 seq 决定 */
  anchorMessage: PiAssistantMessage;
  parts: ContentPart[];
  steps: Step[];
  /** The most recent assistant message in the group (drives final status). */
  lastAssistant: PiAssistantMessage;
  hasPendingHostUi: boolean;
};

const projectAssistantInto = (
  group: GroupAccumulator,
  message: PiAssistantMessage,
  index: number,
  input: PiProjectionInput,
  toolResults: ReturnType<typeof buildToolResultMap>,
  hostUiByToolCall: ReadonlyMap<string, PiHostUiRequest>,
) => {
  const parentId = stepId(message, index);
  group.lastAssistant = message;
  group.steps.push({
    messageId: parentId,
    usage: {
      inputTokens: message.usage?.input ?? 0,
      outputTokens: message.usage?.output ?? 0,
    },
  });

  for (const part of message.content) {
    if (part.type === "text") {
      // 相邻 text block 合成一个 part：流式期间上游可能把同一段回答切成多个
      // 相邻 text block，不合并则 UI 侧每个 part 各占一行（见文件头 2026-10-01
      // 分行修复）。只并相邻项——text → toolCall → text 中间隔着 tool-call
      // part，是合法分段，不会被误并。
      const prev = group.parts[group.parts.length - 1];
      if (prev?.type === "text") {
        group.parts[group.parts.length - 1] = {
          ...prev,
          text: prev.text + part.text,
        };
      } else {
        group.parts.push({ type: "text", text: part.text, parentId });
      }
    } else if (part.type === "thinking") {
      const text =
        part.thinking || (part.redacted ? "[reasoning redacted]" : "");
      group.parts.push({ type: "reasoning", text, parentId });
    } else if (part.type === "toolCall") {
      const paired = toolResults.get(part.id);
      const live = input.toolExecutions[part.id];
      const output =
        paired ??
        projectToolResult(readToolResultContent(live?.partialResult), {
          toolCallId: part.id,
        });
      const isError = paired?.isError ?? live?.status === "error";

      const hostUi = hostUiByToolCall.get(part.id);
      const approval = hostUi && approvalForRequest(hostUi);

      const toolCall: ToolCallPart = {
        type: "tool-call",
        toolCallId: part.id,
        toolName: part.name,
        args: (part.arguments ?? {}) as unknown as NonNullable<
          ToolCallPart["args"]
        >,
        argsText: JSON.stringify(part.arguments ?? {}),
        parentId,
        ...(output.result !== undefined ? { result: output.result } : {}),
        ...(isError ? { isError: true } : {}),
        ...(paired === undefined &&
        output.result !== undefined &&
        live?.status === "running"
          ? { isPreliminary: true }
          : {}),
        ...(approval ? { approval } : {}),
      };

      if (approval) group.hasPendingHostUi = true;
      // 同组内同 toolCallId 去重（兜底）：上游快照/直播合并若再漏出同一
      // assistant 的两份拷贝并入同组，part 查找表按 toolCallId 键控会直接
      // Duplicate key 崩溃。保留后一份（更推进的状态，带齐结果），就地替换；
      // 旧拷贝挂的成图一并移除，随后按新状态照常补图，避免图廊重复。
      const dupIndex = group.parts.findIndex(
        (p) => p.type === "tool-call" && p.toolCallId === part.id,
      );
      if (dupIndex >= 0) {
        group.parts[dupIndex] = toolCall;
        group.parts = group.parts.filter(
          (p, i) =>
            i === dupIndex ||
            !(
              p.type === "data" &&
              p.name === IMAGE_PART_NAME &&
              (p.data as Partial<PiImagePartData>).toolCallId === part.id
            ),
        );
      } else {
        group.parts.push(toolCall);
      }
      // 工具图片 data part：紧跟 tool-call part（旧链路 chunk 顺序契约——结果行
      // 与成图相邻，图廊按 PiImagePartData.toolCallId 认亲）；toolName 由配对
      // 工具名补齐（sidecar transcript/stream 同款语义）
      for (const img of output.images) {
        group.parts.push({
          type: "data",
          name: IMAGE_PART_NAME,
          data: { ...img.data, toolName: part.name },
        });
      }
    }
    // unknown assistant content parts are dropped (open union forward-compat:
    // the transcript remains canonical; the snapshot self-heals).
  }

  // 最终中止标记：快照行上的 __truncationStopped（sidecar thread_snapshot 依
  // isTruncationStoppedRow 标注——连续截断把续跑预算烧到头的那轮）。转成
  // data part 后与直播 chunk（stream.ts 预算耗尽分支）落下的 part 同形，
  // AssistantMessage 检测后渲染「任务已中止」分隔线。被标注的行必是组内最后
  // 一条 assistant（其后是普通 user 行或 EOF），标记落在气泡底部语义正确。
  if ((message as { __truncationStopped?: unknown }).__truncationStopped) {
    group.parts.push(dataPart("truncation-stopped", {}));
  }
};

const buildAssistantMessage = (
  group: GroupAccumulator,
  input: PiProjectionInput,
  isLastMessageInTranscript: boolean,
): ThreadMessageLike => {
  const last = group.lastAssistant;
  const status = assistantStatus(group, input, isLastMessageInTranscript);

  return {
    id: messageId(group.anchorMessage, group.firstIndex),
    role: "assistant",
    createdAt: createdAtOf(last),
    content: group.parts,
    ...(status ? { status } : {}),
    metadata: {
      steps: group.steps,
      custom: {
        pi: {
          provider: last.provider,
          model: last.model,
          api: last.api,
          usage: last.usage,
          stopReason: last.stopReason,
          ...(last.errorMessage ? { errorMessage: last.errorMessage } : {}),
        },
      },
    },
  };
};

const assistantStatus = (
  group: GroupAccumulator,
  input: PiProjectionInput,
  isLastMessageInTranscript: boolean,
): ThreadMessageLike["status"] => {
  if (group.hasPendingHostUi) {
    return { type: "requires-action", reason: "interrupt" };
  }
  const last = group.lastAssistant;
  if (
    input.runStatus === "running" &&
    isLastMessageInTranscript &&
    last.stopReason !== "error" &&
    last.stopReason !== "aborted"
  ) {
    return { type: "running" };
  }
  if (last.stopReason === "error") {
    return {
      type: "incomplete",
      reason: "error",
      ...(last.errorMessage ? { error: last.errorMessage } : {}),
    };
  }
  if (last.stopReason === "aborted") {
    return { type: "incomplete", reason: "cancelled" };
  }
  if (last.stopReason === "length") {
    return { type: "incomplete", reason: "length" };
  }
  return { type: "complete", reason: "stop" };
};

export const projectPiThreadMessages = (
  input: PiProjectionInput,
): ThreadMessageLike[] => {
  const { messages } = input;
  const toolResults = buildToolResultMap(messages);
  const hostUiByToolCall = splitHostUiRequests(
    input.hostUiRequests,
  ).toolAssociated;
  const out: ThreadMessageLike[] = [];
  let group: GroupAccumulator | null = null;

  const flush = (isLast: boolean) => {
    if (!group) return;
    out.push(buildAssistantMessage(group, input, isLast));
    group = null;
  };

  messages.forEach((message, index) => {
    const isLast = index === messages.length - 1;
    switch (message.role) {
      case "assistant": {
        if (!group) {
          group = {
            firstIndex: index,
            anchorMessage: message as PiAssistantMessage,
            parts: [],
            steps: [],
            lastAssistant: message as PiAssistantMessage,
            hasPendingHostUi: false,
          };
        }
        projectAssistantInto(
          group,
          message as PiAssistantMessage,
          index,
          input,
          toolResults,
          hostUiByToolCall,
        );
        // If this is the final transcript message, the group's status reflects
        // the live run; flush so that propagates.
        if (isLast) flush(true);
        break;
      }

      case "toolResult":
        // Paired into the tool-call part by id; never emitted standalone.
        // Keeps the assistant group open so following assistant turns merge in.
        break;

      case "user": {
        // 长度截断自动续跑的注入消息（哨兵前缀，pi-protocol 单源判定）：与
        // sidecar toUiMessage/historyToUiMessages 同口径隐藏，此前经
        // thread_snapshot 直出漏成用户提问气泡。跳过但不 flush——直播上连续
        // assistant 轮（截断轮→续跑轮）本就并入同组，保持「刷新=直播」同构。
        if (isAutoContinueMessage(message)) break;
        flush(false);
        const id = messageId(message as PiUserMessage, index);
        const { parts, attachments } = projectUserContent(
          (message as PiUserMessage).content,
          id,
        );
        out.push({
          id,
          role: "user",
          createdAt: createdAtOf(message as PiUserMessage),
          content: parts,
          ...(attachments.length ? { attachments } : {}),
        });
        break;
      }

      case "bashExecution": {
        flush(false);
        const m = message as PiBashExecutionMessage;
        out.push(
          standaloneData(index, m, "pi-bash-execution", {
            command: m.command,
            output: m.output,
            exitCode: m.exitCode,
            cancelled: m.cancelled,
            truncated: m.truncated,
            fullOutputPath: m.fullOutputPath,
          }),
        );
        break;
      }

      case "custom": {
        flush(false);
        const m = message as PiCustomMessage;
        if (!m.display) break; // hidden from UI, still in LLM context
        out.push({
          id: messageId(m, index),
          role: "assistant",
          createdAt: createdAtOf(m),
          content: [
            dataPart("pi-custom-message", {
              customType: m.customType,
              details: m.details,
            }),
            ...projectUserContent(m.content).parts,
          ],
        });
        break;
      }

      case "branchSummary": {
        flush(false);
        const m = message as PiBranchSummaryMessage;
        out.push(
          standaloneData(index, m, "pi-branch-summary", {
            summary: m.summary,
            fromId: m.fromId,
          }),
        );
        break;
      }

      case "compactionSummary": {
        flush(false);
        const m = message as PiCompactionSummaryMessage;
        // 本地改动（快照分隔线保真）：data part 名与载荷对齐 UI 注册端
        // （compaction-banner CompactionDataUI）与 get_history 的
        // data-compaction part——旧名 "pi-compaction-summary" 分隔线渲染不出
        out.push(
          standaloneData(index, m, "compaction", {
            phase: "complete",
            generation: m.generation,
            tokensBefore: m.tokensBefore,
            summarized: m.summarized,
            // 摘要正文：活动面板「压缩摘要」一节按 data.summary 取用（缺失即整节跳过），
            // 分隔线横幅只认 phase，多带一个字段无副作用
            summary: m.summary,
          }),
        );
        break;
      }

      default:
        flush(false);
        out.push(
          standaloneData(index, message, "pi-unsupported-message", {
            role: message.role,
            message,
          }),
        );
        break;
    }
  });

  // A transcript ending on a `toolResult` leaves the assistant group open; mark
  // it last so the live run status ("running") propagates.
  flush(true);
  return out;
};

const standaloneData = (
  index: number,
  message: StableIdAnchor & { timestamp?: number },
  name: string,
  data: Record<string, unknown>,
): ThreadMessageLike => ({
  id: messageId(message, index),
  role: "assistant",
  createdAt: createdAtOf(message),
  content: [dataPart(name, data)],
});

const isDateEqual = (a: unknown, b: unknown) =>
  a instanceof Date && b instanceof Date
    ? a.getTime() === b.getTime()
    : undefined;

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" &&
  value !== null &&
  Object.getPrototypeOf(value) === Object.prototype;

const deepEqual = (a: unknown, b: unknown): boolean => {
  if (a === b) return true;

  const dateEqual = isDateEqual(a, b);
  if (dateEqual !== undefined) return dateEqual;

  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }

  if (isPlainObject(a) || isPlainObject(b)) {
    if (!isPlainObject(a) || !isPlainObject(b)) return false;
    const aKeys = Object.keys(a);
    const bKeys = Object.keys(b);
    if (aKeys.length !== bKeys.length) return false;
    for (const key of aKeys) {
      if (!Object.prototype.hasOwnProperty.call(b, key)) return false;
      if (!deepEqual(a[key], b[key])) return false;
    }
    return true;
  }

  return false;
};

const sameThreadMessageLike = (
  a: ThreadMessageLike,
  b: ThreadMessageLike,
): boolean =>
  a.id === b.id &&
  a.role === b.role &&
  deepEqual(a.createdAt, b.createdAt) &&
  deepEqual(a.content, b.content) &&
  deepEqual(a.attachments, b.attachments) &&
  deepEqual(a.status, b.status) &&
  deepEqual(a.metadata, b.metadata);

export const shareProjectedThreadMessages = (
  next: readonly ThreadMessageLike[],
  previous: readonly ThreadMessageLike[],
): readonly ThreadMessageLike[] => {
  let changed = next.length !== previous.length;
  const shared = next.map((message, index) => {
    const prev = previous[index];
    if (prev && sameThreadMessageLike(message, prev)) return prev;
    changed = true;
    return message;
  });

  return changed ? shared : previous;
};

export const projectPiThreadMessagesShared = (
  input: PiProjectionInput,
  previous: readonly ThreadMessageLike[],
): readonly ThreadMessageLike[] =>
  shareProjectedThreadMessages(projectPiThreadMessages(input), previous);

export const projectPiThreadRepository = (input: PiProjectionInput) =>
  ExportedMessageRepository.fromArray(projectPiThreadMessages(input));

// re-exported helper purely for tests / advanced consumers
export type { ContentPart as PiProjectedContentPart };
export type { PiToolResultContent };
