import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { initStorage } from "../../src/storage/storage";
import { dispatch } from "../../src/protocol/protocol";
import { getModels } from "../../src/model/model-catalog";

const tmp = mkdtempSync(path.join(tmpdir(), "pi-agent-provider-headers-"));

beforeAll(() => {
  initStorage(path.join(tmp, "state.db"), path.join(tmp, "sessions"));
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
  (process.stdout as unknown as { write: (c: unknown) => boolean }).write =
    origWrite as unknown as (c: unknown) => boolean;
});

const last = (): Record<string, unknown> => JSON.parse(lines[lines.length - 1]);

/** 两段式命令（fetch_models/test_provider）的应答是同 reqId 迟到帧：轮询等它 */
const waitForFrame = async (id: string): Promise<Record<string, unknown>> => {
  const deadline = Date.now() + 5000;
  for (;;) {
    const found = lines
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .find((f) => f.id === id);
    if (found) return found;
    if (Date.now() > deadline) throw new Error(`frame ${id} not observed; got ${lines.length} lines`);
    await new Promise((r) => setTimeout(r, 10));
  }
};

const PID = "custom-headers";
const BASE = "http://127.0.0.1:9/v1";

const addMsg = (
  headers?: Record<string, string>,
  baseUrl: string = BASE,
): Record<string, unknown> => ({
  type: "add_custom_provider",
  providerId: PID,
  name: "headers-provider",
  baseUrl,
  apiKey: "sk-x",
  api: "openai-chat",
  models: [{ id: "m1" }],
  // undefined = 不带该字段（老客户端/导入流程的形态）
  ...(headers === undefined ? {} : { headers }),
});

describe("自定义端点的请求头", () => {
  test("保存后注册进目录，list 能回填", async () => {
    const headers = { "X-Org": "team", "X-Api-Version": "2026-01" };
    await dispatch("h1", addMsg(headers));
    expect(last()).toEqual({ id: "h1", type: "custom_provider", provider: PID });
    // 注册进 pi-ai provider：请求时会合并进每条调用
    expect(getModels().getProvider(PID)?.headers).toEqual(headers);

    await dispatch("h2", { type: "list_custom_providers" });
    const row = (
      last() as { providers: Record<string, unknown>[] }
    ).providers.find((p) => p.providerId === PID)!;
    expect(row.headers).toEqual(headers);
  });

  test("不带 headers 字段 = 保留原值；显式空对象 = 清空", async () => {
    await dispatch("h3", addMsg(undefined));
    expect(getModels().getProvider(PID)?.headers).toEqual({
      "X-Org": "team",
      "X-Api-Version": "2026-01",
    });
    await dispatch("h4", addMsg({}));
    expect(getModels().getProvider(PID)?.headers ?? {}).toEqual({});
  });

  test("非法头名 / 含换行的值被拒；非 Latin-1（中文）值提前拒绝", async () => {
    // dispatch 直接抛错（协议帧由 handleLine 兜底转换），这里断言抛出文案
    await expect(dispatch("h5", addMsg({ "Bad Name": "x" }))).rejects.toThrow(
      /invalid header name/,
    );
    await expect(dispatch("h6", addMsg({ "X-Ok": "a\nb" }))).rejects.toThrow(
      /control characters/,
    );
    // 实测 Bun fetch 会以 native TypeError 拒绝非 Latin-1 头值（报错只剩代码帧），
    // 所以在保存时就拦下来并说清楚
    await expect(dispatch("h6b", addMsg({ "X-Token": "令牌中文" }))).rejects.toThrow(
      /must be ASCII\/Latin-1/,
    );
  });

  test("fetch_models / test_provider 真实带上自定义头（含覆盖默认 Authorization）", async () => {
    const seen: Record<string, string> = {};
    const srv = Bun.serve({
      port: 0,
      fetch(req) {
        seen.org = req.headers.get("x-org") ?? "";
        seen.version = req.headers.get("x-api-version") ?? "";
        seen.auth = req.headers.get("authorization") ?? "";
        const url = new URL(req.url);
        if (url.pathname.endsWith("/models")) {
          return Response.json({ data: [{ id: "m1" }] });
        }
        return Response.json({
          choices: [{ message: { role: "assistant", content: "pong" } }],
        });
      },
    });
    try {
      const base = `http://127.0.0.1:${srv.port}/v1`;
      const headers = {
        "X-Org": "team",
        "X-Api-Version": "2026-01",
        Authorization: "Custom tok",
      };
      await dispatch("h7", addMsg(headers, base));
      expect(last().type).toBe("custom_provider");

      // 表单当前值路径：显式 headers（保存前测试/拉列表）
      await dispatch("h8", {
        type: "fetch_models",
        baseUrl: base,
        apiKey: "sk-x",
        api: "openai-chat",
        headers,
      });
      expect(await waitForFrame("h8")).toEqual({ id: "h8", type: "fetched_models", models: ["m1"] });
      expect(seen.org).toBe("team");
      expect(seen.version).toBe("2026-01");
      expect(seen.auth).toBe("Custom tok"); // 自定义头覆盖 key 派生的 Bearer

      await dispatch("h9", {
        type: "test_provider",
        baseUrl: base,
        apiKey: "sk-x",
        api: "openai-chat",
        model: "m1",
        headers: { Authorization: "Custom tok" },
      });
      expect(await waitForFrame("h9")).toEqual({ id: "h9", type: "tested", ok: true });
      expect(seen.auth).toBe("Custom tok");

      // 不带 headers 的调用（列表行快速测试）：回落到已存行的头
      await dispatch("h10", {
        type: "test_provider",
        baseUrl: base,
        apiKey: "",
        providerId: PID,
        api: "openai-chat",
        model: "m1",
      });
      expect(await waitForFrame("h10")).toEqual({ id: "h10", type: "tested", ok: true });
      expect(seen.auth).toBe("Custom tok");
      expect(seen.org).toBe("team");
    } finally {
      srv.stop(true);
      await dispatch("h11", { type: "delete_custom_provider", provider: PID });
    }
  });
});
