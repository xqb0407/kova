/**
 * Univer Docs 引擎引导（单例，与表格面板同构，见 ../sheet/univer.ts 头注）。
 * 文档 = 工作区 JSON：进 = createDocument(Partial<IDocumentData>)，出 =
 * FDocument.save() 全量快照。
 */
import { createUniver, defaultTheme, LocaleType, mergeLocales } from "@univerjs/presets";
import { UniverDocsCorePreset } from "@univerjs/preset-docs-core";
import UniverPresetDocsCoreZhCN from "@univerjs/preset-docs-core/locales/zh-CN";
import "@univerjs/preset-docs-core/lib/index.css";

type UniverAPI = ReturnType<typeof createUniver>["univerAPI"];
/** FDocument 在 @univerjs/docs/facade（传递依赖，不可直接 import），从 createDocument 返回值推导 */
type FDocument = ReturnType<UniverAPI["createDocument"]>;

let univer: ReturnType<typeof createUniver>["univer"] | null = null;
let api: UniverAPI | null = null;
let currentDocument: FDocument | null = null;
/** 命令执行回调（全局事件统一驱动；文档换绑无需重挂） */
let changeHandler: ((snapshot: string) => void) | null = null;
/** 最近一次序列化内容：选区变更等不产生内容差异的命令不触发落盘 */
let lastSent: string | null = null;

export function bootUniver(container: HTMLElement): UniverAPI {
  if (api) return api;
  const { univer: u, univerAPI } = createUniver({
    locale: LocaleType.ZH_CN,
    locales: { [LocaleType.ZH_CN]: mergeLocales(UniverPresetDocsCoreZhCN) },
    theme: defaultTheme,
    presets: [
      UniverDocsCorePreset({
        container,
        disableAutoFocus: true,
      }),
    ],
  });
  univerAPI.addEvent(univerAPI.Event.CommandExecuted, () => {
    if (!changeHandler) return;
    const snapshot = currentSnapshot();
    if (snapshot === null || snapshot === lastSent) return;
    lastSent = snapshot;
    changeHandler(snapshot);
  });
  univer = u;
  api = univerAPI;
  return univerAPI;
}

/** 整体销毁引擎（视图卸载时调用）：容器已随 React 卸载分离，重挂必须重新引导 */
export function disposeEngine(): void {
  if (currentDocument) {
    try {
      api?.disposeUnit(currentDocument.getId());
    } catch {
      // 引擎可能已处于 disposed 态
    }
  }
  try {
    univer?.dispose();
  } catch {
    // 同上
  }
  univer = null;
  api = null;
  currentDocument = null;
  lastSent = null;
  changeHandler = null;
}

export type LoadResult = { ok: true } | { ok: false; errorText: string };

export function loadDocument(univerAPI: UniverAPI, snapshot: unknown): LoadResult {
  if (currentDocument) {
    try {
      univerAPI.disposeUnit(currentDocument.getId());
    } catch {
      // 已 dispose 的 unit 再 dispose 会抛，忽略即可
    }
    currentDocument = null;
  }
  try {
    const doc = univerAPI.createDocument(snapshot as Parameters<UniverAPI["createDocument"]>[0]);
    currentDocument = doc;
    lastSent = null;
    return { ok: true };
  } catch (err) {
    return { ok: false, errorText: `快照载入失败：${err instanceof Error ? err.message : String(err)}` };
  }
}

export function currentSnapshot(): string | null {
  if (!currentDocument) return null;
  return JSON.stringify(currentDocument.save(), null, 2);
}

/** 挂内容变更回调（引擎命令驱动；序列化去重后仍变化才回调，参数即最新快照） */
export function onEngineChange(cb: (snapshot: string) => void): void {
  changeHandler = cb;
}

export function syncTheme(dark: boolean): void {
  if (!api) return;
  try {
    if (api.isDarkMode() !== dark) api.toggleDarkMode(dark);
  } catch {
    // 主题切换失败不影响编辑
  }
}

/** 新建文档的最小快照：只给 id/title，body 等由引擎默认空文档补全（手写 body 容易缺节导致空白页） */
export function newDocumentSnapshot(name: string): Record<string, unknown> {
  return {
    id: `doc-${Date.now().toString(36)}`,
    title: name,
  };
}
