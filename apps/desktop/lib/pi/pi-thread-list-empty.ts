/**
 * 侧栏空态判定：会话命中数为 0 不一定真的要显示空态——showWhenEmpty 的空项目
 * 也会产生分组。早期只看 filteredIndices，导致新用户建完第一个空工作区后项目
 * 卡不出现、侧栏却显示「暂无对话」。
 */
export function threadListEmptyState(args: {
  query: string;
  filteredCount: number;
  projectGroupCount: number;
}): "search" | "empty" | null {
  if (args.projectGroupCount > 0 || args.filteredCount > 0) return null;
  return args.query ? "search" : "empty";
}
