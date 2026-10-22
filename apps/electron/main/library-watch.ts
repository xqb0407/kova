/**
 * 资料库变更监听：递归 watch 资料库根，防抖后经 kova-event 广播
 * `library:changed`，让资料库页/引用守卫在选择器之外也能感知「系统删除、
 * 同步盘拉回、外部改名」这类不经应用的变更。
 *
 * 只监听资料库根——AI 产物（task-workspace）由 agent 频繁写入，纳入监听只会
 * 造成无意义的刷新风暴，且本次功能不覆盖产物引用。
 *
 * `fs.watch` 的 recursive 选项 macOS / Windows（及新版 Node 的 Linux）都支持；
 * 不支持或根目录消失（ENODEV / ENOENT）时静默退化为「无监听」——渲染层的
 * 窗口聚焦刷新 + 发送前校验仍是兜底，watcher 只是让感知更即时。
 */
import { watch, type FSWatcher } from "node:fs";
import { libraryRoot } from "./library";
import { emitToWindows } from "./ipc";

/** 防抖窗口：一次批量导入/同步会触发一串事件，合并成一次广播 */
const DEBOUNCE_MS = 300;

/** 监听器（同一时刻最多一个：watcher 跟随当前资料库根） */
let watcher: FSWatcher | null = null;
/** 正在监听的根（重启时避免重复 start） */
let watchedRoot: string | null = null;
let debounce: ReturnType<typeof setTimeout> | null = null;
/** 根消失已广播过（error 只广播一次，避免反复弹「位置不可用」） */
let rootMissingReported = false;

function scheduleChanged(root: string): void {
  if (debounce) clearTimeout(debounce);
  debounce = setTimeout(() => {
    debounce = null;
    emitToWindows("library:changed", { root });
  }, DEBOUNCE_MS);
}

/** 当前是否在监听（测试/诊断用） */
export function isLibraryWatched(): boolean {
  return watcher !== null;
}

/** 启动/重启监听（跟随当前资料库根；重复调用同一根是 no-op） */
export function startLibraryWatch(): void {
  const root = libraryRoot();
  if (watcher && watchedRoot === root) return;
  stopLibraryWatch();
  watchedRoot = root;
  rootMissingReported = false;
  try {
    watcher = watch(
      root,
      { recursive: true, persistent: false },
      (_event, filename) => {
        // 事件里的 filename 是相对根的路径；过滤掉永不入库的目录，省得
        // node_modules 恢复/装载时刷屏
        if (typeof filename === "string") {
          const norm = `/${filename.replace(/\\/g, "/").toLowerCase()}/`;
          if (norm.includes("/.git/") || norm.includes("/node_modules/")) return;
        }
        scheduleChanged(root);
      },
    );
    watcher.on("error", () => {
      // 根被删/卸载：广播一次「位置不可用」后收掉监听；恢复靠用户点重试或
      // 改根（set_root 会重新 start）
      if (!rootMissingReported) {
        rootMissingReported = true;
        emitToWindows("library:root-missing", { root });
      }
      stopLibraryWatch();
    });
  } catch {
    // 平台不支持递归 watch 等：静默退化（焦点刷新兜底）
    watcher = null;
  }
}

export function stopLibraryWatch(): void {
  if (debounce) {
    clearTimeout(debounce);
    debounce = null;
  }
  if (watcher) {
    try {
      watcher.close();
    } catch {
      /* ignore */
    }
  }
  watcher = null;
  watchedRoot = null;
}
