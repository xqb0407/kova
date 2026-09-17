/**
 * read 工具结果的正文还原：sidecar 返回 "N\t内容" 逐行 + 末尾可能的
 * 截断提示行（"…[N more lines"）。消息行展开区与面板「文件」标签共用，
 * 剥掉后交给 CodeMirror 自己的行号栏。
 */
export function stripReadLineNumbers(raw: string): string {
  const lines = raw.split("\n");
  return lines
    .filter((l) => !/^…\[\d+ more lines/.test(l))
    .map((l) => l.replace(/^\d+\t/, ""))
    .join("\n");
}
