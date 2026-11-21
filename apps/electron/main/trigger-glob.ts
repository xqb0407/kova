/**
 * 事件触发的纯匹配逻辑（L1b）：glob → 正则、watch 根推导、忽略规则、变更摘要。
 *
 * 单独成文件（不 import electron）：trigger-watchers 依赖 automation-service →
 * ipc → electron，bun test 里拉不起来；这里只留可单测的纯函数。
 */
import { isAbsolute, relative, resolve, sep } from "node:path";

/**
 * glob → 正则：支持 *（段内）/ **（跨段）/ ?；路径统一正斜杠。
 * 刻意不引 picomatch/依赖：触发器只允许这四种模式，缩小语义面也是缩小攻击面。
 */
export function globToRegExp(pattern: string): RegExp {
  let re = "";
  const norm = pattern.replace(/\\/g, "/");
  for (let i = 0; i < norm.length; i += 1) {
    const ch = norm[i]!;
    if (ch === "*") {
      if (norm[i + 1] === "*") {
        // ** 吞掉紧随的 /（`src/**\/*.ts` 应匹配 `src/a.ts`）
        re += norm[i + 2] === "/" ? "(?:.*/)?" : ".*";
        i += norm[i + 2] === "/" ? 2 : 1;
      } else {
        re += "[^/]*";
      }
    } else if (ch === "?") {
      re += "[^/]";
    } else if (".+^${}()|[]\\".includes(ch)) {
      re += `\\${ch}`;
    } else {
      re += ch;
    }
  }
  return new RegExp(`^${re}$`, "i");
}

/** glob 的静态前缀目录（watch 根）：`src/**\/*.ts` → `<ws>/src` */
export function watchRootFor(workspace: string, pattern: string): string {
  const norm = pattern.replace(/\\/g, "/");
  const idx = norm.search(/[*?]/);
  const prefix = idx < 0 ? norm : norm.slice(0, idx);
  const dirEnd = prefix.lastIndexOf("/");
  const rel = dirEnd <= 0 ? "" : prefix.slice(0, dirEnd);
  return resolve(workspace, rel);
}

/** target 是否落在 root 内（root 自身算在内；防 `..`/绝对路径逃逸 watch 根） */
export function isWithin(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export function matchesAny(regexps: RegExp[], relPosix: string): boolean {
  return regexps.some((re) => re.test(relPosix));
}

/** 默认忽略：agent 自身产物与依赖/版本库目录 */
export const IGNORED_SEGMENTS = ["node_modules", ".git", ".kova", "dist", "out", "build"];

export function isIgnored(relPosix: string): boolean {
  return relPosix.split("/").some((seg) => IGNORED_SEGMENTS.includes(seg));
}

/** root → abs 的相对路径（统一正斜杠；空串表示 root 自身） */
export function toPosixRelative(root: string, abs: string): string {
  return relative(root, abs).split(sep).join("/");
}

/** 变更摘要：`N file(s) changed: a, b …M more`（相对 workspace，正斜杠） */
export function summarizeChangedFiles(
  workspace: string,
  changed: Iterable<string>,
  max = 5,
): string {
  const list = [...changed].map((abs) => toPosixRelative(workspace, abs) || abs);
  const shown = list.slice(0, max);
  const more = list.length - shown.length;
  return `${list.length} file(s) changed: ${shown.join(", ")}${more > 0 ? ` …${more} more` : ""}`;
}
