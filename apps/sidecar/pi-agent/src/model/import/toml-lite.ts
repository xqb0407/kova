/**
 * TOML 窄读取器：只解析 Codex config.toml 里的**标量**，够用且不引依赖。
 *
 * 为什么不用完整 TOML 解析器：Codex 的 config.toml 里除了我们需要的
 * `[model_providers.*]`，还混着大量与导入无关的结构（mcp_servers 的嵌套表、
 * shell_environment_policy、projects 的带引号键）。为读四个标量引入一个
 * 解析器不划算，而完整语法（多行数组、内联表、日期）我们一个都用不上。
 *
 * 输出是**扁平点分路径**表（`model_providers.custom.base_url` → 值），而不是
 * 嵌套对象：Codex 的表名带引号与点号（`plugins."a@b"`），扁平键省掉一层
 * 转义推���，调用方按前缀过滤即可。
 *
 * 遇到数组、内联表、数组表一律**跳过而非报错**——它们的值对我们无用，
 * 解析器只保证不把它们误认成标量。
 */

export type TomlScalar = string | number | boolean;
/** 点分路径 → 标量值 */
export type TomlScalars = Record<string, TomlScalar>;

/** 去掉行尾注释：`#` 在引号外才算注释起点 */
function stripComment(line: string): string {
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quote) {
      // 双引号串支持 \" 转义，单引号串（literal）不处理转义
      if (quote === '"' && ch === "\\") {
        i += 1;
      } else if (ch === quote) {
        quote = null;
      }
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === "#") {
      return line.slice(0, i);
    }
  }
  return line;
}

/** 引号内的括号不参与深度计数（`["a]b"]` 不是嵌套） */
function bracketDelta(text: string): number {
  let quote: '"' | "'" | null = null;
  let delta = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      if (quote === '"' && ch === "\\") i += 1;
      else if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === "[" || ch === "{") {
      delta += 1;
    } else if (ch === "]" || ch === "}") {
      delta -= 1;
    }
  }
  return delta;
}

/** 表头/key 里的引号段剥掉：`"a.b"` → `a.b`，`.` 原样保留作路径分隔 */
const unquoteKey = (key: string): string =>
  key
    .split(".")
    .map((seg) => seg.trim().replace(/^["']|["']$/g, ""))
    .filter(Boolean)
    .join(".");

/** 基本串的转义还原；未知转义原样保留（\q → \q） */
function unescapeBasic(body: string): string {
  let out = "";
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (ch !== "\\") {
      out += ch;
      continue;
    }
    const next = body[++i];
    switch (next) {
      case "n": out += "\n"; break;
      case "t": out += "\t"; break;
      case "r": out += "\r"; break;
      case '"': out += '"'; break;
      case "\\": out += "\\"; break;
      case "b": out += "\b"; break;
      case "f": out += "\f"; break;
      case undefined: out += "\\"; break;
      default: out += `\\${next}`;
    }
  }
  return out;
}

/** 标量值 → JS 值。非标量（数组/内联表/空）返回 undefined = 不记录 */
function parseScalar(raw: string): TomlScalar | undefined {
  const value = raw.trim();
  if (!value) return undefined;
  const first = value[0];
  if (first === '"') {
    // 找到未转义的收尾引号
    for (let i = 1; i < value.length; i += 1) {
      if (value[i] === "\\") { i += 1; continue; }
      if (value[i] === '"') return unescapeBasic(value.slice(1, i));
    }
    return undefined;
  }
  if (first === "'") {
    const end = value.indexOf("'", 1);
    return end > 0 ? value.slice(1, end) : undefined;
  }
  if (value === "true") return true;
  if (value === "false") return false;
  // 去掉数字里的下划线分隔符再判；日期等非数字 token 原样当字符串
  if (/^[+-]?[\d_]/.test(value)) {
    const n = Number(value.replace(/_/g, ""));
    if (!Number.isNaN(n)) return n;
  }
  if (first === "[" || first === "{") return undefined;
  return value;
}

/**
 * 解析 TOML 文本的标量赋值。表头 `[a.b]` 与 `[[a.b]]` 都只用来更新当前
 * 路径前缀（数组表的内容逐条覆盖，对我们按前缀读的用法无影响）。
 */
export function parseTomlScalars(text: string): TomlScalars {
  const out: TomlScalars = {};
  let currentPath = "";
  // >0 表示正在跳过一个跨行的数组/内联表：这期间不解析任何赋值
  let skipDepth = 0;

  for (const rawLine of text.split(/\r?\n/)) {
    if (skipDepth > 0) {
      skipDepth += bracketDelta(stripComment(rawLine));
      if (skipDepth < 0) skipDepth = 0;
      continue;
    }
    const line = stripComment(rawLine).trim();
    if (!line) continue;

    if (line.startsWith("[")) {
      const inner = line.replace(/^\[+\s*/, "").replace(/\s*\]+$/, "");
      currentPath = unquoteKey(inner);
      continue;
    }

    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = unquoteKey(line.slice(0, eq));
    if (!key) continue;
    const rest = line.slice(eq + 1);
    // 数组/内联表：连同可能跨行的部分整段跳过，绝不误记成标量
    if (/^[[{]/.test(rest.trim())) {
      skipDepth = bracketDelta(stripComment(rest));
      if (skipDepth > 0) continue;
      continue;
    }
    const scalar = parseScalar(rest);
    if (scalar === undefined) continue;
    out[currentPath ? `${currentPath}.${key}` : key] = scalar;
  }
  return out;
}

/**
 * 取某个前缀下的**子表**，每个子表只保留自己的直接标量键：
 * `tomlTables(s, "model_providers")` 对 `model_providers.custom.base_url` 与
 * `...custom.wire_api` 返回 `{ custom: { base_url: …, wire_api: … } }`。
 *
 * 再深的层级（`mcp_servers.time.env.X`）不展开——Codex 只需要一层，
 * 展开就得引入"哪些键属于哪一层"的归属规则，不值当。
 */
export function tomlTables(
  scalars: TomlScalars,
  prefix: string,
): Record<string, Record<string, TomlScalar>> {
  const head = `${prefix}.`;
  const out: Record<string, Record<string, TomlScalar>> = {};
  for (const [path, value] of Object.entries(scalars)) {
    if (!path.startsWith(head)) continue;
    const rest = path.slice(head.length);
    const dot = rest.indexOf(".");
    if (dot < 0) {
      // 前缀下的直接标量（如顶层 `model`）：不属任何子表，跳过
      continue;
    }
    const table = rest.slice(0, dot);
    const key = rest.slice(dot + 1);
    // 只收子表的直接键：`mcp_servers.time.env.FOO` 的 env 不算 time 的键
    if (key.includes(".")) continue;
    (out[table] ??= {})[key] = value;
  }
  return out;
}