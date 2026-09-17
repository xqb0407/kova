/**
 * 【临时验收工具 · 验收后整文件删除并从 tools.ts 摘除注册】
 *
 * 对话内图片渲染（docs/image-part-design.md §10 PR4）的手工验收 seed：
 * 返回合法 1×1 PNG（走投影上屏）或超大伪 base64（走 2MiB 闸门占位降级），
 * 用来核对直播 / 刷新 / 续流重放三态图片渲染一致。
 *
 * 用法：对话里直接说「用 echo_image 画一张 2 图的测试，再来一张超限的」，
 * 或让模型自行选择 count/oversized 参数。
 */
import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";

/** 真 1×1 透明 PNG（67B 原始），data-image 投影与 <img> 解码都是合法输入 */
const PNG_1x1 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

/** ≈3MiB 原始字节的合法前缀 + 填充：专测超限降级（投影后不进线，永不解码） */
const OVERSIZED_B64 = PNG_1x1 + "A".repeat(4 * 1024 * 1024);

export function buildEchoImageTool(): AgentTool {
  return {
    name: "echo_image",
    label: "Echo Image",
    description:
      "[TEST ONLY] Return fixed PNG image(s) as tool result image blocks. " +
      "Set oversized=true to exceed the 2MiB inline cap (placeholder degradation check).",
    parameters: Type.Object({
      count: Type.Optional(
        Type.Number({ description: "How many images to return (1-3, default 1)" }),
      ),
      oversized: Type.Optional(
        Type.Boolean({ description: "Emit an oversized image block that must fall back to placeholder" }),
      ),
    }),
    execute: async (_id, params) => {
      const n = Math.min(3, Math.max(1, Math.round((params as { count?: number }).count ?? 1)));
      const oversized = Boolean((params as { oversized?: boolean }).oversized);
      const content: (TextContent | ImageContent)[] = [
        {
          type: "text" as const,
          text: `echo_image 产出 ${n} 张测试图${oversized ? "（含 1 张超限）" : ""}`,
        },
      ];
      for (let i = 0; i < n; i++) {
        content.push({ type: "image" as const, data: PNG_1x1, mimeType: "image/png" });
      }
      if (oversized) {
        content.push({ type: "image" as const, data: OVERSIZED_B64, mimeType: "image/png" });
      }
      return { content, details: { count: n, oversized } };
    },
  };
}
