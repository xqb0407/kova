"use client";

/**
 * sidecar 会把**给模型看的注记行**拼进 prompt 文本（protocol/prompt-pipeline 的
 * noticeAppendedText：`text + "\n" + notices`），并随用户消息一起落盘。它们对
 * 用户是噪音，不该出现在自己的气泡里：
 *
 * - 缩放/转码注记只是模型的坐标换算提示（`[图片已缩放：…坐标乘以 N…]`、
 *   `[图片已从 a 转为 b]`）→ 显示层直接隐藏；
 * - 「已省略」表示图片**根本没发出去**（张数/体积/解码失败）→ 不能藏，改成
 *   气泡下方的系统提示，让用户知道模型没收到图。
 *
 * 只在渲染层做（历史消息同样生效）；落盘文本保持原样，模型侧语义不变。
 */

export type PromptNotices = {
  /** 去掉注记后的正文 */
  text: string;
  /** 纯模型提示（对用户隐藏） */
  hidden: string[];
  /** 需要告知用户的告警（图片被省略等） */
  warnings: string[];
};

/** 整行匹配才剥离，避免误伤用户自己写的方括号文本 */
const HIDDEN_LINE_RES = [
  /^\[图片已缩放：.*\]$/,
  /^\[图片已从 .+ 转为 .+\]$/,
];
const WARNING_LINE_RE = /^\[.+已省略：.+\]$/;

/** 资料库上下文隐藏块（发送端 buildPiSendInput 追加，带随机边界；兼容旧的无
 *  边界格式）。块内是给模型的引用路径/笔记正文，用户气泡只该看到芯片。 */
const LIBRARY_CONTEXT_BLOCK_RE =
  /\[\[library-(?:refs|notes)(?::[^\]]+)?\]\][\s\S]*?\[\[\/library-(?:refs|notes)(?::[^\]]+)?\]\]/g;
const LIBRARY_CONTEXT_START_RE =
  /\[\[library-(?:refs|notes)(?::[^\]]+)?\]\]/;

/** 剥掉资料库上下文隐藏块（refs / notes，可能多条）：气泡渲染、编辑回填、
 *  标题摘要共用这一份 */
export function stripLibraryContextBlocks(input: string): string {
  if (!input.includes("[[library-")) return input;
  let out = input.replace(LIBRARY_CONTEXT_BLOCK_RE, "");
  // 未闭合块（异常转录）：从第一个起始标记剥到末尾
  const start = out.search(LIBRARY_CONTEXT_START_RE);
  if (start >= 0) out = out.slice(0, start);
  return out.replace(/[ \t]+$/gm, "").trimEnd();
}

export function splitPromptNotices(input: string): PromptNotices {
  // 先剥资料库上下文隐藏块（多行块，行扫描剥不了），再做逐行注记剥离
  input = stripLibraryContextBlocks(input);
  // 绝大多数消息没有注记：快速返回，不做行扫描
  if (!input.includes("[")) return { text: input, hidden: [], warnings: [] };
  const kept: string[] = [];
  const hidden: string[] = [];
  const warnings: string[] = [];
  for (const line of input.split("\n")) {
    const trimmed = line.trim();
    if (HIDDEN_LINE_RES.some((re) => re.test(trimmed))) {
      hidden.push(trimmed);
      continue;
    }
    if (WARNING_LINE_RE.test(trimmed)) {
      warnings.push(trimmed);
      continue;
    }
    kept.push(line);
  }
  return {
    // 注记总在末尾：剥掉后可能留下空行，收一下尾部空白
    text: kept.join("\n").replace(/[ \t]+$/, "").replace(/\n+$/, ""),
    hidden,
    warnings,
  };
}