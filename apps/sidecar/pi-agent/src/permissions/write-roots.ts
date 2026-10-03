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
   * 免除确认的**完整命令**（用户级 + 本地级）。粒度是整串逐字相等，不是前缀——
   * 前缀匹配会被重定向绕过（记住 `cat` 就等于放行 `cat x > /etc/hosts`）。
   * 代价是命中率低：模型很少原样重复同一条命令。真正消掉弹窗要靠只读判定或
   * OS 级沙箱（见 docs/permission-modes.md），这里是安全的那一半。
   */
  commands: string[];
  /** 读文件/解析的异常说明（不阻断，只进日志与诊断） */
  diagnostics: string[];
};

/** 一份清单文件的规整：坏条目剔除，不整体失败（同 secrets 的宽松口径） */
export function parseWriteRootsFile(raw: unknown): {
  roots: string[];
  commands: string[];
  error?: string;
} {
  if (raw === null || raw === undefined) return { roots: [], commands: [] };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return { roots: [], commands: [], error: "not a JSON object" };
  }
  const obj = raw as { writeRoots?: unknown; allowCommands?: unknown };
  const roots = readStringList(obj.writeRoots, "writeRoots");
  const commands = readStringList(obj.allowCommands, "allowCommands");
  const error = [roots.error, commands.error].filter(Boolean).join("; ") || undefined;
  return { roots: roots.list, commands: commands.list, ...(error ? { error } : {}) };
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
  // 两种规则同住一份文件：写回时把另一种原样带上，别互相抹掉
  const payload = {
    writeRoots: [...existing, entry],
    ...(parsedFile.commands.length ? { allowCommands: parsedFile.commands } : {}),
  };
  await writeFile(file, JSON.stringify(payload, null, 2) + "\n", "utf8");
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
  const payload = {
    ...(existing.roots.length ? { writeRoots: existing.roots } : {}),
    allowCommands: merged,
  };
  await writeFile(file, JSON.stringify(payload, null, 2) + "\n", "utf8");
  await ensureGitignored(cwd, relative(cwd, file));
}

/**
 * 按 shell 运算符拆成简单命令。分隔符取自 Claude Code 的同一份集合
 * （`&&` `||` `;` `|` `|&` `&` 换行，外加括号——那是子 shell 的边界）：
 * 少列一个就是一条绕过路径——原先漏了 `&`，于是 `ls & rm -rf ~` 会被当成
 * 一段、被 `ls *` 规则整条放行。
 *
 * 引号内的分隔符不拆；`2>&1`、`&>` 里的 `&` 不是后台运算符（前后必有 `>` 或数字），
 * 不当分隔符。
 */
export function splitShellSegments(command: string): string[] {
  const segments: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    if (quote) {
      current += ch;
      if (ch === quote && command[i - 1] !== "\\") quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === "\n" || ch === ";" || ch === "(" || ch === ")") {
      segments.push(current);
      current = "";
      continue;
    }
    if (ch === "&") {
      const prev = command[i - 1];
      const next = command[i + 1];
      // `&&`、`>&1`、`>&`、`&>` 都不是后台运算符
      if (next === "&") {
        segments.push(current);
        current = "";
        i++;
        continue;
      }
      if (prev === ">" || prev === "<" || next === ">") {
        current += ch;
        continue;
      }
      segments.push(current);
      current = "";
      continue;
    }
    if (ch === "|") {
      segments.push(current);
      current = "";
      if (command[i + 1] === "|" || command[i + 1] === "&") i++;
      continue;
    }
    current += ch;
  }
  segments.push(current);
  return segments.map((s) => s.trim()).filter(Boolean);
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
 */
/** 写出式重定向的目标：/dev/null（垃圾桶）与 `&2`/`&1`（fd 复制）不算落盘 */
function isHarmlessRedirectTarget(target: string): boolean {
  if (target === "/dev/null") return true;
  return /^&\d+$/.test(target); // 2>&1、>&2 这类 fd 复制，不是路径
}

export function hasWriteHidingSyntax(command: string): boolean {
  if (command.includes("`")) return true;
  if (command.includes("$(")) return true;
  // 只查**写**方向的重定向。`<` 是读，而这一层管写不管读——读从来没经过审批
  // （read/glob/grep 这些工具都不问），为它破例只会让规则更难命中
  const re = /(?:^|\s|\d)&?>>?\s*(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(command))) {
    if (!isHarmlessRedirectTarget(m[1]!.replace(/[;,|&]+$/, ""))) return true;
  }
  return false;
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
  const segments = splitShellSegments(cmd);
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
 * 形态与 Claude Code 完全对齐：
 * - 前缀 = 开头的词，直到第一个参数（含 `/`、`.`、`=` 或带引号的）为止；
 *   选项留在前缀里（`ls *`、`git log *`、`pnpm add *`）。
 * - 每条**子命令**各记一条规则（不是整条复合命令一条），单条命令最多 5 条——
 *   这也是它的口径（approve `git status && npm test` 会分别记下两条）。
 * - 悬空运算符、循环/条件体不做压缩（那两种它也只按子命令匹配）。
 *
 * **不区分只读与写类命令**：它的清单里就有 `Bash(node *)`、`Bash(kill *)` 这种宽规则。
 * 这是刻意的定位——Bash 前缀规则是**便利，不是边界**（它的文档原话：这类模式
 * "fragile"，要真隔离请用沙箱）。想收窄就直接改这份 JSON。
 */
export function deriveCommandRules(command: string): string[] {
  const out: string[] = [];
  if (hasDanglingOperator(command)) return out;
  for (const seg of splitShellSegments(command)) {
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
    push(secondIsValue ? `${first} *` : `${first} ${second} *`);
    if (out.length >= MAX_RULES_PER_COMMAND) break;
  }
  return out;

  function push(rule: string) {
    if (!out.includes(rule)) out.push(rule);
  }
}

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
  ): { roots: string[]; commands: string[] } => {
    const read = readLayerFile(file);
    if (read.error) {
      diagnostics.push(`${layer}: ${read.error}`);
      return { roots: [], commands: [] };
    }
    const parsed = parseWriteRootsFile(read.value);
    if (parsed.error) diagnostics.push(`${layer}: ${parsed.error}`);
    return { roots: parsed.roots, commands: parsed.commands };
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
  return {
    effective,
    declared: resolved(project.roots).filter((r) => !effective.includes(r)),
    commands,
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
