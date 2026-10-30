import { describe, expect, test } from "bun:test";
import {
  captureCdpScreenshot,
  detachCdp,
  ensureCdp,
  getPendingDialog,
  handlePendingDialog,
  isCdpAttached,
  releaseCdpForDevtools,
  sendCdp,
  type CdpHostLike,
} from "../main/browser-cdp";

type MessageListener = (event: unknown, method: string, params: unknown) => void;

class FakeDebugger {
  attached = false;
  foreignAttached = false;
  sent: Array<{ method: string; params?: unknown }> = [];
  messageListener: MessageListener | null = null;

  isAttached(): boolean {
    return this.attached || this.foreignAttached;
  }
  attach(): void {
    this.attached = true;
  }
  detach(): void {
    this.attached = false;
  }
  async sendCommand(method: string, params?: unknown): Promise<unknown> {
    this.sent.push({ method, params });
    return method === "Page.captureScreenshot" ? { data: "aW1n" } : {};
  }
  on(_event: "message", listener: MessageListener): void {
    this.messageListener = listener;
  }
  removeListener(): void {
    this.messageListener = null;
  }
  emit(method: string, params: unknown): void {
    this.messageListener?.({}, method, params);
  }
}

class FakeHost implements CdpHostLike {
  debugger = new FakeDebugger();
  destroyed = false;
  devtools = false;
  listeners = new Map<string, (...args: any[]) => void>();

  isDestroyed(): boolean {
    return this.destroyed;
  }
  isDevToolsOpened(): boolean {
    return this.devtools;
  }
  on(event: string, listener: (...args: any[]) => void): void {
    this.listeners.set(event, listener);
  }
  once(event: "destroyed", listener: () => void): void {
    this.listeners.set(event, listener);
  }
  crash(): void {
    this.listeners.get("render-process-gone")?.({}, { reason: "crashed" });
  }
}

describe("browser CDP session", () => {
  test("懒 attach + Page.enable；重复 ensure 不重复 attach", async () => {
    const host = new FakeHost();
    await ensureCdp(host);
    expect(host.debugger.attached).toBe(true);
    expect(host.debugger.sent[0].method).toBe("Page.enable");
    expect(isCdpAttached(host)).toBe(true);
    await ensureCdp(host);
    expect(host.debugger.sent.filter((s) => s.method === "Page.enable")).toHaveLength(1);
  });

  test("sendCdp 串行下发并透传参数", async () => {
    const host = new FakeHost();
    const first = sendCdp(host, "Input.dispatchMouseEvent", { type: "mousePressed", x: 1, y: 2 });
    const second = sendCdp(host, "Input.dispatchMouseEvent", { type: "mouseReleased", x: 1, y: 2 });
    await Promise.all([first, second]);
    const input = host.debugger.sent.filter((s) => s.method === "Input.dispatchMouseEvent");
    expect(input).toHaveLength(2);
    expect(input[0].params).toEqual({ type: "mousePressed", x: 1, y: 2 });
  });

  test("dialog 事件被记录，handle 后清空", async () => {
    const host = new FakeHost();
    await ensureCdp(host);
    host.debugger.emit("Page.javascriptDialogOpening", {
      type: "confirm",
      message: "Delete?",
      defaultPrompt: "",
    });
    expect(getPendingDialog(host)).toEqual({ type: "confirm", message: "Delete?" });
    await handlePendingDialog(host, true);
    expect(getPendingDialog(host)).toBeNull();
    const handled = host.debugger.sent.find((s) => s.method === "Page.handleJavaScriptDialog");
    expect(handled?.params).toEqual({ accept: true });
  });

  test("没有 dialog 时 handle 报错", async () => {
    const host = new FakeHost();
    await ensureCdp(host);
    let message = "";
    try {
      await handlePendingDialog(host, true);
    } catch (err) {
      message = String((err as Error)?.message ?? err);
    }
    expect(message).toContain("no JavaScript dialog");
  });

  test("DevTools 已打开 / 已有外部 debugger 时拒绝 attach", async () => {
    const devtools = new FakeHost();
    devtools.devtools = true;
    let devtoolsError = "";
    try {
      await ensureCdp(devtools);
    } catch (err) {
      devtoolsError = String((err as Error)?.message ?? err);
    }
    expect(devtoolsError).toContain("DevTools is open");

    const foreign = new FakeHost();
    foreign.debugger.foreignAttached = true;
    let foreignError = "";
    try {
      await ensureCdp(foreign);
    } catch (err) {
      foreignError = String((err as Error)?.message ?? err);
    }
    expect(foreignError).toContain("another debugger");
  });

  test("打开 DevTools 前 release；崩溃先 detach", async () => {
    const host = new FakeHost();
    await ensureCdp(host);
    await releaseCdpForDevtools(host);
    expect(host.debugger.attached).toBe(false);
    expect(isCdpAttached(host)).toBe(false);

    await ensureCdp(host);
    host.crash();
    expect(host.debugger.attached).toBe(false);
    expect(isCdpAttached(host)).toBe(false);
  });

  test("captureCdpScreenshot 走 Page.captureScreenshot", async () => {
    const host = new FakeHost();
    const shot = await captureCdpScreenshot(host, { format: "jpeg", quality: 70 });
    expect(shot.data).toBe("aW1n");
    expect(host.debugger.sent.some((s) => s.method === "Page.captureScreenshot")).toBe(true);
  });

  test("detachCdp 幂等", async () => {
    const host = new FakeHost();
    await ensureCdp(host);
    detachCdp(host);
    detachCdp(host);
    expect(host.debugger.attached).toBe(false);
  });
});
