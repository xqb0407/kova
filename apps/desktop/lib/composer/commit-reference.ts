/**
 * 提交引用（图谱「添加到对话」）：把一次提交变成输入框里的一枚芯片，发送时
 * 展开成一行模型可读的提交描述。与代码引用（lib/composer/code-reference）、
 * 资料库引用同一套 directive 芯片机制：
 *
 * - **芯片文本**（输入框里显示）：
 *   `:commit[3f2a1c9 修复登录态]{name=commit:3f2a1c9:<ts>:<enc作者>:<enc说明>}`
 *   —— cm-directive 的原子芯片，悬浮出叉即可整段移除，位置可拖；
 * - **发送展开**（buildPiSendInput 调用本模块）：
 *   `:commit[...]` → `提交 3f2a1c9（张三，2026-10-28 10:12）：修复登录态`；
 * - **只带元信息不带 diff**：要看改动 agent 自己跑 `git show`，上下文不膨胀。
 *
 * id 里固化作者/说明的编码副本：芯片 label 会被截断，展开要完整信息；作者与
 * 说明经 encodeURIComponent，id 里的分隔符 `:` 不会被内容串味。
 *
 * 本模块保持纯函数（只依赖 directive formatter），发送链路与测试可直接引用。
 */
import { unstable_defaultDirectiveFormatter } from "@assistant-ui/core";

export const COMMIT_DIRECTIVE_TYPE = "commit";

export type CommitReference = {
  hash: string;
  subject: string;
  author: string;
  time: number;
};

const SHORT_LEN = 7;
const LABEL_SUBJECT_MAX = 48;

const pad2 = (n: number) => String(n).padStart(2, "0");

/** 与图谱详情区同一口径：YYYY-MM-DD HH:mm（本地时区，精确到分钟） */
export function formatCommitStamp(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** 芯片 label 只能单行、不能含 `]`（DIRECTIVE_RE 的边界），超长截断 */
function labelText(s: string, max: number): string {
  const flat = s.replace(/[[\]\r\n]/gu, " ").replace(/\s+/gu, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** 提交 → 芯片文本 */
export function buildCommitDirective(ref: CommitReference): string {
  const hash = ref.hash.slice(0, SHORT_LEN);
  return unstable_defaultDirectiveFormatter.serialize({
    type: COMMIT_DIRECTIVE_TYPE,
    label: `${hash} ${labelText(ref.subject, LABEL_SUBJECT_MAX)}`,
    id: [
      COMMIT_DIRECTIVE_TYPE,
      hash,
      String(Math.trunc(ref.time)),
      encodeURIComponent(ref.author),
      encodeURIComponent(ref.subject),
    ].join(":"),
  });
}

/** 指令 id → 引用参数；不合法返回 null（不猜、不吞用户输入） */
export function parseCommitDirectiveId(id: string): CommitReference | null {
  const match = /^commit:([0-9a-f]{4,64}):(\d{1,15}):([^:]*):(.*)$/u.exec(id);
  if (!match) return null;
  const time = Number(match[2]);
  if (!Number.isFinite(time)) return null;
  try {
    return {
      hash: match[1]!,
      time,
      author: decodeURIComponent(match[3]!),
      subject: decodeURIComponent(match[4]!),
    };
  } catch {
    return null;
  }
}

/** 引用 → 给模型的一行描述（与旧版直接贴文字时的措辞一致） */
export function formatCommitReference(ref: CommitReference): string {
  return `提交 ${ref.hash}（${ref.author}，${formatCommitStamp(ref.time)}）：${ref.subject}`;
}

/** 发送前展开：文本里的 `:commit[...]` 芯片 → 一行提交描述；
 *  其它指令（技能/子智能体/代码/资料库等）原样保留，未命中不改动一个字。 */
export function expandCommitDirectives(text: string): string {
  // 快路径：纯文本打字最常见的分支，不跑正则
  if (!text.includes(":commit[")) return text;
  const segments = unstable_defaultDirectiveFormatter.parse(text);
  let out = "";
  let changed = false;
  for (const segment of segments) {
    if (segment.kind === "text") {
      out += segment.text;
      continue;
    }
    if (segment.type === COMMIT_DIRECTIVE_TYPE) {
      const ref = parseCommitDirectiveId(segment.id);
      if (ref) {
        out += formatCommitReference(ref);
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
