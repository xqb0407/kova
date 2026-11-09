/**
 * 浏览器工具行的展示语义：动作标签与主/次摘要。
 *
 * 抽成纯函数：组件只负责渲染，参数到文案的映射可以单测覆盖；新增 browser_*
 * 动作时也不会再往 tool-row.aui.tsx 里堆一个大 switch。
 */

export type BrowserToolSummary = { primary?: string; secondary?: string };

const BROWSER_TOOL_LABELS: Record<string, string> = {
  browser_navigate: "打开网页",
  browser_snapshot: "页面快照",
  browser_resize: "调整视口",
  browser_click: "点击元素",
  browser_type: "输入文本",
  browser_press: "按键",
  browser_hover: "悬停",
  browser_scroll: "滚动页面",
  browser_select: "选择选项",
  browser_check: "勾选控件",
  browser_drag: "拖拽",
  browser_evaluate: "执行脚本",
  browser_wait_for: "等待页面",
  browser_state: "页面状态",
  browser_dialog: "处理对话框",
  browser_back: "后退",
  browser_forward: "前进",
  browser_reload: "刷新页面",
  browser_shot: "页面截图",
};

const SCROLL_DIRECTION: Record<string, string> = {
  up: "向上",
  down: "向下",
  top: "到顶部",
  bottom: "到底部",
};

const MOUSE_BUTTON: Record<string, string> = {
  right: "右键",
  middle: "中键",
};

/** 输入类文案的预览上限：完整参数仍在转录里，行上只留一眼能读的部分 */
const TEXT_PREVIEW_MAX = 80;

function strArg(args: unknown, key: string): string | null {
  const v = (args as Record<string, unknown> | undefined | null)?.[key];
  return typeof v === "string" ? v : null;
}

function numArg(args: unknown, key: string): number | undefined {
  const v = (args as Record<string, unknown> | undefined | null)?.[key];
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function boolArg(args: unknown, key: string): boolean | undefined {
  const v = (args as Record<string, unknown> | undefined | null)?.[key];
  return typeof v === "boolean" ? v : undefined;
}

function strListArg(args: unknown, key: string): string[] {
  const v = (args as Record<string, unknown> | undefined | null)?.[key];
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

function pointText(v: unknown): string | undefined {
  if (typeof v !== "object" || v === null) return undefined;
  const x = (v as Record<string, unknown>).x;
  const y = (v as Record<string, unknown>).y;
  return typeof x === "number" && typeof y === "number" ? `${x}, ${y}` : undefined;
}

function coordText(args: unknown): string | undefined {
  const x = numArg(args, "x");
  const y = numArg(args, "y");
  return x !== undefined && y !== undefined ? `${x}, ${y}` : undefined;
}

function clipText(v: unknown): string | undefined {
  if (typeof v !== "object" || v === null) return undefined;
  const width = (v as Record<string, unknown>).width;
  const height = (v as Record<string, unknown>).height;
  return typeof width === "number" && typeof height === "number"
    ? `${width} × ${height}`
    : undefined;
}

function joinMeta(parts: Array<string | null | undefined | false>): string | undefined {
  return parts.filter(Boolean).join(" · ") || undefined;
}

function previewText(text: string): string | undefined {
  const first = text.split("\n")[0]?.trim() ?? "";
  if (!first) return undefined;
  return first.length > TEXT_PREVIEW_MAX
    ? `${first.slice(0, TEXT_PREVIEW_MAX)}…`
    : first;
}

/** 工具名 → 动作标签；未知的 browser_* 只保留后缀，避免“浏览器 · browser_x” */
export function browserToolLabel(toolName: string): string {
  const label =
    BROWSER_TOOL_LABELS[toolName] ?? toolName.replace(/^browser_/, "");
  return label || "浏览器操作";
}

/** 浏览器工具行摘要：ref/坐标/URL 等关键参数进主行，修饰键与附加条件进次行 */
export function browserToolSummary(
  toolName: string,
  args: unknown,
): BrowserToolSummary {
  const raw = args as Record<string, unknown> | undefined;
  switch (toolName) {
    case "browser_navigate":
      return { primary: strArg(args, "url") ?? undefined };
    case "browser_resize": {
      const width = numArg(args, "width");
      const height = numArg(args, "height");
      return {
        primary:
          width !== undefined && height !== undefined
            ? `${width} × ${height}`
            : width !== undefined
              ? `宽 ${width}`
              : height !== undefined
                ? `高 ${height}`
                : "填充面板",
      };
    }
    case "browser_click": {
      const ref = strArg(args, "ref");
      const pos = coordText(args);
      const button = strArg(args, "button");
      const mods = strListArg(args, "modifiers");
      return {
        primary: ref ? `ref ${ref}` : pos ? `坐标 ${pos}` : undefined,
        secondary: joinMeta([
          boolArg(args, "doubleClick") ? "双击" : null,
          button && button !== "left" ? (MOUSE_BUTTON[button] ?? button) : null,
          mods.length ? mods.join("+") : null,
        ]),
      };
    }
    case "browser_type": {
      const ref = strArg(args, "ref");
      return {
        primary: previewText(strArg(args, "text") ?? ""),
        secondary: joinMeta([
          ref ? `ref ${ref}` : null,
          boolArg(args, "submit") ? "回车提交" : null,
        ]),
      };
    }
    case "browser_press": {
      const ref = strArg(args, "ref");
      const mods = strListArg(args, "modifiers");
      return {
        primary: strArg(args, "key") ?? undefined,
        secondary: joinMeta([
          ref ? `ref ${ref}` : null,
          mods.length ? mods.join("+") : null,
        ]),
      };
    }
    case "browser_hover": {
      const ref = strArg(args, "ref");
      const pos = coordText(args);
      return { primary: ref ? `ref ${ref}` : pos ? `坐标 ${pos}` : undefined };
    }
    case "browser_scroll": {
      const dx = numArg(args, "deltaX");
      const dy = numArg(args, "deltaY");
      const amount = numArg(args, "amount");
      const direction = strArg(args, "direction") ?? "down";
      const ref = strArg(args, "ref");
      return {
        primary:
          dx !== undefined || dy !== undefined
            ? `Δ ${dx ?? 0}, ${dy ?? 0}`
            : `${SCROLL_DIRECTION[direction] ?? direction}${amount !== undefined ? ` ${amount}px` : ""}`,
        secondary: ref ? `ref ${ref}` : undefined,
      };
    }
    case "browser_select": {
      const ref = strArg(args, "ref");
      const values = strListArg(args, "values");
      return {
        primary: ref ? `ref ${ref}` : undefined,
        secondary: values.length ? `选择 ${values.join(", ")}` : undefined,
      };
    }
    case "browser_check": {
      const ref = strArg(args, "ref");
      return {
        primary: ref ? `ref ${ref}` : undefined,
        secondary: boolArg(args, "checked") === false ? "取消勾选" : "勾选",
      };
    }
    case "browser_drag": {
      const fromRef = strArg(args, "fromRef");
      const toRef = strArg(args, "toRef");
      const from = fromRef ? `ref ${fromRef}` : pointText(raw?.from);
      const to = toRef ? `ref ${toRef}` : pointText(raw?.to);
      return { primary: from && to ? `${from} → ${to}` : (from ?? to) };
    }
    case "browser_evaluate":
      return { primary: previewText(strArg(args, "expression") ?? "") };
    case "browser_wait_for": {
      const selector = strArg(args, "selector");
      const text = strArg(args, "text");
      const textGone = strArg(args, "textGone");
      const timeout = numArg(args, "timeoutMs");
      return {
        primary: selector
          ? `选择器 ${selector}`
          : text
            ? `文本「${previewText(text) ?? ""}」`
            : textGone
              ? `等待「${previewText(textGone) ?? ""}」消失`
              : undefined,
        secondary:
          timeout !== undefined ? `${Math.round(timeout / 100) / 10}s` : undefined,
      };
    }
    case "browser_dialog":
      return {
        primary: boolArg(args, "accept") === false ? "取消" : "接受",
        secondary: strArg(args, "promptText")
          ? `输入「${previewText(strArg(args, "promptText") ?? "") ?? ""}」`
          : undefined,
      };
    case "browser_shot": {
      const url = strArg(args, "url");
      const ref = strArg(args, "ref");
      const fullPage = boolArg(args, "fullPage") === true;
      const clip = clipText(raw?.clip);
      const maxDim = numArg(args, "maxDim");
      return {
        primary: url ?? (ref ? `ref ${ref}` : "当前页面"),
        secondary: joinMeta([
          url && ref ? `ref ${ref}` : null,
          fullPage ? "整页" : null,
          clip ? `裁剪 ${clip}` : null,
          maxDim !== undefined ? `最长边 ${maxDim}px` : null,
        ]),
      };
    }
    default:
      return {};
  }
}
