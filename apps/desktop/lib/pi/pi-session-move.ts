"use client";

import { movePiSession, piSessionCwdMap } from "./pi-thread-adapter";

/**
 * 移动会话到另一个项目的共享内核（侧栏行菜单与 /move 命令共用）。
 *
 * 语义等价 pi-move 的 /move：sessionId 与历史不变，只换 cwd；但 kova 的会话
 * 是扁平存储 + SQLite 索引，cwd 是元数据，所以不需要搬/复制 JSONL——真正的
 * 换绑由 sidecar 的 set_session_cwd 完成（驻留 run 重建工具/提示词/技能/MCP）。
 *
 * 目标只允许是"已有项目"（会话自己记录的 cwd 去重），不提供系统任意目录：
 * 移动的语义是改会话归属，不是给会话挑一个全新的文件夹。
 */
export type MoveSessionResult =
  | { kind: "moved"; cwd: string }
  | { kind: "same-dir"; cwd: string };

/** 只做展示/比较用：去尾部斜杠、统一分隔符（不解析 ~ 或相对路径） */
function normalizeSessionPath(p: string): string {
  const trimmed = p.trim();
  const stripped = trimmed.replace(/[\\/]+$/, "");
  return (stripped || trimmed).replace(/\\/g, "/");
}

function sameSessionDirectory(a: string, b: string): boolean {
  return normalizeSessionPath(a) === normalizeSessionPath(b);
}

/**
 * 当前已有的项目目录：按**当前清单里的会话**取 cwd 去重。
 * 不直接遍历 cwd 镜像的值——镜像不清理已删除会话的旧条目（历史实现），
 * 直接取会冒出已不存在的"幽灵项目"。任务会话的空 cwd 不算项目。
 */
export function listProjectDirectories(
  sessionIds: Iterable<string>,
  excludeCwd?: string,
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const sessionId of sessionIds) {
    const cwd = piSessionCwdMap.get(sessionId);
    if (!cwd) continue;
    if (excludeCwd && sameSessionDirectory(cwd, excludeCwd)) continue;
    // 同一目录可能同时存在 /a 与 /a/ 两种写法：按规范化键去重
    const key = normalizeSessionPath(cwd);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(cwd);
  }
  return out;
}

export async function moveSessionToDirectory(
  sessionId: string,
  targetCwd: string,
): Promise<MoveSessionResult> {
  if (typeof window === "undefined") {
    throw new Error("移动会话仅支持桌面端");
  }
  if (!targetCwd) throw new Error("请选择目标项目");

  const currentCwd = piSessionCwdMap.get(sessionId) ?? "";
  if (currentCwd && sameSessionDirectory(currentCwd, targetCwd)) {
    return { kind: "same-dir", cwd: targetCwd };
  }

  await movePiSession(sessionId, targetCwd);
  // 侧栏项目组折叠时自动展开目标组（监听方在 clone-thread-shell 的
  // projOpenDirs 状态旁，任务 tab 下也能生效）
  window.dispatchEvent(
    new CustomEvent("pi:session-moved", {
      detail: { sessionId, cwd: targetCwd },
    }),
  );
  return { kind: "moved", cwd: targetCwd };
}
