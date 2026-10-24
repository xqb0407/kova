/**
 * 两段式 provider 命令（test_provider / fetch_models）的行为钉桩：
 * - handler 受理即返回（网络等待不在 mgmt 串行队列里）——dispatch resolve
 *   时刻不得已有应答帧；
 * - 结果以同 reqId 的迟到帧回填（tested / fetched_models / error）。
 *
 * 背景：同步等待时端点不通要干等满 fetch 超时（test_provider 20s），把
 * abort/queue_clear 等「停止类」命令堵在 mgmt 串行队列身后（2026-10-24
 * 实测占队 20s，用户点停止无响应）。
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { dispatch, setInitGate } from "../../src/protocol/protocol";
import { initStorage } from "../../src/storage/storage";

const tmp = mkdtempSync(path.join(tmpdir(), "pi-agent-provider-2phase-"));

beforeAll(() => {
  initStorage(path.join(tmp, "state.db"), path.join(tmp, "sessions"));
  setInitGate(Promise.resolve());
});

/** 捕获协议流（send 写 process.stdout） */
const lines: string[] = [];
let origWrite: typeof process.stdout.write;

beforeAll(() => {
  origWrite = process.stdout.write.bind(process.stdout);
  (process.stdout as unknown as { write: (c: unknown) => boolean }).write = (
    c: unknown,
  ) => {
    lines.push(String(c));
    return true;
  };
});

afterAll(() => {
  (process.stdout as unknown as { write: typeof origWrite }).write = origWrite;
});

const flush = () => new Promise((r) => setTimeout(r, 20));

/** 清空捕获（lines 在同文件用例间共享，各用例只看自己产生的帧） */
const resetLines = () => {
  lines.length = 0;
};

/** 找出指定 reqId 的应答帧 */
const frameOf = (reqId: string): Record<string, unknown> | undefined =>
  lines
    .map((l) => JSON.parse(l) as Record<string, unknown>)
    .find((f) => f.id === reqId);

describe("test_provider 两段式", () => {
  test("受理即返回，结果经同 reqId 迟到帧回填", async () => {
    resetLines();
    let releaseFetch: (v: Response) => void = () => {};
    const gate = new Promise<Response>((resolve) => {
      releaseFetch = resolve;
    });
    const origFetch = globalThis.fetch;
    globalThis.fetch = (() => gate) as unknown as typeof fetch;
    try {
      await dispatch("req-tp-1", {
        type: "test_provider",
        baseUrl: "https://gw.example/v1",
        model: "m1",
        api: "openai-chat",
      });
      // 受理时刻：fetch 还没回来，不允许已有任何应答帧（= 没占串行队列）
      expect(lines).toEqual([]);

      releaseFetch(new Response(null, { status: 200 }));
      await flush();

      const frame = frameOf("req-tp-1");
      expect(frame?.type).toBe("tested");
      expect(frame?.ok).toBe(true);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  test("网络失败：迟到 error 帧与 handleLine 同形（前端 piRequest 见 error 即抛）", async () => {
    resetLines();
    const origFetch = globalThis.fetch;
    globalThis.fetch = (() =>
      Promise.reject(new Error("connect EHOSTUNREACH"))) as unknown as typeof fetch;
    try {
      await dispatch("req-tp-2", {
        type: "test_provider",
        baseUrl: "https://gw.example/v1",
        model: "m1",
        api: "openai-chat",
      });
      await flush();

      const frame = frameOf("req-tp-2");
      expect(frame?.type).toBe("error");
      expect(String(frame?.errorText)).toContain("EHOSTUNREACH");
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  test("前置校验失败走同步 error 帧（不派活、不产生迟到帧）", async () => {
    resetLines();
    const origFetch = globalThis.fetch;
    let fetchCalled = false;
    globalThis.fetch = (() => {
      fetchCalled = true;
      return Promise.reject(new Error("should not be called"));
    }) as unknown as typeof fetch;
    try {
      await expect(
        dispatch("req-tp-3", {
          type: "test_provider",
          baseUrl: "https://gw.example/v1",
          // model 缺失：同步抛错
          api: "openai-chat",
        }),
      ).rejects.toThrow("model is required");
      expect(fetchCalled).toBe(false);
      await flush();
      const frame = frameOf("req-tp-3");
      expect(frame).toBeUndefined();
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});

describe("fetch_models 两段式", () => {
  test("受理即返回，列表经同 reqId 迟到帧回填", async () => {
    resetLines();
    let releaseFetch: (v: Response) => void = () => {};
    const gate = new Promise<Response>((resolve) => {
      releaseFetch = resolve;
    });
    const origFetch = globalThis.fetch;
    globalThis.fetch = (() => gate) as unknown as typeof fetch;
    try {
      await dispatch("req-fm-1", {
        type: "fetch_models",
        baseUrl: "https://gw.example/v1",
        api: "openai-chat",
      });
      expect(lines).toEqual([]);

      releaseFetch(
        Response.json({ data: [{ id: "m-a" }, { id: "m-b" }, { id: "m-a" }] }),
      );
      await flush();

      const frame = frameOf("req-fm-1");
      expect(frame?.type).toBe("fetched_models");
      // 去重保序
      expect(frame?.models).toEqual(["m-a", "m-b"]);
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});
