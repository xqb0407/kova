/**
 * 终端剪贴板快捷键与读写助手：纯判定函数 + 打桩 navigator.clipboard，
 * 不引 xterm/Electron。
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
  attachTerminalClipboardKeys,
  copyTerminalSelection,
  copyTerminalText,
  pasteTerminalClipboard,
  terminalClipboardAction,
} from "@/lib/terminal/clipboard";

type KeyInit = Partial<KeyboardEvent> & Pick<KeyboardEvent, "key">;

const key = (init: KeyInit): KeyboardEvent =>
  ({
    type: "keydown",
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    ...init,
  }) as KeyboardEvent;

const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");

function stubClipboard(clipboard: Partial<Clipboard> | undefined): void {
  Object.defineProperty(globalThis, "navigator", {
    value: clipboard === undefined ? {} : { clipboard },
    configurable: true,
    writable: true,
  });
}

afterEach(() => {
  if (originalNavigator)
    Object.defineProperty(globalThis, "navigator", originalNavigator);
  else delete (globalThis as Record<string, unknown>).navigator;
});

describe("terminalClipboardAction", () => {
  test("macOS 的 ⌘ 组合不参与映射（交给系统 Edit 菜单原生处理）", () => {
    expect(
      terminalClipboardAction(key({ key: "c", metaKey: true })),
    ).toBeNull();
    expect(
      terminalClipboardAction(key({ key: "v", metaKey: true })),
    ).toBeNull();
  });

  test("Windows/Linux：Ctrl+C 永远是 SIGINT，复制走 Shift", () => {
    expect(terminalClipboardAction(key({ key: "c", ctrlKey: true }))).toBeNull();
    expect(
      terminalClipboardAction(key({ key: "C", ctrlKey: true, shiftKey: true })),
    ).toBe("copy");
    expect(terminalClipboardAction(key({ key: "Insert", ctrlKey: true }))).toBe(
      "copy",
    );
  });

  test("Windows/Linux 粘贴：Ctrl+V / Ctrl+Shift+V / Shift+Insert", () => {
    expect(terminalClipboardAction(key({ key: "v", ctrlKey: true }))).toBe("paste");
    expect(
      terminalClipboardAction(key({ key: "v", ctrlKey: true, shiftKey: true })),
    ).toBe("paste");
    expect(terminalClipboardAction(key({ key: "Insert", shiftKey: true }))).toBe(
      "paste",
    );
  });

  test("只处理 keydown；带 Alt/Meta(Win) 的组合不抢", () => {
    expect(
      terminalClipboardAction(key({ key: "v", ctrlKey: true, type: "keyup" })),
    ).toBeNull();
    expect(
      terminalClipboardAction(key({ key: "v", ctrlKey: true, altKey: true })),
    ).toBeNull();
    expect(
      terminalClipboardAction(key({ key: "v", ctrlKey: true, metaKey: true })),
    ).toBeNull();
  });
});

describe("attachTerminalClipboardKeys", () => {
  test("macOS 不挂自定义处理器（避免与菜单快捷键重复粘贴）", () => {
    let attached = false;
    const terminal = {
      attachCustomKeyEventHandler: () => {
        attached = true;
      },
    } as unknown as Parameters<typeof attachTerminalClipboardKeys>[0];

    attachTerminalClipboardKeys(terminal, true);
    expect(attached).toBe(false);

    attachTerminalClipboardKeys(terminal, false);
    expect(attached).toBe(true);
  });
});

describe("copy / paste", () => {
  test("复制选区写入剪贴板；空选区不写", async () => {
    const writes: string[] = [];
    stubClipboard({ writeText: async (text) => void writes.push(text) });

    expect(
      await copyTerminalSelection({ getSelection: () => "git status" }),
    ).toBe(true);
    expect(writes).toEqual(["git status"]);

    expect(await copyTerminalText("")).toBe(false);
    expect(writes).toEqual(["git status"]);
  });

  test("粘贴把剪贴板原文交给 terminal.paste（归一化交给 xterm）", async () => {
    stubClipboard({ readText: async () => "ls -la\r\npwd" });
    const pasted: string[] = [];
    const result = await pasteTerminalClipboard({
      paste: (text) => void pasted.push(text),
    });

    expect(result).toBe("pasted");
    expect(pasted).toEqual(["ls -la\r\npwd"]);
  });

  test("空剪贴板返回 empty，读取失败返回 failed", async () => {
    stubClipboard({ readText: async () => "" });
    expect(await pasteTerminalClipboard({ paste: () => {} })).toBe("empty");

    stubClipboard({
      readText: async () => {
        throw new Error("denied");
      },
    });
    expect(await pasteTerminalClipboard({ paste: () => {} })).toBe("failed");

    stubClipboard(undefined);
    expect(await pasteTerminalClipboard({ paste: () => {} })).toBe("failed");
  });
});
