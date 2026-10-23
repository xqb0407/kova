/**
 * 子智能体并发设置的值域契约（桌面设置页与 sidecar 共用）。
 *
 * 默认 8 与旧的硬编码上限一致；上限 16 防止设置页把单会话同时拉起的
 * 模型请求推到不可控的量级。sidecar 写入前会再 clamp 一次，桌面端只做
 * 输入体验上的同一套钳制。
 */
export const SUBAGENT_MAX_CONCURRENCY_DEFAULT = 8;
export const SUBAGENT_MAX_CONCURRENCY_MIN = 1;
export const SUBAGENT_MAX_CONCURRENCY_MAX = 16;
