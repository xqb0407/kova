import { describe, expect, test } from "bun:test";
import { MODIFIER_BITS, dispatchKey } from "../main/browser-input";

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
