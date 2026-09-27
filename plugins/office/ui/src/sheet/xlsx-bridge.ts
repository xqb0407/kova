/**
 * xlsx/csv ⇄ Univer 工作簿快照 转换桥（纯函数域模块，跑在面板 iframe 里；
 * exceljs 只进本插件包，sidecar/宿主零依赖零感知）。
 *
 * 映射为有损子集的"无损往返"：值 / 公式（含缓存结果 v）/ 合并 / 列宽行高 /
 * 数字格式 / 字体（粗斜下删、字号、字色、字族）/ 填充 / 对齐 / 换行 / 边框。
 * 日期单元按 Excel 序列数字 + 日期数字格式保真（Univer numfmt 引擎识别）。
 * 图表、数据验证、条件格式等 v1 不转换，记入 warnings 告知 agent/用户。
 */
import ExcelJS from "exceljs";

/* ---------------- 快照类型（Univer IWorkbookData 的转换子集） ---------------- */

export type ConvCell = { v?: unknown; s?: string | Record<string, unknown>; f?: string };
export type ConvCellMatrix = Record<string, Record<string, ConvCell | undefined> | undefined>;
export type ConvSheet = {
  id: string;
  name: string;
  rowCount: number;
  columnCount: number;
  cellData: ConvCellMatrix;
  rowData?: Record<string, { h?: number }>;
  columnData?: Record<string, { w?: number }>;
  mergeData?: { startRow: number; endRow: number; startColumn: number; endColumn: number }[];
};
export type ConvSnapshot = {
  id: string;
  name: string;
  sheetOrder: string[];
  styles: Record<string, Record<string, unknown>>;
  sheets: Record<string, ConvSheet>;
};

export type ConvResult = { snapshot: ConvSnapshot; warnings: string[] };

/** 导入上限：约束快照体积（单文件面板加载），超限截断并记 warning */
const MAX_ROWS = 2000;
const MAX_COLS = 100;
const MAX_SHEETS = 20;

/* ---------------- 颜色 / 枚举映射 ---------------- */

/** exceljs ARGB "FF1D1D1F" → Univer "#1D1D1F"；非法输入返回 undefined */
function argbToHex(argb: unknown): string | undefined {
  if (typeof argb !== "string") return undefined;
  const m = /^([0-9a-fA-F]{2})?([0-9a-fA-F]{6})$/.exec(argb);
  if (!m) return undefined;
  return `#${(m[2] ?? argb).toUpperCase()}`;
}

function hexToArgb(hex: string): string {
  return `FF${hex.replace("#", "").toUpperCase()}`;
}

const H_ALIGN: Record<string, number> = { left: 1, center: 2, right: 3 };
const V_ALIGN: Record<string, number> = { top: 1, middle: 2, bottom: 3 };
const H_ALIGN_INV: Record<number, string> = { 1: "left", 2: "center", 3: "right" };
const V_ALIGN_INV: Record<number, string> = { 1: "top", 2: "middle", 3: "bottom" };

/** exceljs 边框样式 → Univer BorderStyleTypes（数值一一对应） */
const BORDER_STYLE: Record<string, number> = {
  thin: 1,
  hair: 2,
  dotted: 3,
  dashed: 4,
  dashDot: 5,
  dashDotDot: 6,
  double: 7,
  medium: 8,
  mediumDashed: 9,
  mediumDashDot: 10,
  mediumDashDotDot: 11,
  slantDashDot: 12,
  thick: 13,
};
const BORDER_STYLE_INV: Record<number, string> = Object.fromEntries(
  Object.entries(BORDER_STYLE).map(([k, v]) => [v, k]),
);

/* ---------------- 导入：xlsx → snapshot ---------------- */

type StyleBag = Record<string, unknown>;

/** exceljs 单元格样式 → Univer IStyleData 子集；无有效样式返回 undefined */
function readCellStyle(cell: ExcelJS.Cell): StyleBag | undefined {
  const st = cell.style;
  if (!st) return undefined;
  const out: StyleBag = {};
  const font = st.font;
  if (font) {
    if (font.bold) out.bl = 1;
    if (font.italic) out.it = 1;
    if (font.underline) out.ul = 1;
    if (font.strike) out.st = 1;
    if (typeof font.size === "number") out.fs = font.size;
    if (font.name) out.ff = font.name;
    const rgb = argbToHex(font.color?.argb);
    if (rgb) out.cl = { rgb };
  }
  const fill = st.fill as { type?: string; fgColor?: { argb?: string } } | undefined;
  if (fill && fill.type === "pattern") {
    const rgb = argbToHex(fill.fgColor?.argb);
    if (rgb) out.bg = { rgb };
  }
  const align = st.alignment;
  if (align) {
    if (align.horizontal && H_ALIGN[align.horizontal] != null) out.ht = H_ALIGN[align.horizontal];
    if (align.vertical && V_ALIGN[align.vertical] != null) out.vt = V_ALIGN[align.vertical];
    if (align.wrapText) out.tb = 2;
  }
  if (st.numFmt && st.numFmt !== "General") out.n = { pattern: st.numFmt };
  const border = st.border as
    | {
        top?: { style?: string; color?: { argb?: string } };
        bottom?: { style?: string; color?: { argb?: string } };
        left?: { style?: string; color?: { argb?: string } };
        right?: { style?: string; color?: { argb?: string } };
      }
    | undefined;
  if (border) {
    const side = (s?: { style?: string; color?: { argb?: string } }) => {
      if (!s?.style || s.style === "none") return undefined;
      const v = BORDER_STYLE[s.style] ?? 1;
      const rgb = argbToHex(s.color?.argb) ?? "#D4D4D8";
      return { s: v, cl: { rgb } };
    };
    const bd: Record<string, unknown> = {};
    const pairs: [string, ReturnType<typeof side>][] = [
      ["t", side(border.top)],
      ["b", side(border.bottom)],
      ["l", side(border.left)],
      ["r", side(border.right)],
    ];
    for (const [k, v] of pairs) {
      if (v) bd[k] = v;
    }
    if (Object.keys(bd).length > 0) out.bd = bd;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** exceljs 单元格值 → { v?, f? }；日期转 Excel 序列数字（配合 numFmt 保真） */
function readCellValue(cell: ExcelJS.Cell, warnings: string[]): { v?: unknown; f?: string } {
  const value = cell.value;
  if (value == null) return {};
  if (value instanceof Date) {
    const serial =
      Date.UTC(value.getFullYear(), value.getMonth(), value.getDate(), value.getHours(), value.getMinutes(), value.getSeconds()) / 86400000 + 25569;
    if (Number.isFinite(serial)) return { v: serial };
    return { v: value.toISOString() };
  }
  switch (typeof value) {
    case "number":
    case "boolean":
    case "string":
      return { v: value };
    case "object": {
      const obj = value as unknown as Record<string, unknown>;
      if (typeof obj.formula === "string") {
        // 主公式格：公式 + 缓存结果（同 xlsx 语义，agent 读档即得计算值）
        return { f: `=${obj.formula}`, ...(obj.result != null ? { v: obj.result } : {}) };
      }
      if (obj.sharedFormula != null) {
        // 共享公式的从格：拿缓存值，公式本体丢了（exceljs 不展开）——由调用方汇总告警
        warnings.push("shared-formula");
        return obj.result != null ? { v: obj.result } : {};
      }
      if (Array.isArray(obj.richText)) {
        return { v: (obj.richText as { text?: string }[]).map((t) => t.text ?? "").join("") };
      }
      if (obj.error != null) return { v: `#${String(obj.error).toUpperCase().slice(0, 8)}` };
      if (typeof obj.text === "string") return { v: obj.text }; // hyperlink
      return { v: String(value) };
    }
    default:
      return {};
  }
}

/** xlsx 字节 → 快照。始终返回可用快照（空簿给一页空表），warnings 汇总有损项 */
export async function importXlsxToSnapshot(buf: ArrayBuffer, name: string): Promise<ConvResult> {
  const warnings: string[] = [];
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);

  const snapshot: ConvSnapshot = {
    id: `wb-${Date.now().toString(36)}`,
    name,
    sheetOrder: [],
    styles: {},
    sheets: {},
  };
  const styleIds = new Map<string, string>();

  const sheets = wb.worksheets.slice(0, MAX_SHEETS);
  if (wb.worksheets.length > MAX_SHEETS) warnings.push(`工作表超过 ${MAX_SHEETS} 个，已截断`);

  sheets.forEach((ws, idx) => {
    const sheetId = `sheet-${idx + 1}`;
    snapshot.sheetOrder.push(sheetId);
    const cellData: ConvCellMatrix = {};
    const rowCount = Math.min(ws.rowCount ?? 0, MAX_ROWS);
    const columnCount = Math.min(ws.columnCount ?? 0, MAX_COLS);
    if ((ws.rowCount ?? 0) > MAX_ROWS) warnings.push(`「${ws.name}」超过 ${MAX_ROWS} 行已截断`);
    if ((ws.columnCount ?? 0) > MAX_COLS) warnings.push(`「${ws.name}」超过 ${MAX_COLS} 列已截断`);

    for (let r = 1; r <= rowCount; r++) {
      for (let c = 1; c <= columnCount; c++) {
        const cell = ws.getRow(r).getCell(c);
        const conv = readCellValue(cell, warnings);
        const style = readCellStyle(cell);
        if (conv.v === undefined && !conv.f && !style) continue;
        const rowKey = String(r - 1);
        const colKey = String(c - 1);
        const entry: ConvCell = { ...conv };
        if (style) {
          const key = JSON.stringify(style);
          let sid = styleIds.get(key);
          if (!sid) {
            sid = `s${styleIds.size + 1}`;
            styleIds.set(key, sid);
            snapshot.styles[sid] = style;
          }
          entry.s = sid;
        }
        (cellData[rowKey] ??= {})[colKey] = entry;
      }
    }

    const sheet: ConvSheet = {
      id: sheetId,
      name: ws.name || `Sheet${idx + 1}`,
      rowCount: Math.max(rowCount, 20),
      columnCount: Math.max(columnCount, 8),
      cellData,
    };

    // 列宽（exceljs 字符宽 ≈ Univer 像素：w*7+5）、行高（pt → px*4/3）
    const columnData: Record<string, { w?: number }> = {};
    for (let c = 1; c <= columnCount; c++) {
      const width = ws.getColumn(c).width;
      if (width && width > 0) columnData[String(c - 1)] = { w: Math.round(width * 7 + 5) };
    }
    if (Object.keys(columnData).length > 0) sheet.columnData = columnData;
    const rowData: Record<string, { h?: number }> = {};
    for (let r = 1; r <= rowCount; r++) {
      const height = ws.getRow(r).height;
      if (height && height > 0) rowData[String(r - 1)] = { h: Math.round((height * 4) / 3) };
    }
    if (Object.keys(rowData).length > 0) sheet.rowData = rowData;

    // 合并：exceljs model.merges 为 "B2:C3" 字符串数组
    const merges = (ws.model as { merges?: string[] } | undefined)?.merges ?? [];
    const mergeData = merges.slice(0, 500).map(decodeRange).filter((m): m is NonNullable<typeof m> => m !== null);
    if (mergeData.length > 0) sheet.mergeData = mergeData;

    snapshot.sheets[sheetId] = sheet;
  });

  if (snapshot.sheetOrder.length === 0) {
    snapshot.sheetOrder.push("sheet-1");
    snapshot.sheets["sheet-1"] = { id: "sheet-1", name: "Sheet1", rowCount: 20, columnCount: 8, cellData: {} };
  }
  return { snapshot, warnings };
}

/** "B2:C3"（1-based A1 记法）→ 0-based 闭区间；解析失败返回 null */
function decodeRange(a1: string): { startRow: number; endRow: number; startColumn: number; endColumn: number } | null {
  const m = /^\$?([A-Z]+)\$?(\d+):\$?([A-Z]+)\$?(\d+)$/i.exec(a1.trim());
  if (!m) return null;
  const colToIdx = (s: string): number => {
    let n = 0;
    for (const ch of s.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
    return n - 1;
  };
  const startColumn = colToIdx(m[1]!);
  const endColumn = colToIdx(m[3]!);
  const startRow = Number(m[2]) - 1;
  const endRow = Number(m[4]) - 1;
  if ([startColumn, endColumn, startRow, endRow].some((n) => !Number.isFinite(n) || n < 0)) return null;
  return { startRow, endRow: Math.max(endRow, startRow), startColumn, endColumn: Math.max(endColumn, startColumn) };
}

/* ---------------- 导出：snapshot → xlsx ---------------- */

/** 快照 → xlsx 字节。样式/合并/列宽行高/数字格式/公式（附缓存值）反向映射 */
export async function exportSnapshotToXlsx(snapshot: ConvSnapshot): Promise<Uint8Array> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Xulux Office";
  const styles = snapshot.styles ?? {};
  const usedNames = new Set<string>();

  const sheetIds = snapshot.sheetOrder?.length ? snapshot.sheetOrder : Object.keys(snapshot.sheets ?? {});
  for (const sheetId of sheetIds) {
    const sheet = snapshot.sheets?.[sheetId];
    if (!sheet) continue;
    let wsName = (sheet.name || sheetId).replace(/[[\]:*?/\\]/g, "-").slice(0, 31) || "Sheet";
    while (usedNames.has(wsName)) wsName = wsName.slice(0, 28) + `_${usedNames.size}`;
    usedNames.add(wsName);
    const ws = wb.addWorksheet(wsName);

    // 列宽 / 行高（与导入互逆）
    for (const [key, col] of Object.entries(sheet.columnData ?? {})) {
      if (typeof col?.w === "number" && col.w > 0) ws.getColumn(Number(key) + 1).width = Math.max(1, (col.w - 5) / 7);
    }
    for (const [key, row] of Object.entries(sheet.rowData ?? {})) {
      if (typeof row?.h === "number" && row.h > 0) ws.getRow(Number(key) + 1).height = (row.h * 3) / 4;
    }

    // 单元格：公式（附缓存值）/ 原始值 / 样式
    const rows = Object.keys(sheet.cellData ?? {})
      .map(Number)
      .filter((n) => Number.isInteger(n) && n >= 0);
    for (const r of rows) {
      const cols = Object.keys(sheet.cellData[String(r)] ?? {})
        .map(Number)
        .filter((n) => Number.isInteger(n) && n >= 0);
      for (const c of cols) {
        const cell = sheet.cellData[String(r)]?.[String(c)];
        if (!cell) continue;
        const target = ws.getRow(r + 1).getCell(c + 1);
        const style = resolveStyle(styles, cell.s);
        if (typeof cell.f === "string" && cell.f.startsWith("=")) {
          target.value = {
            formula: cell.f.slice(1),
            ...(cell.v != null ? { result: cell.v as ExcelJS.CellValue } : {}),
          } as ExcelJS.CellValue;
        } else if (cell.v != null && typeof cell.v !== "object") {
          target.value = cell.v as ExcelJS.CellValue;
        }
        if (style && Object.keys(style).length > 0) target.style = toExcelStyle(style) as Partial<ExcelJS.Style>;
      }
    }

    // 合并
    for (const m of sheet.mergeData ?? []) {
      try {
        ws.mergeCells(m.startRow + 1, m.startColumn + 1, m.endRow + 1, m.endColumn + 1);
      } catch {
        // 非法/重叠区间：exceljs 会抛，跳过该合并
      }
    }
  }

  const out = await wb.xlsx.writeBuffer();
  return new Uint8Array(out as ArrayBuffer);
}

function resolveStyle(
  styles: Record<string, Record<string, unknown>>,
  s: ConvCell["s"],
): Record<string, unknown> | undefined {
  if (!s) return undefined;
  if (typeof s === "string") return styles[s];
  return s;
}

/** Univer IStyleData 子集 → exceljs style */
function toExcelStyle(s: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const font: Record<string, unknown> = {};
  if (s.bl === 1) font.bold = true;
  if (s.it === 1) font.italic = true;
  if (s.ul) font.underline = true;
  if (s.st) font.strike = true;
  if (typeof s.fs === "number") font.size = s.fs;
  if (typeof s.ff === "string") font.name = s.ff;
  const cl = s.cl as { rgb?: string } | undefined;
  if (cl?.rgb) font.color = { argb: hexToArgb(cl.rgb) };
  if (Object.keys(font).length > 0) out.font = font;
  const bg = s.bg as { rgb?: string } | undefined;
  if (bg?.rgb) out.fill = { type: "pattern", pattern: "solid", fgColor: { argb: hexToArgb(bg.rgb) } };
  const align: Record<string, unknown> = {};
  if (typeof s.ht === "number" && H_ALIGN_INV[s.ht]) align.horizontal = H_ALIGN_INV[s.ht];
  if (typeof s.vt === "number" && V_ALIGN_INV[s.vt]) align.vertical = V_ALIGN_INV[s.vt];
  if (s.tb === 2) align.wrapText = true;
  if (Object.keys(align).length > 0) out.alignment = align;
  const n = s.n as { pattern?: string } | undefined;
  if (n?.pattern) out.numFmt = n.pattern;
  const bd = s.bd as Record<string, { s?: number; cl?: { rgb?: string } } | undefined> | undefined;
  if (bd && typeof bd === "object") {
    const border: Record<string, unknown> = {};
    for (const [key, side] of Object.entries(bd)) {
      if (!side || typeof side.s !== "number") continue;
      const style = BORDER_STYLE_INV[side.s] ?? "thin";
      const rgb = side.cl?.rgb ? { argb: hexToArgb(side.cl.rgb) } : undefined;
      border[key === "t" ? "top" : key === "b" ? "bottom" : key === "l" ? "left" : "right"] = {
        style,
        ...(rgb ? { color: rgb } : {}),
      };
    }
    if (Object.keys(border).length > 0) out.border = border;
  }
  return out;
}

/* ---------------- CSV 导入（RFC4180 子集 + 数值启发式） ---------------- */

/** RFC4180 解析：引号转义、引号内逗号/换行；\r\n|\n|\r 均为行界 */
export function parseCsv(text: string): string[][] {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      rows.push(row);
      row = [];
    } else {
      field += ch;
    }
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** 数值启发式：纯数字转 number（保留前导零的编号串不转，如 "007"） */
function maybeNumber(text: string): string | number {
  if (!/^[+-]?\d+(\.\d+)?$/.test(text)) return text;
  if (/^[+-]?0\d/.test(text)) return text; // 前导零：编号而非数字
  const n = Number(text);
  return Number.isFinite(n) ? n : text;
}

/** CSV 文本 → 单 sheet 快照 */
export function importCsvToSnapshot(text: string, name: string): ConvResult {
  const rows = parseCsv(text).slice(0, MAX_ROWS);
  const warnings: string[] = [];
  const width = rows.reduce((w, r) => Math.max(w, r.length), 0);
  if (width > MAX_COLS) warnings.push(`CSV 超过 ${MAX_COLS} 列已截断`);
  const cellData: ConvCellMatrix = {};
  rows.forEach((row, r) => {
    row.slice(0, MAX_COLS).forEach((field, c) => {
      if (field === "") return;
      (cellData[String(r)] ??= {})[String(c)] = { v: maybeNumber(field) };
    });
  });
  return {
    snapshot: {
      id: `wb-${Date.now().toString(36)}`,
      name,
      sheetOrder: ["sheet-1"],
      styles: {},
      sheets: {
        "sheet-1": {
          id: "sheet-1",
          name: "Sheet1",
          rowCount: Math.max(rows.length, 20),
          columnCount: Math.max(width, 8),
          cellData,
        },
      },
    },
    warnings,
  };
}
