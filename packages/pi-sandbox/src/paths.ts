import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

/**
 * 解析符号链接后再规范化一个可能**尚不存在**的路径。
 *
 * 从目标往上找到第一个真实存在的祖先做 realpath，再把剩下的段拼回去。
 * 这样新建文件、目录还不存在时也能得到稳定结果；同时避免工作区内一个指向
 * 外部的软链接在字符串前缀比较下被误判为“在里面”。
 */
export function realResolve(target: string): string {
  const abs = resolve(target);
  let head = abs;
  const tail: string[] = [];
  while (!existsSync(head)) {
    const parent = dirname(head);
    if (parent === head) return abs;
    tail.unshift(head.slice(parent.length + 1));
    head = parent;
  }
  let real: string;
  try {
    real = realpathSync(head);
  } catch {
    return abs;
  }
  return tail.length ? join(real, ...tail) : real;
}

/** path.relative 口径的内外判定：`..` 与绝对路径都被正确归位。 */
export function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** 目标是否落在任一已解析的根内。 */
export function isWithinAnyRoots(
  target: string,
  roots: readonly string[],
): boolean {
  const real = realResolve(target);
  return roots.some((root) => isInside(realResolve(root), real));
}

/** 返回第一个包含目标的根（用于错误信息），没有则 null。 */
export function firstRootContaining(
  target: string,
  roots: readonly string[],
): string | null {
  const real = realResolve(target);
  for (const root of roots) {
    const resolved = realResolve(root);
    if (isInside(resolved, real)) return resolved;
  }
  return null;
}

/** 工具参数里的路径 → 绝对路径（相对路径按 cwd 解析），保留软链接解析。
 *  不 trim：宿主真正的读写用的是原字符串，校验必须和落盘目标一致。 */
export function resolveToolPath(cwd: string, filePath: string): string {
  return realResolve(isAbsolute(filePath) ? filePath : resolve(cwd, filePath));
}
