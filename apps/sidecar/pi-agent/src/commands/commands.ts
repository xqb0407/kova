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
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { activePlugins, resolvePluginComponent } from "../plugins/plugins";
import { projectExtraDirs } from "../agent/projects";

export type CommandSource = "workspace" | "global" | "plugin" | "builtin";

export type CommandDef = {
  name: string;
  description: string;
  argumentHint?: string;
  /** 菜单图标键（desktop ICON_MAP 键名小写，如 zap/bookopen/globe；缺省 zap） */
  icon?: string;
  source: CommandSource;
  /** 模板正文（frontmatter 之后） */
  body: string;
};

export type CommandSummary = {
  name: string;
  description: string;
  argumentHint?: string;
  icon?: string;
  source: CommandSource;
  /** 模板正文（管理页编辑器用；菜单条目忽略。命令都是小文件，整包仍在几 KB 量级） */
  body: string;
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

/** 前端保留名：composer `/` 菜单里的**前端动作命令**（composer-commands.ts 的
 *  SLASH_COMMANDS id 清单，改动要两边同步）——发现层跳过 + 保存层拒绝双闸 */
const RESERVED_FRONTEND_NAMES = new Set([
  "shell",
  "browser",
  "explorer",
  "activity",
  "plan-panel",
  "review",
  "plan",
  "ask",
  "goal",
]);

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
  icon?: string;
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
  let icon: string | undefined;
  for (const line of head.split("\n")) {
    const m = /^(description|argument-hint|argumentHint|icon)\s*:\s*(.+?)\s*$/.exec(line);
    if (!m) continue;
    // 值两侧的成对引号剥掉（YAML 风格书写 description: "x" 不该把引号带上菜单）
    const value = m[2].replace(/^["'](.*)["']$/, "$1");
    const key = m[1].toLowerCase();
    if (key === "description") description = value;
    else if (key === "argument-hint" || key === "argumenthint") argumentHint = value;
    else if (key === "icon") icon = value.toLowerCase();
  }
  return { description, argumentHint, ...(icon ? { icon } : {}), body };
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
        ...(parsed.icon ? { icon: parsed.icon } : {}),
        source,
        body: parsed.body,
      });
    } catch {
      /* 单个坏文件跳过 */
    }
  }
  return out;
}

/**
 * 合并四层：builtin 兜底，plugin 盖 builtin，global 盖 plugin，workspace 盖
 * global（用户文件永远赢）。插件层只读（由插件更新管理），逐启用插件取其
 * commands 目录；前端保留名（SLASH_COMMANDS 动作集合）在发现层统一跳过——
 * 那些名字永远被 UI 先吃掉，列出来是死条目。
 * 不做缓存：命令文件是几十个以内的小 md，每轮至多扫一次（expand/snapshot
 * 各一次），读盘成本相对一次模型请求可忽略——换来零陈旧问题（mtime 同毫秒
 * 粒度不够，签名方案救不了同毫秒改文件，实测踩过）。
 */
/** 项目附加目录（历史工作区配置只读兜底；主目录仍最后覆盖） */
function projectExtraCommandDirs(cwd: string): string[] {
  return projectExtraDirs(cwd);
}

function discover(
  cwd: string | undefined,
  opts?: { skipWorkspace?: boolean },
): Map<string, CommandDef> {
  const defs = new Map<string, CommandDef>();
  for (const b of BUILTIN_COMMANDS) defs.set(b.name, { ...b });
  for (const plugin of activePlugins()) {
    const dir = resolvePluginComponent(plugin.manifest, "commands");
    if (!dir || !existsSync(dir)) continue;
    for (const [, def] of scanDir(dir, "plugin")) {
      if (!RESERVED_FRONTEND_NAMES.has(def.name)) defs.set(def.name, def);
    }
  }
  for (const [, def] of scanDir(globalCommandsDir(), "global")) {
    if (!RESERVED_FRONTEND_NAMES.has(def.name)) defs.set(def.name, def);
  }
  if (cwd && !opts?.skipWorkspace) {
    // 附加目录的历史命令：只读兜底（项目主目录随后覆盖同名项）
    for (const dir of projectExtraCommandDirs(cwd)) {
      for (const [, def] of scanDir(join(dir, ".kova", "commands"), "workspace")) {
        if (!RESERVED_FRONTEND_NAMES.has(def.name)) defs.set(def.name, def);
      }
    }
    for (const [, def] of scanDir(join(cwd, ".kova", "commands"), "workspace")) {
      if (!RESERVED_FRONTEND_NAMES.has(def.name)) defs.set(def.name, def);
    }
  }
  return defs;
}

/** 命令清单（菜单水合用，按名排序） */
export function commandsSnapshot(cwd?: string): CommandSummary[] {
  return [...discover(cwd).values()]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(({ name, description, argumentHint, icon, source, body }) => ({
      name,
      description,
      ...(argumentHint ? { argumentHint } : {}),
      ...(icon ? { icon } : {}),
      source,
      body,
    }));
}

/**
 * 展开一条用户输入：`/name 参数...` 命中已知命令时返回模板展开结果；
 * 非斜杠 / 未知命令 / 空文本返回 null（调用方按原样透传）。
 * skipWorkspace：远程会话置 true——cwd 是本地代表目录，扫它的
 * .kova/commands 是错的；远程只展开全局 / 插件 / 内置三层。
 */
export function expandCommand(
  cwd: string | undefined,
  text: string,
  opts?: { skipWorkspace?: boolean },
): string | null {
  const trimmed = text.trimStart();
  if (!trimmed.startsWith("/")) return null;
  const m = /^\/([A-Za-z][\w-]*)(?:\s+([\s\S]*))?$/.exec(trimmed);
  if (!m) return null;
  const name = m[1];
  const rest = (m[2] ?? "").trim();
  const def = discover(cwd, opts).get(name);
  if (!def) return null;
  const body = def.body;
  if (body.includes("$ARGUMENTS")) return body.replaceAll("$ARGUMENTS", rest);
  return rest ? `${body}\n\n${rest}` : body;
}

/**
 * 请求时展开（Agent.transformContext 用）：返回新数组——命中的 user 消息换成
 * 展开后的副本，**原始消息对象不动**（状态/转录/UI 展示保持芯片/原文）。
 *
 * 用户消息里命令可能以两种形态出现：
 * - `:command[/init]{name=command:init}` 芯片原文（composer 插入并随消息持久化，
 *   气泡据此渲染高亮芯片）——先还原成 `/name`，再走模板展开；
 * - 手打 `/name` 纯文本——直接走模板展开。
 * 支持 string 内容与 [{type:"text"}, ...images] 数组内容；其他角色/内容原样。
 */
/** composer 插入的 :command 芯片原文 → 命令名（与桌面 command-directive.ts 同构） */
const COMMAND_CHIP_RE = /:command\[[^\]\n]{0,1024}\]\{name=command:([A-Za-z][\w-]*)\}/g;
const chipToSlash = (text: string): string =>
  text.includes(":command[") ? text.replace(COMMAND_CHIP_RE, "/$1") : text;

export function expandUserCommandMessages(
  messages: readonly AgentMessage[],
  cwd: string | undefined,
  opts?: { skipWorkspace?: boolean },
): AgentMessage[] {
  return messages.map((message) => {
    const msg = message as {
      role?: string;
      content?: unknown;
    };
    if (msg.role !== "user") return message;
    const content = msg.content;
    if (typeof content === "string") {
      const normalized = chipToSlash(content);
      const expanded = expandCommand(cwd, normalized, opts);
      return expanded === null ? message : ({ ...message, content: expanded } as AgentMessage);
    }
    if (Array.isArray(content)) {
      let changed = false;
      const next = content.map((block) => {
        const b = block as { type?: string; text?: string };
        if (b?.type !== "text" || typeof b.text !== "string") return block;
        const expanded = expandCommand(cwd, chipToSlash(b.text), opts);
        if (expanded === null) return block;
        changed = true;
        return { ...b, text: expanded };
      });
      return changed ? ({ ...message, content: next } as AgentMessage) : message;
    }
    return message;
  });
}

/** 测试缝：清空目录签名缓存 */
export function resetCommandsCacheForTest(): void {
  /* 无缓存可清（历史接口，保留调用方兼容） */
}

/* ------------------------------ 管理页：保存/删除 ------------------------------ */

export type CommandDraft = {
  name: string;
  description?: string;
  argumentHint?: string;
  icon?: string;
  body: string;
};

/** frontmatter 序列化：值带引号/冒号时按 YAML 风格包裹（解析端剥成对引号） */
function frontmatterValue(value: string): string {
  return /["':]/.test(value) ? JSON.stringify(value) : value;
}

function serializeCommandDoc(def: CommandDraft): string {
  const lines = ["---", `description: ${frontmatterValue(def.description ?? "")}`];
  if (def.argumentHint) lines.push(`argument-hint: ${frontmatterValue(def.argumentHint)}`);
  if (def.icon) lines.push(`icon: ${def.icon}`);
  lines.push("---", "", def.body.trimEnd());
  return lines.join("\n") + "\n";
}

function commandDirFor(scope: "workspace" | "global", cwd: string | undefined): string {
  if (scope === "workspace") {
    if (!cwd) throw new Error("save_command: workspace scope requires cwd");
    return join(cwd, ".kova", "commands");
  }
  return globalCommandsDir();
}

/**
 * 保存（新建或覆盖）：写 frontmatter + 正文；replaceName 是改名前的原名，
 * 与新名不同时清掉旧文件。保留名拒绝在前端动作集合（见上）。
 */
export async function saveCommandDoc(input: {
  scope: "workspace" | "global";
  name: string;
  description?: string;
  argumentHint?: string;
  icon?: string;
  body: string;
  cwd?: string;
  replaceName?: string;
}): Promise<void> {
  const name = input.name.trim();
  if (!NAME_RE.test(name)) {
    throw new Error(`save_command: 非法命令名 "${name}"（字母开头，字母/数字/-/_）`);
  }
  if (RESERVED_FRONTEND_NAMES.has(name)) {
    throw new Error(`save_command: "${name}" 是前端动作命令的保留名，换一个名字`);
  }
  const dir = commandDirFor(input.scope, input.cwd);
  const { mkdir, writeFile, unlink } = await import("node:fs/promises");
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, `${name}.md`),
    serializeCommandDoc({
      name,
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.argumentHint !== undefined ? { argumentHint: input.argumentHint } : {}),
      // icon 只接受字面词（写进 frontmatter 单行，换行/冒号会破坏块结构）
      ...(input.icon && /^[\w-]+$/.test(input.icon) ? { icon: input.icon } : {}),
      body: input.body,
    }),
    "utf8",
  );
  const replaceName = input.replaceName?.trim();
  if (replaceName && replaceName !== name && NAME_RE.test(replaceName)) {
    try {
      await unlink(join(dir, `${replaceName}.md`));
    } catch {
      /* 旧文件不存在/不可删不阻断保存 */
    }
  }
}

/** 删除（仅工作区/全局层；内置命令不在盘上，天然不可删）。name 必须过
 *  NAME_RE——否则 `../` 形态会拼出目录穿越路径删到任意文件 */
export async function deleteCommandDoc(input: {
  scope: "workspace" | "global";
  name: string;
  cwd?: string;
}): Promise<void> {
  const name = input.name.trim();
  if (!name) throw new Error("delete_command: name is required");
  if (!NAME_RE.test(name)) {
    throw new Error(`delete_command: 非法命令名 "${name}"`);
  }
  const dir = commandDirFor(input.scope, input.cwd);
  const { unlink } = await import("node:fs/promises");
  try {
    await unlink(join(dir, `${name}.md`));
  } catch {
    throw new Error(`delete_command: 命令文件不存在（${dir}/${name}.md）`);
  }
}
