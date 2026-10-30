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
import { hostToolCall } from "../storage/hostdb";
import { sendEventChunk } from "../protocol/stream";
import { sessionForThread } from "../sessions/pending-interactions";
import { getBrowserConfig } from "./browser-config";

const LABELS: Record<string, string> = {
  browser_navigate: "Browser Navigate",
  browser_snapshot: "Browser Snapshot",
  browser_resize: "Browser Resize",
  browser_click: "Browser Click",
  browser_type: "Browser Type",
  browser_press: "Browser Press",
  browser_hover: "Browser Hover",
  browser_scroll: "Browser Scroll",
  browser_select: "Browser Select",
  browser_check: "Browser Check",
  browser_drag: "Browser Drag",
  browser_evaluate: "Browser Evaluate",
  browser_wait_for: "Browser Wait For",
  browser_state: "Browser State",
  browser_dialog: "Browser Dialog",
  browser_back: "Browser Back",
  browser_forward: "Browser Forward",
  browser_reload: "Browser Reload",
  browser_shot: "Browser Screenshot",
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
  /** 该工具受哪个子开关管；不传则跟 enabled 总开关 */
  subSwitch?: "pixelShot",
): AgentTool {
  return {
    name,
    label: LABELS[name] ?? name,
    description,
    parameters,
    execute: async (_id, params, signal) => {
      // 设置门控（常驻注册，execute 实时读）：关闭时婉拒并给替代路径，
      // 下一次调用即读到新值（browser-config.ts）
      const cfg = getBrowserConfig();
      if (subSwitch && !cfg[subSwitch]) {
        return textResult(
          subSwitch === "pixelShot"
            ? "Page screenshots are disabled in Settings (智能体配置 → 电脑控制 → 像素截图). " +
                "Do not retry; the DOM tools still work, but you cannot see canvas/WebGL " +
                "pixels. Report what the snapshot says instead of guessing at the picture."
            : "This capability is disabled in Settings.",
        );
      }
      if (!cfg.enabled && subSwitch !== "pixelShot") {
        return textResult(
          "Browser tools are disabled in Settings (智能体配置 → 电脑控制 → 浏览器驱动). " +
            "Do not retry; use WebFetch for read-only page content instead.",
        );
      }
      // 面板唤起：浏览器 tab 推到前台（无 tab 则新开）；navigate 带 url 直达
      const url =
        typeof (params as { url?: unknown })?.url === "string"
          ? (params as { url: string }).url
          : undefined;
      // 第三参带上属主 sessionId：缺它时前端按「当前显示会话」兜底落桶——
      // 后台会话的浏览器会错开在用户正看的会话里
      sendEventChunk(threadId, {
        type: "data-panelOpen",
        data: { type: "browser", ...(url ? { url } : {}) },
      }, sessionForThread(threadId));
      const data = await hostToolCall(
        name,
        "",
        params as Record<string, unknown>,
        signal ?? undefined,
        threadId,
      );
      // browser_shot 的成功信封是 {base64, mimeType, bytes, width, height, url}
      // ——**没有 output 字段**（Rust browser_shot.rs 只回图片载荷）。早先这里
      // 无条件 textResult(data.output)，于是 data.output 为 undefined，写进转录
      // 的是 {type:"text", text:undefined}，JSON 序列化后变成没有 text 字段的
      // 裸块：下一轮请求前 pi-ai 的上下文估算（estimate.js 的 block.text.length）
      // 直接抛 TypeError，整条会话从此每轮都起不来。像素照必须走 image 块，
      // 与 screenshot-tool.ts 同形。
      if (typeof data.base64 === "string" && typeof data.mimeType === "string") {
        const sizeNote =
          typeof data.width === "number" &&
          typeof data.height === "number" &&
          data.width > 0 &&
          data.height > 0
            ? `${data.width}×${data.height}, `
            : "";
        const kb =
          typeof data.bytes === "number"
            ? `${Math.max(1, Math.round(data.bytes / 1024))} KB`
            : "未知大小";
        return {
          content: [
            {
              type: "text" as const,
              text: `页面像素照（${sizeNote}JPEG ${kb}）`,
            },
            {
              type: "image" as const,
              data: data.base64,
              mimeType: data.mimeType,
            },
          ],
          details: { bytes: data.bytes },
        };
      }
      // 非图片工具的正常文本回程；宿主信封异常（缺 output）时兜底为可读文本，
      // 绝不让 undefined 进 text 块——畸形块会毒死后续每一轮请求。
      if (typeof data.output === "string") return textResult(data.output);
      return textResult(
        `host tool "${name}" returned no readable output ` +
          `(fields: ${Object.keys(data).join(", ") || "none"}). ` +
          `The call may have succeeded but its result was not delivered. ` +
          `Do not retry blindly — verify the current state first.`,
      );
    },
  };
}

export function buildBrowserTools(threadId: string): AgentTool[] {
  return [
    browserTool(
      "browser_navigate",
      threadId,
      "Drive the built-in browser panel (the one the user can see) to a URL and return a " +
        "structured DOM snapshot of the rendered page. Workflow: browser_navigate → read the " +
        "snapshot → act on elements by ref (browser_click / browser_type); every action returns " +
        "a fresh snapshot and refs from older snapshots become stale. This executes JavaScript " +
        "and reflects the post-render DOM — use it when WebFetch is not enough. Redirects " +
        "(http→https, login pages) are normal results; the output notes the final URL. " +
        "IMPORTANT: to view a local HTML file you wrote, pass a file:// URL for a file INSIDE " +
        "the workspace (trusted roots only; copy it there first) — do NOT start a local HTTP " +
        "server for it. If the snapshot comes back empty, the page draws with canvas/WebGL and " +
        "has no accessible elements — that is a real answer, not a failure. Call browser_shot to " +
        "see the picture instead of re-running the snapshot.",
      Type.Object({
        url: Type.String({
          description:
            "Absolute URL to navigate to: http(s)://… or file:///absolute/path.html for a " +
            "local file inside the workspace",
        }),
      }),
    ),
    browserTool(
      "browser_snapshot",
      threadId,
      "Capture the built-in browser's current page as a structured DOM snapshot. Interactive " +
        "elements carry [ref=eN], their accessible name, current value/checked/disabled state " +
        "and a CSS selector; use refs with browser_click / browser_type. Covers the main frame " +
        "only (iframe contents are not included). An empty snapshot means the page is drawn " +
        "with canvas — use browser_shot to see it.",
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
      "Click an element in the built-in browser by ref (from the latest snapshot) or by viewport " +
        "coordinates, then return a fresh snapshot after the page settles. Ref clicks use the " +
        "page's own click semantics with user activation (dialogs, React/Vue handlers and link " +
        "navigation all work); coordinate clicks use trusted CDP input. Refs are invalidated by " +
        "page changes — if it reports a stale ref, take a new browser_snapshot.",
      Type.Object({
        ref: Type.Optional(
          Type.String({ description: "Element ref from the latest snapshot, e.g. \"e12\"" }),
        ),
        x: Type.Optional(Type.Number({ description: "Viewport x (CSS px) when ref is omitted" })),
        y: Type.Optional(Type.Number({ description: "Viewport y (CSS px) when ref is omitted" })),
        button: Type.Optional(
          Type.String({ description: "left | right | middle (default left)" }),
        ),
        doubleClick: Type.Optional(Type.Boolean({ description: "Double click (default false)" })),
        modifiers: Type.Optional(
          Type.Array(
            Type.String({
              description: "Alt | Control | ControlOrMeta | Meta | Shift",
            }),
          ),
        ),
      }),
    ),
    browserTool(
      "browser_type",
      threadId,
      "Type text into an input/textarea/contenteditable element in the built-in browser by ref " +
        "(replaces existing text) and return a fresh snapshot. Uses CDP text insertion, so it also " +
        "works with CJK and controlled inputs. Set submit to press Enter afterwards (submits the " +
        "surrounding form).",
      Type.Object({
        ref: Type.String({ description: "Element ref from the latest snapshot, e.g. \"e3\"" }),
        text: Type.String({ description: "Text to type (replaces current value)" }),
        submit: Type.Optional(
          Type.Boolean({ description: "Press Enter after typing (default false)" }),
        ),
      }),
    ),
    browserTool(
      "browser_press",
      threadId,
      "Press a key or key combination in the built-in browser (Enter, Tab, Escape, arrows, single " +
        "characters, or combinations with modifiers). Optionally focus an element by ref first. " +
        "Returns a fresh snapshot.",
      Type.Object({
        key: Type.String({ description: "Key name, e.g. Enter, Tab, Escape, a, ArrowDown" }),
        ref: Type.Optional(
          Type.String({ description: "Optional element ref to click/focus before pressing" }),
        ),
        modifiers: Type.Optional(
          Type.Array(
            Type.String({ description: "Alt | Control | ControlOrMeta | Meta | Shift" }),
          ),
        ),
      }),
    ),
    browserTool(
      "browser_hover",
      threadId,
      "Move the mouse over an element (ref) or viewport coordinates to trigger hover states " +
        "(menus, tooltips). Returns a fresh snapshot.",
      Type.Object({
        ref: Type.Optional(Type.String({ description: "Element ref from the latest snapshot" })),
        x: Type.Optional(Type.Number({ description: "Viewport x when ref is omitted" })),
        y: Type.Optional(Type.Number({ description: "Viewport y when ref is omitted" })),
        modifiers: Type.Optional(
          Type.Array(Type.String({ description: "Alt | Control | ControlOrMeta | Meta | Shift" })),
        ),
      }),
    ),
    browserTool(
      "browser_scroll",
      threadId,
      "Scroll the page or a scrollable element and return a fresh snapshot. With a ref, scrolls from " +
        "that element's center (works for inner scroll containers). Without a ref, scrolls the page " +
        "at the viewport center. Use direction+amount or explicit deltaX/deltaY.",
      Type.Object({
        direction: Type.Optional(
          Type.String({ description: "up | down | top | bottom (default down)" }),
        ),
        amount: Type.Optional(
          Type.Number({ description: "Pixels for up/down (default 600)" }),
        ),
        ref: Type.Optional(
          Type.String({ description: "Optional element ref whose center receives the wheel" }),
        ),
        x: Type.Optional(Type.Number({ description: "Wheel x (CSS px) when ref is omitted" })),
        y: Type.Optional(Type.Number({ description: "Wheel y (CSS px) when ref is omitted" })),
        deltaX: Type.Optional(Type.Number({ description: "Raw horizontal wheel delta" })),
        deltaY: Type.Optional(Type.Number({ description: "Raw vertical wheel delta" })),
      }),
    ),
    browserTool(
      "browser_select",
      threadId,
      "Select one or more options in a <select> element by ref. Values match option value or visible " +
        "text. Returns a fresh snapshot.",
      Type.Object({
        ref: Type.String({ description: "Ref of the <select> element" }),
        values: Type.Array(Type.String({ description: "Option value or visible text" })),
      }),
    ),
    browserTool(
      "browser_check",
      threadId,
      "Set a checkbox or radio button to checked/unchecked by ref (default checked=true). Returns a " +
        "fresh snapshot.",
      Type.Object({
        ref: Type.String({ description: "Ref of the checkbox/radio" }),
        checked: Type.Optional(
          Type.Boolean({ description: "Desired state (default true)" }),
        ),
      }),
    ),
    browserTool(
      "browser_drag",
      threadId,
      "Drag from one element/point to another using trusted mouse events (sliders, kanban boards, " +
        "map widgets). Use fromRef/toRef or from/to {x,y} viewport coordinates. Returns a fresh " +
        "snapshot.",
      Type.Object({
        fromRef: Type.Optional(Type.String({ description: "Source element ref" })),
        toRef: Type.Optional(Type.String({ description: "Target element ref" })),
        from: Type.Optional(
          Type.Object({
            x: Type.Number({ description: "Start x (CSS px)" }),
            y: Type.Number({ description: "Start y (CSS px)" }),
          }),
        ),
        to: Type.Optional(
          Type.Object({
            x: Type.Number({ description: "End x (CSS px)" }),
            y: Type.Number({ description: "End y (CSS px)" }),
          }),
        ),
        modifiers: Type.Optional(
          Type.Array(Type.String({ description: "Alt | Control | ControlOrMeta | Meta | Shift" })),
        ),
      }),
    ),
    browserTool(
      "browser_evaluate",
      threadId,
      "Evaluate a JavaScript expression in the page's main world and return its JSON-serializable " +
        "value. Runs in the web page only (no Node, no app APIs). Use it to read runtime state that " +
        "the snapshot does not expose (localStorage, JS variables, computed values), or to drive " +
        "flows that need user activation — e.g. `el.click()` on a button that opens a confirm/alert. " +
        "NOTE: Chromium suppresses page dialogs while the app window is occluded/backgrounded, so " +
        "the dialog may not open (confirm just returns false); that is a real answer, not a failure.",
      Type.Object({
        expression: Type.String({
          description: "JavaScript expression; promises are awaited, result must be JSON-serializable",
        }),
      }),
    ),
    browserTool(
      "browser_wait_for",
      threadId,
      "Wait until a selector appears, visible text appears, or text disappears (first condition " +
        "wins), then return a fresh snapshot. Default timeout 10s, max 30s.",
      Type.Object({
        selector: Type.Optional(Type.String({ description: "CSS selector to wait for" })),
        text: Type.Optional(Type.String({ description: "Visible page text to wait for" })),
        textGone: Type.Optional(
          Type.String({ description: "Visible page text that should disappear" }),
        ),
        timeoutMs: Type.Optional(
          Type.Number({ description: "Timeout in ms (500-30000, default 10000)" }),
        ),
      }),
    ),
    browserTool(
      "browser_state",
      threadId,
      "Read lightweight page state without a full snapshot: url, title, canGoBack/canGoForward, " +
        "scroll position, viewport size, and whether a JavaScript dialog is currently open.",
      Type.Object({}),
    ),
    browserTool(
      "browser_dialog",
      threadId,
      "Accept or dismiss the JavaScript dialog currently blocking the page (alert/confirm/prompt/" +
        "beforeunload). If other browser actions report an open dialog, call this first. For prompt, " +
        "pass promptText. Returns a fresh snapshot when possible.",
      Type.Object({
        accept: Type.Boolean({ description: "true = accept/OK, false = dismiss/cancel" }),
        promptText: Type.Optional(
          Type.String({ description: "Text to enter for prompt() dialogs" }),
        ),
      }),
    ),
    browserTool(
      "browser_back",
      threadId,
      "Go back one page in the built-in browser's history and return a fresh snapshot.",
      Type.Object({}),
    ),
    browserTool(
      "browser_forward",
      threadId,
      "Go forward one page in the built-in browser's history and return a fresh snapshot.",
      Type.Object({}),
    ),
    browserTool(
      "browser_reload",
      threadId,
      "Reload the built-in browser's current page and return a fresh snapshot.",
      Type.Object({}),
    ),
    // 相机：不是第二个浏览器。webview 才是工作面，这里只按它当前的 URL 拍一张。
    browserTool(
      "browser_shot",
      threadId,
      "Screenshot the built-in browser's current page as an image you can see in the result. " +
        "By default it captures the live panel page (same login state, same scroll position) " +
        "without navigating. Use it when the snapshot is empty or too thin to answer the " +
        "question: canvas/WebGL scenes, charts, maps, video frames, or 'what does this actually " +
        "look like'. Takes about a second, so don't call it in a loop. Pass url to photograph a " +
        "specific page in a throwaway window instead (does not touch the panel) — required if " +
        "the panel has not navigated yet.",
      Type.Object({
        url: Type.Optional(
          Type.String({
            description:
              "Absolute URL to photograph. Omit to use the panel's current page. Accepts " +
              "file:///absolute/path.html only for files inside the workspace.",
          }),
        ),
        maxDim: Type.Optional(
          Type.Number({ description: "Longest edge in pixels (320-7680, default 1920)" }),
        ),
        quality: Type.Optional(
          Type.Number({ description: "JPEG quality 30-100 (default 80; lower = smaller)" }),
        ),
        format: Type.Optional(
          Type.String({
            description: "jpeg (default) or png. Live panel capture only (ignored with url)",
          }),
        ),
        fullPage: Type.Optional(
          Type.Boolean({
            description: "Capture the whole scrollable page (default false; live panel capture only)",
          }),
        ),
        ref: Type.Optional(
          Type.String({
            description: "Capture only this element (ref from the latest snapshot; live panel capture only)",
          }),
        ),
        clip: Type.Optional(
          Type.Object({
            x: Type.Number({ description: "Document x (CSS px)" }),
            y: Type.Number({ description: "Document y (CSS px)" }),
            width: Type.Number({ description: "Width (CSS px)" }),
            height: Type.Number({ description: "Height (CSS px)" }),
          }),
        ),
      }),
      "pixelShot",
    ),
  ];
}
