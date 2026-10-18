/**
 * 底部终端坞 store 的测试（伪 window 环境 + 打桩 lib/shell）。
 *
 * lib/shell 被整体打桩：坞的语义是**标签编排**（开合、激活、就近切换、
 * 标签关光收起、上限、持久化），会话拉起/回收是 shell store 的职责，
 * 在那边另有测试；不引 xterm/IPC 能让这些断言跑得干净。
 * 用真实代码路径的关键点：ensureHydrated 走 load()、每次变更走 persist()。
 */
import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";

const disk = new Map<string, string>();
(globalThis as Record<string, unknown>).window = {
  localStorage: {
    getItem: (k: string) => (disk.has(k) ? disk.get(k)! : null),
    setItem: (k: string, v: string) => void disk.set(k, String(v)),
    removeItem: (k: string) => void disk.delete(k),
  },
  // 高度落盘是节流写（拖拽中逐帧 persist 会卡主线程）：伪 window 也要给
  // 真定时器，节流路径才走真实代码
  setTimeout: (fn: () => void, ms?: number) =>
    globalThis.setTimeout(fn, ms) as unknown as number,
  clearTimeout: (id: number) => globalThis.clearTimeout(id),
};

type SpawnCall = { id: string; tabId: string; surface: string };
const spawns: SpawnCall[] = [];
/** 让 spawn 悬挂，验证"创建中"期间标签已在场（pending 语义） */
let holdSpawn = false;
const heldResolvers: (() => void)[] = [];
const swept: number[] = [];
let capacityFull = false;

mock.module("@/lib/desktop-env", () => ({
  isDesktop: () => true,
  isMacPlatform: () => true,
}));

mock.module("@/lib/shell", () => ({
  ensureShellTabBridge: () => {},
  isShellCapacityFull: () => capacityFull,
  registerShellDock: () => {},
  sweepUnboundShells: () => void swept.push(1),
  spawnShellSession: (id: string, tabId: string, surface: string) => {
    spawns.push({ id, tabId, surface });
    if (!holdSpawn) return Promise.resolve({ id, title: "kovaelectron" });
    return new Promise((resolve) => {
      heldResolvers.push(() => resolve({ id, title: "kovaelectron" }));
    });
  },
}));

const {
  closeAllDockTabs,
  closeDockTab,
  DOCK_DEFAULT_HEIGHT,
  DOCK_MIN_HEIGHT,
  getTerminalDock,
  newDockTerminal,
  restartDockTerminal,
  setActiveDockTab,
  setTerminalDockHeight,
  setTerminalDockOpen,
  toggleTerminalDock,
} = await import("@/lib/terminal/dock");

afterAll(() => {
  delete (globalThis as Record<string, unknown>).window;
});

afterEach(() => {
  // store 是模块级单例：逐个关标签 + 复位高度/开合，用例间互不残留
  closeAllDockTabs();
  setTerminalDockHeight(DOCK_DEFAULT_HEIGHT);
  spawns.length = 0;
  swept.length = 0;
  capacityFull = false;
  holdSpawn = false;
  heldResolvers.length = 0;
});

describe("开合与空坞", () => {
  test("展开空坞自动给一个终端：标签即刻在场 + 会话在拉起（surface=dock）", () => {
    setTerminalDockOpen(true);
    const s = getTerminalDock();
    expect(s.open).toBe(true);
    expect(s.tabs).toHaveLength(1);
    expect(s.activeId).toBe(s.tabs[0]!.id);
    // 标签先落地、会话异步拉起：绑定 id 已经写进标签
    expect(s.tabs[0]!.sessionId).toBeTruthy();
    expect(spawns).toHaveLength(1);
    expect(spawns[0]!.surface).toBe("dock");
    expect(spawns[0]!.tabId).toBe(s.tabs[0]!.id);
  });

  test("收起再展开原样接回同一批标签（不新拉会话）", () => {
    setTerminalDockOpen(true);
    const before = getTerminalDock();
    toggleTerminalDock();
    expect(getTerminalDock().open).toBe(false);
    // 收起 ≠ 关标签：标签与会话都还在（PTY 由 shell 侧按标签存活判定保活）
    expect(getTerminalDock().tabs).toHaveLength(1);
    toggleTerminalDock();
    const after = getTerminalDock();
    expect(after.open).toBe(true);
    expect(after.tabs).toEqual(before.tabs);
    expect(spawns).toHaveLength(1);
  });

  test("容量满的展开：不摆空横条，坞保持收起", () => {
    capacityFull = true;
    setTerminalDockOpen(true);
    const s = getTerminalDock();
    expect(s.tabs).toHaveLength(0);
    expect(s.open).toBe(false);
    expect(spawns).toHaveLength(0);
  });
});

describe("标签编排", () => {
  test("多开 + 激活 + 关激活项就近切换", () => {
    setTerminalDockOpen(true);
    const first = getTerminalDock().tabs[0]!.id;
    const second = newDockTerminal()!;
    const third = newDockTerminal()!;
    expect(getTerminalDock().tabs.map((t) => t.id)).toEqual([
      first,
      second,
      third,
    ]);
    expect(getTerminalDock().activeId).toBe(third);

    setActiveDockTab(first);
    expect(getTerminalDock().activeId).toBe(first);
    // 关中间那个（非激活）：激活项不动
    closeDockTab(second);
    expect(getTerminalDock().activeId).toBe(first);

    // 关激活项：就近切到相邻（原索引位置上的下一个）
    closeDockTab(first);
    expect(getTerminalDock().activeId).toBe(third);
  });

  test("标签关光时坞一并收起", () => {
    setTerminalDockOpen(true);
    const only = getTerminalDock().tabs[0]!.id;
    closeDockTab(only);
    const s = getTerminalDock();
    expect(s.tabs).toHaveLength(0);
    expect(s.open).toBe(false);
  });

  test("坞内标签上限：到顶后新开返回 null、标签数不变", () => {
    setTerminalDockOpen(true);
    let last: string | null = null;
    for (let i = 0; i < 10; i++) last = newDockTerminal();
    const s = getTerminalDock();
    expect(s.tabs).toHaveLength(5);
    expect(last).toBeNull();
  });

  test("关标签触发回收扫描（失去绑定的会话交给 shell 桥杀）", () => {
    setTerminalDockOpen(true);
    newDockTerminal();
    swept.length = 0;
    closeDockTab(getTerminalDock().tabs[0]!.id);
    expect(swept.length).toBeGreaterThan(0);
  });
});

describe("重启（刷新后悬空 / 进程退出后重开）", () => {
  test("重启把标签指向新会话 id 并用占位标题等待回绑", async () => {
    setTerminalDockOpen(true);
    const tab = getTerminalDock().tabs[0]!;
    spawns.length = 0;
    restartDockTerminal(tab.id);
    const next = getTerminalDock().tabs[0]!;
    expect(next.id).toBe(tab.id);
    expect(next.sessionId).not.toBe(tab.sessionId);
    expect(next.title).toBe("终端");
    expect(spawns).toHaveLength(1);
    expect(spawns[0]!.tabId).toBe(tab.id);
  });

  test("异步拉起完成时用户已关标签：不再回写（no-op，不复活标签）", async () => {
    holdSpawn = true;
    setTerminalDockOpen(true);
    const tab = getTerminalDock().tabs[0]!;
    closeDockTab(tab.id);
    for (const release of heldResolvers) release();
    await Promise.resolve();
    await Promise.resolve();
    expect(getTerminalDock().tabs).toHaveLength(0);
  });
});

describe("持久化", () => {
  test("开合/标签/激活项落盘，键为 terminal-dock-v1", () => {
    setTerminalDockOpen(true);
    const second = newDockTerminal()!;
    setActiveDockTab(second);
    const raw = disk.get("terminal-dock-v1");
    expect(raw).toBeTruthy();
    const saved = JSON.parse(raw!);
    expect(saved.open).toBe(true);
    expect(saved.tabs).toHaveLength(2);
    expect(saved.activeId).toBe(second);
  });

  test("高度按下限钳制，且节流写最终落盘", async () => {
    setTerminalDockOpen(true);
    setTerminalDockHeight(10);
    // 状态即时生效（拖拽中视口跟手），落盘节流到停手后
    expect(getTerminalDock().height).toBe(DOCK_MIN_HEIGHT);
    await new Promise((r) => globalThis.setTimeout(r, 260));
    const saved = JSON.parse(disk.get("terminal-dock-v1")!);
    expect(saved.height).toBe(DOCK_MIN_HEIGHT);
  });
});