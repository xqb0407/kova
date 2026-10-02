/**
 * 访问加速（镜像改写）：把已知慢/不通的主机 URL 改写成「加速前缀 + 原 URL」形态
 * （ghproxy 系，如 https://ghfast.top/https://github.com/...）。
 *
 * 纯函数、无 IO：配置由 mirror-config.ts 提供，两个调用点——
 *   http-tools.ts  WebFetch 发请求前改写
 *   tools.ts       bash 的 git 环境注入（insteadOf，见 gitAccelEnv）
 * 独立成模块是为了能单测：改写错一个字符，模型拿到 404 却会以为源站没这个文件。
 *
 * 匹配语义：主机精确相等 + 路径按段对齐，首条命中即返回，不做递归改写——
 * 模型自己写好的镜像 URL（https://ghfast.top/https://github.com/...）主机不是
 * github.com，因此不会被改第二遍。
 */

/** ghproxy 系加速站：前缀 + 原 URL 即得可直连地址。换一家只需改设置，不必改代码 */
export const DEFAULT_GITHUB_PREFIX = "https://ghfast.top";

export type MirrorRule = {
  /** 匹配的 URL 前缀：主机精确相等，路径按段对齐 */
  from: string;
  /** 替换前缀：改写结果 = to + 原 URL 中未被 from 吃掉的部分 */
  to: string;
  /** 进一步限定：仅当路径包含其中之一才命中（内建 GitHub 规则用它精确到下载路径） */
  contains?: readonly string[];
};

/** 改写策略：mirror-config.ts 的 MirrorConfig 是它的超集（多三个持久化字段） */
export type MirrorPolicy = {
  /** 加速前缀；空串 = 不改写 GitHub（仍可只用自定义规则） */
  githubPrefix: string;
  /** 用户自定义规则，优先于内建规则 */
  customRules?: readonly { from: string; to: string }[];
};

export type MirrorMatch = {
  /** 改写后的 URL */
  url: string;
  /** 命中的规则 */
  rule: MirrorRule;
};

export type MirrorOutcome = {
  /** 实际要请求的 URL（未改写时等于原 URL） */
  url: string;
  match?: MirrorMatch;
  /** 命中规则但 URL 带凭据，为不把 token 送给第三方加速站而跳过 */
  skippedCredential?: boolean;
};

/** 只服务文件、没有 HTML 页面的主机：整站改写，加速收益最大且无副作用 */
const GITHUB_HOST_RULES: readonly string[] = [
  "raw.githubusercontent.com",
  "gist.githubusercontent.com",
  "codeload.github.com",
  "objects.githubusercontent.com",
];

/** github.com 上只改写下载类路径：仓库页面国内多数网络能开，绕第三方反而更慢，
 *  也免得把普通浏览导去代理。发行包与源码包才是卡死的那几步。 */
const GITHUB_DOWNLOAD_PATHS: readonly string[] = [
  "/releases/download/",
  "/releases/latest/download/",
  "/archive/",
  "/raw/",
];

/** 前缀规整：trim、去尾斜杠、必须是带主机的 http(s) 绝对地址且不含查询/锚点。
 *  非法返回 ""——调用方按「没配」处理，绝不拿半个字符串去拼 URL。 */
export function normalizeMirrorPrefix(raw: unknown): string {
  if (typeof raw !== "string") return "";
  const s = raw.trim().replace(/\/+$/, "");
  if (!s) return "";
  try {
    const u = new URL(s);
    if (u.protocol !== "http:" && u.protocol !== "https:") return "";
    if (u.search || u.hash) return "";
    return s;
  } catch {
    return "";
  }
}

/** 规则前缀解析：host + 去尾斜杠的路径（根路径归为空串） */
function parsePrefix(raw: string): { host: string; path: string } | null {
  const norm = normalizeMirrorPrefix(raw);
  if (!norm) return null;
  const u = new URL(norm);
  return { host: u.host, path: u.pathname.replace(/\/+$/, "") };
}

/** 路径按段对齐：/releases 只吃 /releases 本身与 /releases/… ，
 *  不吃 /releases-notes。返回被吃掉的原路径长度，-1 = 不匹配。 */
function consumedPathLength(pathname: string, basePath: string): number {
  if (basePath === "") return 0;
  if (pathname === basePath) return basePath.length;
  if (pathname.startsWith(`${basePath}/`)) return basePath.length;
  return -1;
}

/** 按规则表改写 URL：首条命中即返回；非 http(s)、非法 URL、无命中都返回 null */
export function applyMirrorRules(
  rawUrl: string,
  rules: readonly MirrorRule[],
): MirrorMatch | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;

  for (const rule of rules) {
    const from = parsePrefix(rule.from);
    const to = normalizeMirrorPrefix(rule.to);
    if (!from || !to) continue;
    if (from.host !== url.host) continue;
    const consumed = consumedPathLength(url.pathname, from.path);
    if (consumed < 0) continue;
    if (rule.contains && !rule.contains.some((p) => url.pathname.includes(p))) continue;
    return { url: to + url.pathname.slice(consumed) + url.search + url.hash, rule };
  }
  return null;
}

/** 内建 GitHub 规则：把加速前缀套在原始 URL 前面（ghproxy 系形态） */
export function githubRules(prefix: string): MirrorRule[] {
  const p = normalizeMirrorPrefix(prefix);
  if (!p) return [];
  const rules: MirrorRule[] = GITHUB_HOST_RULES.map((host) => ({
    from: `https://${host}/`,
    to: `${p}/https://${host}/`,
  }));
  rules.push({
    from: "https://github.com/",
    to: `${p}/https://github.com/`,
    contains: GITHUB_DOWNLOAD_PATHS,
  });
  return rules;
}

/** 自定义规则在前、内建在后：用户显式写的规则优先命中（首条命中即返回） */
export function policyRules(policy: MirrorPolicy): MirrorRule[] {
  const custom: MirrorRule[] = [];
  for (const rule of policy.customRules ?? []) {
    const from = normalizeMirrorPrefix(rule.from);
    const to = normalizeMirrorPrefix(rule.to);
    if (from && to) custom.push({ from, to });
  }
  return [...custom, ...githubRules(policy.githubPrefix)];
}

/** 凭据类查询参数名：私有仓库的 raw 链接靠它带 token */
const CREDENTIAL_QUERY_RE = /^(access_token|token|private_token|api_key|apikey|key)$/i;

/**
 * URL/请求头里是否带了凭据。带了就不改写——加速站是第三方，token 不能出境：
 * 私有仓库的 raw 链接（?token=…）、带 Authorization/Cookie 头的 API 调用都走这条。
 */
export function hasCredential(rawUrl: string, headers?: Record<string, string>): boolean {
  if (headers) {
    for (const name of Object.keys(headers)) {
      const lower = name.toLowerCase();
      if (lower === "authorization" || lower === "cookie") return true;
    }
  }
  try {
    const u = new URL(rawUrl);
    if (u.username || u.password) return true;
    for (const [key] of u.searchParams) {
      if (CREDENTIAL_QUERY_RE.test(key)) return true;
    }
  } catch {
    // 非法 URL：applyMirrorRules 同样不改写，这里不必报错
  }
  return false;
}

/** 策略 → 实际请求 URL（WebFetch 用）。无规则/未命中/带凭据都原样返回。 */
export function mirrorUrl(
  rawUrl: string,
  policy: MirrorPolicy,
  headers?: Record<string, string>,
): MirrorOutcome {
  const rules = policyRules(policy);
  if (rules.length === 0) return { url: rawUrl };
  const match = applyMirrorRules(rawUrl, rules);
  if (!match) return { url: rawUrl };
  if (hasCredential(rawUrl, headers)) return { url: rawUrl, skippedCredential: true };
  return { url: match.url, match };
}

/**
 * git 加速环境变量：把 github.com 的读写地址改到镜像（`url.<base>.insteadOf`）。
 * 由 Rust 宿主注入到那一条 bash 派生进程，不落盘、不改用户自己的 git 配置。
 *
 * 注意 GIT_CONFIG_COUNT 会覆盖进程环境里已有的同名变量——桌面应用派生的 shell
 * 不加载用户 rc，撞上的概率可忽略；真撞上也只影响这一条命令。
 */
export function gitAccelEnv(policy: MirrorPolicy): Record<string, string> | null {
  const p = normalizeMirrorPrefix(policy.githubPrefix);
  if (!p) return null;
  const base = `${p}/https://github.com/`;
  return {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: `url.${base}.insteadOf`,
    GIT_CONFIG_VALUE_0: "https://github.com/",
  };
}

/** 只认 HTTPS 形态的 github.com；SSH（git@github.com:）不动——
 *  用 SSH 的人本来就通，改成镜像反而会把带凭据的写操作送到第三方。 */
const GIT_PUSH_RE = /\bpush\b/i;

/**
 * 该 shell 命令要不要注入 git 加速环境。
 * 出现 push 就整体跳过：镜像只代理读（clone/fetch），写操作的凭据既过不去、
 * 也不该发给第三方。判断放宽到「命令里出现 push 这个词」——误判只会少一次
 * 加速，不会让命令跑错方向。
 */
export function shouldAccelerateGit(command: unknown): boolean {
  return typeof command === "string" && !GIT_PUSH_RE.test(command);
}
