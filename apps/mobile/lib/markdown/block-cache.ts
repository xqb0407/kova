/**
 * 块切分的增量缓存（流式 markdown 的性能核心）。
 *
 * 为什么要它：输入框收到的是逐 token 增长的整段文本，而渲染层每 ~50ms 要重新
 * 定一次「有哪些块」。此前每帧都对**全文**跑一遍 marked 的词法分析——回答越长
 * 每帧越贵，还顺带让每个已完成块的 raw 引用都换新（`MarkdownBlock` 按 raw memo，
 * 于是"没变的老块"也全部重渲）。改成追加式增长时只重排**最后一个块**：
 *
 *   上一帧: [块1][块2][块3(可能还在长)]
 *   这一帧: [块1][块2] + 重排(块3 + 新追加的部分)
 *
 * 块1/块2 的 raw 字符串原样复用（引用不变 ⇒ memo 命中，连渲染都省了）。
 * marked 的块级解析在块边界上是局部的（列表/段落/围栏块都自成一块），从最后
 * 一块的起点重排得到的结构与原全文重排一致；跨块才生效的引用式链接定义本来
 * 就被本文件的按块渲染策略排除了。
 *
 * 非追加式变更（换消息、编辑、remend 回退）一律退回全量重排——正确性优先。
 */

/** 一个块：原文 + marked 的 token 类型（尾部 remend 修补要按类型分派） */
export type MarkdownBlockToken = { raw: string; type: string };

export type BlockSplit = {
  /** 这一份切分对应的完整文本（用于判断下一帧是不是它的追加） */
  text: string;
  /** 每个块的原文与类型，顺序即渲染顺序 */
  blocks: readonly MarkdownBlockToken[];
};

/** 词法分析器：整段文本 → 每块（由调用方注入 marked，便于单测） */
export type LexBlocks = (text: string) => readonly MarkdownBlockToken[];

/**
 * 下一帧的块切分。`prev` 传上一帧结果（首帧传 null）。
 * 命中追加式增长时只对尾部调一次 `lex`，其余块原文直接复用（引用不变）。
 */
export function nextBlockSplit(
  prev: BlockSplit | null,
  text: string,
  lex: LexBlocks,
): BlockSplit {
  // 同一份文本（重复渲染/节流未推进）直接复用，顺带保证本函数幂等
  if (prev && prev.text === text) return prev;

  if (
    prev &&
    prev.blocks.length > 0 &&
    text.length > prev.text.length &&
    text.startsWith(prev.text)
  ) {
    const lastRaw = (prev.blocks[prev.blocks.length - 1] as MarkdownBlockToken).raw;
    // 上一帧的最后一个块必须正好落在文本末尾，才敢从它的起点重排；
    // 对不上（尾随空白被 raw 裁掉等）就退回全量
    if (lastRaw.length > 0 && prev.text.endsWith(lastRaw)) {
      const tailStart = prev.text.length - lastRaw.length;
      return {
        text,
        blocks: [...prev.blocks.slice(0, -1), ...lex(text.slice(tailStart))],
      };
    }
  }

  return { text, blocks: lex(text) };
}
