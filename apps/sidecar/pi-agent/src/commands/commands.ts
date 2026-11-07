/**
 * 自定义命令（斜杠提示词模板）：
 * - 层级：工作区 <cwd>/.kova/commands/*.md > 全局 ~/.kova/commands/*.md
 *   （PI_GLOBAL_COMMANDS_DIR 可钉住，测试用）> 内置命令；同名高层覆盖低层
 * - 文件格式：可选 frontmatter（description / argument-hint）+ 正文模板；
 *   正文里的 $ARGUMENTS 在发送时替换为命令名之后的全部文本——没有占位符而
 *   用户带了参数就追加在模板尾部，没带参数且无占位符就原样发送
 * - 展开位置在 sidecar（runTurnBody 入口，msg.text 就地替换）：桌面/移动/
 *   自动化 runner 一套语义；未知命令 / 非斜杠文本原样透传（模型仍收到原文）
 * - /init 是内置命令：扫描仓库写根目录 AGENTS.md（instructions.ts 消费的
 *   就是这个文件，写完下一轮提示词重组自然生效）；用户同名文件可覆盖
 * - 无缓存：每轮至多扫一次（expand/snapshot 各一次），小文件读盘成本可忽略
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type CommandSource = "workspace" | "global" | "builtin";

export type CommandDef = {
  name: string;
  description: string;
  argumentHint?: string;
  source: CommandSource;
  /** 模板正文（frontmatter 之后） */
  body: string;
};

export type CommandSummary = {
  name: string;
  description: string;
  argumentHint?: string;
  source: CommandSource;
};

const NAME_RE = /^[a-z][\w-]*$/i;

/** 全局命令目录（测试经 PI_GLOBAL_COMMANDS_DIR 钉住，兜底 ~/.kova/commands） */
export function globalCommandsDir(): string {
  if (process.env.PI_GLOBAL_COMMANDS_DIR) return process.env.PI_GLOBAL_COMMANDS_DIR;
  return join(homedir(), ".kova", "commands");
}

/** 内置命令：/init——初始化项目空间 AGENTS.md（instructions.ts 的消费端） */
const INIT_BODY = [
  "Survey this workspace and initialize its root instruction file AGENTS.md.",
  "",
  "- Inspect the repository first: README, package manifests, build/test configs,",
  "  directory layout and existing conventions. Do not modify any source files.",
  "- Write AGENTS.md at the workspace root, covering concisely:",
  "  - What the project is (one or two sentences)",
  "  - Build / test / lint commands that actually work in this repo",
  "  - Code style and framework conventions an agent must follow here",
  "  - Key directories and where new code belongs",
  "- Keep it under about 60 lines. State facts found in the repo, not aspirations.",
  "  If AGENTS.md already exists, update it instead: fill gaps and correct stale",
  "  facts, and preserve the user's existing content otherwise.",
  "- Finish with a short summary of what you wrote, in the user's language.",
].join("\n");

const BUILTIN_COMMANDS: CommandDef[] = [
  {
    name: "init",
    description: "初始化项目空间 AGENTS.md：扫描仓库写根目录指令文件",
    argumentHint: "[补充要求]",
    source: "builtin",
    body: INIT_BODY,
  },
];

/** frontmatter 极简解析：文件以 --- 开头时取首个 --- 块，键值按 "key: value" */
function parseDoc(raw: string): {
  description?: string;
  argumentHint?: string;
  body: string;
} {
  const text = raw.replace(/^\uFEFF/, "").trimStart();
  if (!text.startsWith("---")) return { body: raw.trim() };
  const end = text.indexOf("\n---", 3);
  if (end === -1) return { body: raw.trim() };
  const head = text.slice(3, end);
  const body = text.slice(end + 4).trim();
  let description: string | undefined;
  let argumentHint: string | undefined;
  for (const line of head.split("\n")) {
    const m = /^(description|argument-hint|argumentHint)\s*:\s*(.+?)\s*$/.exec(line);
    if (!m) continue;
    if (m[1].toLowerCase() === "description") description = m[2];
    else argumentHint = m[2];
  }
  return { description, argumentHint, body };
}

/** 读一个目录下的 *.md 命令（目录缺失/不可读返回空） */
function scanDir(dir: string, source: CommandSource): Map<string, CommandDef> {
  const out = new Map<string, CommandDef>();
  if (!dir || !existsSync(dir)) return out;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const file of entries) {
    if (!file.endsWith(".md")) continue;
    const name = file.slice(0, -3);
    if (!NAME_RE.test(name)) continue;
    const full = join(dir, file);
    try {
      if (!statSync(full).isFile()) continue;
      const parsed = parseDoc(readFileSync(full, "utf8"));
      out.set(name, {
        name,
        description: parsed.description ?? "",
        ...(parsed.argumentHint ? { argumentHint: parsed.argumentHint } : {}),
        source,
        body: parsed.body,
      });
    } catch {
      /* 单个坏文件跳过 */
    }
  }
  return out;
}

/** 合并三层：builtin 兜底，global 盖 builtin，workspace 盖 global。
 *  不做缓存：命令文件是几十个以内的小 md，每轮至多扫一次（expand/snapshot
 *  各一次），读盘成本相对一次模型请求可忽略——换来零陈旧问题（mtime 同毫秒
 *  粒度不够，签名方案救不了同毫秒改文件，实测踩过）。 */
function discover(cwd: string | undefined): Map<string, CommandDef> {
  const defs = new Map<string, CommandDef>();
  for (const b of BUILTIN_COMMANDS) defs.set(b.name, { ...b });
  for (const [, def] of scanDir(globalCommandsDir(), "global")) defs.set(def.name, def);
  if (cwd) for (const [, def] of scanDir(join(cwd, ".kova", "commands"), "workspace")) defs.set(def.name, def);
  return defs;
}

/** 命令清单（菜单水合用，按名排序） */
export function commandsSnapshot(cwd?: string): CommandSummary[] {
  return [...discover(cwd).values()]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(({ name, description, argumentHint, source }) => ({
      name,
      description,
      ...(argumentHint ? { argumentHint } : {}),
      source,
    }));
}

/**
 * 展开一条用户输入：`/name 参数...` 命中已知命令时返回模板展开结果；
 * 非斜杠 / 未知命令 / 空文本返回 null（调用方按原样透传）。
 */
export function expandCommand(cwd: string | undefined, text: string): string | null {
  const trimmed = text.trimStart();
  if (!trimmed.startsWith("/")) return null;
  const m = /^\/([A-Za-z][\w-]*)(?:\s+([\s\S]*))?$/.exec(trimmed);
  if (!m) return null;
  const name = m[1];
  const rest = (m[2] ?? "").trim();
  const def = discover(cwd).get(name);
  if (!def) return null;
  const body = def.body;
  if (body.includes("$ARGUMENTS")) return body.replaceAll("$ARGUMENTS", rest);
  return rest ? `${body}\n\n${rest}` : body;
}

/** 测试缝：清空目录签名缓存 */
export function resetCommandsCacheForTest(): void {
  /* 无缓存可清（历史接口，保留调用方兼容） */
}
