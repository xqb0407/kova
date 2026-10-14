/**
 * 自定义端点"请求头"的表单 ⇄ 协议转换。
 *
 * 表单是键值行数组（允许留空行、允许同名），协议与存储要求对象；规范化只在
 * 这里做一处，保证 保存 / 测试连接 / 拉模型列表 三条路径同口径。
 */
export type HeaderRow = { name: string; value: string };

/** 表单行 → 请求头对象：跳过空名行；名与值 trim；同名以最后一行为准 */
export function headerRowsToRecord(rows: HeaderRow[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const row of rows) {
    const name = row.name.trim();
    if (!name) continue;
    out[name] = row.value.trim();
  }
  return out;
}

/** 已存请求头 → 表单行（编辑弹窗回填用；空/缺席 → 空数组） */
export function headerRecordToRows(
  record?: Record<string, string> | null,
): HeaderRow[] {
  return Object.entries(record ?? {}).map(([name, value]) => ({ name, value }));
}
