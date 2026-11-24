import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mockModule, restoreAllMocks } from "@/lib/testing/mock-module";

/**
 * 钩子配置镜像的数据安全：水合失败时不能把空镜像全量写回 sidecar
 * （那会清掉已持久化的钩子），恢复后重试水合再保存。
 */

type Req = Record<string, unknown>;

const requests: Req[] = [];
let getHooks: () => Promise<unknown> = async () => ({ type: "hooks", hooks: [] });

mockModule("@/lib/pi/pi-bridge", () => ({
  piRequest: (req: Req) => {
    requests.push(req);
    if (req.type === "get_hooks") return getHooks();
    return Promise.resolve({ type: "hooks_saved" });
  },
}));

afterAll(() => restoreAllMocks());

const hooks = await import("@/lib/pi/hooks");

const existing = {
  id: "h1",
  name: "existing",
  command: "true",
  event: "Stop" as const,
  enabled: true,
};

const newHook = {
  name: "new",
  command: "true",
  event: "Stop" as const,
  enabled: true,
};

beforeEach(async () => {
  // 模块加载期的首次水合是 fire-and-forget：先让它落地，再重置到干净状态
  await new Promise((r) => setTimeout(r, 0));
  hooks.resetHooksMirrorForTest();
  requests.length = 0;
  getHooks = async () => ({ type: "hooks", hooks: [] });
});

describe("hooks 配置镜像水合", () => {
  test("水合失败时保存被拒绝，不用空表覆盖 sidecar 配置", async () => {
    getHooks = async () => {
      throw new Error("sidecar down");
    };
    await hooks.initHookConfigs();
    expect(hooks.getHookConfigs()).toEqual([]);

    await expect(hooks.addHookConfig(newHook)).rejects.toThrow("hooks not loaded");
    expect(requests.some((r) => r.type === "set_hooks")).toBe(false);
  });

  test("恢复后重试水合，保存携带已有配置（不丢旧项）", async () => {
    getHooks = async () => {
      throw new Error("sidecar down");
    };
    await hooks.initHookConfigs();

    getHooks = async () => ({ type: "hooks", hooks: [existing] });
    await hooks.addHookConfig(newHook);

    const saved = requests.filter((r) => r.type === "set_hooks").at(-1) as {
      hooks: Array<typeof existing>;
    };
    expect(saved.hooks).toHaveLength(2);
    expect(saved.hooks[0]).toEqual(existing);
    expect(saved.hooks[1]?.name).toBe("new");
    expect(hooks.getHookConfigs()).toHaveLength(2);
  });

  test("已水合后重复 init 不重复拉取", async () => {
    getHooks = async () => ({ type: "hooks", hooks: [existing] });
    await hooks.initHookConfigs();
    await hooks.initHookConfigs();
    expect(requests.filter((r) => r.type === "get_hooks")).toHaveLength(1);
    expect(hooks.getHookConfigs()).toEqual([existing]);
  });

  test("水合期间收到 hooks_changed 时丢弃过期快照", async () => {
    let resolveGet!: (value: unknown) => void;
    getHooks = () => new Promise((resolve) => (resolveGet = resolve));

    const init = hooks.initHookConfigs();
    hooks.applyHooksChanged([existing]); // 先到的推送才是新值
    resolveGet({ type: "hooks", hooks: [] });
    await init;

    expect(hooks.getHookConfigs()).toEqual([existing]);
  });

  test("hooks_changed 推送直接替换镜像，后续保存基于推送列表", async () => {
    hooks.applyHooksChanged([existing]);
    expect(hooks.getHookConfigs()).toEqual([existing]);

    await hooks.addHookConfig(newHook);
    // 推送已把镜像标记为水合：保存不应再拉 get_hooks
    expect(requests.filter((r) => r.type === "get_hooks")).toHaveLength(0);
    const saved = requests.filter((r) => r.type === "set_hooks").at(-1) as {
      hooks: Array<typeof existing>;
    };
    expect(saved.hooks.map((h) => h.name)).toEqual(["existing", "new"]);
  });
});
