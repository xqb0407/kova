/**
 * cURL 命令解析(纯函数):把终端里复制的 curl 一键转成自定义搜索服务配置。
 *
 * 支持的旗标:
 *   -X/--request           方法(仅认 GET/POST,其它方法不映射)
 *   -H/--header            "K: V",可重复,同名后者覆盖
 *   -d/--data/--data-raw/--data-binary/--data-urlencode   请求体(多次用 & 连接)
 *   -A/--user-agent        → User-Agent 头
 *   -e/--referer           → Referer 头
 *   --url                  → URL;裸参数(非旗标)也当 URL
 * 无值旗标(-s -S -L -k --compressed -v -g 等)跳过;不认识的旗标也跳过。
 * 单双引号与 \ 转义都能吃;非 curl 开头或没有 URL 返回 null。
 */

export interface ParsedCurl {
  /** 仅 GET/POST 会被映射;其它方法不返回(表单保持当前值) */
  method?: "GET" | "POST";
  url?: string;
  headers: Record<string, string>;
  body?: string;
}

const VALUE_FLAGS = new Set([
  "-X",
  "--request",
  "-H",
  "--header",
  "-d",
  "--data",
  "--data-raw",
  "--data-binary",
  "--data-urlencode",
  "-A",
  "--user-agent",
  "-e",
  "--referer",
  "--url",
]);

const NO_VALUE_FLAGS = new Set([
  "-s",
  "-S",
  "-L",
  "-k",
  "--insecure",
  "--compressed",
  "-v",
  "--verbose",
  "-i",
  "--include",
  "-g",
  "--globoff",
  "-4",
  "-6",
  "--fail",
  "--silent",
]);

/** 分词:空格切分;单引号字面量(支持 '\'' 拼接),双引号支持 \" 转义 */
function tokenize(input: string): string[] {
  const tokens: string[] = [];
  let cur = "";
  let hasCur = false;
  let i = 0;
  while (i < input.length) {
    const ch = input[i];
    if (ch === " " || ch === "\t" || ch === "\n") {
      if (hasCur) {
        tokens.push(cur);
        cur = "";
        hasCur = false;
      }
      i += 1;
      continue;
    }
    if (ch === "'") {
      i += 1;
      hasCur = true;
      while (i < input.length && input[i] !== "'") {
        cur += input[i];
        i += 1;
      }
      i += 1; // 吃掉收尾引号
      continue;
    }
    if (ch === '"') {
      i += 1;
      hasCur = true;
      while (i < input.length && input[i] !== '"') {
        if (input[i] === "\\" && i + 1 < input.length) {
          cur += input[i + 1];
          i += 2;
          continue;
        }
        cur += input[i];
        i += 1;
      }
      i += 1;
      continue;
    }
    if (ch === "\\" && i + 1 < input.length) {
      cur += input[i + 1];
      i += 2;
      hasCur = true;
      continue;
    }
    cur += ch;
    hasCur = true;
    i += 1;
  }
  if (hasCur) tokens.push(cur);
  return tokens;
}

export function parseCurlCommand(input: string): ParsedCurl | null {
  const trimmed = input.trim();
  if (!/^curl(\s|$)/.test(trimmed)) return null;
  const tokens = tokenize(trimmed);

  const out: ParsedCurl = { headers: {} };
  const bodies: string[] = [];
  let methodRaw: string | undefined;

  for (let i = 0; i < tokens.length; i += 1) {
    const tok = tokens[i];
    if (i === 0 && tok === "curl") continue;
    if (VALUE_FLAGS.has(tok)) {
      const value = tokens[i + 1];
      if (value === undefined) continue;
      i += 1;
      if (tok === "-X" || tok === "--request") {
        methodRaw = value;
      } else if (tok === "-H" || tok === "--header") {
        const idx = value.indexOf(":");
        if (idx > 0) {
          const name = value.slice(0, idx).trim();
          const val = value.slice(idx + 1).trim();
          if (name) out.headers[name] = val;
        }
      } else if (tok === "-A" || tok === "--user-agent") {
        out.headers["User-Agent"] = value;
      } else if (tok === "-e" || tok === "--referer") {
        out.headers["Referer"] = value;
      } else if (tok === "--url") {
        out.url ??= value;
      } else {
        bodies.push(value);
      }
      continue;
    }
    if (NO_VALUE_FLAGS.has(tok)) continue;
    if (tok.startsWith("-")) continue;
    out.url ??= tok;
  }

  if (bodies.length > 0) out.body = bodies.join("&");
  if (methodRaw) {
    const upper = methodRaw.toUpperCase();
    if (upper === "GET" || upper === "POST") out.method = upper;
  } else if (out.body !== undefined) {
    out.method = "POST";
  }
  if (!out.url || !/^https?:\/\//i.test(out.url)) return null;
  return out;
}
