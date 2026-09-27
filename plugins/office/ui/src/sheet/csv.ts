/**
 * 工作簿快照 → CSV（纯函数）。v1 只导出原始值（cellData.v）：公式结果要等
 * Univer 计算引擎算完才在快照里，导出时点拿不到——公式格导空并在通知里说明。
 * 首列补 BOM，Excel 打开才不乱码。
 */

/** IObjectMatrixPrimitiveType：{"行号": {"列号": 单元格}} 的稀疏字典 */
export type CellMatrix = Record<string, Record<string, { v?: unknown; f?: string | null } | undefined>>;

export type CsvWorkbook = {
  sheetOrder: string[];
  sheets: Record<string, { name?: string; cellData?: CellMatrix }>;
};

/** 二维值矩阵（含空行空列补位，右/下截断到有内容的边界） */
export function matrixOf(cellData: CellMatrix | undefined): string[][] {
  if (!cellData) return [];
  const rows = Object.keys(cellData)
    .map(Number)
    .filter((n) => Number.isInteger(n) && n >= 0);
  if (rows.length === 0) return [];
  let maxRow = Math.max(...rows);
  let maxCol = -1;
  for (const r of rows) {
    const cols = Object.keys(cellData[r] ?? {})
      .map(Number)
      .filter((n) => Number.isInteger(n) && n >= 0);
    if (cols.length > 0) maxCol = Math.max(maxCol, Math.max(...cols));
  }
  const grid: string[][] = [];
  for (let r = 0; r <= maxRow; r++) {
    const row: string[] = [];
    for (let c = 0; c <= maxCol; c++) {
      row.push(cellText(cellData[String(r)]?.[String(c)]));
    }
    grid.push(row);
  }
  return grid;
}

/** 单元格 → CSV 文本：优先值；只有公式的格导空（导出时点拿不到计算结果） */
function cellText(cell: { v?: unknown; f?: string | null } | undefined): string {
  const v = cell?.v;
  if (v === null || v === undefined) return "";
  if (typeof v === "object") return ""; // 富文本（IDocumentData）等复杂值 v1 不展开
  return String(v);
}

function csvField(text: string): string {
  if (/[",\n\r]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

export function workbookToCsv(workbook: CsvWorkbook, sheetId?: string): string {
  const id = sheetId ?? workbook.sheetOrder[0] ?? Object.keys(workbook.sheets ?? {})[0] ?? "";
  const sheet = workbook.sheets?.[id];
  const grid = matrixOf(sheet?.cellData);
  const body = grid.map((row) => row.map(csvField).join(",")).join("\r\n");
  // BOM：让 Excel 按 UTF-8 识别中文
  return "\uFEFF" + body;
}

/** 由导出文件名约定：文档名 + .csv */
export function csvFilename(docName: string): string {
  return `${docName}.csv`;
}
