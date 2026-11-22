/**
 * CDP 输入原语（对齐 X browserCommandInput 的子集）：
 * click / hover / wheel / drag / key / text 全部走 Input.dispatch*，产生
 * isTrusted=true 的真实输入事件——合成 MouseEvent 在部分站点和框架里会被忽略，
 * 这是旧实现“点了没反应”的主要来源。
 */
import {
  sendCdp,
  sendCdpNoWait,
  sendCdpRacingDialog,
  type CdpHostLike,
} from "./browser-cdp";

export const MODIFIER_BITS: Record<string, number> = {
  Alt: 1,
  Control: 2,
  ControlOrMeta: process.platform === "darwin" ? 4 : 2,
  Meta: 4,
  Shift: 8,
};

/** CDP 的 buttons 是「当前按住的键位掩码」；Chromium 还会把 button 对应位
 *  OR 进去。右键只传 1 会让页面收到 3（左+右），中键收到 5（左+中）。 */
const BUTTON_BITS: Record<"left" | "right" | "middle", number> = {
  left: 1,
  right: 2,
  middle: 4,
};

export type InputModifier = "Alt" | "Control" | "ControlOrMeta" | "Meta" | "Shift";

export function modifiersBitmask(modifiers?: readonly string[]): number {
  let bits = 0;
  for (const raw of modifiers ?? []) {
    const key = normalizeModifier(raw);
    if (key) bits |= MODIFIER_BITS[key];
  }
  return bits;
}

function normalizeModifier(raw: string): InputModifier | null {
  const key = raw.trim().toLowerCase();
  if (key === "alt" || key === "option") return "Alt";
  if (key === "control" || key === "ctrl") return "Control";
  if (key === "controlormeta" || key === "cmdorctrl") return "ControlOrMeta";
  if (key === "meta" || key === "cmd" || key === "command" || key === "super" || key === "win") {
    return "Meta";
  }
  if (key === "shift") return "Shift";
  return null;
}

const KEY_MAP: Record<string, { key: string; code: string; windowsVirtualKeyCode: number }> = {
  Enter: { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 },
  Return: { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 },
  Tab: { key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 },
  Escape: { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 },
  Esc: { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 },
  Backspace: { key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 },
  Delete: { key: "Delete", code: "Delete", windowsVirtualKeyCode: 46 },
  ArrowUp: { key: "ArrowUp", code: "ArrowUp", windowsVirtualKeyCode: 38 },
  ArrowDown: { key: "ArrowDown", code: "ArrowDown", windowsVirtualKeyCode: 40 },
  ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", windowsVirtualKeyCode: 37 },
  ArrowRight: { key: "ArrowRight", code: "ArrowRight", windowsVirtualKeyCode: 39 },
  Space: { key: " ", code: "Space", windowsVirtualKeyCode: 32 },
  PageUp: { key: "PageUp", code: "PageUp", windowsVirtualKeyCode: 33 },
  PageDown: { key: "PageDown", code: "PageDown", windowsVirtualKeyCode: 34 },
  Home: { key: "Home", code: "Home", windowsVirtualKeyCode: 36 },
  End: { key: "End", code: "End", windowsVirtualKeyCode: 35 },
};

function keyDefinition(raw: string): { key: string; code: string; windowsVirtualKeyCode: number } {
  const key = raw.trim();
  const known = KEY_MAP[key];
  if (known) return known;
  if (/^[a-z]$/i.test(key)) {
    const upper = key.toUpperCase();
    return {
      key,
      code: `Key${upper}`,
      windowsVirtualKeyCode: upper.charCodeAt(0),
    };
  }
  if (/^[0-9]$/.test(key)) {
    return { key, code: `Digit${key}`, windowsVirtualKeyCode: key.charCodeAt(0) };
  }
  // 单字符（标点/中文）：交给 Chromium 用 key 字段尽力解释。
  return { key, code: "", windowsVirtualKeyCode: key.length === 1 ? key.charCodeAt(0) : 0 };
}

export interface Point {
  x: number;
  y: number;
}

export async function dispatchClick(
  host: CdpHostLike,
  point: Point,
  options?: {
    button?: "left" | "right" | "middle";
    doubleClick?: boolean;
    modifiers?: readonly string[];
  },
): Promise<void> {
  const button = options?.button ?? "left";
  const buttonBits = BUTTON_BITS[button];
  const modifiers = modifiersBitmask(options?.modifiers);
  const base = {
    x: Math.round(point.x),
    y: Math.round(point.y),
    button,
    ...(modifiers > 0 ? { modifiers } : {}),
  };
  await sendCdpNoWait(host, "Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: base.x,
    y: base.y,
    ...(modifiers > 0 ? { modifiers } : {}),
  });
  if (options?.doubleClick) {
    for (const clickCount of [1, 2]) {
      await sendCdpNoWait(host, "Input.dispatchMouseEvent", {
        type: "mousePressed",
        ...base,
        clickCount,
        buttons: buttonBits,
      });
      await sendCdpNoWait(host, "Input.dispatchMouseEvent", {
        type: "mouseReleased",
        ...base,
        clickCount,
        buttons: 0,
      });
    }
    return;
  }
  await sendCdpNoWait(host, "Input.dispatchMouseEvent", {
    type: "mousePressed",
    ...base,
    clickCount: 1,
    buttons: buttonBits,
  });
  await sendCdpNoWait(host, "Input.dispatchMouseEvent", {
    type: "mouseReleased",
    ...base,
    clickCount: 1,
    buttons: 0,
  });
}

export async function dispatchHover(
  host: CdpHostLike,
  point: Point,
  modifiers?: readonly string[],
): Promise<void> {
  const bits = modifiersBitmask(modifiers);
  await sendCdp(host, "Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: Math.round(point.x),
    y: Math.round(point.y),
    ...(bits > 0 ? { modifiers: bits } : {}),
  });
}

export async function dispatchWheel(
  host: CdpHostLike,
  point: Point,
  deltaX: number,
  deltaY: number,
): Promise<void> {
  await sendCdp(host, "Input.dispatchMouseEvent", {
    type: "mouseWheel",
    x: Math.round(point.x),
    y: Math.round(point.y),
    deltaX: Math.round(deltaX),
    deltaY: Math.round(deltaY),
  });
}

export async function dispatchKey(
  host: CdpHostLike,
  key: string,
  modifiers?: readonly string[],
): Promise<void> {
  const def = keyDefinition(key);
  const bits = modifiersBitmask(modifiers);
  // Cmd/Ctrl+A 在 macOS 上由应用菜单的 Edit 快捷键接管，CDP 的 rawKeyDown
  // 不会触发全选（Shift+方向键之类正常）。带上 editing command 才等价于人按。
  // 只认平台主修饰键：macOS 的 Ctrl+A 是 Emacs 的「行首」，不能当成全选。
  const selectAll =
    def.key.toLowerCase() === "a" && (bits & MODIFIER_BITS.ControlOrMeta) !== 0;
  await sendCdpNoWait(host, "Input.dispatchKeyEvent", {
    type: "rawKeyDown",
    key: def.key,
    ...(def.code ? { code: def.code } : {}),
    ...(def.windowsVirtualKeyCode ? { windowsVirtualKeyCode: def.windowsVirtualKeyCode } : {}),
    ...(bits > 0 ? { modifiers: bits } : {}),
    ...(selectAll ? { commands: ["selectAll"] } : {}),
  });
  // 可打印字符：补一个 char 事件（rawKeyDown 不会产生字符输入）。
  // Shift 只改变字符本身，仍应输入；Control/Meta/Alt 是快捷键修饰，
  // 发 char 会把 Cmd+A 变成“全选后又插入 a”。
  const shortcutModifiers =
    MODIFIER_BITS.Alt | MODIFIER_BITS.Control | MODIFIER_BITS.Meta;
  if (def.key.length === 1 && (bits & shortcutModifiers) === 0) {
    await sendCdpNoWait(host, "Input.dispatchKeyEvent", {
      type: "char",
      text: def.key,
      key: def.key,
      ...(def.code ? { code: def.code } : {}),
      ...(def.windowsVirtualKeyCode ? { windowsVirtualKeyCode: def.windowsVirtualKeyCode } : {}),
      ...(bits > 0 ? { modifiers: bits } : {}),
    });
  }
  await sendCdpNoWait(host, "Input.dispatchKeyEvent", {
    type: "keyUp",
    key: def.key,
    ...(def.code ? { code: def.code } : {}),
    ...(def.windowsVirtualKeyCode ? { windowsVirtualKeyCode: def.windowsVirtualKeyCode } : {}),
    ...(bits > 0 ? { modifiers: bits } : {}),
  });
}

export async function insertText(host: CdpHostLike, text: string): Promise<void> {
  // 页面 oninput 里也可能弹 confirm/alert：一看到 dialog 就返回，别让
  // browser_type 的兜底路径等满 10s 超时。
  await sendCdpRacingDialog(host, "Input.insertText", { text });
}

export async function dispatchDrag(
  host: CdpHostLike,
  from: Point,
  to: Point,
  modifiers?: readonly string[],
): Promise<void> {
  const bits = modifiersBitmask(modifiers);
  const start = { x: Math.round(from.x), y: Math.round(from.y) };
  const end = { x: Math.round(to.x), y: Math.round(to.y) };
  await sendCdp(host, "Input.dispatchMouseEvent", {
    type: "mouseMoved",
    ...start,
    ...(bits > 0 ? { modifiers: bits } : {}),
  });
  await sendCdp(host, "Input.dispatchMouseEvent", {
    type: "mousePressed",
    ...start,
    button: "left",
    buttons: 1,
    clickCount: 1,
    ...(bits > 0 ? { modifiers: bits } : {}),
  });
  const steps = 12;
  for (let i = 1; i <= steps; i += 1) {
    const ratio = i / steps;
    await sendCdp(host, "Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: Math.round(start.x + (end.x - start.x) * ratio),
      y: Math.round(start.y + (end.y - start.y) * ratio),
      button: "left",
      buttons: 1,
      ...(bits > 0 ? { modifiers: bits } : {}),
    });
  }
  await sendCdp(host, "Input.dispatchMouseEvent", {
    type: "mouseReleased",
    ...end,
    button: "left",
    clickCount: 1,
    ...(bits > 0 ? { modifiers: bits } : {}),
  });
}
