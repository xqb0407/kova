import { describe, expect, mock, test } from "bun:test";

/**
 * 全局工作模式（work/code）镜像 store 测试：
 * - 水合纪律：localStorage 播种 → get_app_mode 拉真值覆盖（pi-session-mode 同款）
 * - 失败容错：sidecar 无此命令/通信失败 → 保留播种值并置 degraded（旧版 sidecar
 *   下 UI 照常切换、提示词不跟随，设置页据此标注）
 * - setAppMode：应答即真值回写镜像与缓存；失败回弹降级但本地生效
 * mock pi-bridge 的 piRequest（沿用 pi-running.test.ts 的桩风格）。
 */

type Req = Record<string, unknown>;

/** 可切换的协议应答桩：返回 Error 实例表示请求失败 */
let responder: (req: Req) => unknown = () => ({ type: "app_mode", mode: "code" });
let calls: Req[] = [];

mock.module("@/lib/pi-bridge", () => ({
  piRequest: (payload: Req) => {
    calls.push(payload);
    const res = responder(payload);
    if (res instanceof Error) return Promise.reject(res);
    return Promise.resolve(res);
  },
}));

// app-mode 在模块加载与 initAppMode 里都访问 window.localStorage，先装桩
const seedStore = new Map<string, string>();
(globalThis as { window?: unknown }).window = {
  localStorage: {
    getItem: (k: string) => seedStore.get(k) ?? null,
    setItem: (k: string, v: string) => void seedStore.set(k, v),
    removeItem: (k: string) => void seedStore.delete(k),
  },
};

const { getAppMode, getAppModeDegraded, initAppMode, setAppMode } = await import(
  "@/lib/app-mode"
);

const flush = () => new Promise((r) => setTimeout(r, 0));

/** 每用例重置：清缓存/桩行为/内存态，再按当前桩重新水合 */
async function reset(seed?: "work" | "code") {
  seedStore.clear();
  if (seed) seedStore.set("app.mode", seed);
  calls = [];
  responder = () => ({ type: "app_mode", mode: "code" });
  initAppMode();
  await flush();
}

describe("app-mode 水合", () => {
  test("无播种时默认 code，get_app_mode 真值覆盖内存", async () => {
    await reset();
    expect(getAppMode()).toBe("code");
    expect(getAppModeDegraded()).toBe(false);
    expect(calls.some((c) => c.type === "get_app_mode")).toBe(true);
  });

  test("播种 work 先行生效，sidecar 真值随后覆盖（work→code）", async () => {
    responder = () => ({ type: "app_mode", mode: "code" });
    seedStore.set("app.mode", "work");
    calls = [];
    initAppMode();
    // 水合请求在途：播种值先可见
    expect(getAppMode()).toBe("work");
    await flush();
    expect(getAppMode()).toBe("code");
    expect(getAppModeDegraded()).toBe(false);
  });

  test("sidecar 真值为 work 时覆盖 code 播种", async () => {
    responder = () => ({ type: "app_mode", mode: "work" });
    calls = [];
    initAppMode();
    await flush();
    expect(getAppMode()).toBe("work");
    expect(getAppModeDegraded()).toBe(false);
  });

  test("请求失败（旧版 sidecar 等）：保留播种值并置 degraded", async () => {
    responder = () => new Error("unknown request type");
    seedStore.set("app.mode", "work");
    initAppMode();
    await flush();
    expect(getAppMode()).toBe("work");
    expect(getAppModeDegraded()).toBe(true);
  });

  test("非法响应类型忽略：内存保持播种值", async () => {
    responder = () => ({ type: "personalization" });
    seedStore.set("app.mode", "work");
    initAppMode();
    await flush();
    expect(getAppMode()).toBe("work");
  });
});

describe("setAppMode", () => {
  test("成功：发出 set_app_mode，镜像与缓存都落到新模式", async () => {
    await reset();
    // sidecar 应答 = 规整后的生效值：set 回显请求的 mode，get 回真值
    responder = (req) => ({
      type: "app_mode",
      mode: req.type === "set_app_mode" ? req.mode : "code",
    });
    const applied = setAppMode("work");
    expect(calls.at(-1)?.type).toBe("set_app_mode");
    await applied;
    expect(getAppMode()).toBe("work");
    expect(seedStore.get("app.mode")).toBe("work");
    expect(getAppModeDegraded()).toBe(false);
  });

  test("失败：标记 degraded，但本地生效并写缓存（下次启动水合收敛）", async () => {
    await reset();
    responder = (req) =>
      req.type === "set_app_mode" ? new Error("sidecar offline") : { type: "app_mode", mode: "code" };
    await setAppMode("work");
    expect(getAppMode()).toBe("work");
    expect(seedStore.get("app.mode")).toBe("work");
    expect(getAppModeDegraded()).toBe(true);
  });
});
