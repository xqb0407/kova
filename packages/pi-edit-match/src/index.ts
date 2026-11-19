/**
 * edit 工具的多策略降级匹配器（纯函数、零依赖）。
 *
 * 设计原则（回归安全第一）：
 * - `exact` 永远先试且行为与旧实现逐字节一致（子串计数 + 唯一性）；
 *   宽策略只在 exact 零命中时才运行——所有今天能成功的 edit 结果不变，
 *   唯一变化是「原来必报错废一轮」的调用现在可能成功。
 * - 行级宽策略在 CRLF 内容上于 `\r\n → \n` 归一副本中运行（行数守恒，
 *   按行号映射回原文提取候选，保留原行尾）。
 * - `replaceAll=true` 跳过全部行级宽策略与行号前缀剥离（后者的短串会命中
 *   模型从未见过的位置），防止误替换扩散。
 * - 内容超过 BROAD_STRATEGY_MAX_CHARS / BROAD_STRATEGY_MAX_LINES 时跳过
 *   行级宽策略（逐窗扫描 O(行数×搜索行数)），落回 not_found——大文件
 *   行为与改动前完全一致，不会更慢。
 *
 * 统一报错/成功文案也在这里维护，三处 edit 调用点（桌面本地 / ACP 本地 /
 * SSH 远程）共用同一份措辞。
 */

export type EditMatchStrategy =
  | "exact"
  | "quote_normalized"
  | "line_number_prefix_stripped"
  | "escape_normalized"
  | "unicode_escape_normalized"
  | "line_trimmed"
  | "block_anchor";

export type EditMatchResult =
  | {
      status: "matched";
      /** 文件中实际命中的原文（可能与模型给的 search 存在空白/引号/转义差异） */
      actualString: string;
      strategy: EditMatchStrategy;
      candidateCount: number;
    }
  | { status: "ambiguous"; strategy: EditMatchStrategy; candidateCount: number }
  | { status: "not_found" };

export interface EditMatchInput {
  content: string;
  search: string;
  replaceAll: boolean;
}

/** 行级宽策略集合：命中结果与原文存在结构性差异（整块空白/相似块），replaceAll 时必须跳过 */
const BROAD_MATCHERS: ReadonlySet<EditMatchStrategy> = new Set([
  "line_trimmed",
  "block_anchor",
]);

/**
 * 策略序（从严到宽）。注意没有独立的「缩进弹性」档：缩进归一相等蕴含
 * 逐行 trim 相等，line_trimmed 排序在前且 minLines 更小，永远先命中——
 * 单列一档是不可达代码（对抗审查证明后删除，勿再引入）。
 */
const STRATEGY_ORDER: readonly EditMatchStrategy[] = [
  "exact",
  "quote_normalized",
  "line_number_prefix_stripped",
  "escape_normalized",
  "unicode_escape_normalized",
  "line_trimmed",
  "block_anchor",
];

/** block_anchor 的中间行平均相似度门槛 */
const BLOCK_ANCHOR_MIN_SIMILARITY = 0.8;

/** 行级宽策略的内容上限（UTF-16 码元）：超过则跳过，行为退回 not_found */
export const BROAD_STRATEGY_MAX_CHARS = 4_000_000;
/** 行级宽策略的行数上限 */
export const BROAD_STRATEGY_MAX_LINES = 100_000;

const LEFT_SINGLE_CURLY_QUOTE = "\u2018";
const RIGHT_SINGLE_CURLY_QUOTE = "\u2019";
const LEFT_DOUBLE_CURLY_QUOTE = "\u201C";
const RIGHT_DOUBLE_CURLY_QUOTE = "\u201D";

interface Candidate {
  value: string;
}

/* ------------------------------- 主入口 ------------------------------- */

/**
 * 按策略序（从严到宽）寻找 old_string 在文件中的匹配。
 *
 * 返回语义：
 * - matched：唯一候选。调用方应基于 actualString 计数/替换，而非原始 search。
 * - ambiguous：存在多个不同候选（或多命中且未 replaceAll 的判定由调用方
 *   基于 actualString 计数完成）。
 * - not_found：全部策略零命中（含空 search 与超限跳过宽策略的情形）。
 */
export function findEditMatch(input: EditMatchInput): EditMatchResult {
  const { content, search, replaceAll } = input;
  const broadAllowed =
    !replaceAll &&
    content.length <= BROAD_STRATEGY_MAX_CHARS &&
    countLines(content) <= BROAD_STRATEGY_MAX_LINES;

  for (const strategy of STRATEGY_ORDER) {
    if (BROAD_MATCHERS.has(strategy) && !broadAllowed) continue;
    // 剥行号前缀是内容缩短（非编码级变换）：剥出的更短串会命中模型从未见过
    // 的位置，replaceAll 会把它们全部替换——与宽策略豁免同款保守语义
    if (strategy === "line_number_prefix_stripped" && replaceAll) continue;
    const candidates = collectCandidates(strategy, content, search);
    if (candidates.length === 0) continue;
    return toMatchResult(strategy, candidates);
  }

  return { status: "not_found" };
}

/** 降级策略命中时对 new_string 做与 old_string 对称的还原（escape/unicode），
 *  使替换文本与实际命中片段保持同一语义层——模型两个参数写的是同一种笔误 */
export function normalizeReplacementForMatch(
  strategy: EditMatchStrategy,
  newString: string,
): string {
  if (strategy === "escape_normalized") return unescapeVisibleCharacters(newString);
  if (strategy === "unicode_escape_normalized") return unescapeUnicodeCharacters(newString);
  return newString;
}

/**
 * lookalike 归一（1:1 字符映射，坐标可回映原文）：弯引号 → 直引号、
 * 各类破折号/连字符 → -、特殊空格（NBSP/全角空格等）→ 普通空格。
 * 都是模型在拷贝粘贴富文本时高频引入的「看不见的替身字符」。
 */
function normalizeQuotes(value: string): string {
  return (
    value
      .replaceAll(LEFT_SINGLE_CURLY_QUOTE, "'")
      .replaceAll(RIGHT_SINGLE_CURLY_QUOTE, "'")
      .replaceAll(LEFT_DOUBLE_CURLY_QUOTE, '"')
      .replaceAll(RIGHT_DOUBLE_CURLY_QUOTE, '"')
      // 破折号/连字符家族 → -（U+2010 hyphen、U+2011 non-breaking hyphen、
      // U+2012 figure dash、U+2013 en-dash、U+2014 em-dash、U+2015 horizontal
      // bar、U+2212 minus）
      .replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, "-")
      // 特殊空格 → 普通空格（U+00A0 NBSP、U+2002-U+200A 各类宽度空格、
      // U+202F narrow NBSP、U+205F medium math space、U+3000 ideographic space）
      .replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, " ")
  );
}
export function preserveQuoteStyle(
  oldString: string,
  actualOldString: string,
  newString: string,
): string {
  if (oldString === actualOldString) return newString;

  let result = newString;
  if (
    actualOldString.includes(LEFT_DOUBLE_CURLY_QUOTE) ||
    actualOldString.includes(RIGHT_DOUBLE_CURLY_QUOTE)
  ) {
    result = applyCurlyDoubleQuotes(result);
  }
  if (
    actualOldString.includes(LEFT_SINGLE_CURLY_QUOTE) ||
    actualOldString.includes(RIGHT_SINGLE_CURLY_QUOTE)
  ) {
    result = applyCurlySingleQuotes(result);
  }
  return result;
}

/**
 * 行尾适配（非 exact 命中时调用）：actualString 来自原文，行尾风格以它为准。
 * CRLF 文件里 newString 若只有 \n，整段写回会产生混合行尾——统一成 \r\n。
 */
export function adaptReplacementLineEndings(actualString: string, newString: string): string {
  if (!actualString.includes("\r\n")) return newString;
  return newString.replaceAll("\r\n", "\n").replaceAll("\n", "\r\n");
}

/**
 * 剥 read 输出的行号前缀（模型把 read 结果原样贴回 old_string 的高频错误）。
 * 两种行号格式都容忍前导空白：`42\t…`（本地 read）与 `    42\t…`（远程宽列）、
 * `42: …`。不是每一行都带合法前缀时返回 null（调用方跳过本策略）。
 */
export function stripReadLineNumberPrefixes(search: string): string | null {
  const lines = search.split("\n");
  const stripped = lines.map((line) => {
    const colonMatch = line.match(/^\s*\d+: (.*)$/);
    if (colonMatch) return colonMatch[1] ?? "";
    const tabMatch = line.match(/^\s*\d+\t(.*)$/);
    if (tabMatch) return tabMatch[1] ?? "";
    return null;
  });
  return stripped.every((line): line is string => line !== null) ? stripped.join("\n") : null;
}

/* ----------------------------- 统一文案 ----------------------------- */

/** not_found 的自愈式报错：回显搜索串并给出恢复动作 */
export function editNotFoundMessage(filePath: string, oldString: string): string {
  return (
    `String to replace not found in file: ${filePath}\n\n` +
    `Old string: ${oldString.slice(0, 200)}\n\n` +
    "Re-read the file with read and retry with exact current content."
  );
}

/** 歧义报错：模糊策略多候选，或唯一 actualString 在 replace_all=false 下多命中 */
export function editAmbiguousMessage(count: number, filePath: string, oldString: string): string {
  return (
    `Found ${count} candidate blocks matching ${oldString.slice(0, 200)} in ${filePath}; ` +
    "add more surrounding context or set replace_all=true."
  );
}

/** 非 exact 命中的自愈提示：模型需要知道实际写入与其输入存在差异 */
export function editMatchedNote(strategy: EditMatchStrategy): string {
  return strategy === "exact"
    ? ""
    : ` (matched via ${strategy}; your old_string differed in whitespace/quotes/escapes/line numbers)`;
}

/** 替换后的全文与原文一致：模型把 old_string 原样当 new_string 交回来了（空转） */
export function editNoChangeMessage(filePath: string): string {
  return (
    `No changes made to ${filePath}: the replacement produced identical content. ` +
    "If you intended this edit, provide the actual new text; otherwise move on."
  );
}

/* --------------------------- 完整替换管线 --------------------------- */

export interface EditApplyInput {
  content: string;
  /** 仅用于报错文案展示（调用方决定传相对路径还是绝对路径） */
  filePath: string;
  oldString: string;
  newString: string;
  replaceAll: boolean;
}

export type EditApplyResult =
  | { ok: true; updated: string; count: number; strategy: EditMatchStrategy }
  | { ok: false; error: string };

/**
 * 三处 edit 调用点（桌面本地 / ACP 本地 / SSH 远程）共用的完整管线：
 * findEditMatch → actualString 出现次数歧义判定 → new_string 规范化
 * （escape 策略的转义还原 + 降级命中的弯引号回写与行尾适配）→ 执行替换。
 *
 * 失败以字符串返回错误文案（不抛错，包保持纯函数）；成功返回替换后全文
 * 与展示计数（replaceAll 生效时为真实出现次数，否则为 1）。
 */
export function applyEditMatch(input: EditApplyInput): EditApplyResult {
  const { filePath, oldString, newString, replaceAll } = input;
  // BOM 剥离后再匹配：模型不会在 old_string 里带上不可见的 BOM，带着它匹配
  // 恒失；写回时原样补回（updated 含 BOM，调用方整文写回不变）
  const bom = input.content.charCodeAt(0) === 0xfeff ? "\uFEFF" : "";
  const content = bom ? input.content.slice(1) : input.content;
  const match = findEditMatch({ content, search: oldString, replaceAll });
  if (match.status === "not_found") {
    return { ok: false, error: editNotFoundMessage(filePath, oldString) };
  }
  if (match.status === "ambiguous") {
    return { ok: false, error: editAmbiguousMessage(match.candidateCount, filePath, oldString) };
  }
  // 歧义以 actualString 的真实出现次数为准（模糊候选可能同值多现）
  const occurrences = content.split(match.actualString).length - 1;
  if (occurrences > 1 && !replaceAll) {
    return { ok: false, error: editAmbiguousMessage(occurrences, filePath, oldString) };
  }
  // 规范化链（仅降级命中）：escape 策略对 new_string 做同样的转义还原 →
  // 弯引号按文件风格回写 → 行尾适配。exact 路径写回 newString 原文
  // （回归安全：与旧实现逐字节一致，包括 CRLF 文件上模型自带 \r\n 的
  // exact 编辑——那是改动前的既有行为，不扩大改动面）
  const replacement =
    match.strategy === "exact"
      ? newString
      : adaptReplacementLineEndings(
          match.actualString,
          preserveQuoteStyle(
            oldString,
            match.actualString,
            normalizeReplacementForMatch(match.strategy, newString),
          ),
        );
  // split/join 字面写回（单/多命中同路径）：String.replace 的 replacement 会
  // 解释 $&/$'/$` 等模式串，模型输出里的字面 $ 会被静默改写——旧实现单命中
  // 路径即有此问题，这里统一为字面语义
  const body = content.split(match.actualString).join(replacement);
  if (body === content) {
    return { ok: false, error: editNoChangeMessage(filePath) };
  }
  return {
    ok: true,
    updated: bom + body,
    count: replaceAll ? occurrences : 1,
    strategy: match.strategy,
  };
}

/* --------------------------- 各策略收集器 --------------------------- */

function collectCandidates(
  strategy: EditMatchStrategy,
  content: string,
  search: string,
): Candidate[] {
  switch (strategy) {
    case "exact":
      return collectSubstringCandidates(content, search);
    case "quote_normalized":
      return collectQuoteNormalizedCandidates(content, search);
    case "line_number_prefix_stripped":
      return collectLineNumberPrefixCandidates(content, search);
    case "escape_normalized":
      return collectEscapeNormalizedCandidates(content, search);
    case "unicode_escape_normalized":
      return collectUnicodeEscapeNormalizedCandidates(content, search);
    case "line_trimmed":
      return collectLineTrimmedCandidates(content, search);
    case "block_anchor":
      return collectBlockAnchorCandidates(content, search);
  }
}

function toMatchResult(strategy: EditMatchStrategy, candidates: Candidate[]): EditMatchResult {
  const uniqueValues = [...new Set(candidates.map((candidate) => candidate.value))];
  if (uniqueValues.length !== 1) {
    return { status: "ambiguous", strategy, candidateCount: candidates.length };
  }
  return {
    status: "matched",
    actualString: uniqueValues[0] ?? "",
    strategy,
    candidateCount: candidates.length,
  };
}

/** 子串收集：value 即命中片段本身 */
function collectSubstringCandidates(content: string, search: string): Candidate[] {
  if (search.length === 0) return [];
  const candidates: Candidate[] = [];
  let position = 0;
  while (position <= content.length) {
    const index = content.indexOf(search, position);
    if (index === -1) break;
    candidates.push({ value: search });
    position = index + Math.max(search.length, 1);
  }
  return candidates;
}

/**
 * 长度保持型归一匹配：归一只做 1:1 字符映射（弯引号 → 直引号），
 * 归一坐标即原文坐标，候选按原文切出以保留原字符。
 */
function collectQuoteNormalizedCandidates(content: string, search: string): Candidate[] {
  const normalizedContent = normalizeQuotes(content);
  const normalizedSearch = normalizeQuotes(search);
  if (normalizedSearch.length === 0) return [];
  const candidates: Candidate[] = [];
  let position = 0;
  while (position <= normalizedContent.length) {
    const index = normalizedContent.indexOf(normalizedSearch, position);
    if (index === -1) break;
    candidates.push({ value: content.slice(index, index + search.length) });
    position = index + Math.max(normalizedSearch.length, 1);
  }
  return candidates;
}

function collectLineNumberPrefixCandidates(content: string, search: string): Candidate[] {
  const stripped = stripReadLineNumberPrefixes(search);
  if (stripped === null || stripped === search) return [];
  return collectSubstringCandidates(content, stripped);
}

/** 模型写了字面 `\n`/`\t`/`\"` 而文件里是真实字符：对 search 还原后按原文子串搜索 */
function collectEscapeNormalizedCandidates(content: string, search: string): Candidate[] {
  const unescaped = unescapeVisibleCharacters(search);
  if (unescaped === search) return [];
  return collectSubstringCandidates(content, unescaped);
}

/** 同上，针对 `\uXXXX`：候选直接取文件中的真实片段 */
function collectUnicodeEscapeNormalizedCandidates(content: string, search: string): Candidate[] {
  const unescaped = unescapeUnicodeCharacters(search);
  if (unescaped === search) return [];
  return collectSubstringCandidates(content, unescaped);
}

/* ------------------- 行级宽策略（CRLF 归一副本中运行） ------------------- */

/**
 * 行级策略公共入口：在 `\r\n → \n` 归一副本上匹配，候选按行号映射回原文
 * 提取（保留原行尾）。\r\n → \n 只删 \r 不动 \n，split("\n") 行数守恒，
 * 行号映射恒成立。
 */
function collectLineBasedCandidates(
  content: string,
  search: string,
  minLines: number,
  blockMatches: (block: string[], searchLines: string[]) => boolean,
): Candidate[] {
  // \r\n → \n 只删 \r 不动 \n，split("\n") 行数必然守恒，行号可直接映射回原文
  const normalizedContent = content.replaceAll("\r\n", "\n");
  const originalLines = content.split("\n");
  const normalizedLines = normalizedContent.split("\n");
  const searchLines = trimTrailingEmptyLine(
    search.split("\n").map((line) => line.replace(/\r$/, "")),
  );
  if (searchLines.length < minLines) return [];

  // 行起始偏移一次预计算（O(n)）：候选提取 O(1)。锚点大量命中的病态文件上
  // 若按候选逐个累加偏移会退化成 O(n²)，宽匹配上限内也是可观的卡顿
  const lineOffsets = lineStartOffsets(originalLines);

  const candidates: Candidate[] = [];
  for (let index = 0; index <= normalizedLines.length - searchLines.length; index += 1) {
    const block = normalizedLines.slice(index, index + searchLines.length);
    if (!blockMatches(block, searchLines)) continue;
    candidates.push({
      value: blockCandidateFromOriginal(content, lineOffsets, index, searchLines.length),
    });
  }
  return candidates;
}

/**
 * 按行号从原文提取候选块：块止于末行的行内容，行终止符（\n 或 \r\n 的 \r）
 * 留在候选之外——写回时终止符不被消费，文件原行尾自然保留。LF 文件的结果
 * 与旧的 `originalLines.slice(...).join("\n")` 逐字节一致。
 */
function blockCandidateFromOriginal(
  content: string,
  lineOffsets: readonly number[],
  startLine: number,
  lineCount: number,
): string {
  const start = lineOffsets[startLine]!;
  if (startLine + lineCount >= lineOffsets.length - 1) {
    return content.slice(start);
  }
  const nlPos = lineOffsets[startLine + lineCount]! - 1;
  const contentEnd = content[nlPos - 1] === "\r" ? nlPos - 1 : nlPos;
  return content.slice(start, contentEnd);
}

/** 每行在原文中的起始偏移（长度 = 行数 + 1，末项为 EOF 偏移） */
function lineStartOffsets(lines: string[]): number[] {
  const offsets = new Array<number>(lines.length + 1);
  let offset = 0;
  for (let index = 0; index < lines.length; index += 1) {
    offsets[index] = offset;
    offset += lines[index]!.length + 1;
  }
  offsets[lines.length] = offset;
  return offsets;
}

function collectLineTrimmedCandidates(content: string, search: string): Candidate[] {
  return collectLineBasedCandidates(content, search, 1, (block, searchLines) =>
    block.every((line, offset) => line.trim() === searchLines[offset]!.trim()),
  );
}

function collectBlockAnchorCandidates(content: string, search: string): Candidate[] {
  const searchLines = trimTrailingEmptyLine(
    search.split("\n").map((line) => line.replace(/\r$/, "")),
  );
  if (searchLines.length < 3) return [];
  const first = searchLines[0]!.trim();
  const last = searchLines[searchLines.length - 1]!.trim();
  return collectLineBasedCandidates(
    content,
    search,
    3,
    (block) =>
      block[0]!.trim() === first &&
      block[block.length - 1]!.trim() === last &&
      averageMiddleSimilarity(block, searchLines) >= BLOCK_ANCHOR_MIN_SIMILARITY,
  );
}

/* ------------------------------- 辅助 ------------------------------- */

function countLines(content: string): number {
  let lines = 1;
  for (let i = 0; i < content.length; i += 1) {
    if (content.charCodeAt(i) === 10) lines += 1;
  }
  return lines;
}

function trimTrailingEmptyLine(lines: string[]): string[] {
  if (lines.length > 0 && lines[lines.length - 1] === "") return lines.slice(0, -1);
  return lines;
}

function averageMiddleSimilarity(actual: string[], expected: string[]): number {
  if (actual.length <= 2) return 1;
  let total = 0;
  let count = 0;
  for (let index = 1; index < actual.length - 1; index += 1) {
    total += lineSimilarity(actual[index]!.trim(), expected[index]!.trim());
    count += 1;
  }
  return count === 0 ? 1 : total / count;
}

/**
 * 行级相似度护栏：任一侧超过此长度的行不做 Levenshtein（O(L²) 每行对，
 * 在 electron 主进程同步执行），直接判 0（block_anchor 拒绝该窗口）。
 * 常规代码行远低于此；超长行（minified bundle、超长 CSV 记录）场景
 * 常数时间退出，总字符/行数上限不约束单行长度。
 */
const FUZZY_LINE_MAX_CHARS = 500;

function lineSimilarity(left: string, right: string): number {
  if (left === right) return 1;
  if (left.length > FUZZY_LINE_MAX_CHARS || right.length > FUZZY_LINE_MAX_CHARS) return 0;
  const maxLength = Math.max(left.length, right.length);
  if (maxLength === 0) return 1;
  return 1 - levenshtein(left, right) / maxLength;
}

function levenshtein(left: string, right: string): number {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const cost = left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1;
      current[rightIndex] = Math.min(
        previous[rightIndex]! + 1,
        current[rightIndex - 1]! + 1,
        previous[rightIndex - 1]! + cost,
      );
    }
    previous.splice(0, previous.length, ...current);
  }
  return previous[right.length] ?? 0;
}

/** 模型侧常见的可见转义还原（字面 `\n` → 换行等）；未识别的转义原样保留 */
function unescapeVisibleCharacters(search: string): string {
  return search.replace(/\\([ntr"'`\\$])/g, (match, token: string) => {
    switch (token) {
      case "n":
        return "\n";
      case "t":
        return "\t";
      case "r":
        return "\r";
      case '"':
      case "'":
      case "`":
      case "\\":
      case "$":
        return token;
      default:
        return match;
    }
  });
}

function unescapeUnicodeCharacters(search: string): string {
  return search.replace(/(\\\\)|\\u([0-9a-fA-F]{4})/g, (match, escapedBackslash, hex: string) => {
    if (escapedBackslash !== undefined) return match;
    return String.fromCharCode(Number.parseInt(hex, 16));
  });
}

/* --------------------------- 弯引号风格回写 --------------------------- */

function applyCurlyDoubleQuotes(value: string): string {
  return [...value]
    .map((char, index, chars) => {
      if (char !== '"') return char;
      return isOpeningQuoteContext(chars, index)
        ? LEFT_DOUBLE_CURLY_QUOTE
        : RIGHT_DOUBLE_CURLY_QUOTE;
    })
    .join("");
}

function applyCurlySingleQuotes(value: string): string {
  return [...value]
    .map((char, index, chars) => {
      if (char !== "'") return char;
      const previous = chars[index - 1];
      const next = chars[index + 1];
      if (isLetter(previous) && isLetter(next)) {
        return RIGHT_SINGLE_CURLY_QUOTE;
      }
      return isOpeningQuoteContext(chars, index)
        ? LEFT_SINGLE_CURLY_QUOTE
        : RIGHT_SINGLE_CURLY_QUOTE;
    })
    .join("");
}

function isOpeningQuoteContext(chars: string[], index: number): boolean {
  if (index === 0) return true;
  const previous = chars[index - 1];
  return (
    previous === " " ||
    previous === "\t" ||
    previous === "\n" ||
    previous === "\r" ||
    previous === "(" ||
    previous === "[" ||
    previous === "{" ||
    previous === "\u2014" ||
    previous === "\u2013" ||
    previous === '"' ||
    previous === "'" ||
    previous === "\u201C" ||
    previous === "\u2018"
  );
}

function isLetter(char: string | undefined): boolean {
  return char !== undefined && /\p{L}|\p{N}/u.test(char);
}
