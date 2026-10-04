/**
 * 工作区写边界：判定一次工具调用是否**只**在工作区内落盘。
 *
 * 用途是 `workspace-write` 审批档（"工作区内免确认、之外要确认"）。这一层刻意做成
 * 纯函数（除 realpath 外零依赖、无 I/O 语义），因为它是安全判据——判定逻辑必须能
 * 被单测逐条钉住，而不是混在审批流程里靠人肉推演。
 *
 * ⚠️ 这一层管不住 bash：一条 `bash -c` 能写到任何地方，参数里看不出目标路径。
 * 所以 bash 一律返回 false（照常弹审批）。真正的等价做法是 OS 级沙箱
 *（seatbelt / landlock），那是另一件事，见 docs/permission-modes.md。
 */
import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

/** 参数里带目标路径的写类工具（其余工具没有可判的路径，一律不放行） */
const PATH_BEARING_WRITE_TOOLS = new Set(["write", "edit"]);

/**
 * 解析符号链接后再规范化一个可能**尚不存在**的路径。
 *
 * 为什么要逐个祖先 realpath：直接对目标 realpath 时文件还不存在（新建文件，
 * write 的常见情形）会抛错；只做字符串 resolve 又会被软链接绕过——工作区内一个
 * 指向 `/etc` 的软链接，字符串前缀比较看起来完全合法。所以从目标往上找到第一个
 * 真实存在的祖先做 realpath，再把剩下的段拼回去。
 *
 * macOS 上这步也是必需的：`/tmp` → `/private/tmp`、`/Users` 某些情形同样是软链接，
 * 不 realpath 会让「同一个目录」在两个名字下被判成一内一外。
 */
export function realResolve(target: string): string {
  const abs = resolve(target);
  let head = abs;
  const tail: string[] = [];
  // 祖先链有限，最多到根；existsSync 命中即停
  while (!existsSync(head)) {
    const parent = dirname(head);
    if (parent === head) return abs; // 到根还不存在（不可能）：退回字符串结果
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

/** path.relative 口径的内外判定：不看字符串前缀，`..` 与绝对路径都被正确归位 */
export function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * 这次工具调用是不是「只在工作区内写」。
 *
 * 只有 write / edit 且 file_path 落在 cwd（含子目录）内才算；其余一律 false：
 * - bash：参数看不出会写到哪（见文件头）；
 * - 子代理/技能/主题/插件管理：写的是应用配置目录，本来就在工作区之外；
 * - 参数缺失或不是字符串：判不了就是不放行——安全判据的方向永远是「不确定就拦」。
 */
export function writeTargetInsideWorkspace(
  toolName: string,
  args: unknown,
  cwd: string,
): boolean {
  const target = writeTargetPath(toolName, args, cwd);
  if (!target) return false;
  return isInside(realResolve(cwd), target);
}

/**
 * 这次工具调用要写的绝对路径（解软链、`..` 已归位）；判不了返回 null。
 *
 * 与 writeTargetInsideWorkspace 共用同一套解析——写成两份的话，两份的差异
 * （尤其 resolve/join 这种细节）迟早会变成一处能绕、一处不能绕的漏洞。
 */
export function writeTargetPath(
  toolName: string,
  args: unknown,
  cwd: string,
): string | null {
  if (!PATH_BEARING_WRITE_TOOLS.has(toolName)) return null;
  const filePath = (args as { file_path?: unknown } | null | undefined)?.file_path;
  if (typeof filePath !== "string" || !filePath.trim()) return null;
  // 必须用 resolve 而不是 join：join 对绝对路径**不会丢弃前缀**，会把
  // `/other/secret.ts` 拼成 `<cwd>/other/secret.ts`（通常不存在），再被
  // realResolve 的「向上找存在的祖先」圆回工作区内部——绝对路径指向外部反而
  // 被放行。resolve 的语义才正确：绝对路径直接取胜
  return realResolve(resolve(cwd, filePath.trim()));
}

/** 这次工具调用是否「带路径的写」（write/edit）。调用方据此决定要不要解析清单 */
export function isPathBearingWrite(toolName: string): boolean {
  return PATH_BEARING_WRITE_TOOLS.has(toolName);
}
