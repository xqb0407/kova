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
  sendCdpNoWait,
  sendCdpRacingDialog,
  type CdpHostLike,
} from "../main/browser-cdp";

type MessageListener = (event: unknown, method: string, params: unknown) => void;

class FakeDebugger {
  attached = false;
  foreignAttached = false;
  sent: Array<{ method: string; params?: unknown }> = [];
  messageListener: MessageListener | null = null;
  /** 命中后返回一个永挂起的 Promise（模拟被 dialog 阻塞的命令）。 */
  blockMethod: string | null = null;
  /** 命中后同步抛错（模拟 detach 竞态）。 */
  throwSyncMethod: string | null = null;
  /** 命中后返回 rejected Promise（模拟命令自身报错）。 */
  rejectMethod: string | null = null;
  rejectMessage = "boom";
  private rejectBlocked: ((err: Error) => void) | null = null;

  isAttached(): boolean {
    return this.attached || this.foreignAttached;
  }
  attach(): void {
    this.attached = true;
  }
  detach(): void {
    this.attached = false;
  }
  sendCommand(method: string, params?: unknown): Promise<unknown> {
    this.sent.push({ method, params });
    if (this.throwSyncMethod === method) throw new Error("sync send failure");
    if (this.rejectMethod === method) {
      return Promise.reject(new Error(this.rejectMessage));
    }
    if (this.blockMethod === method) {
      return new Promise((_resolve, reject) => {
        this.rejectBlocked = reject;
      });
    }
    return Promise.resolve(
      method === "Page.captureScreenshot" ? { data: "aW1n" } : {},
    );
  }
  unblock(): void {
    this.rejectBlocked?.(new Error("unblocked"));
    this.rejectBlocked = null;
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

  test("命令自身报错含 timed out 时不会误 detach", async () => {
    const host = new FakeHost();
    await ensureCdp(host);
    host.debugger.rejectMethod = "Runtime.evaluate";
    host.debugger.rejectMessage = "page timed out while loading";
    let message = "";
    try {
      await sendCdp(host, "Runtime.evaluate", {});
    } catch (err) {
      message = String((err as Error)?.message ?? err);
    }
    expect(message).toContain("timed out");
    expect(isCdpAttached(host)).toBe(true);
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

  test("handle dialog 能插队：不被阻塞中的 evaluate 拖住", async () => {
    const host = new FakeHost();
    await ensureCdp(host);
    host.debugger.blockMethod = "Runtime.evaluate";
    const blocked = sendCdp(host, "Runtime.evaluate", { expression: 'confirm("x")' });
    // 等队首命令真正发出去（此时它已被 dialog 阻塞）。
    for (
      let i = 0;
      i < 20 && !host.debugger.sent.some((s) => s.method === "Runtime.evaluate");
      i += 1
    ) {
      await new Promise((r) => setTimeout(r, 0));
    }
    host.debugger.emit("Page.javascriptDialogOpening", {
      type: "confirm",
      message: "Proceed?",
    });

    const started = Date.now();
    await handlePendingDialog(host, true);
    expect(Date.now() - started).toBeLessThan(500);
    expect(
      host.debugger.sent.some((s) => s.method === "Page.handleJavaScriptDialog"),
    ).toBe(true);

    // 收掉永挂起的命令，避免它留到 10s 超时后再触发 detach。
    host.debugger.unblock();
    await blocked.catch(() => undefined);
  });

  test("sendCdpRacingDialog：dialog 打开时立即返回，不等 10s 超时", async () => {
    const host = new FakeHost();
    await ensureCdp(host);
    host.debugger.blockMethod = "Runtime.evaluate";
    const racing = sendCdpRacingDialog(host, "Runtime.evaluate", {
      expression: 'confirm("x")',
    });
    for (
      let i = 0;
      i < 20 && !host.debugger.sent.some((s) => s.method === "Runtime.evaluate");
      i += 1
    ) {
      await new Promise((r) => setTimeout(r, 0));
    }
    const started = Date.now();
    host.debugger.emit("Page.javascriptDialogOpening", {
      type: "confirm",
      message: "Proceed?",
    });
    let raceError = "";
    try {
      await racing;
    } catch (err) {
      raceError = String((err as Error)?.message ?? err);
    }
    expect(raceError).toContain("dialog");
    expect(Date.now() - started).toBeLessThan(500);

    // 底层 evaluate 仍挂在队列里：解掉它，避免拖到 10s 超时。
    host.debugger.unblock();
    await new Promise((r) => setTimeout(r, 0));
  });

  test("sendCdpRacingDialog：正常命令照常返回", async () => {
    const host = new FakeHost();
    const value = await sendCdpRacingDialog(host, "Runtime.evaluate", {
      expression: "1",
    });
    expect(value).toEqual({});
  });

  test("sendCdpRacingDialog：已有 dialog 时不再下发命令", async () => {
    const host = new FakeHost();
    await ensureCdp(host);
    host.debugger.emit("Page.javascriptDialogOpening", {
      type: "alert",
      message: "Already open",
    });
    const before = host.debugger.sent.length;
    let raceError = "";
    try {
      await sendCdpRacingDialog(host, "Runtime.evaluate", { expression: "1" });
    } catch (err) {
      raceError = String((err as Error)?.message ?? err);
    }
    expect(raceError).toContain("dialog");
    expect(host.debugger.sent.length).toBe(before);
  });

  test("sendCdpNoWait 同步抛错不会泄漏 inFlight", async () => {
    const host = new FakeHost();
    await ensureCdp(host);
    host.debugger.throwSyncMethod = "Input.dispatchMouseEvent";
    let sendError = "";
    try {
      await sendCdpNoWait(host, "Input.dispatchMouseEvent", {});
    } catch (err) {
      sendError = String((err as Error)?.message ?? err);
    }
    expect(sendError).toContain("sync send failure");
    const started = Date.now();
    await releaseCdpForDevtools(host);
    expect(Date.now() - started).toBeLessThan(1_000);
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
