import { describe, expect, test } from "bun:test";
import {
  MODIFIER_BITS,
  dispatchClick,
  dispatchDrag,
  dispatchKey,
} from "../main/browser-input";

class FakeDebugger {
  attached = false;
  sent: Array<{ method: string; params?: any }> = [];

  isAttached(): boolean {
    return this.attached;
  }
  attach(): void {
    this.attached = true;
  }
  detach(): void {
    this.attached = false;
  }
  on(_event: "message", _listener: (event: unknown, method: string, params: unknown) => void): void {}
  removeListener(): void {}
  async sendCommand(method: string, params?: unknown): Promise<unknown> {
    this.sent.push({ method, params });
    return {};
  }
}

class FakeHost {
  debugger = new FakeDebugger();
  isDestroyed(): boolean {
    return false;
  }
  on(): void {}
  once(): void {}
}

function keyEvents(host: FakeHost): any[] {
  return host.debugger.sent
    .filter((s) => s.method === "Input.dispatchKeyEvent")
    .map((s) => s.params);
}

describe("CDP 键盘输入", () => {
  test("ControlOrMeta+A 附带 selectAll 编辑命令", async () => {
    const host = new FakeHost();
    await dispatchKey(host, "a", ["ControlOrMeta"]);
    const down = keyEvents(host).find((p) => p.type === "rawKeyDown");
    expect(down?.commands).toEqual(["selectAll"]);
    expect(down?.modifiers).toBe(MODIFIER_BITS.ControlOrMeta);
  });

  test("普通字母不带编辑命令，并补 char 事件", async () => {
    const host = new FakeHost();
    await dispatchKey(host, "a");
    const events = keyEvents(host);
    expect(events.find((p) => p.type === "rawKeyDown")?.commands).toBeUndefined();
    expect(events.find((p) => p.type === "char")?.text).toBe("a");
  });

  test("Shift+A 仍补 char，可输入大写", async () => {
    const host = new FakeHost();
    await dispatchKey(host, "A", ["Shift"]);
    const char = keyEvents(host).find((p) => p.type === "char");
    expect(char?.text).toBe("A");
    expect(char?.modifiers).toBe(MODIFIER_BITS.Shift);
  });

  test("Control/Meta/Alt + 字符不发 char（避免快捷键后误输入）", async () => {
    for (const modifier of ["Control", "Meta", "Alt"]) {
      const host = new FakeHost();
      await dispatchKey(host, "a", [modifier]);
      expect(keyEvents(host).some((p) => p.type === "char")).toBe(false);
    }
  });

  test("Shift+A 不当成全选", async () => {
    const host = new FakeHost();
    await dispatchKey(host, "a", ["Shift"]);
    expect(keyEvents(host).find((p) => p.type === "rawKeyDown")?.commands).toBeUndefined();
  });

  test("其它按键不带编辑命令", async () => {
    const host = new FakeHost();
    await dispatchKey(host, "Enter", ["ControlOrMeta"]);
    expect(keyEvents(host).find((p) => p.type === "rawKeyDown")?.commands).toBeUndefined();
  });
});

function mouseEvents(host: FakeHost): any[] {
  return host.debugger.sent
    .filter((s) => s.method === "Input.dispatchMouseEvent")
    .map((s) => s.params);
}

describe("CDP 鼠标输入", () => {
  test("左右中键的 buttons 位掩码正确", async () => {
    const cases = [
      ["left", 1],
      ["right", 2],
      ["middle", 4],
    ] as const;
    for (const [button, mask] of cases) {
      const host = new FakeHost();
      await dispatchClick(host, { x: 10, y: 20 }, { button });
      const events = mouseEvents(host);
      const pressed = events.find((p) => p.type === "mousePressed");
      expect(pressed?.button).toBe(button);
      // Chromium 会把 button 位 OR 进 buttons；传错会得到 3/5。
      expect(pressed?.buttons).toBe(mask);
      expect(events.find((p) => p.type === "mouseReleased")?.buttons).toBe(0);
    }
  });

  test("拖拽按下时带 buttons=1，移动过程保持按住", async () => {
    const host = new FakeHost();
    await dispatchDrag(host, { x: 1, y: 2 }, { x: 13, y: 14 });
    const events = mouseEvents(host);
    expect(events.find((p) => p.type === "mousePressed")?.buttons).toBe(1);
    const moves = events.filter(
      (p) => p.type === "mouseMoved" && p.buttons === 1,
    );
    expect(moves.length).toBeGreaterThanOrEqual(12);
  });
});
