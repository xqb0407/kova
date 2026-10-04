/**
 * 移动端代码块高亮：零依赖的正则分词器。
 *
 * 桌面/web 端的高亮是 streamdown + Shiki（WASM + oniguruma），RN 上没有对应物
 * （react-native-marked 也不提供 highlight 注入点），所以这里自带一个够用的
 * tokenizer：按语言把源码切成「注释/字符串/数字/关键字/标识符…」的 token 流，
 * 由 CodeBlock 渲染成带色的嵌套 <Text>。
 *
 * 取舍是刻意的：
 * - 不做语法树、不做嵌套作用域——聊天里的代码块 90% 是脚本/配置/片段，
 *   词法着色已经和肉眼预期的「高亮」等价；
 * - 规则里只准用非捕获组（每个规则外面包一层捕获组，组号 = 规则号），
 *   新增语言时漏了这条会让整个表错位；
 * - 超过 SIZE_CAP 的块直接回退纯文本：流式期间每个节流拍都要全量分词，
 *   巨型块的正则会把 JS 线程拖到掉帧。
 */

export type Tok = { v: string; c?: string };

type Rule = { c: string; p: string };
type LangDef = { flags?: string; rules: Rule[] };

const C_LINE = (ch: string) => `${ch}[^\\n]*`;
const C_BLOCK = "/\\*[\\s\\S]*?\\*/";
const DQ = '"(?:[^\\\\\\n"]|\\\\.)*"';
const SQ = "'(?:[^\\\\\\n']|\\\\.)*'";
const BT = "`(?:[^\\\\`]|\\\\.)*`";
const NUM = "\\b(?:0[xXbBoO][0-9a-fA-F_]+|\\d[\\d_]*(?:\\.\\d+)?(?:[eE][+-]?\\d+)?)\\b";
const KW = (words: string) => `\\b(?:${words})\\b`;
const FN = "\\b[a-zA-Z_$][\\w$]*(?=\\s*\\()";
const CLS = "\\b[A-Z][A-Za-z0-9_]*\\b";

const JS_KW =
  "const|let|var|function|return|if|else|for|while|do|switch|case|default|break|continue|new|class|extends|implements|interface|enum|async|await|yield|try|catch|finally|throw|import|export|from|as|of|in|instanceof|typeof|void|delete|null|undefined|true|false|this|super|static|public|private|protected|readonly|get|set|keyof|infer|satisfies|is";

const TS: LangDef = {
  rules: [
    { c: "comment", p: `(?:${C_LINE("//")}|${C_BLOCK})` },
    { c: "string", p: `(?:${BT}|${DQ}|${SQ})` },
    { c: "number", p: NUM },
    { c: "keyword", p: KW(JS_KW) },
    { c: "title", p: FN },
    { c: "type", p: CLS },
  ],
};

const PY: LangDef = {
  rules: [
    { c: "comment", p: C_LINE("#") },
    {
      c: "string",
      p: `(?:[a-zA-Z]{0,2}(?:"""[\\s\\S]*?"""|'''[\\s\\S]*?''')|[a-zA-Z]{0,2}(?:${DQ}|${SQ})|(?:${DQ}|${SQ}))`,
    },
    { c: "number", p: NUM },
    { c: "keyword", p: KW("def|class|return|if|elif|else|for|while|import|from|as|pass|break|continue|try|except|finally|raise|with|lambda|yield|global|nonlocal|assert|del|in|is|not|and|or|None|True|False|async|await|self|match|case") },
    { c: "meta", p: "@[\\w.]+" },
    { c: "title", p: FN },
  ],
};

const SH: LangDef = {
  rules: [
    { c: "comment", p: C_LINE("#") },
    { c: "string", p: `(?:${DQ}|${SQ})` },
    { c: "variable", p: "\\$(?:\\w+|\\{[^}]*\\})" },
    { c: "number", p: NUM },
    { c: "keyword", p: KW("if|then|else|elif|fi|for|while|do|done|case|esac|function|in|return|export|local|source|set|unset|shift|trap|eval") },
    { c: "title", p: KW("echo|cd|ls|cat|grep|sed|awk|sudo|apt|brew|npm|npx|pnpm|yarn|git|docker|curl|wget|make|python|python3|node|bun|chmod|mkdir|rm|mv|cp|find|xargs|kubectl|ssh") },
  ],
};

const JSONL: LangDef = {
  rules: [
    { c: "meta", p: `${DQ}(?=\\s*:)` },
    { c: "string", p: DQ },
    { c: "number", p: NUM },
    { c: "keyword", p: KW("true|false|null") },
  ],
};

const YAML: LangDef = {
  flags: "m",
  rules: [
    { c: "comment", p: C_LINE("#") },
    { c: "meta", p: "^[ \\t]*[\\w.-]+(?=:(?:\\s|$))" },
    { c: "string", p: `(?:${DQ}|${SQ})` },
    { c: "number", p: NUM },
    { c: "keyword", p: KW("true|false|null|yes|no|on|off|&\\*|~") },
  ],
};

const CSS: LangDef = {
  rules: [
    { c: "comment", p: C_BLOCK },
    { c: "string", p: `(?:${DQ}|${SQ})` },
    { c: "keyword", p: "@[\\w-]+" },
    { c: "meta", p: "[\\w-]+(?=\\s*:)" },
    { c: "number", p: "(?:#[0-9a-fA-F]{3,8}\\b|\\b\\d[\\d.]*(?:px|em|rem|%|vh|vw|s|ms|deg)?\\b)" },
    { c: "title", p: "[a-zA-Z-]+(?=\\()" },
  ],
};

const HTML: LangDef = {
  rules: [
    { c: "comment", p: "<!--[\\s\\S]*?-->" },
    { c: "string", p: `(?:${DQ}|${SQ})` },
    { c: "keyword", p: "</?[\\w-]+|/?>|<[?!][\\w-]*" },
    { c: "meta", p: "[\\w-]+(?==)" },
  ],
};

const SQL: LangDef = {
  flags: "i",
  rules: [
    { c: "comment", p: `(?:--[^\\n]*|${C_BLOCK})` },
    { c: "string", p: `(?:${DQ}|${SQ})` },
    { c: "number", p: NUM },
    { c: "keyword", p: KW("select|from|where|insert|into|values|update|set|delete|join|left|right|inner|outer|on|group|by|order|limit|offset|as|and|or|not|null|in|is|like|between|having|distinct|create|table|alter|drop|index|view|primary|key|foreign|references|default|constraint|union|all|with|recursive|case|when|then|else|end|cast|exists") },
    { c: "title", p: "\\b[a-zA-Z_][\\w]*(?=\\s*\\()" },
  ],
};

const C_LIKE = (kw: string): LangDef => ({
  rules: [
    { c: "comment", p: `(?:${C_LINE("//")}|${C_BLOCK})` },
    { c: "string", p: `(?:${DQ}|${SQ})` },
    { c: "number", p: NUM },
    { c: "keyword", p: KW(kw) },
    { c: "title", p: FN },
    { c: "type", p: CLS },
  ],
});

const DIFF: LangDef = {
  flags: "m",
  rules: [
    { c: "string", p: "^\\+[^\\n]*" },
    { c: "keyword", p: "^-[^\\n]*" },
    { c: "meta", p: "^@@[^\\n]*" },
  ],
};

const MD: LangDef = {
  flags: "m",
  rules: [
    { c: "keyword", p: "^#{1,6}[^\\n]*" },
    { c: "string", p: "(?:\\*\\*[^*\\n]+\\*\\*|\\*[^*\\n]+\\*|`[^`\\n]+`)" },
    { c: "meta", p: "\\[[^\\]\\n]*\\]\\([^)\\n]*\\)" },
    { c: "comment", p: "^>[^\\n]*" },
  ],
};

const LANGS: Record<string, LangDef> = {
  ts: TS,
  typescript: TS,
  tsx: TS,
  js: TS,
  javascript: TS,
  jsx: TS,
  mjs: TS,
  cjs: TS,
  py: PY,
  python: PY,
  sh: SH,
  bash: SH,
  zsh: SH,
  shell: SH,
  json: JSONL,
  jsonc: JSONL,
  json5: JSONL,
  yaml: YAML,
  yml: YAML,
  toml: YAML,
  css: CSS,
  scss: CSS,
  less: CSS,
  html: HTML,
  xml: HTML,
  svg: HTML,
  sql: SQL,
  go: C_LIKE("package|import|func|return|if|else|for|range|switch|case|default|break|continue|type|struct|interface|map|chan|go|defer|var|const|nil|true|false|string|int|int64|float64|bool|error"),
  rust: C_LIKE("fn|let|mut|if|else|for|while|loop|match|return|struct|enum|impl|trait|pub|use|mod|crate|self|super|where|async|await|move|ref|type|const|static|Some|None|Ok|Err|true|false|String|Vec|i32|i64|u32|u64|f32|f64|bool"),
  java: C_LIKE("package|import|public|private|protected|class|interface|extends|implements|static|final|void|return|if|else|for|while|do|switch|case|break|continue|new|try|catch|finally|throw|throws|this|super|abstract|enum|record|null|true|false|int|long|double|float|boolean|char|byte|String|var"),
  kotlin: C_LIKE("fun|val|var|if|else|when|for|while|return|class|interface|object|data|sealed|open|override|private|public|internal|companion|null|true|false|String|Int|Long|Double|Boolean|List|Map|import|package|is|in|as|by|lazy|lateinit"),
  c: C_LIKE("int|long|short|char|float|double|void|return|if|else|for|while|do|switch|case|break|continue|struct|union|enum|typedef|static|const|extern|sizeof|unsigned|signed|NULL|char"),
  cpp: C_LIKE("int|long|char|float|double|void|bool|auto|return|if|else|for|while|do|switch|case|break|continue|class|struct|union|enum|namespace|template|typename|static|const|constexpr|extern|new|delete|public|private|protected|virtual|override|nullptr|true|false|std|string|vector"),
  cs: C_LIKE("using|namespace|class|interface|struct|enum|public|private|protected|internal|static|void|var|const|readonly|return|if|else|for|foreach|while|do|switch|case|break|continue|new|try|catch|finally|throw|null|true|false|int|string|bool|double|float|object|async|await"),
  swift: C_LIKE("func|let|var|if|else|guard|return|for|while|switch|case|break|continue|class|struct|enum|protocol|extension|import|public|private|internal|fileprivate|static|final|override|init|deinit|self|super|nil|true|false|String|Int|Double|Bool|Array|Dictionary|Optional|async|await|throws|throw|try|catch"),
  ruby: C_LIKE("def|end|class|module|if|elsif|else|unless|while|until|for|in|do|return|yield|begin|rescue|ensure|raise|require|attr_accessor|attr_reader|self|nil|true|false|and|or|not|then|case|when|lambda|proc|puts|print"),
  php: C_LIKE("function|class|interface|trait|extends|implements|public|private|protected|static|const|var|echo|print|return|if|else|elseif|for|foreach|while|do|switch|case|break|continue|try|catch|finally|throw|new|use|namespace|null|true|false|array|echo"),
  diff: DIFF,
  md: MD,
  markdown: MD,
};

const SIZE_CAP = 30_000;

type Compiled = { re: RegExp; classes: string[] };
const compiledCache = new Map<string, Compiled>();

function compile(lang: string): Compiled | null {
  const hit = compiledCache.get(lang);
  if (hit) return hit;
  const def = LANGS[lang];
  if (!def) return null;
  const classes = def.rules.map((r) => r.c);
  const source = def.rules.map((r) => `(${r.p})`).join("|");
  const flags = `g${(def.flags ?? "").replace(/g/g, "")}`;
  const compiled: Compiled = { re: new RegExp(source, flags), classes };
  compiledCache.set(lang, compiled);
  return compiled;
}

/** 分词入口：语言不认识、块过大、正则异常都回 null（调用方回退纯文本）。 */
export function highlightCode(code: string, language: string | undefined): Tok[] | null {
  const lang = (language ?? "").trim().toLowerCase();
  if (!lang || code.length > SIZE_CAP) return null;
  const compiled = compile(lang);
  if (!compiled) return null;
  const { re, classes } = compiled;
  re.lastIndex = 0;
  const toks: Tok[] = [];
  let last = 0;
  try {
    let m: RegExpExecArray | null;
    while ((m = re.exec(code)) !== null) {
      if (m[0].length === 0) {
        re.lastIndex += 1;
        continue;
      }
      if (m.index > last) toks.push({ v: code.slice(last, m.index) });
      let cls: string | undefined;
      for (let g = 1; g < m.length; g += 1) {
        if (m[g] !== undefined) {
          cls = classes[g - 1];
          break;
        }
      }
      toks.push({ v: m[0], c: cls });
      last = m.index + m[0].length;
    }
  } catch {
    return null;
  }
  if (last < code.length) toks.push({ v: code.slice(last) });
  return toks;
}

/** GitHub 风格双色板（token 类 → 颜色）；由 CodeBlock 按当前 scheme 取用 */
export const CODE_PALETTE: Record<"light" | "dark", Record<string, string>> = {
  light: {
    comment: "#6e7781",
    string: "#0a3069",
    number: "#0550ae",
    keyword: "#cf222e",
    title: "#8250df",
    type: "#953800",
    meta: "#116329",
    variable: "#953800",
  },
  dark: {
    comment: "#8b949e",
    string: "#a5d6ff",
    number: "#79c0ff",
    keyword: "#ff7b72",
    title: "#d2a8ff",
    type: "#ffa657",
    meta: "#7ee787",
    variable: "#ffa657",
  },
};
