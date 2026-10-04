/**
 * 队列快照契约（设计文档 plans/session-context-design.md §5）。
 * 全量快照、整字段替换语义：任何增量深合并都是禁手，最后快照胜出。
 * 载荷不含 msg 帧——恢复项由前端按文本重建气泡。
 */
import { z } from "zod";

export const queueSnapshotItemSchema = z.looseObject({
  id: z.number(),
  reqId: z.string(),
  text: z.string(),
  createdAt: z.string(),
});

export const queueSnapshotSchema = z.looseObject({
  version: z.literal(2),
  threadId: z.string(),
  items: z.array(queueSnapshotItemSchema),
  nextId: z.number(),
});

export type QueueSnapshotItem = z.infer<typeof queueSnapshotItemSchema>;
export type QueueSnapshot = z.infer<typeof queueSnapshotSchema>;
