/**
 * 技能文档（SKILL.md）的解析 / 渲染 / 校验 / 落盘（frontmatter + 正文）。
 * 发现与合并见 discovery.ts，启用开关见 state.ts。
 */
import { homedir } from "node:os";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { normalizeSkillName, setSkillEnabled, type SkillScope } from "./state";
import { systemSkillsDir, workspaceSkillsDir } from "./discovery";

export type SkillDraft = {
  name: string;
  description: string;
  content: string;
  disableModelInvocation?: boolean;
};

/** 附属文件（多文件技能，如市场安装的脚本/资源）：相对技能目录的安全相对路径 + 文本 */
export type SkillAuxFile = { path: string; content: string };

/** 单个技能文档字节上限（正文只按需 read，这里防的是意外巨型文件） */
export const MAX_SKILL_BYTES = 128 * 1024;
/** 附属文件的单个/总量/个数上限（技能是文本指令包，防意外巨型与滥用） */
export const MAX_AUX_FILE_BYTES = 256 * 1024;
export const MAX_AUX_TOTAL_BYTES = 1024 * 1024;
export const MAX_AUX_FILES = 32;
/** 名称/描述上限（与 pi-agent-core loadSkills 的校验一致） */
const MAX_NAME_CHARS = 64;
const MAX_DESCRIPTION_CHARS = 1024;

const FRONT_MATTER_RE = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

/**
 * 解析一份技能文档（导入路径与加载校验共用同一 frontmatter 规则）。
 * frontmatter 用 yaml 包解析（与 pi-agent-core loadSkills 一致，支持块标量）。
 */
export function parseSkillDoc(
  raw: string,
  options: { fallbackName?: string } = {},
): { ok: true; draft: SkillDraft } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  let name = "";
  let description = "";
  let disableModelInvocation = false;
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
      if (r["disable-model-invocation"] === true) disableModelInvocation = true;
    }
    body = raw.slice(m[0].length);
  }
  if (!name && options.fallbackName) name = options.fallbackName.trim();
  body = body.trim();
  if (!name) errors.push("缺少 name（frontmatter 或文件名兜底）");
  if (!description) errors.push("缺少 description（模型据此判断何时使用该技能）");
  if (!body) errors.push("正文为空");
  if (description.length > MAX_DESCRIPTION_CHARS) {
    errors.push(`description 超过 ${MAX_DESCRIPTION_CHARS} 字符（${description.length}）`);
  }
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    draft: {
      name,
      description,
      content: body,
      ...(disableModelInvocation ? { disableModelInvocation: true } : {}),
    },
  };
}

/** 渲染一份技能文档：frontmatter（yaml 序列化保证引号/多行安全）+ 正文 */
export function renderSkillDoc(draft: SkillDraft): string {
  const fm = stringifyYaml({
    name: draft.name,
    description: draft.description,
    ...(draft.disableModelInvocation ? { "disable-model-invocation": true } : {}),
  });
  return `---\n${fm}---\n\n${draft.content.trim()}\n`;
}

/** 技能名 → slug（沿用子智能体的宽松规则：保留非 ASCII，仅替换非法字符） */
export function skillSlug(name: string): string {
  const slug = name
    .trim()
    .replace(/[:<>"/\\?*|\s\x00-\x1f]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_NAME_CHARS);
  return slug || "skill";
}

/** 技能名 → 平铺文档文件名 */
export function skillFileName(name: string): string {
  return `${skillSlug(name)}.md`;
}

/** 附属文件路径与大小校验：必须是不含 .. 的库内相对路径，且不能占用 SKILL.md 本位 */
export function validateAuxFiles(files: SkillAuxFile[]): string[] {
  const errors: string[] = [];
  if (files.length > MAX_AUX_FILES) {
    errors.push(`附属文件超过 ${MAX_AUX_FILES} 个上限`);
  }
  let total = 0;
  for (const file of files) {
    const p = typeof file.path === "string" ? file.path : "";
    const segments = p.split("/");
    const unsafe =
      !p ||
      p.includes("\\") ||
      p.startsWith("/") ||
      segments.some((seg) => !seg || seg === "." || seg === ".." || seg !== seg.trim());
    if (unsafe) {
      errors.push(`附属文件路径不安全：${p || "(空)"}`);
      continue;
    }
    if (p.toUpperCase() === "SKILL.MD") {
      errors.push("SKILL.md 由文档本体提供，不能作为附属文件");
      continue;
    }
    const size = Buffer.byteLength(typeof file.content === "string" ? file.content : "", "utf8");
    total += size;
    if (size > MAX_AUX_FILE_BYTES) {
      errors.push(`附属文件超过 ${Math.floor(MAX_AUX_FILE_BYTES / 1024)} KB：${p}`);
    }
  }
  if (total > MAX_AUX_TOTAL_BYTES) {
    errors.push(`附属文件总量超过 ${Math.floor(MAX_AUX_TOTAL_BYTES / 1024)} KB 上限`);
  }
  return errors;
}

/** 目录式技能（<dir>/SKILL.md）清单：目录名、解析出的名字与归一化名（保存/删除的同名清理用）。
 *  parsed = false 表示 SKILL.md 解析失败，名字是目录名兜底——删除匹配只信这种场景下的目录名。 */
function listDirSkills(
  dir: string,
): Array<{ dirName: string; name: string; norm: string; parsed: boolean }> {
  if (!existsSync(dir)) return [];
  const out: Array<{ dirName: string; name: string; norm: string; parsed: boolean }> = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const skillMd = join(dir, entry.name, "SKILL.md");
    if (!existsSync(skillMd)) continue;
    let name = entry.name;
    let parsed = false;
    try {
      const result = parseSkillDoc(readFileSync(skillMd, "utf8"), { fallbackName: entry.name });
      if (result.ok) {
        name = result.draft.name;
        parsed = true;
      }
    } catch {
      // 坏文件按未解析处理，名字回落目录名
    }
    out.push({ dirName: entry.name, name, norm: normalizeSkillName(name), parsed });
  }
  return out;
}

function validateSkillDraft(draft: SkillDraft): string[] {
  const errors: string[] = [];
  if (!draft.name.trim()) errors.push("名称不能为空");
  if (draft.name.trim().length > MAX_NAME_CHARS) {
    errors.push(`名称不能超过 ${MAX_NAME_CHARS} 字符`);
  }
  if (!draft.description.trim()) errors.push("描述不能为空（模型据此决定何时使用）");
  if (draft.description.trim().length > MAX_DESCRIPTION_CHARS) {
    errors.push(`描述不能超过 ${MAX_DESCRIPTION_CHARS} 字符`);
  }
  if (!draft.content.trim()) errors.push("正文不能为空");
  if (Buffer.byteLength(renderSkillDoc(draft), "utf8") > MAX_SKILL_BYTES) {
    errors.push(`文档超过 ${Math.floor(MAX_SKILL_BYTES / 1024)} KB 上限`);
  }
  return errors;
}

export type SkillWriteOptions = {
  /** workspace 层必填：所属工作区 cwd */
  cwd?: string;
  /** 测试注入：覆盖系统目录解析（workspace 层忽略） */
  systemDir?: string;
  /** 编辑时改名：旧名对应的本层文件一并删除 */
  replaceName?: string;
  /** 附属文件（非空时按目录式技能落盘：<slug>/SKILL.md + files） */
  files?: SkillAuxFile[];
};

/**
 * 保存（新增或同名覆盖）一份系统/工作区技能。
 * 与子智能体不同，跨层同名允许（工作区遮蔽系统是刻意支持的项目定制路径，
 * 生态目录只读更拦不住）；同层同名 = 覆盖旧文件。
 *
 * 携带非空 files 时按**目录式技能**写入（<slug>/SKILL.md + 附属文件，
 * agentskills.io 形态；loadSkills 对全部层递归识别），整目录替换、无残留；
 * 否则保持平铺 <slug>.md。两个形态的同名旧条目（平铺文件或目录）都会被清理，
 * 编辑既有目录式技能却不带 files 时会回落平铺——旧目录一并清掉，不会双份。
 * 目录式写入撞上别的技能占用的同名目录（目录名相同、SKILL.md 名字不同）时
 * 明确报错，不做任何清理——两个静默方向都是毁掉别人的技能。
 */
export async function saveSkillDoc(
  scope: "system" | "workspace",
  draft: SkillDraft,
  options: SkillWriteOptions = {},
): Promise<void> {
  const { cwd, replaceName } = options;
  const errors = validateSkillDraft(draft);
  const auxFiles = options.files ?? [];
  if (auxFiles.length > 0) errors.push(...validateAuxFiles(auxFiles));
  if (errors.length > 0) throw new Error(errors.join("；"));
  const norm = normalizeSkillName(draft.name);

  const dir =
    scope === "system"
      ? options.systemDir ?? systemSkillsDir()
      : workspaceSkillsDir(cwd ?? homedir());
  const replaceNorm = replaceName ? normalizeSkillName(replaceName) : undefined;
  const shouldReplace = (candidate: string) => candidate === norm || candidate === replaceNorm;
  const writingDirForm = auxFiles.length > 0;

  if (existsSync(dir)) {
    // 占用检查先行：目录式写入撞上别的技能占用的同名目录 → 明确报错，不做任何清理。
    // （两个静默方向都堵死：直接删是丢别人技能；不删硬写是覆盖其 SKILL.md 并混入旧文件）
    if (writingDirForm) {
      const newSlugNorm = normalizeSkillName(skillSlug(draft.name));
      for (const dirSkill of listDirSkills(dir)) {
        if (shouldReplace(dirSkill.norm)) continue;
        if (normalizeSkillName(dirSkill.dirName) === newSlugNorm) {
          errors.push(
            `目录 ${dirSkill.dirName}/ 已被技能「${dirSkill.name}」占用，请先在技能设置里删除或改名它再安装`,
          );
        }
      }
      if (errors.length > 0) throw new Error(errors.join("；"));
    }
    // 同名清理：平铺文件（可能 slug 不同，按解析出的 name 比对）+ 目录式技能（解析名匹配）
    for (const existing of readdirSync(dir).filter((n) => /\.md$/i.test(n))) {
      const full = join(dir, existing);
      try {
        const parsed = parseSkillDoc(readFileSync(full, "utf8"), {
          fallbackName: basename(existing).replace(/\.md$/i, ""),
        });
        const existingNorm = parsed.ok
          ? normalizeSkillName(parsed.draft.name)
          : normalizeSkillName(basename(existing).replace(/\.md$/i, ""));
        if (shouldReplace(existingNorm)) unlinkSync(full);
      } catch {
        // 坏文件交给诊断路径处理，不挡保存
      }
    }
    for (const dirSkill of listDirSkills(dir)) {
      if (!shouldReplace(dirSkill.norm)) continue;
      rmSync(join(dir, dirSkill.dirName), { recursive: true, force: true });
    }
  }

  if (writingDirForm) {
    // 目录式：<slug>/SKILL.md + 附属文件（同名旧目录已在上面清理，这里全新写入）
    const skillDir = join(dir, skillSlug(draft.name));
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), renderSkillDoc(draft), "utf8");
    for (const file of auxFiles) {
      const target = join(skillDir, ...file.path.split("/"));
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, file.content, "utf8");
    }
  } else {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, skillFileName(draft.name)), renderSkillDoc(draft), "utf8");
  }
}

/** 删除一份系统/工作区技能（生态目录只读不可删）。清同名文件/目录并清开关残留。 */
export async function deleteSkillDoc(
  scope: "system" | "workspace",
  name: string,
  options: SkillWriteOptions = {},
): Promise<void> {
  const { cwd } = options;
  const dir =
    scope === "system"
      ? options.systemDir ?? systemSkillsDir()
      : workspaceSkillsDir(cwd ?? homedir());
  const norm = normalizeSkillName(name);
  let removed = false;
  if (existsSync(dir)) {
    for (const fileName of readdirSync(dir).filter((n) => /\.md$/i.test(n))) {
      const full = join(dir, fileName);
      let raw: string;
      try {
        raw = readFileSync(full, "utf8");
      } catch {
        continue;
      }
      const parsed = parseSkillDoc(raw, {
        fallbackName: basename(fileName).replace(/\.md$/i, ""),
      });
      const fileNorm = parsed.ok
        ? normalizeSkillName(parsed.draft.name)
        : normalizeSkillName(basename(fileName).replace(/\.md$/i, ""));
      if (fileNorm === norm) {
        unlinkSync(full);
        removed = true;
      }
    }
    // 目录式技能（<dir>/SKILL.md）：解析成功按解析名删；解析失败才信目录名兜底——
    // 目录名与内容名不同是常态，按目录名删会误伤别的技能
    for (const dirSkill of listDirSkills(dir)) {
      const byParsedName = dirSkill.parsed && dirSkill.norm === norm;
      const byFallbackDirName =
        !dirSkill.parsed && normalizeSkillName(dirSkill.dirName) === norm;
      if (!byParsedName && !byFallbackDirName) continue;
      rmSync(join(dir, dirSkill.dirName), { recursive: true, force: true });
      removed = true;
    }
  }
  if (!removed) throw new Error(`未找到 ${scope === "system" ? "系统" : "工作区"}技能 "${name}"`);
  await setSkillEnabled(scope as SkillScope, name, true, cwd).catch(() => {});
}
