/**
 * 代码引用（「引用到对话」）：把编辑器选区变成一条 **agent 按需读取的紧凑引用**。
 *
 * 设计（引用以附件形态加入对话，内容不内联）：
 * - **芯片文本**（输入框里显示、消息里显示）：`:code[path:11-16]{name=code:path:11-16}`
 *   —— 复用 directive 芯片机制（cm-directive 的 Decoration.replace 原子芯片）；
 * - **发送展开**（buildPiSendInput 调用本模块）：`:code[...]` → `@path (lines 11-16)`，
 *   模型看到的是标准引用形式；**代码内容由 agent 用自己的文件工具读取**——行号精确、
 *   内容永远最新、不占上下文。选这条路线的前提是 agent 有本地文件访问（桌面端满足）。
 *
 * 本模块保持纯函数（只依赖 directive formatter），发送链路与测试可直接引用；
 * 插入输入框的桥（insertIntoComposer）在调用方（文件视图）里接。
 */
import { unstable_defaultDirectiveFormatter } from "@assistant-ui/core";

export type CodeReference = {
  /** 展示/给模型的路径（相对工作目录优先；绝对路径也能被反引号形式承载） */
  path: string;
  startLine: number;
  endLine: number;
};

/** 引用串里的路径呈现：相对且"可提及"（无空白/@/控制符）用 `@path`；
 *  否则反引号包裹——提及正则会误吞带空格的裸路径。 */
export function formatCodeReferencePath(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  if (isMentionablePath(normalized)) return `@${normalized}`;
  return `\`${normalized.replace(/[`\r\n]/g, "'")}\``;
}

function isMentionablePath(path: string): boolean {
  if (!path || path.length > 120 || path.startsWith("/")) return false;
  // eslint-disable-next-line no-control-regex
  if (/\s|@|[\u0000-\u001f\u007f-\u009f]/.test(path)) return false;
  return path.split("/").every((part) => part && part !== "." && part !== "..");
}

/** 选区 → 给模型的引用串：`@src/foo.ts (lines 11-16)`（单行 `(line 12)`） */
export function formatCodeReference(ref: CodeReference): string {
  const lines =
    ref.startLine === ref.endLine
      ? `line ${ref.startLine}`
      : `lines ${ref.startLine}-${ref.endLine}`;
  return `${formatCodeReferencePath(ref.path)} (${lines})`;
}

/** 选区 → 芯片文本：`:code[src/foo.ts:11-16]{name=code:src/foo.ts:11-16}` */
export function buildCodeDirective(ref: CodeReference): string {
  const range =
    ref.startLine === ref.endLine
      ? `${ref.startLine}`
      : `${ref.startLine}-${ref.endLine}`;
  return unstable_defaultDirectiveFormatter.serialize({
    type: "code",
    label: `${ref.path}:${range}`,
    id: `code:${ref.path}:${range}`,
  });
}

/** 指令 id（或退而用 label）→ 引用参数；不合法返回 null。
 *  路径可能含 `:`（Windows 盘符），从右侧按 `<path>:<start>[-<end>]` 切。 */
export function parseCodeDirectiveId(idOrLabel: string): CodeReference | null {
  const match = /^(?:code:)?(.*):(\d+)(?:-(\d+))?$/u.exec(idOrLabel);
  if (!match) return null;
  const path = match[1] ?? "";
  const startLine = Number(match[2]);
  const endLine = match[3] ? Number(match[3]) : startLine;
  if (!path || !Number.isFinite(startLine) || !Number.isFinite(endLine)) {
    return null;
  }
  return { path, startLine, endLine };
}

/** 发送前展开：文本里的 `:code[...]` 芯片 → `@path (lines N-M)` 引用；
 *  其它指令（技能/子智能体等）原样保留，未命中/解析失败不改动一个字。 */
export function expandCodeDirectives(text: string): string {
  // 快路径：纯文本打字最常见的分支，不跑正则
  if (!text.includes(":code[")) return text;
  const segments = unstable_defaultDirectiveFormatter.parse(text);
  let out = "";
  let changed = false;
  for (const segment of segments) {
    if (segment.kind === "text") {
      out += segment.text;
      continue;
    }
    if (segment.type === "code") {
      const ref =
        parseCodeDirectiveId(segment.id) ?? parseCodeDirectiveId(segment.label);
      if (ref) {
        out += formatCodeReference(ref);
        changed = true;
        continue;
      }
    }
    // 原样回写（formatter 的序列化与源文本可精确回环）：不吞任何用户输入
    out += unstable_defaultDirectiveFormatter.serialize({
      type: segment.type,
      label: segment.label,
      id: segment.id,
    });
  }
  return changed ? out : text;
}

/** 引用串用相对路径最稳（agent 的 cwd 就是工作目录；绝对路径也能工作，
 *  但会被反引号包裹、模型还得自己换算）。路径在工作目录下时折算相对，
 *  否则原样返回绝对路径。 */
export function toWorkspaceRelative(
  path: string,
  workspace: string | null | undefined,
): string {
  if (!workspace) return path;
  const normalizedWorkspace = workspace.replace(/\\/g, "/").replace(/\/+$/u, "");
  const normalizedPath = path.replace(/\\/g, "/");
  if (normalizedPath === normalizedWorkspace) return path;
  const prefix = `${normalizedWorkspace}/`;
  if (normalizedPath.startsWith(prefix)) {
    return normalizedPath.slice(prefix.length);
  }
  return path;
}
