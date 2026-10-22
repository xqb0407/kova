/**
 * 工作区写边界：判定一次工具调用是否**只**在工作区内落盘。
 *
 * 用途是 `workspace-write` 审批档（"工作区内免确认、之外要确认"）。这一层刻意做成
 * 纯函数（除 realpath 外零依赖、无 I/O 语义），因为它是安全判据——判定逻辑必须能
 * 被单测逐条钉住，而不是混在审批流程里靠人肉推演。
 *
 * ⚠️ 这一层管不住 bash：一条 `bash -c` 能写到任何地方，参数里看不出目标路径。
 * 所以 bash 一律返回 false（照常弹审批）；真正的 OS 隔离由
 * permissions/sandbox-plan.ts 生成计划、宿主执行。
 */
import { resolve } from "node:path";
import { isInside, realResolve } from "pi-sandbox";

export { isInside, realResolve };

/** 参数里带目标路径的写类工具（其余工具没有可判的路径，一律不放行） */
const PATH_BEARING_WRITE_TOOLS = new Set(["write", "edit"]);

/**
 * 这次工具调用是不是「只在工作区内写」。
 *
 * 只有 write / edit 且 file_path 落在 cwd（含子目录）内才算；其余一律 false：
 * - bash：参数看不出会写到哪（见文件头）；
 * - 子代理/技能/主题/插件管理：写的是应用配置目录，本来就在工作区之外；
 * - 参数缺失或不是字符串：判不了就是不放行——安全判据的方向永远是「不确定就拦」。
 *
 * extraRoots = 项目虚拟目录（用户在项目设置里添加的其它代码工程根）：
 * 按「工作区内」对待，但仍然只认 write/edit 的结构化路径参数（bash 不受影响）。
 */
export function writeTargetInsideWorkspace(
  toolName: string,
  args: unknown,
  cwd: string,
  extraRoots: readonly string[] = [],
): boolean {
  const target = writeTargetPath(toolName, args, cwd);
  if (!target) return false;
  const roots = [cwd, ...extraRoots];
  return roots.some((root) => isInside(realResolve(root), target));
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
