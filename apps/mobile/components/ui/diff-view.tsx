import { useMemo } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { monoStyle } from "@/components/assistant-ui/elements/surfaces";
import { diffLines, type DiffLine } from "@/lib/panels/panel-activity";
import { useTheme, withAlpha } from "./theme";

/**
 * 行级 diff（移动端版，观感对齐桌面端「审查」标签的 diff 块）：
 * - 左右两栏行号（旧 / 新），改动行整行着色 + 前缀符号
 * - 连续未改动行按 git 惯例收敛成「⋯ N 行未改动」，改动段各留 3 行上下文
 * - 长行横向滚动（外层 ScrollView），行号与正文同滚，不换行错位
 *
 * 与 git 面板共用一份实现（磁盘 diff 与工具流水 diff 同一套渲染）。
 */

type NumberedLine = DiffLine & { oldNo?: number; newNo?: number };

export type DiffHunk =
  | { type: "lines"; rows: NumberedLine[] }
  | { type: "gap"; count: number };

/** 给 diff 行配上旧/新行号（ctx 双计，add 只计新，del 只计旧） */
export function numberDiffLines(lines: readonly DiffLine[]): NumberedLine[] {
  let oldNo = 1;
  let newNo = 1;
  return lines.map((line) => {
    if (line.kind === "ctx") {
      const row = { ...line, oldNo: oldNo++, newNo: newNo++ };
      return row;
    }
    if (line.kind === "del") return { ...line, oldNo: oldNo++ };
    return { ...line, newNo: newNo++ };
  });
}

/** 收敛未改动行：改动周围留 context 行，其余折成 gap 段 */
export function buildHunks(
  rows: readonly NumberedLine[],
  context = 3,
): DiffHunk[] {
  const changed: number[] = [];
  rows.forEach((row, i) => {
    if (row.kind !== "ctx") changed.push(i);
  });
  if (changed.length === 0) {
    return rows.length ? [{ type: "gap", count: rows.length }] : [];
  }
  const keep = new Set<number>();
  for (const i of changed) {
    for (let j = Math.max(0, i - context); j <= Math.min(rows.length - 1, i + context); j++) {
      keep.add(j);
    }
  }
  const out: DiffHunk[] = [];
  let i = 0;
  while (i < rows.length) {
    if (keep.has(i)) {
      const run: NumberedLine[] = [];
      while (i < rows.length && keep.has(i)) {
        run.push(rows[i]!);
        i += 1;
      }
      out.push({ type: "lines", rows: run });
      continue;
    }
    let count = 0;
    while (i < rows.length && !keep.has(i)) {
      count += 1;
      i += 1;
    }
    out.push({ type: "gap", count });
  }
  return out;
}

/** 双向 diff（edit 的 old→new）；write 用全增行（oldText=null） */
export function asDiffLines(
  oldText: string | null,
  newText: string,
): DiffLine[] {
  if (oldText === null) {
    // 全新增：保留末尾空行语义（与 fileChangeStats 的计数口径一致）
    if (!newText.length) return [];
    return newText.split("\n").map((text) => ({ kind: "add" as const, text }));
  }
  return diffLines(oldText, newText);
}

const GUTTER = 30;

/* ------------------------------ 统一 diff（git 文本） ------------------------------ */

export type UnifiedRow =
  | { kind: "hunk"; text: string }
  | { kind: "ctx" | "add" | "del"; text: string; oldNo?: number; newNo?: number };

/**
 * 解析 `git diff` 的统一格式：丢掉 `diff --git / index / --- / +++` 元信息
 * （文件名与索引号在 UI 里另有位置），hunk 头 `@@ -a,b +c,d @@` 决定行号基准，
 * 之后按前缀累计旧/新行号。
 */
export function parseUnifiedDiff(text: string): UnifiedRow[] {
  const rows: UnifiedRow[] = [];
  let oldNo = 0;
  let newNo = 0;
  let inHunk = false;
  for (const line of text.split("\n")) {
    if (
      line.startsWith("diff --git") ||
      line.startsWith("index ") ||
      line.startsWith("--- ") ||
      line.startsWith("+++ ") ||
      line.startsWith("new file mode") ||
      line.startsWith("deleted file mode") ||
      line.startsWith("similarity index") ||
      line.startsWith("rename ")
    ) {
      continue;
    }
    const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (header) {
      oldNo = Number.parseInt(header[1] ?? "0", 10);
      newNo = Number.parseInt(header[2] ?? "0", 10);
      rows.push({ kind: "hunk", text: line });
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    if (line.startsWith("+")) {
      rows.push({ kind: "add", text: line.slice(1), newNo: newNo++ });
    } else if (line.startsWith("-")) {
      rows.push({ kind: "del", text: line.slice(1), oldNo: oldNo++ });
    } else if (line.startsWith(" ")) {
      rows.push({ kind: "ctx", text: line.slice(1), oldNo: oldNo++, newNo: newNo++ });
    }
    // `\ No newline at end of file` 之类的注记不占行
  }
  return rows;
}

/** 统一 diff 视图（git 面板用）：hunk 头 + 行号栏，与两栏 diff 同一套行样式 */
export function UnifiedDiffView({
  text,
  maxLines = 400,
}: {
  text: string;
  maxLines?: number;
}) {
  const { colors } = useTheme();
  const rows = useMemo(() => parseUnifiedDiff(text), [text]);
  const capped = rows.length > maxLines;
  const shown = capped ? rows.slice(0, maxLines) : rows;

  if (rows.length === 0) {
    return (
      <Text style={[styles.empty, { color: colors.mutedForegroundFaint }]}>
        没有可显示的差异
      </Text>
    );
  }

  return (
    <View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
        <View style={styles.block}>
          {shown.map((row, i) =>
            row.kind === "hunk" ? (
              <View key={i} style={styles.hunkRow}>
                <Text style={[styles.hunkText, { color: colors.mutedForeground }]}>
                  {row.text}
                </Text>
              </View>
            ) : (
              <View
                key={i}
                style={[
                  styles.row,
                  row.kind === "add" && { backgroundColor: withAlpha(colors.success, 0.12) },
                  row.kind === "del" && { backgroundColor: withAlpha(colors.destructive, 0.12) },
                ]}
              >
                <Text style={[styles.no, { color: colors.mutedForegroundFaint }]}>
                  {row.oldNo ?? ""}
                </Text>
                <Text style={[styles.no, { color: colors.mutedForegroundFaint }]}>
                  {row.newNo ?? ""}
                </Text>
                <Text
                  style={[
                    styles.sign,
                    {
                      color:
                        row.kind === "add"
                          ? colors.success
                          : row.kind === "del"
                            ? colors.destructive
                            : colors.mutedForegroundFaint,
                    },
                  ]}
                >
                  {row.kind === "add" ? "+" : row.kind === "del" ? "−" : " "}
                </Text>
                <Text
                  style={[
                    styles.code,
                    {
                      color:
                        row.kind === "ctx" ? colors.mutedForeground : colors.foreground,
                    },
                  ]}
                >
                  {row.text.length ? row.text : " "}
                </Text>
              </View>
            ),
          )}
        </View>
      </ScrollView>
      {capped ? (
        <Text style={[styles.empty, { color: colors.mutedForegroundFaint }]}>
          {`仅显示前 ${maxLines} 行（共 ${rows.length} 行）`}
        </Text>
      ) : null}
    </View>
  );
}

export function DiffView({
  lines,
  maxLines = 240,
  context = 3,
}: {
  lines: readonly DiffLine[];
  maxLines?: number;
  context?: number;
}) {
  const { colors } = useTheme();
  const rows = useMemo(() => numberDiffLines(lines), [lines]);
  const capped = rows.length > maxLines;
  const shown = capped ? rows.slice(0, maxLines) : rows;
  const hunks = useMemo(() => buildHunks(shown, context), [shown, context]);

  if (rows.length === 0) {
    return (
      <Text style={[styles.empty, { color: colors.mutedForegroundFaint }]}>
        没有内容差异
      </Text>
    );
  }

  return (
    <View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
        <View style={styles.block}>
          {hunks.map((hunk, hi) =>
            hunk.type === "gap" ? (
              <View key={`gap-${hi}`} style={styles.gapRow}>
                <View style={[styles.gapLine, { backgroundColor: colors.border }]} />
                <Text style={[styles.gapText, { color: colors.mutedForegroundFaint }]}>
                  {`${hunk.count} 行未改动`}
                </Text>
                <View style={[styles.gapLine, { backgroundColor: colors.border }]} />
              </View>
            ) : (
              hunk.rows.map((row, ri) => (
                <View
                  key={`${hi}-${ri}`}
                  style={[
                    styles.row,
                    row.kind === "add" && { backgroundColor: withAlpha(colors.success, 0.12) },
                    row.kind === "del" && { backgroundColor: withAlpha(colors.destructive, 0.12) },
                  ]}
                >
                  <Text style={[styles.no, { color: colors.mutedForegroundFaint }]}>
                    {row.oldNo ?? ""}
                  </Text>
                  <Text style={[styles.no, { color: colors.mutedForegroundFaint }]}>
                    {row.newNo ?? ""}
                  </Text>
                  <Text
                    style={[
                      styles.sign,
                      {
                        color:
                          row.kind === "add"
                            ? colors.success
                            : row.kind === "del"
                              ? colors.destructive
                              : colors.mutedForegroundFaint,
                      },
                    ]}
                  >
                    {row.kind === "add" ? "+" : row.kind === "del" ? "−" : " "}
                  </Text>
                  <Text
                    style={[
                      styles.code,
                      {
                        color:
                          row.kind === "ctx" ? colors.mutedForeground : colors.foreground,
                      },
                    ]}
                  >
                    {row.text.length ? row.text : " "}
                  </Text>
                </View>
              ))
            ),
          )}
        </View>
      </ScrollView>
      {capped ? (
        <Text style={[styles.empty, { color: colors.mutedForegroundFaint }]}>
          {`仅显示前 ${maxLines} 行（共 ${rows.length} 行）`}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  block: { minWidth: "100%" },
  row: { flexDirection: "row", alignItems: "flex-start", paddingVertical: 1 },
  no: {
    width: GUTTER,
    textAlign: "right",
    paddingRight: 6,
    fontSize: 10.5,
    lineHeight: 16,
    ...monoStyle,
  },
  sign: { width: 12, fontSize: 11.5, lineHeight: 16, ...monoStyle },
  code: { fontSize: 11.5, lineHeight: 16, paddingRight: 10, ...monoStyle },
  gapRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingVertical: 2,
    minWidth: 220,
  },
  gapLine: { flex: 1, height: StyleSheet.hairlineWidth, opacity: 0.7 },
  gapText: { fontSize: 10.5 },
  hunkRow: { paddingVertical: 3, minWidth: 220 },
  hunkText: { fontSize: 11, lineHeight: 16, ...monoStyle },
  empty: { fontSize: 11.5, paddingVertical: 4 },
});
