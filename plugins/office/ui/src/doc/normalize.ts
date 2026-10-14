/**
 * 文档快照载入前容错归一（纯函数）。
 *
 * Univer 文档模型有两条硬性约定（getEmptySnapshot 的权威形状）：
 *   1. body.dataStream 以 `\r\n` 结尾——`\r` 是段落终止符，`\n` 是节分隔符；
 *   2. body.sectionBreaks 至少一条、startIndex 指向 dataStream 里那个 `\n`
 *      （引擎兼容层会静默过滤掉不指向 `\n` 的节）。
 * 缺了节，文档模型没有可排版的 section，引擎不报错、直接渲染空白页。
 *
 * agent 半途手写的快照经常缺这些；这里在载入前补齐，对已合法的快照
 * （面板 save 回读的）零改动。段落/节的 id（para_/section_ 前缀）缺失时
 * 引擎部分路径能容忍，这里统一补齐以免踩内部 map 查找。
 */

/** 段落条目（agent 写的快照里可能只有 startIndex） */
type ParagraphLike = { startIndex: number; paragraphId?: string; paragraphStyle?: Record<string, unknown> };

/** 节条目（sectionId 可省，引擎会自补） */
type SectionBreakLike = { startIndex: number; sectionId?: string };

export type NormalizableDoc = {
  id?: string;
  title?: string;
  documentStyle?: Record<string, unknown>;
  body?: {
    dataStream?: string;
    textRuns?: unknown[];
    paragraphs?: ParagraphLike[];
    sectionBreaks?: SectionBreakLike[];
    [key: string]: unknown;
  };
  [key: string]: unknown;
};

let idSeq = 0;
/** 与引擎同前缀的随机 id（para_/section_ + 随机串）；仅用于补缺，不与引擎冲突 */
function makeId(prefix: string): string {
  idSeq = (idSeq + 1) % 1e6;
  return `${prefix}${Date.now().toString(36)}${idSeq.toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

export function normalizeDocSnapshot<T extends NormalizableDoc>(snapshot: T): T {
  const body = snapshot.body ?? {};
  // 1) dataStream 收尾归一：保证以 \r\n 结尾（\r=段落终止，\n=节分隔）
  let ds = typeof body.dataStream === "string" ? body.dataStream : "";
  if (ds.length === 0) {
    ds = "\r\n";
  } else if (!ds.endsWith("\n")) {
    if (!ds.endsWith("\r")) ds += "\r";
    ds += "\n";
  }
  // 2) 段落：至少一条；缺 id 补 id（保唯一）
  const ids = new Set<string>();
  const rawParagraphs = Array.isArray(body.paragraphs) ? body.paragraphs : [];
  const paragraphs: ParagraphLike[] =
    rawParagraphs.length > 0
      ? rawParagraphs.map((p) => {
          const pid =
            p && typeof p.paragraphId === "string" && p.paragraphId && !ids.has(p.paragraphId)
              ? (ids.add(p.paragraphId), p.paragraphId)
              : makeId("para_");
          ids.add(pid);
          return { ...p, paragraphId: pid };
        })
      : [{ startIndex: 0, paragraphId: makeId("para_") }];
  // 3) 节：过滤不指向 \n 的非法项；保证有一条指向末尾 \n
  const lastNl = ds.length - 1;
  const sectionIds = new Set<string>();
  const sectionBreaks: SectionBreakLike[] = (Array.isArray(body.sectionBreaks) ? body.sectionBreaks : []).filter(
    (sb) => sb && ds[sb.startIndex] === "\n",
  );
  if (!sectionBreaks.some((sb) => sb.startIndex === lastNl)) {
    sectionBreaks.push({ startIndex: lastNl });
  }
  const fixedSections = sectionBreaks.map((sb) => {
    const sid =
      sb.sectionId && !sectionIds.has(sb.sectionId) ? (sectionIds.add(sb.sectionId), sb.sectionId) : makeId("section_");
    sectionIds.add(sid);
    return { ...sb, sectionId: sid };
  });

  return {
    ...snapshot,
    body: {
      textRuns: [],
      ...body,
      dataStream: ds,
      paragraphs,
      sectionBreaks: fixedSections,
    },
  };
}
