import { afterAll, describe, expect, test } from "bun:test";
import { mockModule, restoreAllMocks } from "@/lib/testing/mock-module";

/**
 * 设计主题前端镜像 store 测试（app-mode 同款桩风格）：
 * - 清单应答即快照（findThemeEntry 作为快照探针）；save 的应答同为清单帧
 * - delete 语义：本地把引用该主题的线程快照回落「不使用主题」
 *   （与 sidecar 清理驻留会话一致）
 * - 会话级三态：偏好列 undefined = 未设置不播种；"" = 显式不使用；
 *   JSON = 选中；脏 JSON 视作不使用；没有任何已知 sessionId 的线程不发请求
 * - setActive/setSession 后偏好镜像（piSessionPrefsMap）跟齐，hydrate 播种源不失真
 */

type Req = Record<string, unknown>;
type Ref = { scope: "builtin" | "user"; id: string };
type PrefsEntry = { designTheme?: string | null };

let responder: (req: Req) => unknown = () => listFrame();
let calls: Req[] = [];

function listFrame(active?: Ref | null): Req {
  return {
    type: "design_themes",
    entries: [
      { scope: "builtin", id: "nova", name: "Nova", desc: "冷蓝", accents: ["#3b82f6"], shadowed: false },
      { scope: "user", id: "demo", name: "Demo", desc: "暖橙", accents: [], shadowed: false, sizeBytes: 42 },
    ],
    version: "1.0.0",
    builtinCount: 1,
    userCount: 1,
    error: null,
    ...(active !== undefined ? { active } : {}),
  };
}

/** 会话簿记的替身：与 pi-thread-adapter 同语义（registry 优先；__LOCALID_ 草稿
 *  无会话返回 undefined；其余 id 本身就是 sessionId——新链路/恢复线程行） */
const registry = new Map<string, string>();
const prefs = new Map<string, PrefsEntry>();
const { isLocalDraftThreadId } = await import("@/lib/pi/pi-thread-identity");
mockModule("@/lib/pi/pi-thread-adapter", () => ({
  piSessionRegistry: registry,
  piSessionPrefsMap: prefs,
  prefsSessionIdFor: (threadId: string) =>
    registry.get(threadId) ?? (prefs.has(threadId) ? threadId : undefined),
  piSessionIdForThread: (threadId: string) =>
    registry.get(threadId) ?? (isLocalDraftThreadId(threadId) ? undefined : threadId),
}));

mockModule("@/lib/pi/pi-bridge", () => ({
  piRequest: (payload: Req) => {
    calls.push(payload);
    const res = responder(payload);
    if (res instanceof Error) return Promise.reject(res);
    return Promise.resolve(res);
  },
}));

afterAll(() => {
  restoreAllMocks();
});

const {
  deleteDesignTheme,
  findThemeEntry,
  getSessionDesignTheme,
  handleDesignThemePush,
  hydrateSessionTheme,
  refreshDesignThemes,
  saveDesignTheme,
  setActiveDesignTheme,
  setSessionDesignTheme,
} = await import("@/lib/design-themes/design-themes");

const flush = () => new Promise((r) => setTimeout(r, 0));

/** 每用例重置：桩行为/调用记录/会话簿记（线程 id 各用例自带，互不串扰） */
async function reset() {
  calls = [];
  responder = () => listFrame();
  registry.clear();
  prefs.clear();
}

describe("清单镜像", () => {
  test("refresh 应答即快照：版本/条目/按 ref 查找", async () => {
    await reset();
    await refreshDesignThemes();
    const nova = findThemeEntry({ scope: "builtin", id: "nova" });
    expect(nova?.name).toBe("Nova");
    expect(findThemeEntry({ scope: "user", id: "demo" })?.sizeBytes).toBe(42);
    expect(findThemeEntry({ scope: "user", id: "ghost" })).toBeUndefined();
  });

  test("save 应答刷新快照（改后即见，不再另拉清单）", async () => {
    await reset();
    responder = (req) =>
      req.type === "save_design_theme"
        ? { ...listFrame(), userCount: 2, entries: [...(listFrame().entries as object[]), { scope: "user", id: "two", name: "Two", desc: "", accents: [], shadowed: false }] }
        : listFrame();
    await saveDesignTheme({ definition: { name: "Two", content: "body" } });
    expect(findThemeEntry({ scope: "user", id: "two" })?.name).toBe("Two");
    const req = calls.find((c) => c.type === "save_design_theme");
    expect(req?.scope).toBe("user");
    expect(req?.definition).toEqual({ name: "Two", content: "body" });
  });

  test("delete 后本地引用该主题的线程回落不使用（与 sidecar 清理语义对齐）", async () => {
    await reset();
    registry.set("t-a", "s-a");
    prefs.set("s-a", { designTheme: JSON.stringify({ scope: "user", id: "demo" }) });
    setActiveDesignTheme("t-a", { scope: "user", id: "demo" });
    expect(getSessionDesignTheme("t-a")).toEqual({ scope: "user", id: "demo" });
    await deleteDesignTheme("demo");
    expect(getSessionDesignTheme("t-a")).toBeNull();
    // 偏好镜像行同步收口（下一次 hydrate 播种不指向已删主题）
    expect(prefs.get("s-a")?.designTheme).toBe("");
  });

  test("改名保存（应答 ref 换新 id）：线程选中与偏好镜像跟着换新、不断链", async () => {
    await reset();
    registry.set("t-r", "s-r");
    prefs.set("s-r", { designTheme: JSON.stringify({ scope: "user", id: "demo" }) });
    setActiveDesignTheme("t-r", { scope: "user", id: "demo" });
    responder = (req) =>
      req.type === "save_design_theme"
        ? {
            // 真帧是 design_theme_saved 应答：ref = 保存后的权威身份（改名换新 id），带清单快照
            ...listFrame(),
            type: "design_theme_saved",
            ref: { scope: "user", id: "demo2" },
            entries: [
              ...(listFrame().entries as object[]),
              { scope: "user", id: "demo2", name: "Demo 2", desc: "", accents: [], shadowed: false },
            ],
          }
        : listFrame();
    await saveDesignTheme({ id: "demo", definition: { name: "Demo 2", content: "b" } });
    expect(getSessionDesignTheme("t-r")).toEqual({ scope: "user", id: "demo2" });
    expect(prefs.get("s-r")?.designTheme).toBe(JSON.stringify({ scope: "user", id: "demo2" }));
    // 请求载荷业务 id 走 themeId（裸 id 被协议 reqId 占用）
    const req = calls.find((c) => c.type === "save_design_theme");
    expect(req?.themeId).toBe("demo");
  });
});

describe("会话级选中（三态播种与写回）", () => {
  test("未发送草稿（__LOCALID_）不发请求（避免懒建会话）", async () => {
    await reset();
    await hydrateSessionTheme("__LOCALID_draft-1");
    expect(calls.length).toBe(0);
    expect(getSessionDesignTheme("__LOCALID_draft-1")).toBeUndefined();
  });

  test("恢复线程（行 id 即 sessionId）即使偏好镜像没有也拉活动真值", async () => {
    await reset();
    responder = () => listFrame({ scope: "builtin", id: "nova" });
    await hydrateSessionTheme("t-restored");
    const req = calls.find((c) => c.type === "list_design_themes");
    expect(req?.sessionId).toBe("t-restored");
    expect(getSessionDesignTheme("t-restored")).toEqual({ scope: "builtin", id: "nova" });
  });

  test("偏好列 JSON 播种选中态；含 active 应答以活动真值覆盖", async () => {
    await reset();
    registry.set("t-b", "s-b");
    prefs.set("s-b", { designTheme: JSON.stringify({ scope: "builtin", id: "nova" }) });
    responder = () => listFrame(); // 应答不带 active：保留播种值
    await hydrateSessionTheme("t-b");
    expect(getSessionDesignTheme("t-b")).toEqual({ scope: "builtin", id: "nova" });
    responder = () => listFrame(null); // 活动真值：显式不使用
    await hydrateSessionTheme("t-b");
    expect(getSessionDesignTheme("t-b")).toBeNull();
  });

  test("偏好列三态：\"\" 播种为不使用；从未设置不播种；脏 JSON 视作不使用", async () => {
    await reset();
    registry.set("t-c", "s-c");
    prefs.set("s-c", { designTheme: "" });
    await hydrateSessionTheme("t-c");
    expect(getSessionDesignTheme("t-c")).toBeNull();

    await reset();
    registry.set("t-d", "s-d");
    prefs.set("s-d", {});
    responder = () => listFrame({ scope: "user", id: "demo" });
    await hydrateSessionTheme("t-d");
    expect(getSessionDesignTheme("t-d")).toEqual({ scope: "user", id: "demo" });

    await reset();
    registry.set("t-e", "s-e");
    prefs.set("s-e", { designTheme: "{oops" });
    responder = () => listFrame();
    await hydrateSessionTheme("t-e");
    expect(getSessionDesignTheme("t-e")).toBeNull();
  });

  test("setSession 写活动真值并校准偏好镜像（下一次 hydrate 播种不回落）", async () => {
    await reset();
    registry.set("t-f", "s-f");
    prefs.set("s-f", { designTheme: "" });
    responder = (req) =>
      req.type === "set_design_theme"
        ? { type: "design_theme_set", sessionId: "s-f", theme: { scope: "builtin", id: "nova" } }
        : listFrame({ scope: "builtin", id: "nova" });
    await setSessionDesignTheme("t-f", { scope: "builtin", id: "nova" });
    const req = calls.find((c) => c.type === "set_design_theme");
    expect(req?.sessionId).toBe("s-f");
    expect(req?.theme).toEqual({ scope: "builtin", id: "nova" });
    expect(prefs.get("s-f")?.designTheme).toBe(JSON.stringify({ scope: "builtin", id: "nova" }));
    // 同会话的新线程仅靠偏好镜像播种（模拟刷新后重进）：值不回落
    registry.set("t-f2", "s-f");
    responder = () => listFrame();
    await hydrateSessionTheme("t-f2");
    expect(getSessionDesignTheme("t-f2")).toEqual({ scope: "builtin", id: "nova" });
  });

  test("显式不使用：应答 theme=null 也要写偏好列空串（不回退最近使用）", async () => {
    await reset();
    registry.set("t-g", "s-g");
    prefs.set("s-g", { designTheme: JSON.stringify({ scope: "user", id: "demo" }) });
    setActiveDesignTheme("t-g", { scope: "user", id: "demo" });
    responder = () => ({ type: "design_theme_set", sessionId: "s-g", theme: null });
    await setSessionDesignTheme("t-g", null);
    expect(getSessionDesignTheme("t-g")).toBeNull();
    expect(prefs.get("s-g")?.designTheme).toBe("");
  });

  test("未发送草稿只落本地选中态，不发 set_design_theme（避免懒建会话）", async () => {
    await reset();
    await setSessionDesignTheme("__LOCALID_draft-2", { scope: "builtin", id: "nova" });
    expect(calls.some((c) => c.type === "set_design_theme")).toBe(false);
    expect(getSessionDesignTheme("__LOCALID_draft-2")).toEqual({ scope: "builtin", id: "nova" });
  });
});

describe("推送直更（多窗口/远程同步）", () => {
  test("design_themes 推送帧整包覆写清单快照（他窗 save/delete 立见）", async () => {
    await reset();
    await refreshDesignThemes();
    expect(findThemeEntry({ scope: "user", id: "demo" })).toBeDefined();
    handleDesignThemePush({
      type: "design_themes",
      entries: [{ scope: "user", id: "three", name: "Three", desc: "", accents: [], shadowed: false }],
      version: "1.0.1",
      builtinCount: 0,
      userCount: 1,
      error: null,
    });
    expect(findThemeEntry({ scope: "user", id: "demo" })).toBeUndefined();
    expect(findThemeEntry({ scope: "user", id: "three" })?.name).toBe("Three");
  });

  test("design_theme_set 推送帧按 setActive 同款写面更新线程与偏好镜像", async () => {
    await reset();
    registry.set("t-p", "s-p");
    prefs.set("s-p", { designTheme: "" });
    handleDesignThemePush({
      type: "design_theme_set",
      threadId: "t-p",
      sessionId: "s-p",
      theme: { scope: "builtin", id: "nova" },
    });
    expect(getSessionDesignTheme("t-p")).toEqual({ scope: "builtin", id: "nova" });
    expect(prefs.get("s-p")?.designTheme).toBe(JSON.stringify({ scope: "builtin", id: "nova" }));
    // 改名重映射/删除收口的收口推送：null 收敛为显式「不使用」
    handleDesignThemePush({ type: "design_theme_set", threadId: "t-p", sessionId: "s-p", theme: null });
    expect(getSessionDesignTheme("t-p")).toBeNull();
    expect(prefs.get("s-p")?.designTheme).toBe("");
  });
});
