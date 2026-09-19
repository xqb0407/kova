/**
 * 浏览器驱动工具（browser_navigate / browser_snapshot / browser_click /
 * browser_type / browser_scroll / browser_back）：schema 留本侧，执行转发
 * Rust 宿主（browser.rs）驱动面板子 webview——渲染载体是 unstable 多 webview，
 * 前端 browser-view 只负责定位与显示，控制回路全部走 hostdb（host_query），
 * 不经过前端中转。每个动作的结果都带渲染后的页面快照（可交互树 + ref），
 * 模型按 ref 决策下一步，无需单独再取快照。
 * 动作开始时顺带发 data-panelOpen chunk：前端把浏览器 tab 推到前台并展开
 * 收起的面板，用户能实时看到 agent 的操作（pi-transport 消费）。
 * 快照 ref 与页面状态绑定，页面一变即失效（宿主报 stale ref，让模型重新快照）。
 * 设置开关（browser-config.ts，get/set_browser 协议）：工具常驻注册不按开关
 * 增删（缓存纪律），execute 内实时门控，关闭时婉拒。
 */
import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { hostToolCall } from "./hostdb";
import { sendEventChunk } from "./stream";
import { getBrowserConfig } from "./browser-config";

const LABELS: Record<string, string> = {
  browser_navigate: "Browser Navigate",
  browser_snapshot: "Browser Snapshot",
  browser_resize: "Browser Resize",
  browser_click: "Browser Click",
  browser_type: "Browser Type",
  browser_scroll: "Browser Scroll",
  browser_back: "Browser Back",
};

/** 与 tools.ts textResult 同形（AgentToolResult.details 必填） */
const textResult = (text: string) => ({
  content: [{ type: "text" as const, text }],
  details: undefined,
});

function browserTool(
  name: string,
  threadId: string,
  description: string,
  parameters: AgentTool["parameters"],
): AgentTool {
  return {
    name,
    label: LABELS[name] ?? name,
    description,
    parameters,
    execute: async (_id, params, signal) => {
      // 设置门控（常驻注册，execute 实时读）：关闭时婉拒并给替代路径，
      // 下一次调用即读到新值（browser-config.ts）
      if (!getBrowserConfig().enabled) {
        return textResult(
          "Browser tools are disabled in Settings (智能体工具 → 浏览器驱动). " +
            "Do not retry; use WebFetch for read-only page content instead.",
        );
      }
      // 面板唤起：浏览器 tab 推到前台（无 tab 则新开）；navigate 带 url 直达
      const url =
        typeof (params as { url?: unknown })?.url === "string"
          ? (params as { url: string }).url
          : undefined;
      sendEventChunk(threadId, {
        type: "data-panelOpen",
        data: { type: "browser", ...(url ? { url } : {}) },
      });
      const data = await hostToolCall(
        name,
        "",
        params as Record<string, unknown>,
        signal ?? undefined,
      );
      return textResult(data.output);
    },
  };
}

export function buildBrowserTools(threadId: string): AgentTool[] {
  return [
    browserTool(
      "browser_navigate",
      threadId,
      "Drive the built-in browser panel (the one the user can see) to a URL and return the " +
        "rendered page as an interactive snapshot. Workflow: browser_navigate → read the snapshot → " +
        "act on elements by ref (browser_click / browser_type); every action returns a fresh snapshot. " +
        "This executes JavaScript and reflects the post-render DOM — use it when WebFetch is not enough.",
      Type.Object({
        url: Type.String({ description: "Absolute http(s) URL to navigate to" }),
      }),
    ),
    browserTool(
      "browser_snapshot",
      threadId,
      "Capture the built-in browser's current page as an interactive tree. Interactive elements " +
        "carry [ref=eN]; use refs with browser_click / browser_type. Covers the main frame only.",
      Type.Object({}),
    ),
    browserTool(
      "browser_resize",
      threadId,
      "Switch the built-in browser's viewport size (responsive checking). Pass width+height in CSS px " +
        "(e.g. 1280x800 desktop, 768x1024 tablet, 375x812 mobile) to pin a fixed viewport, or no args " +
        "to fill the panel again. Returns a fresh snapshot of the reflowed page.",
      Type.Object({
        width: Type.Optional(Type.Number({ description: "Viewport width in CSS px" })),
        height: Type.Optional(Type.Number({ description: "Viewport height in CSS px" })),
        fill: Type.Optional(
          Type.Boolean({ description: "Reset to fill the panel (default when width/height omitted)" }),
        ),
      }),
    ),
    browserTool(
      "browser_click",
      threadId,
      "Click an element in the built-in browser by ref (from the latest snapshot) and return a " +
        "fresh snapshot after the page settles. Refs are invalidated by page changes — if it reports " +
        "a stale ref, take a new browser_snapshot.",
      Type.Object({
        ref: Type.String({ description: "Element ref from the latest snapshot, e.g. \"e12\"" }),
      }),
    ),
    browserTool(
      "browser_type",
      threadId,
      "Type text into an input/textarea/contenteditable element in the built-in browser by ref " +
        "(replaces existing text) and return a fresh snapshot. Set submit to press Enter afterwards " +
        "(submits the surrounding form).",
      Type.Object({
        ref: Type.String({ description: "Element ref from the latest snapshot, e.g. \"e3\"" }),
        text: Type.String({ description: "Text to type (replaces current value)" }),
        submit: Type.Optional(
          Type.Boolean({ description: "Press Enter after typing (default false)" }),
        ),
      }),
    ),
    browserTool(
      "browser_scroll",
      threadId,
      "Scroll the built-in browser's page and return a fresh snapshot. Use it to reveal content " +
        "cut off by the snapshot limit.",
      Type.Object({
        direction: Type.String({ description: "up | down | top | bottom" }),
        amount: Type.Optional(
          Type.Number({ description: "Pixels for up/down (default 600)" }),
        ),
      }),
    ),
    browserTool(
      "browser_back",
      threadId,
      "Go back one page in the built-in browser's history and return a fresh snapshot.",
      Type.Object({}),
    ),
  ];
}
