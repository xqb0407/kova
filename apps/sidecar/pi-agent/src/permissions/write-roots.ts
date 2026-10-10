/**
 * 可写根清单（`workspace-write` 档的「额外放行目录」）。
 *
 * 解决的问题：工作区内随便改、工作区外要问，这是 `workspace-write` 档的承诺。
 * 但真实工作常跨项目（前后端两个目录、共享库、monorepo 外的脚手架），每次都弹确认
 * 就成了纯噪声。所以给一份清单：列进去的目录按「工作区内」对待，不再问。
 *
 * 三层文件，优先级越靠后越具体（并集，不是覆盖）：
 *   ~/.kova/permissions.json            用户级：所有项目
 *   <cwd>/.kova/permissions.json        项目共享：进 git，团队同一份
 *   <cwd>/.kova/permissions.local.json  项目本地：本机、建议加 .git/info/exclude
 *
 * 形状：`{ "writeRoots": ["../shared-lib", "~/work/cache"] }`
 * 相对路径相对 `cwd` 解析，`~/` 相对家目录。
 *
 * 同一份文件里还住着另外两种授权规则（`allowCommands` / `allowMcpTools`），
 * 三者同属「本机许可」，写回时互不抹掉。
 *
 * ## 项目文件只能提议，不能授权
 *
 * `.kova/permissions.json` 跟着仓库走——clone 一个别人的项目，那个仓库不该有权
 * 给 agent 授权写你的家目录。所以项目层声明的根**永远不生效**（`declared`），
 * 只出现在审批卡上作为「这个项目请求放行 X」的说明；你点了「允许并记住」之后，
 * 它才被写进**你自己的** `.kova/permissions.local.json`——从那一刻起生效。
 *
 * 这条结构上就成立：没有任何「信任状态」可以被仓库伪造，唯一能授权的文件都在
 * 你自己机器上（local 是本机、git 里排掉，user 是你的全局配置）。
 */
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { isInside, realResolve } from "../agent/workspace-boundary";
import { logErr } from "../log";

/** 清单条数上限：防一份畸形文件把每次工具调用的解析拖成开销 */
const MAX_ROOTS = 64;

export type WriteRootsResolution = {
  /** 生效的根（绝对、已解软链、去重）。含工作区自身 */
  effective: string[];
  /**
   * 项目层声明的根——**永远不生效**，只用于审批卡上那句「这个项目请求放行 X」。
   * 用户同意后由 rememberWriteRoot 写进他自己的 local 文件，那时才成为 effective。
   */
  declared: string[];
  /**
   * 免除确认的**命令词前缀规则**（用户级 + 本地级），形态 `pnpm add *`：
   * 逐段校验 + 反藏写守卫 + 转义感知的分段三件套齐了才命中（见
   * commandMatchesRules 的注释）。单靠前缀本身不是边界——前缀规则只是便利，
   * 真正的隔离要靠 OS 级沙箱（见 docs/permission-modes.md）。
   */
  commands: string[];
  /**
   * 免审批的 MCP 工具（`server__tool` 全名，逐字相等）。
   *
   * 为什么是全名而不是 glob：MCP 工具的副作用面完全由服务器作者决定，
   * `dbx__execute_query` 与 `dbx__describe_table` 的风险差着量级，而工具名
   * 本身没有可依赖的语义前缀。前缀规则那套「命中即放行」的便利在这里没有对应物。
   */
  mcpTools: string[];
  /** 读文件/解析的异常说明（不阻断，只进日志与诊断） */
  diagnostics: string[];
};

/** 一份清单文件的规整：坏条目剔除，不整体失败（同 secrets 的宽松口径） */
export function parseWriteRootsFile(raw: unknown): {
  roots: string[];
  commands: string[];
  mcpTools: string[];
  error?: string;
} {
  if (raw === null || raw === undefined) return { roots: [], commands: [], mcpTools: [] };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return { roots: [], commands: [], mcpTools: [], error: "not a JSON object" };
  }
  const obj = raw as { writeRoots?: unknown; allowCommands?: unknown; allowMcpTools?: unknown };
  const roots = readStringList(obj.writeRoots, "writeRoots");
  const commands = readStringList(obj.allowCommands, "allowCommands");
  const mcpTools = readStringList(obj.allowMcpTools, "allowMcpTools");
  const error = [roots.error, commands.error, mcpTools.error].filter(Boolean).join("; ") || undefined;
  return {
    roots: roots.list,
    commands: commands.list,
    mcpTools: mcpTools.list,
    ...(error ? { error } : {}),
  };
}

/**
 * 一份文件里的一个字符串数组字段：坏条目剔除（宽松），但**字段类型错要报**
 * —— 诊断是给人排查「我的清单为什么没生效」用的，静默丢弃等于让人对着一个
 * 写错的字段名发愁。 */
function readStringList(
  value: unknown,
  field: string,
): { list: string[]; error?: string } {
  if (value === undefined) return { list: [] };
  if (!Array.isArray(value)) return { list: [], error: `${field} must be an array` };
  return {
    list: value
      .filter((r): r is string => typeof r === "string" && r.trim() !== "")
      .map((r) => r.trim())
      .slice(0, MAX_ROOTS),
  };
}

/**
 * 一条清单项 → 绝对路径。
 *
 * 只做路径展开，不做存在性校验：目录可能还没建（比如要 agent 顺手创建），
 * 存在与否由 realResolve 的「向上找存在的祖先」自然处理。
 */
export function resolveWriteRoot(
  root: string,
  cwd: string,
  home: string = homedir(),
): string | null {
  const trimmed = root.trim();
  if (!trimmed) return null;
  // 只认 `~/`：`~user` 形态各家 shell 语义不一，宁可当普通相对路径
  const expanded =
    trimmed === "~" ? home : trimmed.startsWith("~/") ? join(home, trimmed.slice(2)) : trimmed;
  return realResolve(isAbsolute(expanded) ? expanded : resolve(cwd, expanded));
}

/**
 * 把一份清单文件里三种规则**原样带回**的写回载荷。
 *
 * 三种规则同住一个文件，任何一处写盘都必须带上另外两种——否则「记住一条命令」
 * 会顺手抹掉用户早先记住的目录与 MCP 工具。各 writer 自己拼 payload 正是当年
 * 那个 bug 的成因，所以收敛到这一个函数。
 */
function payloadWith(
  parsed: { roots: string[]; commands: string[]; mcpTools: string[] },
  patch: Partial<{ writeRoots: string[]; allowCommands: string[]; allowMcpTools: string[] }>,
): string {
  const merged = {
    writeRoots: patch.writeRoots ?? parsed.roots,
    allowCommands: patch.allowCommands ?? parsed.commands,
    allowMcpTools: patch.allowMcpTools ?? parsed.mcpTools,
  };
  const body: Record<string, string[]> = {};
  for (const [key, list] of Object.entries(merged)) {
    if (list.length) body[key] = list;
  }
  return JSON.stringify(body, null, 2) + "\n";
}

/**
 * 把一条根记进本机的 local 清单（用户在审批卡上点「允许并记住」时调用）。
 *
 * 写进 `<cwd>/.kova/permissions.local.json` 而不是项目共享那份：这是**你在本机**
 * 的授权，路径带机器特征，进 git 会污染团队配置、也会让别人的 clone 凭空多出
 * 一条"项目声明"。同时把它加进 `.git/info/exclude`（与 Claude Code 同款），
 * 免得用户多一个需要自己记得排除的未跟踪文件。
 */
export async function rememberWriteRoot(cwd: string, root: string): Promise<void> {
  const file = layerPaths(cwd).local;
  const real = realResolve(root);
  await mkdir(dirname(file), { recursive: true });
  // cwd 也要先归一：不归一时 relative 会用「/var/… 的 cwd」减「/private/var/… 的目标」，
  // 算出 `../../../../private/var/…` 这种看着就不对的相对路径（macOS 上必现）
  const realCwd = realResolve(cwd);
  if (real === realCwd) return; // 记工作区自身没有意义（它本来就在生效集里）
  const parsedFile = parseWriteRootsFile(readLayerFile(file).value);
  const existing = parsedFile.roots;
  // 相对还是绝对：**写字面更短的那个**。同级项目是 `../shared-lib`（短、跟着仓库走
  // 的人看得懂），家目录缓存是绝对路径（`../../../../Users/…` 没人想读）。
  // 不用"是否含 .."当判据——那会把最常见的「工作区外的兄弟目录」推成绝对路径
  const asRel = relative(realCwd, real);
  const entry = asRel && asRel.length <= real.length ? asRel : real;
  if (existing.some((r) => resolveWriteRoot(r, cwd) === real)) return;
  // 三种规则同住一份文件：写回时把另外两种原样带上，别互相抹掉
  await writeFile(
    file,
    payloadWith(parsedFile, { writeRoots: [...existing, entry] }),
    "utf8",
  );
  await ensureGitignored(cwd, relative(cwd, file));
}

/**
 * 把这次批准的命令拆成**前缀规则**记进本机清单（bash 卡上点「允许并记住」时调用）。
 *
 * 规则形态与 Claude Code 的 `Bash(pnpm add *)` 对齐：`"pnpm add *"` = 前缀匹配，
 * 后面接什么参数都算命中；不带 `*` 的写法则逐字相等。
 *
 * 为什么只记前缀、以及前缀**必须**配上 commandMatchesRules 的逐段校验才安全：
 * 见那个函数的注释（`cat *` 单独用就等于放行 `cat x > /etc/hosts`）。
 */
export async function rememberCommand(cwd: string, command: string): Promise<void> {
  const rules = deriveCommandRules(command);
  if (!rules.length) return;
  const file = layerPaths(cwd).local;
  await mkdir(dirname(file), { recursive: true });
  const existing = parseWriteRootsFile(readLayerFile(file).value);
  const merged = [...existing.commands];
  for (const rule of rules) if (!merged.includes(rule)) merged.push(rule);
  if (merged.length === existing.commands.length) return;
  await writeFile(file, payloadWith(existing, { allowCommands: merged }), "utf8");
  await ensureGitignored(cwd, relative(cwd, file));
}

/**
 * 把一个 MCP 工具记进本机清单（MCP 审批卡上点「允许并记住这个工具」时调用）。
 *
 * 粒度是 `server__tool` 全名逐字相等，不带 glob：这条授权的对面是一次真实的
 * 外部副作用（改文件、发请求、写数据库），而 MCP 工具名没有可依赖的语义前缀，
 * `read_*` 未必只读。宁可多问一次。
 *
 * 与另两条规则同纪律：只写本机 local 文件，项目共享那份永远不获得授权效力。
 */
export async function rememberMcpTool(cwd: string, fullName: string): Promise<void> {
  const trimmed = fullName.trim();
  if (!trimmed) return;
  const file = layerPaths(cwd).local;
  const parsed = parseWriteRootsFile(readLayerFile(file).value);
  if (parsed.mcpTools.includes(trimmed)) return;
  await mkdir(dirname(file), { recursive: true });
  await writeFile(
    file,
    payloadWith(parsed, { allowMcpTools: [...parsed.mcpTools, trimmed] }),
    "utf8",
  );
  await ensureGitignored(cwd, relative(cwd, file));
}

/** 解析结果：分段 + 这次解析能不能作为放行依据 */
export type ShellParse = {
  /** 简单命令段（引号与转义内的分隔符不拆，与 shell 一致） */
  segments: string[];
  /**
   * 存在**未加引号的写方向重定向**，且目标不是垃圾桶（`/dev/null`）或 fd 复制
   * （`&N`）。在这一次扫描里顺手判定，不另起一个正则：重定向的识别与分词共用
   * 同一套引号/转义词法，分开写就会漂移（漂移的方向是"一处能绕一处不能绕"）。
   */
  writeRedirect: boolean;
  /**
   * `false` = 分段结果**不可依赖**，调用方必须按"不解析不放行"处理。三种情形：
   * - 引号未闭合（含悬空反斜杠）：shell 本身就是语法错误；
   * - `$'…'`（ANSI-C）与 `$"…"`（本地化）：转义规则与普通单/双引号不同——
   *   `$'it\'s'` 在 shell 里是一个词，而普通单引号在 `\` 后就会收尾。
   * 模拟不了就不模拟：判死比假装解析对更安全。
   */
  balanced: boolean;
};

/**
 * 从一个**未加引号**的 `>`（下标 i）读出重定向目标与结束位置。
 *
 * 目标为空（`echo a >`）、是路径（`> out.txt`）都算落盘；`>&2` / `2>&1` 是 fd 复制，
 * 不算。`&>f` 形态由调用方的 `&` 分支让位给这里的 `>`，不必单独认。
 */
function readRedirectTarget(command: string, i: number): { target: string; end: number } {
  let j = i + 1;
  if (command[j] === ">") j += 1; // >>
  while (command[j] === " " || command[j] === "\t") j += 1;
  if (command[j] === "&") {
    let k = j + 1;
    let digits = "";
    while (k < command.length && command[k]! >= "0" && command[k]! <= "9") {
      digits += command[k];
      k += 1;
    }
    if (digits) return { target: `&${digits}`, end: k };
  }
  let quote: '"' | "'" | null = null;
  let target = "";
  while (j < command.length) {
    const c = command[j]!;
    if (quote) {
      target += c;
      if (c === quote) quote = null;
      j += 1;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      target += c;
      j += 1;
      continue;
    }
    if (c === "\\") {
      target += c;
      j += 1;
      if (j < command.length) {
        target += command[j];
        j += 1;
      }
      continue;
    }
    if (" \t\n;|&()".includes(c)) break;
    target += c;
    j += 1;
  }
  return { target, end: j };
}

/** 目标词去掉一层成对引号后是否算无害（`/dev/null` 或 `&N`） */
function redirectTargetIsHarmless(rawTarget: string): boolean {
  const quoted = /^(["'])(.*)\1$/.exec(rawTarget);
  return isHarmlessRedirectTarget(quoted ? quoted[2]! : rawTarget);
}

/**
 * 把一条命令拆成简单命令段，并判定这次解析是否可信。
 *
 * 分隔符取自 Claude Code 的同一份集合（`&&` `||` `;` `|` `|&` `&` 换行，外加括号
 * ——那是子 shell 的边界）：少列一个就是一条绕过路径——原先漏了 `&`，于是
 * `ls & rm -rf ~` 会被当成一段、被 `ls *` 规则整条放行。
 *
 * **反斜杠必须模拟**（这条是本函数存在的另一半理由）：`\` 转义的下一个字符既不是
 * 分隔符也不开引号，而引号内的转义规则逐种不同——引号外 `\'` 是字面量引号、
 * 单引号内根本没有转义、双引号内只有 `"` `\` `$` 反引号与换行被转义。旧实现只
 * 记一个 quote 状态、收尾时看"前一个字符是不是 \"，于是 `echo a\' ; rm -rf ~`
 * 被压成一段（以为引号一直开着），而 shell 会执行第二条命令——一条 `echo *`
 * 规则就把任意命令链放行了。同族的还有 `"a\\" ; rm -rf ~`（偶数反斜杠后真的
 * 收尾）与 `$'…'`（转义规则又不一样）。
 *
 * 写方向的重定向也在这里判（`writeRedirect`）：**不能靠"`>` 前面是不是空格"**——
 * `echo alpha${IFS}>f` 里 `>` 前面是 `}`，而 shell 里它是货真价实的重定向
 * （参数展开发生在分词之后，`${IFS}` 只把它与前一个词分开），实测会写出文件。
 */
export function parseShellCommand(command: string): ShellParse {
  if (command.includes("$'") || command.includes('$"')) {
    return { segments: [], writeRedirect: false, balanced: false };
  }
  const segments: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let writeRedirect = false;
  let i = 0;
  const flush = () => {
    segments.push(current);
    current = "";
  };
  while (i < command.length) {
    const ch = command[i]!;
    if (quote === "'") {
      // 单引号内没有转义：下一个 `'` 一定收尾（要写一个单引号靠 `'\''`：
      // 收尾、转义、重开）
      current += ch;
      if (ch === "'") quote = null;
      i += 1;
      continue;
    }
    if (quote === '"') {
      if (ch === "\\") {
        const next = command[i + 1];
        // 双引号内只对 `"` `\` `$` 反引号与换行是转义，其余反斜杠是字面量
        if (next !== undefined && '"\\$`\n'.includes(next)) {
          current += ch + next;
          i += 2;
          continue;
        }
        current += ch;
        i += 1;
        continue;
      }
      current += ch;
      if (ch === '"') quote = null;
      i += 1;
      continue;
    }
    // ↓ 引号外
    if (ch === "\\") {
      const next = command[i + 1];
      if (next === undefined)
        return { segments: [], writeRedirect: false, balanced: false }; // 悬空反斜杠
      current += ch + next;
      i += 2;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      i += 1;
      continue;
    }
    if (ch === ">") {
      // 写方向重定向：这里与分词共用同一套引号/转义状态，所以"`>` 前面是什么"
      // 不影响判定（`alpha${IFS}>f`、`2>f`、`x>>f`、`&>f` 都在这一支收口）
      const { target, end } = readRedirectTarget(command, i);
      if (!redirectTargetIsHarmless(target)) writeRedirect = true;
      current += command.slice(i, end);
      i = end;
      continue;
    }
    if (ch === "\n" || ch === ";" || ch === "(" || ch === ")") {
      flush();
      i += 1;
      continue;
    }
    if (ch === "&") {
      const prev = command[i - 1];
      const next = command[i + 1];
      // `&&`、`>&1`、`>&`、`&>` 都不是后台运算符（后两种让位给 `>` 那一支）
      if (next === "&") {
        flush();
        i += 2;
        continue;
      }
      if (prev === ">" || prev === "<" || next === ">") {
        current += ch;
        i += 1;
        continue;
      }
      flush();
      i += 1;
      continue;
    }
    if (ch === "|") {
      flush();
      i += command[i + 1] === "|" || command[i + 1] === "&" ? 2 : 1;
      continue;
    }
    current += ch;
    i += 1;
  }
  if (quote !== null) return { segments: [], writeRedirect, balanced: false }; // 引号未闭合
  flush();
  return {
    segments: segments.map((s) => s.trim()).filter(Boolean),
    writeRedirect,
    balanced: true,
  };
}

/** 只要分段的调用方（诊断/推导）；需要判解析可信度的走 parseShellCommand */
export function splitShellSegments(command: string): string[] {
  return parseShellCommand(command).segments;
}

/**
 * 命令尾部挂着悬空运算符（`npm test &&`）视为**不可解析**：既不放行也不记规则。
 * 口径同 Claude Code（它明确说这种命令不拆段、`Bash(npm *)` 也不批准它）。
 */
export function hasDanglingOperator(command: string): boolean {
  return /(?:&&|\|\||\|&|[|&;])\s*$/.test(command.replace(/\s+$/, ""));
}

/**
 * 命令里有没有「能藏下一次写」的 shell 语法：重定向、命令替换、反引号。
 *
 * 这一条是**前缀规则能成立的前提**。没有它，`cat *` 就等于放行
 * `cat notes.txt > /etc/hosts` —— 前缀规则本身只是个便利，不是边界。
 * 唯一放行的重定向目标是 `/dev/null`（`2>/dev/null`、`&>/dev/null`），
 * 因为那是只读命令里最常用的写法，且写它等于写垃圾桶。
 *
 * 重定向的识别**不做独立正则**，而是取 parseShellCommand 里那次扫描的结果：
 * 判定与分词共用同一套引号/转义词法。独立正则的两个方向都错过——按"`>` 前面
 * 必须是空格/数字/开头"扫，`echo alpha${IFS}>f` 漏判（shell 里真的写盘）；
 * 而照正则的字面扫描，引号里的 `>`（`echo "a > b"`）又被误判成重定向，
 * 让这类只读命令永远弹卡、永远记不住。
 *
 * `$'…'` / `$"…"` 也在这里判死：它们的转义规则与普通引号不同（见
 * parseShellCommand），任何"语义模拟不了"的写法都不该走到放行——
 * 分段层已经判死，这里再挡一道，让本函数单独被使用时也不会漏。
 */
/** 写出式重定向的目标：/dev/null（垃圾桶）与 `&2`/`&1`（fd 复制）不算落盘 */
function isHarmlessRedirectTarget(target: string): boolean {
  if (target === "/dev/null") return true;
  return /^&\d+$/.test(target); // 2>&1、>&2 这类 fd 复制，不是路径
}

export function hasWriteHidingSyntax(command: string): boolean {
  if (command.includes("`")) return true;
  if (command.includes("$(")) return true;
  if (command.includes("$'") || command.includes('$"')) return true;
  // 只查**写**方向的重定向。`<` 是读，而这一层管写不管读——读从来没经过审批
  // （read/glob/grep 这些工具都不问），为它破例只会让规则更难命中
  const parsed = parseShellCommand(command);
  // 解析不可信（引号未闭合等）时保守当"能藏写"：这一层是谓词，不是裁决者
  return parsed.balanced ? parsed.writeRedirect : true;
}

/**
 * 结构关键字：以它们开头的段**既不派生规则也不豁免**。
 *
 * 理由：`for d in *; do ...; done` 这种循环体里的命令不受前缀覆盖——把它压缩成
 * `for d *` 既没意义（正文不归它管）也误导（看起来像放行了整个循环）。
 * 这类构造一律不做压缩：用户下次还会被问，而那是诚实的行为。
 */
const SHELL_KEYWORDS = new Set([
  "for",
  "while",
  "until",
  "if",
  "then",
  "else",
  "elif",
  "fi",
  "case",
  "esac",
  "do",
  "done",
  "select",
  "time",
  "coproc",
  "{",
  "}",
  "function",
]);

/** 一条简单命令是否被某条规则放行 */
function ruleMatches(segment: string, rule: string): boolean {
  const trimmedRule = rule.trim();
  if (!trimmedRule) return false;
  if (trimmedRule.endsWith("*")) {
    const prefix = trimmedRule.slice(0, -1).trim().split(/\s+/);
    const tokens = segment.split(/\s+/);
    if (tokens.length < prefix.length) return false;
    return prefix.every((p, i) => tokens[i] === p);
  }
  return segment.trim() === trimmedRule;
}

/**
 * 整条命令是否命中规则集：**逐段校验，每段都要命中**。
 *
 * 逐段的必要性：`git log && rm -rf ~` 的第一段命中 `git log *`，但第二段不会
 * 命中任何规则——不拆段就等于用一条只读规则放行了整条链。
 * `cd` 是例外：它只能改本子 shell 的工作目录，改不了别的东西，而它几乎出现在
 * 每条命令里（`cd X && cat Y`），不放行它规则就形同虚设。
 */
export function commandMatchesRules(command: string, rules: readonly string[]): boolean {
  const cmd = command.trim();
  if (!cmd) return false;
  if (hasDanglingOperator(cmd)) return false;
  if (hasWriteHidingSyntax(cmd)) return false;
  // 解析不可信（引号未闭合 / 悬空反斜杠 / `$'…'`）就不放行：分段数是"逐段校验"
  // 的地基，地基不可信时每段命中也没有意义（`echo a\' ; rm -rf ~` 就是靠
  // 少拆一段混过整条规则集的）
  const parsed = parseShellCommand(cmd);
  if (!parsed.balanced) return false;
  const segments = parsed.segments;
  if (!segments.length) return false;
  return segments.every((seg) => {
    const first = seg.split(/\s+/)[0];
    // cd 只改本子 shell 的工作目录，且几乎出现在每条命令里（`cd X && cat Y`）
    if (first === "cd") return true;
    return rules.some((rule) => ruleMatches(seg, rule));
  });
}

/**
 * 从一条被批准的命令推出要记的规则：逐段取**命令前缀**，`cd` 段跳过。
 *
 * 形态与 Claude Code 对齐：
 * - 前缀 = 开头的词，直到第一个参数（含 `/`、`.`、`=` 或带引号的）为止；
 *   选项留在前缀里（`ls *`、`git log *`、`pnpm add *`）。
 * - 每条**子命令**各记一条规则（不是整条复合命令一条），单条命令最多 5 条——
 *   这也是它的口径（approve `git status && npm test` 会分别记下两条）。
 * - 悬空运算符、循环/条件体、解释器类命令（见 isCodeExecutingPrefix）不做压缩。
 *
 * **不区分只读与写类命令**：它的清单里就有 `Bash(node *)`、`Bash(kill *)` 这种宽规则。
 * 这是刻意的定位——Bash 前缀规则是**便利，不是边界**（它的文档原话：这类模式
 * "fragile"，要真隔离请用沙箱）。想收窄就直接改这份 JSON。
 * 唯一的例外是解释器类：那条规则等于"永久放行任意代码"，由 UI 的一次点击产生
 * 太容易顺手点掉，所以不派生（手写 JSON 仍然有效）。
 */
export function deriveCommandRules(command: string): string[] {
  const out: string[] = [];
  if (hasDanglingOperator(command)) return out;
  // 不可解析的命令不记规则：分段不可信时，"每段各记一条"可能给用户没看见的
  // 那条命令也记上（`echo a\' ; rm -rf ~` 的段划分与 shell 不一致）
  const parsed = parseShellCommand(command);
  if (!parsed.balanced) return out;
  for (const seg of parsed.segments) {
    const trimmed = seg.trim();
    const tokens = trimmed.split(/\s+/).filter(Boolean);
    const first = tokens[0];
    if (!first) continue;
    if (first === "cd") continue; // 匹配时天然放行，不必记
    if (SHELL_KEYWORDS.has(first)) continue; // 循环/条件体不做压缩
    const second = tokens[1];
    const secondIsValue =
      !second ||
      second.startsWith("-") ||
      /[/.=$]/.test(second) ||
      second.startsWith('"') ||
      second.startsWith("'");
    if (isCodeExecutingPrefix(first, secondIsValue ? undefined : second)) continue;
    push(secondIsValue ? `${first} *` : `${first} ${second} *`);
    if (out.length >= MAX_RULES_PER_COMMAND) break;
  }
  return out;

  function push(rule: string) {
    if (!out.includes(rule)) out.push(rule);
  }
}

/**
 * 这条前缀是不是"第一词之后就是代码"——是则不派生规则。
 *
 * `node script.js` → `node *`、`bash scripts/deploy.sh` → `bash *`、
 * `npx --yes x` → `npx *`、`env FOO=1 node x.js` → `env *`：规则一记下来，
 * **之后每次运行都不再问**，等于用一次点击换永久生效的任意代码执行。这类命令
 * 在"允许并记住"这条路上是最容易被顺手点掉的一个坑，所以由 UI 产生的规则不含它。
 *
 * 名单宁可长、判定宁可钝：误判的代价是"下次再问一次"，漏判的代价是"永久免问"。
 * 真想放开就手改 `.kova/permissions.local.json`——那是你自己机器上的文件，
 * 与写根清单同一条纪律（文件是你的，UI 不递刀）。
 */
function isCodeExecutingPrefix(first: string, second?: string): boolean {
  // 包装器/远端执行/破坏性写删：**第二词也不是"被钉住的目标"**——
  // `ssh host uptime` 的第二词是主机名（命令从第三个词开始）、`docker run <image>`
  // 的镜像是别人打包好的代码、`sudo rm` 的 `rm` 后面是任意路径。这类一律不记。
  if (CODE_EXECUTING_ANY_POSITION.has(first)) return true;
  // 解释器/运行器：后面直接跟"要执行的代码"，只有单词语前缀这一种形态
  // （`node *`、`bash *`、`npx *`），两词的（`node run.js` → `node run.js *`）是
  // 钉住了具体脚本的窄规则，照记
  if (second === undefined) return CODE_EXECUTING_SINGLE_WORD.has(first);
  // 第二词是"跑远端包 / 跑任意命令"的子命令（`pnpm dlx *`、`npm exec *`、`yarn x *`）
  return CODE_EXECUTING_SUBCOMMANDS.has(second);
}

/**
 * 第一词之后的**任意**参数都可能是要执行的代码/远端命令，或任意路径的写删：
 * 两词前缀也压不出安全的规则。
 */
const CODE_EXECUTING_ANY_POSITION = new Set([
  // 包装 / 提权 / 远端执行：其后紧跟的就是"要跑的东西"
  "sudo",
  "doas",
  "su",
  "env",
  "xargs",
  "parallel",
  "time",
  "nohup",
  "nice",
  "command",
  "exec",
  "eval",
  "source",
  ".",
  "ssh",
  "docker",
  "podman",
  "nerdctl",
  "kubectl",
  // 任意参数 = 任意路径的写/删：一次点击换来"以后随便删哪都行"太容易顺手点掉
  "rm",
  "rmdir",
  "mv",
  "cp",
  "install",
  "ln",
  "mkdir",
  "touch",
  "truncate",
  "dd",
  "tee",
  "chmod",
  "chown",
  "chgrp",
  "tar",
  "rsync",
  "unzip",
  "find",
  "patch",
  "sed",
  "awk",
]);

/** 第一词即解释器/运行器：后面跟什么就是执行什么（单词语前缀不记） */
const CODE_EXECUTING_SINGLE_WORD = new Set([
  // shell 本体
  "sh",
  "bash",
  "zsh",
  "dash",
  "ksh",
  "fish",
  "csh",
  "tcsh",
  "ash",
  "busybox",
  "pwsh",
  "powershell",
  // 语言解释器 / 运行器
  "node",
  "deno",
  "bun",
  "tsx",
  "ts-node",
  "python",
  "python3",
  "py",
  "ruby",
  "perl",
  "php",
  "lua",
  "Rscript",
  "groovy",
  "java",
  "osascript",
  "swift",
  "dotnet",
  // 包运行器（等于执行远端拿到的代码）
  "npx",
  "bunx",
  "uvx",
  "pipx",
  // 构建系统（Makefile 里是什么不由规则决定）
  "make",
  "gmake",
]);

/** 第二词是"执行后面的东西"的子命令（配合包管理器/运行器使用） */
const CODE_EXECUTING_SUBCOMMANDS = new Set(["dlx", "exec", "x"]);

/** 单条命令最多记几条规则（同 Claude Code 的上限） */
const MAX_RULES_PER_COMMAND = 5;

/** 把 local 清单加进 .git/info/exclude（仓库不重要/无 .git 时静默跳过） */
async function ensureGitignored(cwd: string, relPath: string): Promise<void> {
  if (!relPath || relPath.startsWith("..")) return;
  try {
    const gitDir = join(cwd, ".git");
    if (!existsSync(gitDir)) return;
    const exclude = join(gitDir, "info", "exclude");
    await mkdir(dirname(exclude), { recursive: true });
    const current = existsSync(exclude) ? await readFile(exclude, "utf8") : "";
    if (current.split("\n").some((l) => l.trim() === relPath)) return;
    const next = current && !current.endsWith("\n") ? `${current}\n` : current;
    await appendFile(exclude, `${next}# pi-kova：本机权限清单，不进仓库\n${relPath}\n`, "utf8");
  } catch (err) {
    logErr("permissions: failed to update .git/info/exclude:", err);
  }
}

/** 目标是否落在任一可写根内（软链接按真实落点算，与工作区判定同一套） */
export function isWriteRootAllowed(target: string, roots: readonly string[]): boolean {
  const real = realResolve(target);
  return roots.some((root) => isInside(root, real));
}

/** 命中的那条根（给审批文案用），没命中返回 undefined */
export function matchingWriteRoot(
  target: string,
  roots: readonly string[],
): string | undefined {
  const real = realResolve(target);
  return roots.find((root) => isInside(root, real));
}

/** 读一层文件。解析失败要**带回说明**而不是只记日志——诊断是给人排查「我的清单
 *  为什么没生效」用的，日志在 sidecar 那边，用户看不到 */
function readLayerFile(file: string): { value?: unknown; error?: string } {
  if (!existsSync(file)) return {};
  try {
    return { value: JSON.parse(readFileSync(file, "utf8")) as unknown };
  } catch (err) {
    logErr(`permissions: failed to parse ${file}:`, err);
    return { error: `invalid JSON (${err instanceof Error ? err.message : String(err)})` };
  }
}

function layerPaths(cwd: string): { user: string; project: string; local: string } {
  return {
    user: join(homedir(), ".kova", "permissions.json"),
    project: join(cwd, ".kova", "permissions.json"),
    local: join(cwd, ".kova", "permissions.local.json"),
  };
}

/**
 * 解析出这次真正生效的可写根。
 *
 * 工作区自身**总是**在生效集里：调用方（modes.ts 的 workspace-write 分支）用它
 * 一句 `isWriteRootAllowed` 就能判完「工作区内 or 清单内」，不必两处判定。
 */
export async function loadWriteRoots(cwd: string): Promise<WriteRootsResolution> {
  const paths = layerPaths(cwd);
  const diagnostics: string[] = [];
  const collect = (
    layer: "user" | "project" | "local",
    file: string,
  ): { roots: string[]; commands: string[]; mcpTools: string[] } => {
    const read = readLayerFile(file);
    if (read.error) {
      diagnostics.push(`${layer}: ${read.error}`);
      return { roots: [], commands: [], mcpTools: [] };
    }
    const parsed = parseWriteRootsFile(read.value);
    if (parsed.error) diagnostics.push(`${layer}: ${parsed.error}`);
    return { roots: parsed.roots, commands: parsed.commands, mcpTools: parsed.mcpTools };
  };

  const resolved = (roots: string[]): string[] =>
    roots.map((r) => resolveWriteRoot(r, cwd)).filter((r): r is string => r !== null);

  // 生效 = 工作区自身 + 你自己机器上的两份（用户级、本地级）。
  // 项目层只作为 declared 返回，供审批卡说明用——它永远不进 effective
  const userLayer = collect("user", paths.user);
  const localLayer = collect("local", paths.local);
  const project = collect("project", paths.project);

  const effective = [
    ...new Set([realResolve(cwd), ...resolved([...userLayer.roots, ...localLayer.roots])]),
  ];
  // 命令白名单不做路径展开，原样比对；与写根同一套规矩——项目层只提议不生效
  const commands = [...new Set([...userLayer.commands, ...localLayer.commands])];
  // MCP 工具同理：项目层声明的免审批名单只出现在审批卡说明里，不产生授权效力
  const mcpTools = [...new Set([...userLayer.mcpTools, ...localLayer.mcpTools])];
  return {
    effective,
    declared: resolved(project.roots).filter((r) => !effective.includes(r)),
    commands,
    mcpTools,
    diagnostics,
  };
}

/** 诊断/测试用：工作区目录下的清单文件绝对路径 */
export function writeRootsFiles(cwd: string): { user: string; project: string; local: string } {
  return layerPaths(cwd);
}

/** 相对工作区的展示名（审批文案里给人看，全路径太长） */
export function displayRoot(root: string, cwd: string): string {
  const rel = relative(cwd, root);
  return rel && !rel.startsWith("..") ? rel : root;
}
