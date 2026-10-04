/**
 * panel-tabs 测试的伪 window：内存版 localStorage/sessionStorage。
 * 作为首个 import 在 store 模块求值前安装（ESM 按声明顺序执行），
 * 让 hydrate/persist 走真实代码路径；预置 v1 旧键验证「不迁移、清除」。
 * 测试文件 afterAll 拆除，避免污染同进程跑的其他测试文件。
 */
const disk = new Map<string, string>();
const session = new Map<string, string>();

// 预置 v1 全局标签旧档：新 store 首次使用时应清除而非迁移
disk.set(
  "agent-panel-tabs",
  JSON.stringify({ tabs: [{ id: "legacy-1", type: "activity" }], activeId: "legacy-1" }),
);

(globalThis as Record<string, unknown>).window = {
  localStorage: {
    getItem: (k: string) => (disk.has(k) ? disk.get(k)! : null),
    setItem: (k: string, v: string) => void disk.set(k, String(v)),
    removeItem: (k: string) => void disk.delete(k),
  },
  sessionStorage: {
    getItem: (k: string) => (session.has(k) ? session.get(k)! : null),
    setItem: (k: string, v: string) => void session.set(k, String(v)),
    removeItem: (k: string) => void session.delete(k),
  },
};

/** 供测试断言/检查落盘内容的句柄 */
export const fakeLocalStorage = disk;

/** 拆除伪 window（restore 同进程全局环境） */
export function removeFakeWindow(): void {
  delete (globalThis as Record<string, unknown>).window;
}
