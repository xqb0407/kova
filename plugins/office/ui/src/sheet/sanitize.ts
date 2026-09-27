/**
 * 表格快照载入前卫生化（纯函数）：冻结参数是重灾区——agent 会把没有列冻结的
 * startColumn 写成 -1，而 Univer 的 IFreeze 契约要求 startRow/startColumn 非负
 * （无冻结侧为 0）；负值让冻结区计算崩掉、网格静默渲染成空白。
 * 这里把 freeze 钳回合法域：split 非负、对应侧无冻结时 start 归零。
 */

export type SanitizableSheet = {
  id?: string;
  freeze?: { xSplit?: number; ySplit?: number; startRow?: number; startColumn?: number } | null;
  [key: string]: unknown;
};

export type SanitizableSnapshot = { sheets?: Record<string, SanitizableSheet> | null; [key: string]: unknown };

const nonNeg = (v: unknown): number => {
  const n = Math.round(Number(v ?? 0));
  return Number.isFinite(n) && n > 0 ? n : 0;
};

export function sanitizeSheetSnapshot<T extends SanitizableSnapshot>(snapshot: T): T {
  // 0) sheet id 一致性：Univer 以 sheet.id 建工作表索引，id 缺失/重复/与键不符
  //    会让渲染管线错乱（网格静默空白）。统一以 sheets 对象的键为准。
  const sheets = snapshot.sheets;
  if (sheets && typeof sheets === "object") {
    for (const [key, sheet] of Object.entries(sheets)) {
      if (!sheet || typeof sheet !== "object") continue;
      if (sheet.id !== key) sheet.id = key;
    }
  }
  for (const sheet of Object.values(snapshot.sheets ?? {})) {
    const freeze = sheet?.freeze;
    if (!freeze || typeof freeze !== "object") continue;
    const xSplit = nonNeg(freeze.xSplit);
    const ySplit = nonNeg(freeze.ySplit);
    freeze.xSplit = xSplit;
    freeze.ySplit = ySplit;
    freeze.startRow = ySplit > 0 ? nonNeg(freeze.startRow) : 0;
    freeze.startColumn = xSplit > 0 ? nonNeg(freeze.startColumn) : 0;
  }
  return snapshot;
}

/** 空壳资源判定：Univer save() 会把权限/命名等插件资源快照进来，空壳纯噪音 */
function isEmptyResource(r: unknown): boolean {
  if (!r || typeof r !== "object") return true;
  const data = (r as { data?: unknown }).data;
  return data == null || data === "" || data === "{}";
}

/**
 * 保护/鉴权类资源必须剥离：沙箱 iframe 里 IndexedDB 不可用 →
 * SHEET_AuthzIoMockService 鉴权失败 → 权限层默认拒绝编辑（用户输入无反应），
 * 且 SHEET_*_PROTECTION* 的权限点重复注册刷屏。它们只对 Pro 协作有意义。
 */
const STRIP_RESOURCE_RE = /PROTECTION|AuthzIo/i;

/** 剥离空壳与保护/鉴权 resources；有真实数据的其他资源原样保留 */
export function dropEmptyResources<T extends { resources?: unknown }>(snapshot: T): T {
  const res = snapshot.resources;
  if (Array.isArray(res)) {
    const kept = res.filter((r) => !isEmptyResource(r) && !STRIP_RESOURCE_RE.test(String((r as { name?: unknown }).name ?? "")));
    if (kept.length !== res.length) snapshot.resources = kept;
    if (kept.length === 0) delete snapshot.resources;
  }
  return snapshot;
}
