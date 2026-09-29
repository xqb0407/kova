/**
 * 屏幕截图工具（screenshot）：schema 留本侧，执行转发 Rust 宿主
 * （tool_exec.rs handle_screenshot）。宿主把全屏静默抓图并压成 JPEG
 * （按内联预算阶梯降质/缩尺寸），回 base64；本侧只把它拼成工具结果的 image
 * 块 —— 投影闸门（image-parts.ts）与前端渲染（image-data.tsx）自动生效，
 * 对话里直接出缩略卡片。
 *
 * 平台：macOS（screencapture + sips）与 Windows（PowerShell + System.Drawing）；
 * Linux 宿主返回 Err，agent 循环按工具错误处理。
 */
import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { hostScreenshotCall } from "../storage/hostdb";

function formatKb(bytes: number): string {
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export function buildScreenshotTool(cwd: string): AgentTool {
  return {
    name: "screenshot",
    label: "Screenshot",
    description:
      "Capture the current full screen and return it as an image you can see in the result. " +
      "Use it to see what's on the user's display (app state, a non-browser window, visual bugs). " +
      "The image is compressed to fit inline display; optionally cap the longest edge (maxDim) or " +
      "set JPEG quality (30-100). macOS and Windows only.",
    parameters: Type.Object({
      maxDim: Type.Optional(
        Type.Number({ description: "Longest edge in pixels after resize (640-3840, default 1920)" }),
      ),
      quality: Type.Optional(
        Type.Number({ description: "JPEG quality 30-100 (default 70; lower = smaller file)" }),
      ),
    }),
    execute: async (_id, params, signal) => {
      const data = await hostScreenshotCall(
        cwd,
        params as Record<string, unknown>,
        signal ?? undefined,
      );
      const sizeNote =
        data.width > 0 && data.height > 0
          ? `${data.width}×${data.height}, `
          : "";
      const text = `屏幕截图（${sizeNote}JPEG ${formatKb(data.bytes)}）`;
      return {
        content: [
          { type: "text" as const, text },
          { type: "image" as const, data: data.base64, mimeType: data.mimeType },
        ],
        details: { bytes: data.bytes, width: data.width, height: data.height },
      };
    },
  };
}
