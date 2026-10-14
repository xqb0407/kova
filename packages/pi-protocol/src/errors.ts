/**
 * 错误归因契约（设计文档 §8）。
 * errorText 永久保留为兜底字符串；error 对象字段来自 sidecar
 * agent/agent-errors.ts 的 ClassifiedAgentError（分类器上线到线协议）。
 */
import { z } from "zod";

export const errorSourceSchema = z.enum([
  "provider",
  "network",
  "tool",
  "runtime",
]);

export const errorPayloadSchema = z.looseObject({
  code: z.string(),
  source: errorSourceSchema,
  retryable: z.boolean(),
  statusCode: z.number().int().min(100).max(599).optional(),
});

/** 管理命令错误应答帧（errorText 旧字段不动，error 为加性扩展） */
export const errorResponseFrameSchema = z.looseObject({
  id: z.string().optional(),
  type: z.literal("error"),
  errorText: z.string(),
  error: errorPayloadSchema.optional(),
});

export type ErrorSource = z.infer<typeof errorSourceSchema>;
export type ErrorPayload = z.infer<typeof errorPayloadSchema>;
export type ErrorResponseFrame = z.infer<typeof errorResponseFrameSchema>;
