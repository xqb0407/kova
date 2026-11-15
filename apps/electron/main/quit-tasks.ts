/**
 * 退出任务清单组装（纯函数，无 Electron 依赖，可单测）。
 *
 * 退出流程把「用户可感知的运行中工作」归一成一张有序清单：
 *   运行中的会话 → 后台 bash → 终端 → 仍需收尾的后台服务。
 * 标题只做展示，缺失时由渲染层回落「未命名会话」；这里不读 DB、不碰进程，
 * 调用方负责查标题、脱敏命令文本。
 */

export type QuitTaskKind =
  | "session"
  | "background"
  | "terminal"
  | "automation"
  | "engine"
  | "remote"
  | "im";

export type QuitTaskStatus = "pending" | "stopping" | "stopped";

export type QuitTaskInfo = {
  /** 稳定 id：`<kind>:<key>`，同时供停止循环解析目标 */
  id: string;
  kind: QuitTaskKind;
  /** null = 渲染层按 kind 显示类型名（服务类任务没有具体标题） */
  title: string | null;
  status: QuitTaskStatus;
};

export type QuitSessionSeed = {
  id: string;
  title?: string | null;
  firstMessage?: string | null;
};

export type QuitBackgroundSeed = {
  id: number;
  /** 调用方应先用 redactSecrets 脱敏 */
  command: string;
};

export type QuitTerminalSeed = {
  id: string;
  cwd?: string | null;
};

export type QuitServiceSeed = {
  kind: "automation" | "engine" | "remote" | "im";
  running: boolean;
};

export const QUIT_TITLE_MAX = 80;

/** 单行化 + 截断：任务标题只占提示条一行，换行/超长会撑破胶囊 */
export function normalizeQuitTitle(text: string | null | undefined): string | null {
  if (!text) return null;
  const firstLine = text.split(/\r?\n/, 1)[0]?.replace(/\s+/g, " ").trim() ?? "";
  if (!firstLine) return null;
  if (firstLine.length <= QUIT_TITLE_MAX) return firstLine;
  return `${firstLine.slice(0, QUIT_TITLE_MAX - 1)}…`;
}

/** 终端标题：cwd 的目录名（远端路径也适用）；cwd 缺失则交给渲染层显示类型名 */
function terminalTitle(cwd: string | null | undefined): string | null {
  const trimmed = cwd?.trim();
  if (!trimmed) return null;
  const normalized = trimmed.replace(/[\\/]+$/, "");
  const at = Math.max(normalized.lastIndexOf("/"), normalized.lastIndexOf("\\"));
  const base = at >= 0 ? normalized.slice(at + 1) : normalized;
  return normalizeQuitTitle(base);
}

/**
 * 组装退出清单。顺序即停止顺序：先收会话（用户最在意），再收后台进程/终端，
 * 最后才是服务级收尾；服务只在确实运行时入列，避免提示条出现无意义的空步骤。
 */
export function composeQuitTasks(input: {
  sessions: QuitSessionSeed[];
  background: QuitBackgroundSeed[];
  terminals: QuitTerminalSeed[];
  services: QuitServiceSeed[];
}): QuitTaskInfo[] {
  const out: QuitTaskInfo[] = [];
  const seen = new Set<string>();
  const push = (task: QuitTaskInfo) => {
    if (seen.has(task.id)) return;
    seen.add(task.id);
    out.push(task);
  };

  for (const session of input.sessions) {
    push({
      id: `session:${session.id}`,
      kind: "session",
      title: normalizeQuitTitle(session.title) ?? normalizeQuitTitle(session.firstMessage),
      status: "pending",
    });
  }
  for (const task of input.background) {
    push({
      id: `background:${task.id}`,
      kind: "background",
      title: normalizeQuitTitle(task.command),
      status: "pending",
    });
  }
  for (const terminal of input.terminals) {
    push({
      id: `terminal:${terminal.id}`,
      kind: "terminal",
      title: terminalTitle(terminal.cwd),
      status: "pending",
    });
  }
  for (const service of input.services) {
    if (!service.running) continue;
    push({
      id: `service:${service.kind}`,
      kind: service.kind,
      title: null,
      status: "pending",
    });
  }
  return out;
}
