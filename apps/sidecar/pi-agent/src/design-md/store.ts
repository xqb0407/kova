/**
 * 设计主题的清单与正文存取（两层：内置 builtin + 用户 user）。
 *
 * - 内置层：元数据来自主题包 catalog（内存 zip 副本，builtin-sync 同时把同字节
 *   的 DESIGN.md 解压到 <root>/builtin/ 供外部直接访问）；运行时按只读处理，
 *   管理页对内置主题只能预览/使用/fork（fork = 取正文另存进用户层）。
 * - 用户层：<root>/user/<slug>.md（frontmatter name/description/accents + 正文），
 *   解析渲染规则仿 skills/docs.ts（yaml frontmatter、同名覆盖本层旧文件）。
 * - 同名裁决：模型按名引用主题时用户层遮蔽内置层（清单条目保留双方并给内置
 *   打 shadowed 标，UI 可提示"已被同名自定义主题覆盖"）。
 * - 快照：refreshThemes() 现算并缓存同步视图；compose 提示词与 use_design_theme
 *   走快照（名称展示），正文每次从 zip/磁盘现值读。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { builtinCatalog, readBuiltinDoc, type BuiltinThemeMeta } from "./catalog";
import { userThemesDir } from "./paths";
import { logErr } from "../log";

export type ThemeScope = "builtin" | "user";

/** 会话当前主题的引用（JSON 落 kv/会话列；normalizeThemeRef 是唯一入口） */
export type ThemeRef = { scope: ThemeScope; id: string };

export type DesignThemeEntry = {
  scope: ThemeScope;
  /** builtin = 包内 slug；user = 文件名 stem */
  id: string;
  name: string;
  desc: string;
  accents: string[];
  /** 内置条目：存在同名用户主题遮蔽 */
  shadowed?: boolean;
  /** 用户条目：正文字节数（编辑回填前的展示） */
  sizeBytes?: number;
};

export type DesignThemeSnapshot = {
  entries: DesignThemeEntry[];
  /** 主题包 catalog.version */
  version: string;
  builtinCount: number;
  userCount: number;
  error: string | null;
};

/** 单主题正文档字节上限（防意外巨型文件；内置 ~20KB） */
export const MAX_THEME_BYTES = 256 * 1024;
const MAX_NAME_CHARS = 64;

const EMPTY_SNAPSHOT: DesignThemeSnapshot = {
  entries: [],
  version: "",
  builtinCount: 0,
  userCount: 0,
  error: null,
};

let snapshot: DesignThemeSnapshot = EMPTY_SNAPSHOT;

const normName = (v: string): string => v.trim().toLowerCase();

/** 主题名 → 用户层文件 slug（仿 skillFileName：保留非 ASCII，仅替换非法字符） */
export function themeFileSlug(name: string): string {
  const slug = name
    .trim()
    .replace(/[:<>"/\\?*|\s\x00-\x1f]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_NAME_CHARS);
  return slug || "theme";
}

/** 任意来源（kv JSON / 协议消息 / 会话列）的主题引用宽松规整；非法一律 null */
export function normalizeThemeRef(raw: unknown): ThemeRef | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (r.scope !== "builtin" && r.scope !== "user") return null;
  if (typeof r.id !== "string" || !r.id.trim()) return null;
  return { scope: r.scope, id: r.id.trim() };
}

const FRONT_MATTER_RE = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

export type UserThemeDraft = {
  name: string;
  description: string;
  content: string;
  accents?: string[];
};

/** 解析一份用户主题（导入与加载共用）；无 frontmatter 时用文件 stem 兜底名称 */
export function parseThemeDoc(
  raw: string,
  options: { fallbackName?: string } = {},
): { ok: true; draft: UserThemeDraft } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  let name = "";
  let description = "";
  let accents: string[] | undefined;
  let body = raw;
  const m = FRONT_MATTER_RE.exec(raw);
  if (m) {
    let fm: unknown;
    try {
      fm = parseYaml(m[1]);
    } catch (err) {
      return {
        ok: false,
        errors: [`frontmatter 解析失败: ${err instanceof Error ? err.message : String(err)}`],
      };
    }
    if (fm !== null && typeof fm === "object" && !Array.isArray(fm)) {
      const r = fm as Record<string, unknown>;
      if (typeof r.name === "string") name = r.name.trim();
      if (typeof r.description === "string") description = r.description.trim();
      if (Array.isArray(r.accents)) {
        accents = r.accents.filter((a): a is string => typeof a === "string").slice(0, 4);
      }
    }
    body = raw.slice(m[0].length);
  }
  if (!name && options.fallbackName) name = options.fallbackName.trim();
  body = body.trim();
  if (!name) errors.push("缺少 name（frontmatter 或文件名兜底）");
  if (!body) errors.push("正文为空");
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, draft: { name, description, content: body, accents } };
}

export function renderThemeDoc(draft: UserThemeDraft): string {
  const fmObj: Record<string, unknown> = { name: draft.name, description: draft.description };
  if (draft.accents && draft.accents.length > 0) fmObj.accents = draft.accents;
  const fm = stringifyYaml(fmObj);
  return `---\n${fm}---\n\n${draft.content.trim()}\n`;
}

function readUserDir(): Map<string, { draft: UserThemeDraft; sizeBytes: number } | null> {
  const dir = userThemesDir();
  const out = new Map<string, { draft: UserThemeDraft; sizeBytes: number } | null>();
  if (!existsSync(dir)) return out;
  for (const file of readdirSync(dir).filter((n) => /\.md$/i.test(n))) {
    const id = basename(file).replace(/\.md$/i, "");
    try {
      const raw = readFileSync(join(dir, file), "utf8");
      const parsed = parseThemeDoc(raw, { fallbackName: id });
      if (parsed.ok) {
        out.set(id, { draft: parsed.draft, sizeBytes: Buffer.byteLength(raw, "utf8") });
      } else {
        out.set(id, null); // 坏文件占位，清单里跳过（诊断走日志）
        logErr(`design-md: bad theme file ${file}:`, parsed.errors.join("；"));
      }
    } catch (err) {
      logErr("design-md: read theme file failed:", file, err);
    }
  }
  return out;
}

/** 现算并缓存快照（启动、set/save/delete 后与 list 前调用；同步视图供 compose/工具用） */
export async function refreshThemes(): Promise<DesignThemeSnapshot> {
  let builtin: BuiltinThemeMeta[] = [];
  let version = "";
  let error: string | null = null;
  try {
    const catalog = await builtinCatalog();
    builtin = catalog.themes;
    version = catalog.version;
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }
  const user = readUserDir();
  const userNorms = new Set<string>();
  for (const entry of user.values()) {
    if (entry) userNorms.add(normName(entry.draft.name));
  }
  const entries: DesignThemeEntry[] = [];
  for (const t of builtin) {
    entries.push({
      scope: "builtin",
      id: t.id,
      name: t.name,
      desc: t.desc,
      accents: t.accents,
      ...(userNorms.has(normName(t.name)) || userNorms.has(t.id) ? { shadowed: true } : {}),
    });
  }
  for (const [id, entry] of user) {
    if (!entry) continue;
    entries.push({
      scope: "user",
      id,
      name: entry.draft.name,
      desc: entry.draft.description,
      accents: entry.draft.accents ?? [],
      sizeBytes: entry.sizeBytes,
    });
  }
  snapshot = {
    entries,
    version,
    builtinCount: builtin.length,
    userCount: [...user.values()].filter((v) => v !== null).length,
    error,
  };
  return snapshot;
}

/** 当前快照（同步读；refreshThemes 之前为启动初值/上次刷新值） */
export function themesSnapshot(): DesignThemeSnapshot {
  return snapshot;
}

export function findTheme(ref: ThemeRef): DesignThemeEntry | undefined {
  return snapshot.entries.find((e) => e.scope === ref.scope && e.id === ref.id);
}

/**
 * 按名查找（use_design_theme 工具的 name 参数）：用户层优先于内置层，
 * 内置按包内不区分大小写匹配 id 或 name，用户按归一名匹配。
 */
export function resolveThemeByName(name: string): ThemeRef | null {
  const want = normName(name);
  const user = [...snapshot.entries].reverse().find((e) => e.scope === "user" && normName(e.name) === want);
  if (user) return { scope: user.scope, id: user.id };
  const builtin = snapshot.entries.find(
    (e) => e.scope === "builtin" && (e.id === want || normName(e.name) === want),
  );
  if (builtin) return { scope: builtin.scope, id: builtin.id };
  return null;
}

/** 主题正文：builtin 走 zip 内存副本；user 现读磁盘（与 read 语义一致，改后即见）。
 *  用户主题返回去 frontmatter 的正文本体——提示词加载（use_design_theme）用。 */
export async function readThemeContent(ref: ThemeRef): Promise<string | null> {
  if (ref.scope === "builtin") return readBuiltinDoc(ref.id);
  const file = userThemeFile(ref.id);
  if (!file) return null;
  const parsed = parseThemeDoc(readFileSync(file, "utf8"), { fallbackName: ref.id });
  return parsed.ok ? parsed.draft.content : null;
}

/** 主题"原文"（管理页取全文：编辑回填要保留 frontmatter，故与正文不同）；
 *  builtin 无 frontmatter，zip 内 DESIGN.md 原文即全文 */
export async function readThemeDocRaw(ref: ThemeRef): Promise<string | null> {
  if (ref.scope === "builtin") return readBuiltinDoc(ref.id);
  const file = userThemeFile(ref.id);
  if (!file || !existsSync(file)) return null;
  return readFileSync(file, "utf8");
}

/** 用户主题文件路径（id 含路径成分一律拒绝——与 deleteUserTheme 同护栏） */
function userThemeFile(id: string): string | null {
  if (id.includes("/") || id.includes("\\") || id.includes("..")) return null;
  return join(userThemesDir(), `${id}.md`);
}

/**
 * 保存用户主题（新建/同名覆盖/改名编辑传 replaceId 清旧文件；fork 内置 =
 * 调用方取正文后按新草稿保存，store 无需特判来源）。
 * 返回值带 clobbered：归一名扫描顺带合并掉的「别的 id」的用户主题（典型 =
 * 大小写不敏感文件系统上 themeFileSlug 保留大小写，"Kova" 与 "kova" 是两个
 * 业务 id 却同一文件名；或旧文件 stem 与新 slug 不同但同名）。这些文件已删，
 * 指向旧 id 的会话引用不会自动跟——调用方须逐个 remapThemeRefs 到 ref，
 * 否则他处引用悬空（list 里消失却仍被 use，restore 读盘大小写兜底读到新主题）。
 */
export type SaveUserThemeResult = { ref: ThemeRef; clobbered: string[] };

export async function saveUserTheme(
  draft: UserThemeDraft,
  options: { replaceId?: string } = {},
): Promise<SaveUserThemeResult> {
  const errors: string[] = [];
  if (!draft.name.trim()) errors.push("名称不能为空");
  if (draft.name.trim().length > MAX_NAME_CHARS) errors.push(`名称不能超过 ${MAX_NAME_CHARS} 字符`);
  if (!draft.content.trim()) errors.push("正文不能为空");
  if (Buffer.byteLength(renderThemeDoc(draft), "utf8") > MAX_THEME_BYTES) {
    errors.push(`文档超过 ${Math.floor(MAX_THEME_BYTES / 1024)} KB 上限`);
  }
  if (errors.length > 0) throw new Error(errors.join("；"));
  const dir = userThemesDir();
  mkdirSync(dir, { recursive: true });
  const id = themeFileSlug(draft.name);
  const filePath = join(dir, `${id}.md`);
  const norm = normName(draft.name);
  const clobbered: string[] = [];
  for (const existing of readdirSync(dir).filter((n) => /\.md$/i.test(n))) {
    const full = join(dir, existing);
    if (full === filePath) continue;
    const existingId = basename(existing).replace(/\.md$/i, "");
    try {
      const parsed = parseThemeDoc(readFileSync(full, "utf8"), { fallbackName: existingId });
      const existingNorm = parsed.ok ? normName(parsed.draft.name) : normName(existingId);
      if (existingNorm === norm || existingId === options.replaceId) {
        unlinkSync(full);
        // 归一名命中 = 它主题被本保存合并（replaceId 那条走主 remap 线，不算）。
        // 先删后写：大小写不敏感 FS 上文件名也重新落到本 slug 的 casing，
        // 盘上 id 与返回 id 一致
        if (existingNorm === norm && existingId !== id) clobbered.push(existingId);
      }
    } catch {
      // 坏文件不挡保存
    }
  }
  writeFileSync(filePath, renderThemeDoc(draft), "utf8");
  return { ref: { scope: "user", id }, clobbered };
}

/** 删除用户主题（内置层不可删：ref.scope 校验在 handler 已挡，这里再兜一层） */
export function deleteUserTheme(id: string): void {
  if (id.includes("/") || id.includes("\\") || id.includes("..")) {
    throw new Error(`非法主题 id: ${id}`);
  }
  const file = join(userThemesDir(), `${id}.md`);
  if (!existsSync(file)) throw new Error(`主题不存在: ${id}`);
  unlinkSync(file);
}

/** 测试钩子：清快照 */
export function resetThemesSnapshotForTest(): void {
  snapshot = EMPTY_SNAPSHOT;
}
