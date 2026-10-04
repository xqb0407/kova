/**
 * 宿主副作用端口（HostEffects）。
 *
 * 主工程的运行时基座（PiClientBase / TurnCheckpointTracker）在几处调用了
 * **桌面 Web 专属**的宿主能力：agent 面板分桶与唤起、文件树刷新、git 影子仓库
 * 检查点、子代理活动台账、侧边栏运行指示、完成提醒总线。这些能力依赖 Tauri
 * invoke、DOM 事件与 localStorage，在手机上既不存在也无意义。
 *
 * 与其把一千多行面板逻辑搬过来，不如在这里给出明确的无操作实现：基座的调用
 * 点一行不改（照旧从本模块导入同名函数），语义从「驱动桌面 UI」退化为「什么
 * 都不做」。运行时的事件分发、快照、消息投影等核心路径完全不受影响。
 *
 * 若日后移动端要做子代理活动视图，把 applyDelegationChunk 换成真实实现即可，
 * 基座无需再动。
 */

// ---------- 面板（浏览器 / 文件 / 插件面板） ----------

export type PanelTabKind = "browser" | "file" | string;

export function getCurrentPanelThreadId(): string | null {
  return null;
}

export function focusPanelTabFor(
  _threadId: string,
  _kind: PanelTabKind,
  _extra?: Record<string, unknown>,
): void {
  /* 移动端没有 agent 面板 */
}

export function focusPluginPanelFor(
  _threadId: string,
  _plugin: string,
  _panel: string,
  _extra?: Record<string, unknown>,
): void {
  /* 移动端没有插件面板 */
}

// ---------- 文件树 ----------

export function refreshFileTree(_workspacePath: string | null): void {
  /* 移动端不展示文件树 */
}

// ---------- 侧边栏运行指示 ----------

export { resyncPiRunning } from "@/lib/pi/pi-running";

// ---------- 子代理活动 ----------

export function applyDelegationChunk(_data: unknown): void {
  /* 移动端 v1 不展示子代理活动 */
}

// ---------- 完成提醒总线 ----------

export function emitAgentEvent(
  _type: string,
  _payload?: { threadId?: string; data?: Record<string, unknown> },
): void {
  /* 移动端 v1 不做完成提醒（系统级通知另行评估） */
}

// ---------- 轻提示（toast） ----------

/**
 * 桌面端走 `@/components/ui/toast`（framer-motion + react-dom 的 UI 栈）。
 * 那套东西在 RN 上不存在，而调用方（如 pi-vision-warning）不能为此把整个
 * UI 栈拖进运行时的静态依赖图——所以把提示也收进本端口。
 *
 * 移动端的呈现由根视图订阅本总线后自己渲染顶部横幅；基座只管发。
 */

export type NotifyLevel = "info" | "success" | "warning" | "error";

export type NotifyMessage = {
  id: number;
  level: NotifyLevel;
  text: string;
};

type NotifyListener = (message: NotifyMessage) => void;

const notifyListeners = new Set<NotifyListener>();
let nextNotifyId = 1;

export function notify(level: NotifyLevel, text: string): void {
  const message: NotifyMessage = { id: nextNotifyId++, level, text };
  for (const listener of [...notifyListeners]) {
    try {
      listener(message);
    } catch (err) {
      console.warn("[host-effects] notify listener failed", String(err));
    }
  }
}

export function subscribeNotify(listener: NotifyListener): () => void {
  notifyListeners.add(listener);
  return () => {
    notifyListeners.delete(listener);
  };
}