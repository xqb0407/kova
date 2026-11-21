import { afterAll, describe, expect, test } from "bun:test";
import { mockModule, restoreAllMocks } from "@/lib/testing/mock-module";

// isDesktop() 是查 window.__KOVA_DESKTOP__ 的纯函数：给 window 垫片即可，
// 不 mock "@/lib/desktop-env"（别名 id 的 mock.module 跨文件 restore 不可靠，会
// 泄漏 isDesktop=true 污染后续文件——mock-module.ts 头注实证过的坑）
const hadWindow = "window" in globalThis;
(globalThis as unknown as { window?: Record<string, unknown> }).window = {
  __KOVA_DESKTOP__: {},
  location: { hostname: "localhost" },
};

/**
 * workspace 胶囊 store 语义测试：
 * - 启动（initWorkspaceStore）恢复 recents 与 lastUsed，但**不恢复** current；
 *   新对话/启动草稿由 restoreLastUsedWorkspace 显式恢复（见 last-used.test.ts）
 * - source 标注（user=手动选 / session=切会话跟随）；仅 user 计入 recents/lastUsed
 * - clear 只清当前选择；kv 持久化读写走 mock 的 invoke
 *
 * 自锚说明（mock-module.ts 头注的教训）：本文件可能不是 workspace-store 的
 * 首个消费者（bun 同进程跨文件模块缓存），顶层 import 时的 init 副作用可能
 * 落在别人的 mock 窗口里。因此不依赖 import 期副作用：显式 await
 * initWorkspaceStore() 重放启动路径，断言当前 mock 下的行为。
 */

const kv = new Map<string, string>();

mockModule("@/desktop-bridge/core", () => ({
  invoke: (cmd: string, args?: Record<string, string>) => {
    const key = args?.key ?? "";
    if (cmd === "kv_get") return Promise.resolve(kv.get(key) ?? null);
    if (cmd === "kv_set") {
      kv.set(key, args?.value ?? "");
      return Promise.resolve(null);
    }
    if (cmd === "kv_delete") {
      kv.delete(key);
      return Promise.resolve(null);
    }
    return Promise.reject(new Error(`unexpected cmd: ${cmd}`));
  },
}));

const store = await import("@/lib/workspace/workspace-store");
afterAll(() => {
  restoreAllMocks();
  if (!hadWindow) delete (globalThis as unknown as { window?: unknown }).window;
});

/** 预置旧版本留下的粘性状态：current 指向 home-iot，recents 两条 */
function seedLegacyKv() {
  kv.set("workspace", "/old/home-iot");
  kv.set("workspace.recents", JSON.stringify(["/recent-a", "/recent-b"]));
}

describe("workspace-store：启动语义", () => {
  test("kv 里有旧 workspace 也不恢复 current（恢复由新对话入口显式触发）", async () => {
    seedLegacyKv();
    store.clearWorkspace(); // 单例可能被其它文件的加载路径污染，先归零
    seedLegacyKv(); // clear 的 kv_delete 会抹掉预置值，重放前再种一次
    await store.initWorkspaceStore();
    expect(store.getWorkspace()).toBeNull();
    expect(store.getWorkspaceSource()).toBeNull();
    // recents 照常恢复（经由下一条用例的置顶断言间接可见）
  });
});

describe("workspace-store：source 与 recents", () => {
  test("user 选择置顶最近列表；重复选择不重复计", () => {
    store.setWorkspace("/pick-a"); // 默认 source=user
    expect(store.getWorkspace()).toBe("/pick-a");
    expect(store.getWorkspaceSource()).toBe("user");
    store.setWorkspace("/pick-a");
    store.setWorkspace("/pick-b");
    // 手动顺序：b、a（新的在前），接在启动恢复的 recent-a/recent-b 之前
    expect(kv.get("workspace.recents")).toBe(
      JSON.stringify(["/pick-b", "/pick-a", "/recent-a", "/recent-b"]),
    );
  });

  test("session 同步不污染最近列表，但带跟随来源", () => {
    store.setWorkspace("/from-session", "session");
    expect(store.getWorkspace()).toBe("/from-session");
    expect(store.getWorkspaceSource()).toBe("session");
    expect(kv.get("workspace.recents")).not.toContain("/from-session");
  });

  test("clearWorkspace 连 source 一起清并删 kv", () => {
    store.clearWorkspace();
    expect(store.getWorkspace()).toBeNull();
    expect(store.getWorkspaceSource()).toBeNull();
    expect(kv.has("workspace")).toBe(false);
  });

  test("清后手动重选：source 回到 user（残留 session 标记不得复活）", () => {
    store.setWorkspace("/again");
    expect(store.getWorkspaceSource()).toBe("user");
  });
});

describe("workspace-store：最近选择的项目空间", () => {
  test("user 选择记录 lastUsed 并持久化；session 同步不记", () => {
    store.setWorkspace("/pick-c", "user", "proj-c");
    expect(store.getLastUsedWorkspace()).toEqual({
      dir: "/pick-c",
      projectId: "proj-c",
    });
    expect(JSON.parse(kv.get("workspace.lastUsed")!)).toEqual({
      dir: "/pick-c",
      projectId: "proj-c",
    });

    store.setWorkspace("/follow", "session", "proj-x");
    expect(store.getLastUsedWorkspace()).toEqual({
      dir: "/pick-c",
      projectId: "proj-c",
    });
  });

  test("clear 只清当前选择，保留最近项目", () => {
    store.setWorkspace("/pick-d", "user", null);
    store.clearWorkspace();
    expect(store.getWorkspace()).toBeNull();
    expect(store.getWorkspaceSource()).toBeNull();
    expect(store.getLastUsedWorkspace()).toEqual({
      dir: "/pick-d",
      projectId: null,
    });
  });

  test("启动加载恢复 lastUsed，但 store 本身不恢复 current", async () => {
    kv.set(
      "workspace.lastUsed",
      JSON.stringify({ dir: "/restored", projectId: "proj-r" }),
    );
    store.clearWorkspace();
    await store.initWorkspaceStore();
    expect(store.getLastUsedWorkspace()).toEqual({
      dir: "/restored",
      projectId: "proj-r",
    });
    expect(store.getWorkspace()).toBeNull();
    expect(store.getWorkspaceSource()).toBeNull();
  });
});
