/**
 * Vendored from `@earendil-works/pi-agent-core@0.99.2`:
 *   dist/harness/skills.js
 *   dist/harness/system-prompt.js
 *   dist/harness/env/nodejs.js (仅 loadSkills 需要的 5 个文件方法)
 * License: MIT (see NOTICE.md in this directory).
 *
 * 1.0.0 把 experimental harness 从 pi-agent-core 移除后，Kova 的 skills 发现
 * 仍依赖这组实现。这里保持 0.99.2 的行为：递归 SKILL.md、根目录 .md、ignore
 * 文件、frontmatter 校验、<available_skills> 格式化。
 */
import ignore from "ignore";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { basename, join } from "node:path";
import { parse } from "yaml";

export type SkillDiagnosticCode =
  | "file_info_failed"
  | "list_failed"
  | "read_failed"
  | "parse_failed"
  | "invalid_metadata";

export interface SkillDiagnostic {
  type: "warning";
  code: SkillDiagnosticCode;
  message: string;
  path: string;
}

export interface Skill {
  name: string;
  /**
   * 展示/调用名：插件技能为 `<plugin>:<skill>`，普通技能缺省等同 name。
   * 由宿主在插件层装载后补上；loadSkills 本身不生成。
   */
  qualifiedName?: string;
  description: string;
  content: string;
  filePath: string;
  disableModelInvocation?: boolean;
}

export interface SkillLoadResult {
  skills: Skill[];
  diagnostics: SkillDiagnostic[];
}

/** loadSkills 需要的最小执行环境（上游 NodeExecutionEnv 的子集）。 */
export interface HarnessFileInfo {
  name: string;
  path: string;
  kind: "file" | "directory" | "symlink" | "other";
  size: number;
  mtimeMs: number;
}

export type HarnessFileErrorCode =
  | "not_found"
  | "permission_denied"
  | "not_directory"
  | "is_directory"
  | "invalid"
  | "aborted"
  | "unknown";

export interface HarnessFileError {
  code: HarnessFileErrorCode;
  message: string;
  path: string;
}

export type HarnessResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: HarnessFileError };

export interface HarnessExecutionEnv {
  fileInfo(path: string): Promise<HarnessResult<HarnessFileInfo>>;
  listDir(path: string): Promise<HarnessResult<HarnessFileInfo[]>>;
  joinPath(parts: string[]): Promise<HarnessResult<string>>;
  readTextFile(path: string): Promise<HarnessResult<string>>;
  canonicalPath(path: string): Promise<HarnessResult<string>>;
}

const MAX_NAME_LENGTH = 64;
const MAX_DESCRIPTION_LENGTH = 1024;
const IGNORE_FILE_NAMES = [".gitignore", ".ignore", ".fdignore"];

function ok<T>(value: T): HarnessResult<T> {
  return { ok: true, value };
}

function toFileError(error: unknown, fallbackPath: string): HarnessFileError {
  const e = error as NodeJS.ErrnoException | undefined;
  const map: Record<string, HarnessFileErrorCode> = {
    ENOENT: "not_found",
    ENOTDIR: "not_directory",
    EISDIR: "is_directory",
    EACCES: "permission_denied",
    EPERM: "permission_denied",
    EINVAL: "invalid",
    ABORT_ERR: "aborted",
  };
  return {
    code: map[e?.code ?? ""] ?? "unknown",
    message: e?.message ? String(e.message) : String(error),
    path: fallbackPath,
  };
}

function fail<T>(error: unknown, fallbackPath: string): HarnessResult<T> {
  return { ok: false, error: toFileError(error, fallbackPath) };
}

async function readFileInfo(path: string): Promise<HarnessResult<HarnessFileInfo>> {
  try {
    const st = await lstat(path);
    const kind = st.isFile()
      ? "file"
      : st.isDirectory()
        ? "directory"
        : st.isSymbolicLink()
          ? "symlink"
          : "other";
    return ok({
      name: basename(path),
      path,
      kind,
      size: st.size,
      mtimeMs: st.mtimeMs,
    });
  } catch (error) {
    return fail(error, path);
  }
}

/** 只实现 loadSkills 用到的文件方法；不搬完整 NodeExecutionEnv。 */
export function createNodeExecutionEnv(): HarnessExecutionEnv {
  return {
    fileInfo: readFileInfo,
    async listDir(path) {
      try {
        const entries = await readdir(path, { withFileTypes: true });
        const out: HarnessFileInfo[] = [];
        for (const entry of entries) {
          const info = await readFileInfo(join(path, entry.name));
          if (info.ok) out.push(info.value);
        }
        return ok(out);
      } catch (error) {
        return fail(error, path);
      }
    },
    async joinPath(parts) {
      return ok(join(...parts));
    },
    async readTextFile(path) {
      try {
        return ok(await readFile(path, "utf8"));
      } catch (error) {
        return fail(error, path);
      }
    },
    async canonicalPath(path) {
      try {
        return ok(await realpath(path));
      } catch (error) {
        return fail(error, path);
      }
    },
  };
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

export async function loadSkills(dirs: string | string[]): Promise<SkillLoadResult> {
  const env = createNodeExecutionEnv();
  const skills: Skill[] = [];
  const diagnostics: SkillDiagnostic[] = [];
  for (const dir of Array.isArray(dirs) ? dirs : [dirs]) {
    const rootInfoResult = await env.fileInfo(dir);
    if (!rootInfoResult.ok) {
      if (rootInfoResult.error.code !== "not_found") {
        diagnostics.push({
          type: "warning",
          code: "file_info_failed",
          message: rootInfoResult.error.message,
          path: dir,
        });
      }
      continue;
    }
    const rootInfo = rootInfoResult.value;
    if ((await resolveKind(env, rootInfo, diagnostics)) !== "directory") continue;
    const result = await loadSkillsFromDirInternal(
      env,
      rootInfo.path,
      true,
      ignore(),
      rootInfo.path,
    );
    skills.push(...result.skills);
    diagnostics.push(...result.diagnostics);
  }
  return { skills, diagnostics };
}

async function loadSkillsFromDirInternal(
  env: HarnessExecutionEnv,
  dir: string,
  includeRootFiles: boolean,
  ignoreMatcher: ReturnType<typeof ignore>,
  rootDir: string,
): Promise<SkillLoadResult> {
  const skills: Skill[] = [];
  const diagnostics: SkillDiagnostic[] = [];
  const dirInfoResult = await env.fileInfo(dir);
  if (!dirInfoResult.ok) {
    if (dirInfoResult.error.code !== "not_found") {
      diagnostics.push({
        type: "warning",
        code: "file_info_failed",
        message: dirInfoResult.error.message,
        path: dir,
      });
    }
    return { skills, diagnostics };
  }
  const dirInfo = dirInfoResult.value;
  if ((await resolveKind(env, dirInfo, diagnostics)) !== "directory") {
    return { skills, diagnostics };
  }
  await addIgnoreRules(env, ignoreMatcher, dir, rootDir, diagnostics);
  const entriesResult = await env.listDir(dir);
  if (!entriesResult.ok) {
    diagnostics.push({
      type: "warning",
      code: "list_failed",
      message: entriesResult.error.message,
      path: dir,
    });
    return { skills, diagnostics };
  }
  const entries = entriesResult.value;
  for (const entry of entries) {
    if (entry.name !== "SKILL.md") continue;
    const fullPath = entry.path;
    const kind = await resolveKind(env, entry, diagnostics);
    if (kind !== "file") continue;
    const relPath = relativeEnvPath(rootDir, fullPath);
    if (ignoreMatcher.ignores(relPath)) continue;
    const result = await loadSkillFromFile(env, fullPath, dirInfo.name);
    if (result.skill) skills.push(result.skill);
    diagnostics.push(...result.diagnostics);
    return { skills, diagnostics };
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const fullPath = entry.path;
    const kind = await resolveKind(env, entry, diagnostics);
    if (!kind) continue;
    const relPath = relativeEnvPath(rootDir, fullPath);
    const ignorePath = kind === "directory" ? `${relPath}/` : relPath;
    if (ignoreMatcher.ignores(ignorePath)) continue;
    if (kind === "directory") {
      const result = await loadSkillsFromDirInternal(
        env,
        fullPath,
        false,
        ignoreMatcher,
        rootDir,
      );
      skills.push(...result.skills);
      diagnostics.push(...result.diagnostics);
      continue;
    }
    if (kind !== "file" || !includeRootFiles || !entry.name.endsWith(".md")) continue;
    const result = await loadSkillFromFile(env, fullPath, dirInfo.name);
    if (result.skill) skills.push(result.skill);
    diagnostics.push(...result.diagnostics);
  }
  return { skills, diagnostics };
}

async function addIgnoreRules(
  env: HarnessExecutionEnv,
  ig: ReturnType<typeof ignore>,
  dir: string,
  rootDir: string,
  diagnostics: SkillDiagnostic[],
): Promise<void> {
  const relativeDir = relativeEnvPath(rootDir, dir);
  const prefix = relativeDir ? `${relativeDir}/` : "";
  for (const filename of IGNORE_FILE_NAMES) {
    const ignorePathResult = await env.joinPath([dir, filename]);
    if (!ignorePathResult.ok) {
      diagnostics.push({
        type: "warning",
        code: "file_info_failed",
        message: ignorePathResult.error.message,
        path: dir,
      });
      continue;
    }
    const ignorePath = ignorePathResult.value;
    const info = await env.fileInfo(ignorePath);
    if (!info.ok) {
      if (info.error.code !== "not_found") {
        diagnostics.push({
          type: "warning",
          code: "file_info_failed",
          message: info.error.message,
          path: ignorePath,
        });
      }
      continue;
    }
    if (info.value.kind !== "file") continue;
    const content = await env.readTextFile(ignorePath);
    if (!content.ok) {
      diagnostics.push({
        type: "warning",
        code: "read_failed",
        message: content.error.message,
        path: ignorePath,
      });
      continue;
    }
    const patterns = content.value
      .split(/\r?\n/)
      .map((line) => prefixIgnorePattern(line, prefix))
      .filter((line): line is string => Boolean(line));
    if (patterns.length > 0) ig.add(patterns);
  }
}

function prefixIgnorePattern(line: string, prefix: string): string | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("#") && !trimmed.startsWith("\\#")) return null;
  let pattern = line;
  let negated = false;
  if (pattern.startsWith("!")) {
    negated = true;
    pattern = pattern.slice(1);
  } else if (pattern.startsWith("\\!")) {
    pattern = pattern.slice(1);
  }
  if (pattern.startsWith("/")) pattern = pattern.slice(1);
  const prefixed = prefix ? `${prefix}${pattern}` : pattern;
  return negated ? `!${prefixed}` : prefixed;
}

async function loadSkillFromFile(
  env: HarnessExecutionEnv,
  filePath: string,
  parentDirName: string,
): Promise<{ skill: Skill | null; diagnostics: SkillDiagnostic[] }> {
  const diagnostics: SkillDiagnostic[] = [];
  const isDeclaredSkill =
    filePath.replace(/[\\/]+$/, "").split(/[\\/]/).pop() === "SKILL.md";
  const rawContent = await env.readTextFile(filePath);
  if (!rawContent.ok) {
    diagnostics.push({
      type: "warning",
      code: "read_failed",
      message: rawContent.error.message,
      path: filePath,
    });
    return { skill: null, diagnostics };
  }
  const parsed = parseFrontmatter(rawContent.value);
  if (!parsed.ok) {
    if (isDeclaredSkill) {
      diagnostics.push({
        type: "warning",
        code: "parse_failed",
        message: parsed.error.message,
        path: filePath,
      });
    }
    return { skill: null, diagnostics };
  }
  const { frontmatter, body } = parsed.value;
  const description =
    typeof frontmatter.description === "string" ? frontmatter.description : undefined;
  if (!isDeclaredSkill && (!description || description.trim() === "")) {
    return { skill: null, diagnostics };
  }
  for (const error of validateDescription(description)) {
    diagnostics.push({
      type: "warning",
      code: "invalid_metadata",
      message: error,
      path: filePath,
    });
  }
  const frontmatterName =
    typeof frontmatter.name === "string" ? frontmatter.name : undefined;
  const name = frontmatterName || parentDirName;
  for (const error of validateName(name, parentDirName)) {
    diagnostics.push({
      type: "warning",
      code: "invalid_metadata",
      message: error,
      path: filePath,
    });
  }
  if (!description || description.trim() === "") {
    return { skill: null, diagnostics };
  }
  return {
    skill: {
      name,
      description,
      content: body,
      filePath,
      disableModelInvocation: frontmatter["disable-model-invocation"] === true,
    },
    diagnostics,
  };
}

function validateName(name: string, parentDirName: string): string[] {
  const errors: string[] = [];
  if (name !== parentDirName) {
    errors.push(`name "${name}" does not match parent directory "${parentDirName}"`);
  }
  if (name.length > MAX_NAME_LENGTH) {
    errors.push(`name exceeds ${MAX_NAME_LENGTH} characters (${name.length})`);
  }
  if (!/^[a-z0-9-]+$/.test(name)) {
    errors.push("name contains invalid characters (must be lowercase a-z, 0-9, hyphens only)");
  }
  if (name.startsWith("-") || name.endsWith("-")) {
    errors.push("name must not start or end with a hyphen");
  }
  if (name.includes("--")) {
    errors.push("name must not contain consecutive hyphens");
  }
  return errors;
}

function validateDescription(description: string | undefined): string[] {
  const errors: string[] = [];
  if (!description || description.trim() === "") {
    errors.push("description is required");
  } else if (description.length > MAX_DESCRIPTION_LENGTH) {
    errors.push(
      `description exceeds ${MAX_DESCRIPTION_LENGTH} characters (${description.length})`,
    );
  }
  return errors;
}

function parseFrontmatter(content: string):
  | { ok: true; value: { frontmatter: Record<string, unknown>; body: string } }
  | { ok: false; error: Error } {
  try {
    const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    if (!normalized.startsWith("---")) {
      return { ok: true, value: { frontmatter: {}, body: normalized } };
    }
    const endIndex = normalized.indexOf("\n---", 3);
    if (endIndex === -1) {
      return { ok: true, value: { frontmatter: {}, body: normalized } };
    }
    const yamlString = normalized.slice(4, endIndex);
    const body = normalized.slice(endIndex + 4).trim();
    return {
      ok: true,
      value: {
        frontmatter: (parse(yamlString) ?? {}) as Record<string, unknown>,
        body,
      },
    };
  } catch (error) {
    return { ok: false, error: toError(error) };
  }
}

async function resolveKind(
  env: HarnessExecutionEnv,
  info: HarnessFileInfo,
  diagnostics: SkillDiagnostic[],
): Promise<"file" | "directory" | undefined> {
  if (info.kind === "file" || info.kind === "directory") return info.kind;
  const canonicalPath = await env.canonicalPath(info.path);
  if (!canonicalPath.ok) {
    if (canonicalPath.error.code !== "not_found") {
      diagnostics.push({
        type: "warning",
        code: "file_info_failed",
        message: canonicalPath.error.message,
        path: info.path,
      });
    }
    return undefined;
  }
  const target = await env.fileInfo(canonicalPath.value);
  if (!target.ok) {
    if (target.error.code !== "not_found") {
      diagnostics.push({
        type: "warning",
        code: "file_info_failed",
        message: target.error.message,
        path: info.path,
      });
    }
    return undefined;
  }
  return target.value.kind === "file" || target.value.kind === "directory"
    ? target.value.kind
    : undefined;
}

function dirnameEnvPath(path: string): string {
  const normalized = path.replace(/[\\/]+$/, "");
  const separatorIndex = Math.max(
    normalized.lastIndexOf("/"),
    normalized.lastIndexOf("\\"),
  );
  if (separatorIndex === 2 && normalized[1] === ":") {
    return normalized.slice(0, 3);
  }
  return separatorIndex <= 0 ? "/" : normalized.slice(0, separatorIndex);
}

function relativeEnvPath(root: string, path: string): string {
  const normalizedRoot = root.replace(/\\/g, "/").replace(/\/+$/, "");
  const normalizedPath = path.replace(/\\/g, "/").replace(/\/+$/, "");
  if (normalizedPath === normalizedRoot) return "";
  return normalizedPath.startsWith(`${normalizedRoot}/`)
    ? normalizedPath.slice(normalizedRoot.length + 1)
    : normalizedPath.replace(/^\/+/, "");
}

export function formatSkillsForSystemPrompt(skills: readonly Skill[]): string {
  const visibleSkills = skills.filter((skill) => !skill.disableModelInvocation);
  if (visibleSkills.length === 0) return "";
  const lines = [
    "The following skills provide specialized instructions for specific tasks.",
    "Read the full skill file when the task matches its description.",
    "When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.",
    "",
    "<available_skills>",
  ];
  for (const skill of visibleSkills) {
    lines.push("  <skill>");
    lines.push(`    <name>${escapeXml(skill.qualifiedName ?? skill.name)}</name>`);
    lines.push(`    <description>${escapeXml(skill.description)}</description>`);
    lines.push(`    <location>${escapeXml(skill.filePath)}</location>`);
    lines.push("  </skill>");
  }
  lines.push("</available_skills>");
  return lines.join("\n");
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
