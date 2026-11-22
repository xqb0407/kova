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

/**
 * 项目删除清缓存（forgetProjectWorkspaces）：彻底删除/归档/从侧栏移除项目后，
 * lastUsed 若指向它必须清掉——恢复路径（resolveLastUsedWorkspace）按注册表
 * 匹配，归档/隐藏项目仍在注册表里，不清的话新对话会把会话默默带回用户以为
 * 已经删掉的项目空间。recents 只在彻底删除（目录成孤儿）时清理。
 */
describe("workspace-store：项目删除清缓存", () => {
  test("彻底删除：清 lastUsed，孤儿目录移出 recents，别人的目录保留", async () => {
    store.clearWorkspace(); // 先归零，避免内存 recents 覆盖下面的 kv 预置
    kv.set(
      "workspace.lastUsed",
      JSON.stringify({ dir: "/proj-a/src", projectId: "proj-a" }),
    );
    kv.set("workspace.recents", JSON.stringify(["/proj-a/src", "/other/dir"]));
    await store.initWorkspaceStore();
    expect(store.getLastUsedWorkspace()).toEqual({
      dir: "/proj-a/src",
      projectId: "proj-a",
    });

    store.forgetProjectWorkspaces("proj-a", ["/proj-a"], { purgeRecents: true });
    expect(store.getLastUsedWorkspace()).toBeNull();
    expect(kv.has("workspace.lastUsed")).toBe(false);
    expect(kv.get("workspace.recents")).toBe(JSON.stringify(["/other/dir"]));
  });

  test("lastUsed 是项目子目录（projectId 缺失）也按目录匹配清除；不传 purge 不动 recents", async () => {
    store.clearWorkspace();
    kv.set(
      "workspace.lastUsed",
      JSON.stringify({ dir: "/proj-a/packages/app", projectId: null }),
    );
    kv.set("workspace.recents", JSON.stringify(["/proj-a/packages/app"]));
    await store.initWorkspaceStore();

    store.forgetProjectWorkspaces("proj-a", ["/proj-a"]);
    expect(store.getLastUsedWorkspace()).toBeNull();
    expect(kv.has("workspace.lastUsed")).toBe(false);
    // 没有彻底删除：目录仍属于项目，recents 保留
    expect(kv.get("workspace.recents")).toBe(
      JSON.stringify(["/proj-a/packages/app"]),
    );
  });

  test("归档/移除：projectId 或目录匹配都清 lastUsed，recents 保留（项目可恢复）", async () => {
    store.clearWorkspace();
    kv.set(
      "workspace.lastUsed",
      JSON.stringify({ dir: "/proj-a", projectId: "proj-a" }),
    );
    kv.set("workspace.recents", JSON.stringify(["/proj-a", "/other/dir"]));
    await store.initWorkspaceStore();

    // 归档/移除传项目全部文件夹（远程项目与普通目录的 lastUsed 没有
    // projectId，只能按目录认），但不传 purgeRecents
    store.forgetProjectWorkspaces("proj-a", ["/proj-a"]);
    expect(store.getLastUsedWorkspace()).toBeNull();
    expect(kv.has("workspace.lastUsed")).toBe(false);
    expect(kv.get("workspace.recents")).toBe(
      JSON.stringify(["/proj-a", "/other/dir"]),
    );
  });

  test("lastUsed 指向别的项目：空操作（不删 kv、recents 不动）", async () => {
    store.clearWorkspace();
    kv.set(
      "workspace.lastUsed",
      JSON.stringify({ dir: "/proj-b", projectId: "proj-b" }),
    );
    kv.set("workspace.recents", JSON.stringify(["/proj-b"]));
    await store.initWorkspaceStore();

    store.forgetProjectWorkspaces("proj-a", ["/proj-a"]);
    expect(store.getLastUsedWorkspace()).toEqual({
      dir: "/proj-b",
      projectId: "proj-b",
    });
    expect(kv.has("workspace.lastUsed")).toBe(true);
    expect(kv.get("workspace.recents")).toBe(JSON.stringify(["/proj-b"]));
  });
});

/**
 * 胶囊 × 的语义（forgetWorkspace）：用户显式「不要这个工作区了」——当前选择
 * 与「下次新对话自动恢复」的 lastUsed 一起清；recents 保留（手动重选的入口）。
 * 与 clearWorkspace 的区别必须钉住：后者是恢复失败留空的 fallback，偏好必须保留。
 */
describe("workspace-store：胶囊 ×（forgetWorkspace）", () => {
  test("清当前选择 + 清 lastUsed 偏好，recents 保留", async () => {
    store.clearWorkspace();
    kv.set(
      "workspace.lastUsed",
      JSON.stringify({ dir: "/proj-a", projectId: "proj-a" }),
    );
    kv.set("workspace.recents", JSON.stringify(["/proj-a", "/other"]));
    await store.initWorkspaceStore();
    store.setWorkspace("/proj-a", "user", "proj-a");
    expect(kv.get("workspace")).toBe("/proj-a");

    store.forgetWorkspace();
    expect(store.getWorkspace()).toBeNull();
    expect(store.getLastUsedWorkspace()).toBeNull();
    expect(kv.has("workspace")).toBe(false);
    expect(kv.has("workspace.lastUsed")).toBe(false);
    expect(kv.get("workspace.recents")).toBe(
      JSON.stringify(["/proj-a", "/other"]),
    );
  });

  test("session 跟随态点 ×（本来就没有 lastUsed）：清当前，recents 不动", async () => {
    store.clearWorkspace();
    kv.delete("workspace.lastUsed");
    kv.set("workspace.recents", JSON.stringify(["/pick-b"]));
    await store.initWorkspaceStore();
    // source=session 不写 lastUsed（胶囊跟随会话目录的形态）
    store.setWorkspace("/from-session", "session", "proj-x");
    expect(store.getLastUsedWorkspace()).toBeNull();

    store.forgetWorkspace();
    expect(store.getWorkspace()).toBeNull();
    expect(store.getLastUsedWorkspace()).toBeNull();
    expect(kv.has("workspace.lastUsed")).toBe(false);
    expect(kv.get("workspace.recents")).toBe(JSON.stringify(["/pick-b"]));
  });

  test("clearWorkspace 语义不变：只作用于当前会话，偏好保留", () => {
    store.setWorkspace("/proj-a", "user", "proj-a");
    store.clearWorkspace();
    expect(store.getWorkspace()).toBeNull();
    expect(store.getLastUsedWorkspace()).toEqual({
      dir: "/proj-a",
      projectId: "proj-a",
    });
    expect(kv.has("workspace.lastUsed")).toBe(true);
  });
});
