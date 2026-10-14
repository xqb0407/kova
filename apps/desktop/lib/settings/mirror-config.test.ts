import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mockModule, restoreAllMocks } from "@/lib/testing/mock-module";

/**
 * 访问加速设置的配置镜像 store 测试：
 * - 水合：get_mirror 真值覆盖默认（新字段与默认值合并，旧版 sidecar 少字段不炸）
 * - 失败容错：通信失败/旧版 sidecar → 保留默认，保存时仍会尝试
 * - 保存：乐观更新 → set_mirror；失败回滚到上一份并抛出（设置页据此提示）
 * mock pi-bridge 的 piRequest（沿用 app-mode.test.ts 的桩风格）。
 */

type Req = Record<string, unknown>;

/** 可切换的协议应答桩：返回 Error 实例表示请求失败 */
let responder: (req: Req) => unknown = () => ({ type: "mirror", settings: {} });
let calls: Req[] = [];

mockModule("@/lib/pi/pi-bridge", () => ({
  piRequest: (payload: Req) => {
    calls.push(payload);
    const res = responder(payload);
    if (res instanceof Error) return Promise.reject(res);
    return Promise.resolve(res);
  },
}));

// store 在模块加载时会调 initMirrorConfig，其 SSR 守卫读 window——先装桩
const prevWindow = (globalThis as { window?: unknown }).window;
(globalThis as { window?: unknown }).window = {};
afterAll(() => {
  restoreAllMocks();
  (globalThis as { window?: unknown }).window = prevWindow;
});

const { DEFAULT_MIRROR_CONFIG, getMirrorConfig, initMirrorConfig, saveMirrorConfig } =
  await import("@/lib/settings/mirror-config");

const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  calls = [];
  responder = () => ({ type: "mirror", settings: {} });
});

describe("mirror-config 水合", () => {
  test("无应答字段时保持默认（默认开，走内建 GitHub 加速站）", async () => {
    await initMirrorConfig();
    expect(getMirrorConfig()).toEqual(DEFAULT_MIRROR_CONFIG);
    expect(calls.some((c) => c.type === "get_mirror")).toBe(true);
  });

  test("sidecar 真值覆盖默认", async () => {
    responder = () => ({
      type: "mirror",
      settings: {
        enabled: false,
        githubPrefix: "https://gh-proxy.com",
        gitInsteadOf: false,
        customRules: [{ from: "https://huggingface.co", to: "https://hf-mirror.com" }],
      },
    });
    await initMirrorConfig();
    expect(getMirrorConfig()).toEqual({
      enabled: false,
      githubPrefix: "https://gh-proxy.com",
      gitInsteadOf: false,
      customRules: [{ from: "https://huggingface.co", to: "https://hf-mirror.com" }],
    });
  });

  test("旧版 sidecar 只回部分字段：缺的落默认，不炸", async () => {
    responder = () => ({ type: "mirror", settings: { enabled: false } });
    await initMirrorConfig();
    expect(getMirrorConfig()).toEqual({ ...DEFAULT_MIRROR_CONFIG, enabled: false });
  });

  test("通信失败：保留当前值（不覆盖成空），把请求记下来而不是抛出", async () => {
    const before = getMirrorConfig();
    responder = () => new Error("sidecar down");
    await initMirrorConfig();
    await flush();
    expect(getMirrorConfig()).toEqual(before);
  });
});

describe("saveMirrorConfig", () => {
  test("成功后镜像即真值（set_mirror 带整包）", async () => {
    responder = () => ({ type: "mirror", settings: {} });
    const next = { ...DEFAULT_MIRROR_CONFIG, enabled: false };
    await saveMirrorConfig(next);
    expect(getMirrorConfig()).toEqual(next);
    expect(calls.at(-1)).toEqual({ type: "set_mirror", settings: next });
  });

  test("失败：回滚到上一份并抛出", async () => {
    responder = () => ({ type: "mirror", settings: {} });
    await saveMirrorConfig({ ...DEFAULT_MIRROR_CONFIG, enabled: true });
    const before = getMirrorConfig();

    responder = () => new Error("write failed");
    await expect(
      saveMirrorConfig({ ...DEFAULT_MIRROR_CONFIG, enabled: false }),
    ).rejects.toThrow("write failed");
    expect(getMirrorConfig()).toEqual(before);
  });

  /**
   * 回归：设置页的规则行不能因为一次保存就不见。
   * 曾经的实现在失焦时把「两侧都还空着」的行筛掉，于是点开第一个输入框、
   * 再点第二个（触发第一个的 blur）整行当场消失。现在规则列表直接渲染事实源、
   * 逐字符落库，镜像层必须原样收下空白/半截的行。
   */
  test("空白与半截的规则行原样留在镜像里（不会被一次保存吃掉）", async () => {
    responder = () => ({ type: "mirror", settings: {} });
    const editing = [
      { from: "", to: "" },
      { from: "https://h", to: "" },
      { from: "https://huggingface.co/", to: "https://hf-mirror.com/" },
    ];
    await saveMirrorConfig({ ...DEFAULT_MIRROR_CONFIG, customRules: editing });
    expect(getMirrorConfig().customRules).toEqual(editing);
  });
});
