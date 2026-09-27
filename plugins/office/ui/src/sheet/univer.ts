/**
 * Univer 引擎引导（单例）：一个面板生命周期只 createUniver 一次，换文档 =
 * disposeUnit + createWorkbook（宿主 doc.open 推送与用户换绑共用此路径）。
 * 文档即工作区 JSON：进 = createWorkbook(Partial<IWorkbookData>)，出 =
 * FWorkbook.save() 全量快照（agent 写的精简骨架会被补全后再落盘，属预期）。
 */
import { createUniver, defaultTheme, LocaleType, mergeLocales } from "@univerjs/presets";
import { UniverSheetsCorePreset } from "@univerjs/preset-sheets-core";
import type { FWorkbook } from "@univerjs/preset-sheets-core";
import UniverPresetSheetsCoreZhCN from "@univerjs/preset-sheets-core/locales/zh-CN";
import "@univerjs/preset-sheets-core/lib/index.css";
import { dropEmptyResources, sanitizeSheetSnapshot } from "./sanitize";

type UniverAPI = ReturnType<typeof createUniver>["univerAPI"];

let univer: ReturnType<typeof createUniver>["univer"] | null = null;
let api: UniverAPI | null = null;
let currentWorkbook: FWorkbook | null = null;
/** 命令执行回调（全局事件统一驱动；文档换绑无需重挂）。
 *  fromCalc=true 表示这帧是"载入后计算值回填"——派生数据，不算用户编辑 */
let changeHandler: ((snapshot: string, meta: { fromCalc: boolean }) => void) | null = null;
/** 最近一次序列化内容：选区变更等不产生内容差异的命令不触发落盘 */
let lastSent: string | null = null;
/** 载入后延迟回填计算值的定时器（换档重排） */
let calcEmitTimer: ReturnType<typeof setTimeout> | null = null;
/** 文件里的原始快照 id：引擎会话用一次性 id（避免同名 unit 重复注册权限点的告警刷屏），
 *  序列化写盘时换回原 id，文件对外保持稳定 */
let originalIdRef: string | null = null;

export function bootUniver(container: HTMLElement): UniverAPI {
  if (api) return api;
  const { univer: u, univerAPI } = createUniver({
    locale: LocaleType.ZH_CN,
    locales: { [LocaleType.ZH_CN]: mergeLocales(UniverPresetSheetsCoreZhCN) },
    theme: defaultTheme,
    presets: [
      UniverSheetsCorePreset({
        container,
        // 面板是低焦点环境（iframe），别在启动时抢宿主焦点
        disableAutoFocus: true,
      }),
    ],
  });
  univerAPI.addEvent(univerAPI.Event.CommandExecuted, () => {
    if (!changeHandler) return;
    const snapshot = enrichedSnapshot();
    if (snapshot === null || snapshot === lastSent) return;
    lastSent = snapshot;
    changeHandler(snapshot, { fromCalc: false });
  });
  univer = u;
  api = univerAPI;
  return univerAPI;
}

/** 整体销毁引擎（视图卸载时调用）：容器已随 React 卸载分离，重挂必须重新引导 */
export function disposeEngine(): void {
  if (currentWorkbook) {
    try {
      api?.disposeUnit(currentWorkbook.getId());
    } catch {
      // 引擎可能已处于 disposed 态
    }
  }
  try {
    univer?.dispose();
  } catch {
    // 同上
  }
  if (calcEmitTimer) {
    clearTimeout(calcEmitTimer);
    calcEmitTimer = null;
  }
  univer = null;
  api = null;
  currentWorkbook = null;
  lastSent = null;
  originalIdRef = null;
  changeHandler = null;
}

export type LoadResult = { ok: true } | { ok: false; errorText: string };

/** 载入快照（替换当前 unit）；agent 半途写坏的 JSON 在这里被拦成错误而不是白屏 */
export function loadWorkbook(univerAPI: UniverAPI, json: string): LoadResult {
  let parsed: { id?: unknown } | null = null;
  try {
    // 载入前卫生化：agent 写的 freeze 负值会让网格静默空白（见 sanitize.ts）
    parsed = dropEmptyResources(sanitizeSheetSnapshot(JSON.parse(json)));
  } catch {
    return { ok: false, errorText: "文档不是合法 JSON（可能被 agent 写到一半）" };
  }
  // 引擎会话改用一次性 id：disposeUnit 后同名 unit 重复注册会刷权限点告警，
  // 且避免权限状态跨载入残留；文件 id 在序列化时还原（originalIdRef）
  originalIdRef = parsed && typeof parsed.id === "string" ? parsed.id : null;
  const snapshot = {
    ...parsed,
    id: `u-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
  };
  if (currentWorkbook) {
    try {
      univerAPI.disposeUnit(currentWorkbook.getId());
    } catch {
      // 已 dispose 的 unit 再 dispose 会抛，忽略即可
    }
    currentWorkbook = null;
  }
  try {
    const wb = univerAPI.createWorkbook(snapshot as Parameters<UniverAPI["createWorkbook"]>[0]);
    currentWorkbook = wb;
    lastSent = null;
    scheduleCalcEmit();
    return { ok: true };
  } catch (err) {
    return { ok: false, errorText: `快照载入失败：${err instanceof Error ? err.message : String(err)}` };
  }
}

/** 当前快照（pretty-print）；无载入的文档返回 null。写盘 id 还原为文件原 id */
export function currentSnapshot(): string | null {
  if (!currentWorkbook) return null;
  const snap = currentWorkbook.save() as { id?: string };
  if (originalIdRef) snap.id = originalIdRef;
  return JSON.stringify(snap, null, 2);
}

type EnrichableSnapshot = {
  sheets: Record<
    string,
    { cellData?: Record<string, Record<string, { v?: unknown; f?: string } | undefined> | undefined> }
  >;
};

/**
 * 当前快照 + 公式计算值回填：把引擎已算出的公式结果写进对应 cell 的 v
 * （同 xlsx 缓存值语义）——agent read 文件即得计算结果，数据迭代闭环。
 * 只回填快照里有 f 的格；批量取值（整片 getRange.getValues 一次），行列封顶防大表卡顿。
 */
function enrichedSnapshot(): string | null {
  if (!currentWorkbook) return null;
  const snap = currentWorkbook.save() as unknown as EnrichableSnapshot & { id?: string };
  if (originalIdRef) snap.id = originalIdRef;
  try {
    for (const ws of currentWorkbook.getSheets()) {
      const cellData = snap.sheets?.[ws.getSheetId()]?.cellData;
      if (!cellData) continue;
      let maxR = -1;
      let maxC = -1;
      let formulaCount = 0;
      for (const [r, cols] of Object.entries(cellData)) {
        const ri = Number(r);
        for (const [c, cell] of Object.entries(cols ?? {})) {
          if (cell?.f) {
            const ci = Number(c);
            if (ri > maxR) maxR = ri;
            if (ci > maxC) maxC = ci;
            formulaCount++;
          }
        }
      }
      if (formulaCount === 0 || maxR < 0) continue;
      const rows = Math.min(maxR + 1, 400);
      const cols = Math.min(maxC + 1, 60);
      const grid = ws.getRange(0, 0, rows, cols).getValues() as unknown[][];
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const cell = cellData[String(r)]?.[String(c)];
          if (!cell?.f) continue;
          const val = grid[r]?.[c];
          if (val != null && typeof val !== "object") cell.v = val;
        }
      }
    }
  } catch {
    // 取值失败（引擎未就绪等）：退回原始快照
  }
  return JSON.stringify(snap, null, 2);
}

/** 载入后等计算引擎跑完，再发一次"计算值回填"保存——用户没动过也算数，
 *  agent read 文件就能拿到公式结果。派生数据不标 dirty（见 SheetView）。 */
function scheduleCalcEmit(): void {
  if (calcEmitTimer) clearTimeout(calcEmitTimer);
  calcEmitTimer = setTimeout(() => {
    calcEmitTimer = null;
    if (!changeHandler) return;
    const snapshot = enrichedSnapshot();
    if (snapshot === null || snapshot === lastSent) return;
    lastSent = snapshot;
    changeHandler(snapshot, { fromCalc: true });
  }, 1800);
}

/** 挂内容变更回调（引擎命令驱动；序列化去重后仍变化才回调，参数即最新快照） */
export function onEngineChange(cb: (snapshot: string, meta: { fromCalc: boolean }) => void): void {
  changeHandler = cb;
}

/** 主题跟随宿主（亮/暗）；OSS 主题对暗色的支持随版本演进，失败静默 */
export function syncTheme(dark: boolean): void {
  if (!api) return;
  try {
    if (api.isDarkMode() !== dark) api.toggleDarkMode(dark);
  } catch {
    // 主题切换失败不影响编辑
  }
}
