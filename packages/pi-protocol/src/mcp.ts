/**
 * MCP 元数据契约（2026 能力面：resources / prompts）。
 *
 * 只定义跨 sidecar ⇄ desktop 需要的**可序列化元数据**；工具 schema、调用结果
 * 仍由 mcp-cache / mcp-output-guard 管。schema 一律 loose：协议只增不改，
 * 旧端忽略新字段，新端收到未知字段原样保留。
 *
 * Tasks 的 capability 也在这里占位：M1 只读声明，M2 才接执行面。
 */
import { z } from "zod";

/** 服务器能力开关（initialize 的 serverCapabilities 投影） */
export const mcpCapabilityFlagsSchema = z.looseObject({
  resources: z.boolean(),
  prompts: z.boolean(),
  tasks: z.boolean(),
});
export type McpCapabilityFlags = z.infer<typeof mcpCapabilityFlagsSchema>;

/** 一条可读资源（resources/list） */
export const mcpResourceMetaSchema = z.looseObject({
  uri: z.string(),
  name: z.string(),
  title: z.string().optional(),
  description: z.string().optional(),
  mimeType: z.string().optional(),
  size: z.number().int().nonnegative().optional(),
});
export type McpResourceMeta = z.infer<typeof mcpResourceMetaSchema>;

/** 资源模板（resources/templates/list） */
export const mcpResourceTemplateMetaSchema = z.looseObject({
  uriTemplate: z.string(),
  name: z.string(),
  title: z.string().optional(),
  description: z.string().optional(),
  mimeType: z.string().optional(),
});
export type McpResourceTemplateMeta = z.infer<typeof mcpResourceTemplateMetaSchema>;

/** resources/list + resources/templates/list 的一次快照 */
export const mcpResourceSnapshotSchema = z.looseObject({
  resources: z.array(mcpResourceMetaSchema),
  resourceTemplates: z.array(mcpResourceTemplateMetaSchema),
});
export type McpResourceSnapshot = z.infer<typeof mcpResourceSnapshotSchema>;

/** prompt 参数声明 */
export const mcpPromptArgumentSchema = z.looseObject({
  name: z.string(),
  description: z.string().optional(),
  required: z.boolean().optional(),
});
export type McpPromptArgument = z.infer<typeof mcpPromptArgumentSchema>;

/** 一条服务器 prompt（prompts/list） */
export const mcpPromptMetaSchema = z.looseObject({
  name: z.string(),
  title: z.string().optional(),
  description: z.string().optional(),
  arguments: z.array(mcpPromptArgumentSchema).optional(),
});
export type McpPromptMeta = z.infer<typeof mcpPromptMetaSchema>;

/** resources/read 的单条内容；text 与 blob 二选一（读取侧再走输出防护） */
export const mcpResourceContentSchema = z.looseObject({
  uri: z.string(),
  mimeType: z.string().optional(),
  text: z.string().optional(),
  blob: z.string().optional(),
});
export type McpResourceContent = z.infer<typeof mcpResourceContentSchema>;
