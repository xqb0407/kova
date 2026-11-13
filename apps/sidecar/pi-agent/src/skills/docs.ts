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
import {
  COMPAT_MANAGED_MARKER,
  compatHomeSkillsDir,
  systemSkillsDir,
  workspaceSkillsDir,
} from "./discovery";

/** 可写技能层：系统（应用数据）、工作区（<cwd>/.kova/skills）、
 *  生态兼容（~/.agents/skills，与 agentskills.io 工具共享） */
export type SkillDocScope = "system" | "workspace" | "compat";

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
 *  recursive = 生态目录（~/.agents/skills）：技能常嵌在 @org/@user 分类目录下。
 *  parsed = false 表示 SKILL.md 解析失败，名字是目录名兜底——删除匹配只信这种场景下的目录名。 */
function listDirSkills(
  dir: string,
  recursive = false,
): Array<{
  dirName: string;
  dirPath: string;
  name: string;
  norm: string;
  parsed: boolean;
}> {
  if (!existsSync(dir)) return [];
  const out: Array<{
    dirName: string;
    dirPath: string;
    name: string;
    norm: string;
    parsed: boolean;
  }> = [];
  const collect = (dirPath: string, dirName: string) => {
    const skillMd = join(dirPath, "SKILL.md");
    if (!existsSync(skillMd)) return;
    let name = dirName;
    let parsed = false;
    try {
      const result = parseSkillDoc(readFileSync(skillMd, "utf8"), { fallbackName: dirName });
      if (result.ok) {
        name = result.draft.name;
        parsed = true;
      }
    } catch {
      // 坏文件按未解析处理，名字回落目录名
    }
    out.push({ dirName, dirPath, name, norm: normalizeSkillName(name), parsed });
  };
  const walk = (abs: string, depth: number) => {
    if (depth > 4) return;
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith(".") || entry.name === "node_modules") {
        continue;
      }
      const child = join(abs, entry.name);
      if (existsSync(join(child, "SKILL.md"))) {
        // 技能目录内部的子目录是附属文件，不再往下找技能
        collect(child, entry.name);
        continue;
      }
      if (recursive) walk(child, depth + 1);
    }
  };
  walk(dir, 0);
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
  /** 测试注入：覆盖生态用户目录解析（仅 compat 层） */
  compatDir?: string;
  /** 编辑时改名：旧名对应的本层文件一并删除 */
  replaceName?: string;
  /** 附属文件（非空时按目录式技能落盘：<slug>/SKILL.md + files） */
  files?: SkillAuxFile[];
};

/** 可写层 → 落盘目录 */
const scopeDir = (scope: SkillDocScope, options: SkillWriteOptions): string => {
  if (scope === "system") return options.systemDir ?? systemSkillsDir();
  if (scope === "compat") return options.compatDir ?? compatHomeSkillsDir();
  return workspaceSkillsDir(options.cwd ?? homedir());
};

/**
 * 保存（新增或同名覆盖）一份系统/工作区/生态用户技能。
 * 与子智能体不同，跨层同名允许（工作区遮蔽系统是刻意支持的项目定制路径；
 * 生态目录来自外部工具，写入层同样拦不住同名）；同层同名 = 覆盖旧文件。
 *
 * 携带非空 files 时按**目录式技能**写入（<slug>/SKILL.md + 附属文件，
 * agentskills.io 形态；loadSkills 对全部层递归识别），整目录替换、无残留；
 * 生态用户目录（~/.agents/skills）始终按目录式写入，方便其他工具识别；
 * 其余层无 files 时保持平铺 <slug>.md。两个形态的同名旧条目（平铺文件或目录）
 * 都会被清理，编辑既有目录式技能却不带 files 时会回落平铺——旧目录一并清掉，
 * 不会双份。目录式写入撞上别的技能占用的同名目录（目录名相同、SKILL.md
 * 名字不同）时明确报错，不做任何清理——两个静默方向都是毁掉别人的技能。
 */
export async function saveSkillDoc(
  scope: SkillDocScope,
  draft: SkillDraft,
  options: SkillWriteOptions = {},
): Promise<void> {
  const { cwd, replaceName } = options;
  const errors = validateSkillDraft(draft);
  if (scope === "compat" && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(draft.name.trim())) {
    // 生态目录要求目录名与 frontmatter name 一致且符合 agentskills.io 规范；
    // 否则其他工具/本应用发现时都会报 name mismatch / invalid characters
    errors.push("生态目录要求技能名为小写字母、数字与连字符（agentskills.io 规范）");
  }
  const auxFiles = options.files ?? [];
  if (auxFiles.length > 0) errors.push(...validateAuxFiles(auxFiles));
  if (errors.length > 0) throw new Error(errors.join("；"));
  const norm = normalizeSkillName(draft.name);

  const dir = scopeDir(scope, options);
  const replaceNorm = replaceName ? normalizeSkillName(replaceName) : undefined;
  const shouldReplace = (candidate: string) => candidate === norm || candidate === replaceNorm;
  // 生态用户目录始终目录式（agentskills.io：<name>/SKILL.md，其他工具直接识别）
  const writingDirForm = scope === "compat" || auxFiles.length > 0;
  // 生态目录里的技能常按 @org/@user 分层，同名清理需要递归扫描
  const recursiveScan = scope === "compat";
  const targetDir = join(dir, skillSlug(draft.name));

  if (existsSync(dir)) {
    // 占用检查先行：目录式写入撞上别的技能占用的同名目录 → 明确报错，不做任何清理。
    // （两个静默方向都堵死：直接删是丢别人技能；不删硬写是覆盖其 SKILL.md 并混入旧文件）
    if (writingDirForm) {
      const newSlugNorm = normalizeSkillName(skillSlug(draft.name));
      for (const dirSkill of listDirSkills(dir, recursiveScan)) {
        if (shouldReplace(dirSkill.norm)) continue;
        // 递归层只拦「目标目录本身」被别的技能占用：嵌套分类目录里的同名叶子
        // 不算冲突（新技能写顶层，删除/覆盖仍按解析名精确匹配）
        const occupied = recursiveScan
          ? dirSkill.dirPath === targetDir
          : normalizeSkillName(dirSkill.dirName) === newSlugNorm;
        if (occupied) {
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
    for (const dirSkill of listDirSkills(dir, recursiveScan)) {
      if (!shouldReplace(dirSkill.norm)) continue;
      rmSync(dirSkill.dirPath, { recursive: true, force: true });
    }
  }

  if (writingDirForm) {
    // 目录式：<slug>/SKILL.md + 附属文件（同名旧目录已在上面清理，这里全新写入）
    const skillDir = targetDir;
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), renderSkillDoc(draft), "utf8");
    for (const file of auxFiles) {
      const target = join(skillDir, ...file.path.split("/"));
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, file.content, "utf8");
    }
    if (scope === "compat") {
      // 托管标记：设置页据此允许删除本应用装进生态目录的技能。编辑仍关闭——
      // 编辑器重写会丢附属文件与第三方 frontmatter。
      writeFileSync(
        join(skillDir, COMPAT_MANAGED_MARKER),
        JSON.stringify({ managedBy: "kova", version: 1 }),
        "utf8",
      );
    }
  } else {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, skillFileName(draft.name)), renderSkillDoc(draft), "utf8");
  }
}

/** 删除一份系统/工作区/生态用户技能。清同名文件/目录并清开关残留。 */
export async function deleteSkillDoc(
  scope: SkillDocScope,
  name: string,
  options: SkillWriteOptions = {},
): Promise<void> {
  const { cwd } = options;
  const dir = scopeDir(scope, options);
  const recursiveScan = scope === "compat";
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
    for (const dirSkill of listDirSkills(dir, recursiveScan)) {
      const byParsedName = dirSkill.parsed && dirSkill.norm === norm;
      const byFallbackDirName =
        !dirSkill.parsed && normalizeSkillName(dirSkill.dirName) === norm;
      if (!byParsedName && !byFallbackDirName) continue;
      rmSync(dirSkill.dirPath, { recursive: true, force: true });
      removed = true;
    }
  }
  if (!removed) {
    const label =
      scope === "system" ? "系统" : scope === "compat" ? "生态用户" : "工作区";
    throw new Error(`未找到${label}技能 "${name}"`);
  }
  await setSkillEnabled(scope as SkillScope, name, true, cwd).catch(() => {});
}
