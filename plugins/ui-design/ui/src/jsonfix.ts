/**
 * JSON 修复层：把「AI 手写坏了的 JSON」救成可解析文本（纯函数，零依赖）。
 *
 * 依据实测的坏写法（parseDesignDoc 直接 JSON.parse 全部报废）逐类修复：
 *   ① BOM / ② ```json 围栏 / ③ 前后夹带说明文字 / ④ // 与 /* *\/ 注释
 *   ⑤ 尾逗号 / ⑥ 单引号字符串 / ⑦ 裸键名 / ⑧ 中文智能引号键值 /
 *   ⑨ 字符串里未转义的换行与制表符 / ⑩ undefined·NaN·Infinity / ⑪ 截断补全
 *
 * 契约：**合法 JSON 原样返回**（fast path，fixes 为空、逐字节不变）；
 * 修复过程只做「去掉不可解析成分 / 补齐结构」，绝不猜改业务字段值。
 * 修复明细（fixes）回传给调用方，由面板/MCP 提示"已自动修复"。
 */

export type JsonFixResult = {
  text: string;
  /** 命中的修复项（人类可读，已按类合并计数） */
  fixes: string[];
  changed: boolean;
};

/** 输出上限：超过就不再尝试修复（原样返回），避免病态输入拖死解析 */
const MAX_INPUT = 4 * 1024 * 1024;
/** 截断补全的反向候选扫描上限 */
const MAX_CUT_CANDIDATES = 160;

const isIdentStart = (ch: string): boolean => /[\p{L}_$]/u.test(ch);
const isIdentPart = (ch: string): boolean => /[\p{L}\p{N}_$-]/u.test(ch);

class Counter {
  private m = new Map<string, number>();
  bump(label: string) {
    this.m.set(label, (this.m.get(label) ?? 0) + 1);
  }
  list(): string[] {
    return [...this.m.entries()].map(([k, n]) => (n > 1 ? `${k} ×${n}` : k));
  }
  get size(): number {
    return this.m.size;
  }
}

/** 主入口：坏文本 → 可解析文本 + 修复明细 */
export function fixJsonText(input: string): JsonFixResult {
  const raw = typeof input === "string" ? input : "";
  if (!raw) return { text: raw, fixes: [], changed: false };
  // fast path：本来就是合法 JSON，逐字节不动
  if (tryParse(raw) !== NOT_JSON) return { text: raw, fixes: [], changed: false };
  if (raw.length > MAX_INPUT) return { text: raw, fixes: [], changed: false };

  const count = new Counter();
  const stripped = stripOuter(raw, count);
  const scanned = scanRepair(stripped, count);
  if (tryParse(scanned) !== NOT_JSON) {
    return { text: scanned, fixes: count.list(), changed: true };
  }

  // 截断补全：先「就地闭合」，失败再反向找完整前缀
  const closed = closeAndParse(scanned);
  if (closed !== null) {
    count.bump("内容截断（已补全结尾）");
    return { text: closed, fixes: count.list(), changed: true };
  }
  const salvaged = salvageByCut(scanned);
  if (salvaged !== null) {
    count.bump("内容截断（已弃尾保全）");
    return { text: salvaged, fixes: count.list(), changed: true };
  }
  // 救不动：返回清理后的文本（调用方仍会 fatal，但错误更贴近真实位置）
  return { text: scanned, fixes: count.list(), changed: true };
}

/* ---------------- ① 外层：BOM / 围栏 / 夹带说明 ---------------- */

function stripOuter(input: string, count: Counter): string {
  let s = input;
  if (s.charCodeAt(0) === 0xfeff) {
    s = s.slice(1);
    count.bump("BOM 头");
  }
  // ```json … ``` / ``` … ```
  const fence = /```[ \t]*[A-Za-z0-9_-]*[ \t]*\r?\n([\s\S]*?)```/.exec(s);
  if (fence) {
    const inner = fence[1] ?? "";
    if (tryParse(inner.trim()) !== NOT_JSON || /[[{]/.test(inner)) {
      s = inner;
      count.bump("Markdown 围栏");
    }
  }
  // 前后夹带说明文字：截取首个 { / [ 到最后一个 } / ]
  const first = firstOf(s, "{", "[");
  const last = lastOf(s, "}", "]");
  if (first > 0 || (last >= 0 && last < trimEnd(s).length - 1)) {
    if (first >= 0 && last > first) {
      s = s.slice(first, last + 1);
      count.bump("首尾多余文字");
    }
  }
  return s;
}

const firstOf = (s: string, a: string, b: string): number => {
  const ia = s.indexOf(a);
  const ib = s.indexOf(b);
  if (ia < 0) return ib;
  if (ib < 0) return ia;
  return Math.min(ia, ib);
};
const lastOf = (s: string, a: string, b: string): number => Math.max(s.lastIndexOf(a), s.lastIndexOf(b));
const trimEnd = (s: string): string => s.replace(/\s+$/, "");

/* ---------------- ② 扫描修复：注释/尾逗号/引号/键名 ---------------- */

function scanRepair(input: string, count: Counter): string {
  let out = "";
  let i = 0;
  const n = input.length;
  /** out 里最后一个非空白字符（判断"这个标识符在值位还是键位"） */
  const lastSig = (): string => {
    for (let k = out.length - 1; k >= 0; k--) {
      const c = out[k]!;
      if (c !== " " && c !== "\n" && c !== "\t" && c !== "\r") return c;
    }
    return "";
  };
  const skipWs = (from: number): number => {
    let k = from;
    while (k < n && /\s/.test(input[k]!)) k++;
    return k;
  };
  /** 跳过空白与注释（用于尾逗号/键名前瞻），返回下一个有效字符位置 */
  const skipWsComments = (from: number): number => {
    let k = from;
    for (;;) {
      k = skipWs(k);
      if (input[k] === "/" && input[k + 1] === "/") {
        const nl = input.indexOf("\n", k);
        k = nl < 0 ? n : nl + 1;
        continue;
      }
      if (input[k] === "/" && input[k + 1] === "*") {
        const end = input.indexOf("*/", k + 2);
        k = end < 0 ? n : end + 2;
        continue;
      }
      return k;
    }
  };

  while (i < n) {
    const ch = input[i]!;

    /* 注释 */
    if (ch === "/" && input[i + 1] === "/") {
      const nl = input.indexOf("\n", i);
      i = nl < 0 ? n : nl;
      count.bump("行注释 //");
      continue;
    }
    if (ch === "/" && input[i + 1] === "*") {
      const end = input.indexOf("*/", i + 2);
      i = end < 0 ? n : end + 2;
      count.bump("块注释 /* */");
      continue;
    }

    /* 双引号字符串：原样搬运，仅补转义控制字符 */
    if (ch === '"') {
      out += ch;
      i++;
      while (i < n) {
        const c = input[i]!;
        if (c === "\\") {
          out += c + (input[i + 1] ?? "");
          i += 2;
          continue;
        }
        if (c === '"') {
          out += c;
          i++;
          break;
        }
        if (c === "\n") {
          out += "\\n";
          count.bump("字符串内未转义换行");
          i++;
          continue;
        }
        if (c === "\r") {
          out += "\\r";
          i++;
          continue;
        }
        if (c === "\t") {
          out += "\\t";
          count.bump("字符串内未转义制表符");
          i++;
          continue;
        }
        if (c < " ") {
          out += `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`;
          i++;
          continue;
        }
        out += c;
        i++;
      }
      continue;
    }

    /* 单引号字符串 → 双引号 */
    if (ch === "'") {
      let body = "";
      let j = i + 1;
      while (j < n) {
        const c = input[j]!;
        if (c === "\\") {
          const nxt = input[j + 1] ?? "";
          body += nxt === "'" ? "'" : nxt === '"' ? '\\"' : `\\${nxt}`;
          j += 2;
          continue;
        }
        if (c === "'") {
          j++;
          break;
        }
        if (c === '"') {
          body += '\\"';
          j++;
          continue;
        }
        if (c === "\n") {
          body += "\\n";
          j++;
          continue;
        }
        body += c;
        j++;
      }
      out += `"${body}"`;
      i = j;
      count.bump("单引号字符串");
      continue;
    }

    /* 尾逗号：`,` 后（跳空白/注释）是 } 或 ] → 丢弃 */
    if (ch === ",") {
      const k = skipWsComments(i + 1);
      if (input[k] === "}" || input[k] === "]") {
        count.bump("尾逗号");
        i++;
        continue;
      }
      out += ch;
      i++;
      continue;
    }

    /* 智能引号：成对出现且作键（后跟冒号）或值（在值位）→ 转直引号 */
    if (ch === "“" || ch === "‘") {
      const closer = ch === "“" ? "”" : "’";
      const end = input.indexOf(closer, i + 1);
      if (end > i) {
        const after = skipWs(end + 1);
        const isKey = input[after] === ":";
        const ctxChar = lastSig();
        const isValuePos = ctxChar === ":" || ctxChar === "," || ctxChar === "[" || ctxChar === "";
        if (isKey || isValuePos) {
          const body = input
            .slice(i + 1, end)
            .replace(/\\/g, "\\\\")
            .replace(/"/g, '\\"')
            .replace(/\n/g, "\\n");
          out += `"${body}"`;
          i = end + 1;
          count.bump(isKey ? "中文引号键名" : "中文引号字符串");
          continue;
        }
      }
      out += ch;
      i++;
      continue;
    }

    /* 裸键名 / 裸字面量：{,} 之后或上一有效字符是 { 或 , 时 */
    if (isIdentStart(ch)) {
      const ctxChar = lastSig();
      let j = i;
      while (j < n && isIdentPart(input[j]!)) j++;
      const word = input.slice(i, j);
      const after = skipWsComments(j);
      const isKeyPos = ctxChar === "{" || ctxChar === "," || ctxChar === "";
      if (input[after] === ":" && isKeyPos) {
        out += `"${word}"`;
        i = j;
        count.bump("裸键名");
        continue;
      }
      if (!isKeyPos && (word === "undefined" || word === "NaN" || word === "Infinity")) {
        out += "null";
        i = j;
        count.bump(`${word} → null`);
        continue;
      }
      out += word;
      i = j;
      continue;
    }

    out += ch;
    i++;
  }
  return out;
}

/* ---------------- ③ 截断补全 ---------------- */

const NOT_JSON = Symbol("not-json");

function tryParse(text: string): unknown | typeof NOT_JSON {
  try {
    return JSON.parse(text);
  } catch {
    return NOT_JSON;
  }
}

/**
 * 扫描文本（字符串/注释感知）返回未闭合结构的收尾串；文本本身合法则为 ""。
 * 例：`{"a":[1,2` → `]}`。
 */
function closersFor(text: string): string {
  const stack: string[] = [];
  let inStr = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (inStr) {
      if (c === "\\") i++;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{") stack.push("}");
    else if (c === "[") stack.push("]");
    else if (c === "}" || c === "]") stack.pop();
  }
  let out = inStr ? '"' : "";
  while (stack.length) out += stack.pop();
  return out;
}

/** 策略 A：清理悬挂的尾巴（尾逗号/冒号/半个键），再按栈补闭合 */
function closeAndParse(text: string): string | null {
  let s = text.replace(/\s+$/, "");
  for (let round = 0; round < 4; round++) {
    const before = s;
    if (s.endsWith(":")) s = s.slice(0, -1).replace(/\s+$/, "");
    if (s.endsWith(",")) s = s.slice(0, -1).replace(/\s+$/, "");
    // 悬挂的键："…"（刚被切断的键）——去掉后若尾巴是 , 或 : 继续循环处理
    const m = /"((?:[^"\\]|\\.)*)"$/.exec(s);
    if (m) {
      const beforeKey = s.slice(0, m.index).replace(/\s+$/, "");
      if (beforeKey.endsWith(",") || beforeKey.endsWith("{") || beforeKey.endsWith("[")) {
        s = beforeKey;
      }
    }
    if (s === before) break;
  }
  const candidate = s + closersFor(s);
  return tryParse(candidate) !== NOT_JSON ? candidate : null;
}

/** 策略 B：从尾部反向找完整元素边界（, 处截断），逐候选尝试闭合 */
function salvageByCut(text: string): string | null {
  const cuts: number[] = [];
  let inStr = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (inStr) {
      if (c === "\\") i++;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === ",") cuts.push(i);
  }
  let tried = 0;
  for (let k = cuts.length - 1; k >= 0 && tried < MAX_CUT_CANDIDATES; k--, tried++) {
    const prefix = text.slice(0, cuts[k]).replace(/\s+$/, "");
    const candidate = prefix + closersFor(prefix.replace(/"$/, ""));
    const parsed = tryParse(candidate);
    if (parsed !== NOT_JSON) return candidate;
  }
  return null;
}
