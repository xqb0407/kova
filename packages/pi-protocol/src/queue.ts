/**
 * 队列快照契约（设计文档 plans/session-context-design.md §5）。
 * 全量快照、整字段替换语义：任何增量深合并都是禁手，最后快照胜出。
 * 载荷不含 msg 帧——恢复项由前端按原载荷重建：文本 + 随快照携带的
 * 图片附件（文档类附件 sidecar 已落盘 .kova/attachments 并折算说明行，
 * 重发只需文本）。
 */
import { z } from "zod";

/** 随快照携带的图片附件——**与 prompt 帧附件同形**（前端组装的
 *  { name, mimeType, data | path }，见 desktop lib/pi/pi-channel.ts 的
 *  PiPromptAttachment）：粘贴/网页端图片带 data（裸 base64，无 data: 前缀），
 *  dialog 路径直选图片带 path（派发/出队时按需读盘内联）。
 *
 *  兼容性注记（2026-10-05 修复）：此前这里（连同 sidecar 的两处过滤）要求
 *  一个前端从不发送的 `type: "image"` 字段，导致队列快照/出队把图片全丢
 *  （本机全部历史 queue_state 行无一携带 attachments，而其中多次是带图排队）。
 *  schema 保持 loose：历史行里的多余字段（含旧 `type`）原样透传。
 *  可选：旧快照行无此字段照常回放。 */
export const queueAttachmentSchema = z.looseObject({
  name: z.string().optional(),
  mimeType: z.string(),
  data: z.string().optional(),
  path: z.string().optional(),
});

export type QueueAttachment = z.infer<typeof queueAttachmentSchema>;

export const queueSnapshotItemSchema = z.looseObject({
  id: z.number(),
  reqId: z.string(),
  text: z.string(),
  createdAt: z.string(),
  attachments: z.array(queueAttachmentSchema).optional(),
});

export const queueSnapshotSchema = z.looseObject({
  version: z.literal(2),
  threadId: z.string(),
  items: z.array(queueSnapshotItemSchema),
  nextId: z.number(),
});

export type QueueSnapshotItem = z.infer<typeof queueSnapshotItemSchema>;
export type QueueSnapshot = z.infer<typeof queueSnapshotSchema>;
