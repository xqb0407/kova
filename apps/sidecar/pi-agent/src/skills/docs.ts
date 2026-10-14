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
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { normalizeSkillName, setSkillEnabled, type SkillScope } from "./state";
import { systemSkillsDir, workspaceSkillsDir } from "./discovery";

export type SkillDraft = {
  name: string;
  description: string;
  content: string;
  disableModelInvocation?: boolean;
};

/** 单个技能文档字节上限（正文只按需 read，这里防的是意外巨型文件） */
export const MAX_SKILL_BYTES = 128 * 1024;
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

/** 技能名 → 文件名（沿用子智能体的宽松规则：保留非 ASCII，仅替换非法字符） */
export function skillFileName(name: string): string {
  const slug = name
    .trim()
    .replace(/[:<>"/\\?*|\s\x00-\x1f]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_NAME_CHARS);
  return `${slug || "skill"}.md`;
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
};

/**
 * 保存（新增或同名覆盖）一份系统/工作区技能。
 * 与子智能体不同，跨层同名允许（工作区遮蔽系统是刻意支持的项目定制路径，
 * 生态目录只读更拦不住）；同层同名 = 覆盖旧文件。
 */
export async function saveSkillDoc(
  scope: "system" | "workspace",
  draft: SkillDraft,
  options: SkillWriteOptions = {},
): Promise<void> {
  const { cwd, replaceName } = options;
  const errors = validateSkillDraft(draft);
  if (errors.length > 0) throw new Error(errors.join("；"));
  const norm = normalizeSkillName(draft.name);

  const dir =
    scope === "system"
      ? options.systemDir ?? systemSkillsDir()
      : workspaceSkillsDir(cwd ?? homedir());
  const filePath = join(dir, skillFileName(draft.name));
  const replaceNorm = replaceName ? normalizeSkillName(replaceName) : undefined;
  // 同名编辑 = 覆盖本层同名文件（可能文件名 slug 不同）；改名编辑再清掉旧名文件
  if (existsSync(dir)) {
    for (const existing of readdirSync(dir).filter((n) => /\.md$/i.test(n))) {
      const full = join(dir, existing);
      if (full === filePath) continue;
      try {
        const parsed = parseSkillDoc(readFileSync(full, "utf8"), {
          fallbackName: basename(existing).replace(/\.md$/i, ""),
        });
        const existingNorm = parsed.ok
          ? normalizeSkillName(parsed.draft.name)
          : normalizeSkillName(basename(existing).replace(/\.md$/i, ""));
        if (existingNorm === norm || (replaceNorm && existingNorm === replaceNorm)) {
          unlinkSync(full);
        }
      } catch {
        // 坏文件交给诊断路径处理，不挡保存
      }
    }
  }
  mkdirSync(dir, { recursive: true });
  writeFileSync(filePath, renderSkillDoc(draft), "utf8");
}

/** 删除一份系统/工作区技能（生态目录只读不可删）。清同名文件并清开关残留。 */
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
  }
  if (!removed) throw new Error(`未找到 ${scope === "system" ? "系统" : "工作区"}技能 "${name}"`);
  await setSkillEnabled(scope as SkillScope, name, true, cwd).catch(() => {});
}
