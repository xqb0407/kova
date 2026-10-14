/**
 * 迁移自桌面端 apps/desktop/lib/panels/artifacts.ts（2026-10-03）：
 * 唯一的本地改动是 `ThreadMessage` 的导入换成 @assistant-ui/react-native；
 * 派生口径（write 白名单 / 大小 / 最新一次 write 为当前版本）与桌面端逐行同源。
 */
import type { ThreadMessage } from "@assistant-ui/react-native";
import {
  FAILED_RE,
  fileChangePair,
  resultText,
  type FileChangeEntry,
  type FileChangeGroup,
} from "@/lib/panels/panel-activity";

/**
 * 产物（artifact）派生层：把一条 assistant 消息里 agent 用 `write` 工具产出的
 * 「面向用户的交付文件」识别出来，归并成消息尾部的产物卡数据。
 *
 * 关键：不依赖模型主动调用任何专用工具——`write` 的 args 里本就带
 * `file_path` + 完整 `content`（见 panel-activity.fileChangePair），卡片的大小、
 * 预览、打开全部从消息快照派生，刷新/切线程后 transcript 重建的 tool part 同样可用。
 * 因此 sidecar / Rust / 协议层零改动。
 *
 * 判定口径 = 扩展名白名单：代码源文件（.ts/.tsx/.css…）不进卡，维持普通「写入」行，
 * 避免编码任务里每建一个文件都弹卡。
 */

/** 交付物扩展名白名单（小写、不含点）。二进制（pdf/png/…）无法经文本 write 工具产出，故不列。 */
const DELIVERABLE_EXT = new Set([
  "html",
  "htm",
  "xhtml",
  "svg",
  "md",
  "markdown",
  "mdx",
  "txt",
  "rtf",
  "csv",
  "tsv",
  "json",
  "jsonl",
  "xml",
  "yaml",
  "yml",
  "log",
  "ics",
  "vtt",
  "srt",
]);

/** 取小写扩展名（不含点）；无扩展名或以点开头的文件（.gitignore）返回空串 */
export function extOf(path: string): string {
  const norm = path.replace(/\\/g, "/");
  const base = norm.slice(norm.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return "";
  return base.slice(dot + 1).toLowerCase();
}

/** 是否交付物（按扩展名白名单） */
export function isDeliverable(path: string): boolean {
  return DELIVERABLE_EXT.has(extOf(path));
}

/** 适合「浏览器预览」的类型：网页类 + PDF（浏览器原生渲染）。md/csv/json 等用代码/文件查看即可，不进浏览器。 */
const BROWSER_PREVIEW_EXT = new Set(["html", "htm", "xhtml", "svg", "pdf"]);
export function isBrowserPreviewable(path: string): boolean {
  return BROWSER_PREVIEW_EXT.has(extOf(path));
}

/** UTF-8 字节数 */
export function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

/**
 * 工作区相对/绝对路径 → file:// URL（内置浏览器只吃 URL，本地文件靠它加载）。
 * 逐段 encodeURIComponent 兼容空格/中文；Windows 盘符走三斜杠 file:///C:/…。
 * 产物卡与「产物」标签页共用一份语义。
 */
export function toFileUrl(cwd: string, rel: string): string {
  let abs = rel.replace(/\\/g, "/");
  if (!/^[A-Za-z]:\//.test(abs) && !abs.startsWith("/")) {
    abs = `${cwd.replace(/[\\/]+$/, "").replace(/\\/g, "/")}/${abs.replace(/^\/+/, "")}`;
  }
  // Windows 盘符段（C:）不参与编码，否则编码成 C%3A 后三斜杠判定失效
  const segments = abs.split("/");
  const drive = /^[A-Za-z]:$/.test(segments[0]);
  const encoded = segments
    .map((seg, i) => (drive && i === 0 ? seg : encodeURIComponent(seg)))
    .join("/");
  return drive ? `file:///${encoded}` : `file://${encoded}`;
}

/** 字节数 → 人类可读（B 整数；KB/MB/GB 一位小数，1024 进制） */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "";
  if (n < 1024) return `${Math.round(n)} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(1)} ${units[i]}`;
}

export type MessageArtifact = {
  /** write part 的 toolCallId：预览据此在「文件」标签定位内容快照 */
  toolCallId: string;
  /** 模型给的路径（可能相对工作区或绝对） */
  path: string;
  /** 文件名（含扩展名） */
  base: string;
  /** 内容字节数（由 write args.content 现算） */
  size: number;
};

/**
 * 从一条消息的 parts 派生产物列表：
 * 扫已完成的 `write` 工具调用 → 交付物白名单过滤 → 按路径去重（后写覆盖）。
 * 运行中（无 result）或失败（isError）的 write 不收录。
 * 只在消息回合结束时调用一次（组件侧已 gate），避免流式逐 token 重算字节数。
 */
export function messageArtifacts(
  parts: ThreadMessage["content"],
): MessageArtifact[] {
  const byPath = new Map<string, MessageArtifact>();
  for (const part of parts) {
    if (part.type !== "tool-call" || part.toolName !== "write") continue;
    // 结果未回填 = 还在执行；失败 = 未落盘：都不算产物。isError 之外再比一次
    // 失败文本（拒绝 reason 等），防上游标记缺失时被拒写入混进产物卡
    if (part.result == null || part.isError === true) continue;
    if (FAILED_RE.test(resultText(part.result) ?? "")) continue;
    const pair = fileChangePair("write", part.args);
    if (!pair || !isDeliverable(pair.path)) continue;
    const norm = pair.path.replace(/\\/g, "/");
    byPath.set(norm, {
      toolCallId: part.toolCallId,
      path: pair.path,
      base: norm.slice(norm.lastIndexOf("/") + 1),
      size: byteLength(pair.newText),
    });
  }
  return [...byPath.values()];
}

/**
 * 会话级产物汇总（面板「产物」标签页的数据源）：
 * 把 panel-activity 的文件变更组（edit/write 按路径聚合、条目按时间序）折叠成
 * 交付文件清单——每路径取最后一次成功的 write 为当前版本（edit 只携带替换
 * 片段，不代表全文，故不据其计大小、不换快照锚点）；write 白名单、大小口径
 * 与消息尾部产物卡完全同源，两处展示永远一致。
 * 组序 = 路径首次出现序，这里倒序输出（最新产出的文件在最上）。
 * 在途 / 失败的 write 不收录；消费方以 files 引用做 useMemo，派生廉价。
 */
export function threadArtifacts(groups: FileChangeGroup[]): MessageArtifact[] {
  const out: MessageArtifact[] = [];
  for (const group of groups) {
    if (!isDeliverable(group.path)) continue;
    let last: FileChangeEntry | null = null;
    for (const entry of group.entries) {
      if (entry.op === "write" && !entry.running && !entry.failed) last = entry;
    }
    if (!last) continue;
    const norm = group.path.replace(/\\/g, "/");
    out.push({
      toolCallId: last.toolCallId,
      path: group.path,
      base: norm.slice(norm.lastIndexOf("/") + 1),
      size: byteLength(last.newText),
    });
  }
  return out.reverse();
}
