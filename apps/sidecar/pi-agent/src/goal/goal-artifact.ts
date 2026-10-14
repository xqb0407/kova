/**
 * 目标产物落盘：把目标契约写成一份人能直接打开看的 Markdown。
 *
 * 为什么要有这个文件：目标原本只活在内存槽位 + 一行 goal_state JSONL 里，用户
 * 看不到「我到底答应了什么、模型打算拿什么证明做到了」。验收标准确认之后这份
 * 契约就定型了，它值得有一个可以 diff、可以被外部工具读的落点——PI-Desktop
 * 把这件事交给宿主写 `.pi/goal/*.md` 而不是让模型自己写，正是同一个理由。
 *
 * 写入纪律与 plan 文件一致：路径首写定名、之后整体覆盖；调用方 fire-and-forget，
 * 写失败只记日志（丢的是可读性，不是状态机的正确性）。目标真正的权威副本在
 * goal_state 行里，这份文件是它的投影。
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { logErr } from "../log";
import { fileTimestamp, sanitizeFileName } from "../agent/artifact-naming";
import type { Goal } from "./goal-state";

/** 目标当前阶段的验收标准段落 */
function criteriaSection(goal: Goal): string {
  const a = goal.acceptance;
  if (!a || a.status === "skipped") {
    return "（未设验收标准：完成判定不做逐条对账）";
  }
  if (a.status === "pending") {
    return [
      "（正在拟定）",
      ...(a.feedback ? ["", `用户上一条意见：${a.feedback}`] : []),
    ].join("\n");
  }
  const lines = a.items.map((c) => `- [ ] ${c.id} — ${c.text}`);
  if (a.status === "proposed") {
    return ["（待用户确认）", "", ...lines].join("\n");
  }
  return lines.join("\n");
}

function renderGoal(goal: Goal): string {
  const title = goal.objective.split(/\r?\n/)[0]?.trim() || "Goal";
  return [
    `# ${title}`,
    "",
    `- 目标 id: ${goal.id}`,
    `- 状态: ${goal.status}`,
    `- 建立于: ${new Date(goal.startedAt).toISOString()}`,
    `- 最后更新: ${new Date(goal.updatedAt).toISOString()}`,
    `- 轮次上限: ${goal.maxAutoTurns === null ? "不限" : goal.maxAutoTurns}`,
    `- 已跑轮次: ${goal.turnCount}`,
    "",
    "## 目标",
    "",
    goal.objective,
    "",
    "## 验收标准",
    "",
    criteriaSection(goal),
    ...(goal.completionSummary
      ? ["", "## 完成说明", "", goal.completionSummary]
      : []),
    ...(goal.completionAudit?.length
      ? [
          "",
          "## 完成时的逐条对账",
          "",
          ...goal.completionAudit.map(
            (r) => `- ${r.met ? "✅" : "❌"} ${r.id} — ${r.text}：${r.evidence}`,
          ),
        ]
      : []),
    "",
  ].join("\n");
}

/**
 * 产物路径：首次调用定名 `<cwd>/.kova/goals/goal-<标题>-<时间>.md`，
 * 之后沿用已有路径（覆盖写）。目标换一个就换一份新文件——调用方在换目标时
 * 把路径重置掉（见 goal.ts 的 startGoal / syncGoalOnUserPrompt）。
 */
export function goalArtifactPath(
  cwd: string,
  goal: Goal,
  existingPath: string | undefined,
): string {
  if (existingPath) return existingPath;
  const firstLine = goal.objective.split(/\r?\n/)[0] ?? "";
  return join(
    cwd,
    ".kova",
    "goals",
    [
      "goal",
      sanitizeFileName(firstLine) || "untitled",
      fileTimestamp(new Date(goal.startedAt)),
    ].join("-") + ".md",
  );
}

/**
 * 按路径串行的写入链。
 *
 * 为什么必须串行：每次目标变更都会 fire-and-forget 写一次，而这些变更在
 * turn_end 附近常常连着发生（结算 → 提交 → 确认）。两个 writeFile 并发落在同一
 * 路径上会互相截断——实测能把文件写成前半是新内容、后半是 NUL 的撕裂状态。
 * 串成一条链之后每次写的仍是「那一刻的盘面」，但落盘顺序与变更顺序一致，
 * 最后落地的是最新一份。
 */
const writeChains = new Map<string, Promise<void>>();

/** 写一份产物（调用方保证路径；不做 catch，避免"看起来写成功了"） */
async function writeGoalArtifact(path: string, goal: Goal): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, renderGoal(goal), "utf8");
}

/**
 * 落盘的 fire-and-forget 包装：状态机是同步的，不该为了写文件变成异步。
 * 失败只记日志——用户的条与循环照常工作，丢的只是那份可读副本。
 *
 * @param onPath 路径首次确定时回填给 run（run.goalFilePath）
 */
export function writeGoalArtifactAsync(
  cwd: string,
  goal: Goal,
  existingPath: string | undefined,
  onPath: (path: string) => void,
): void {
  const path = goalArtifactPath(cwd, goal, existingPath);
  onPath(path);
  const previous = writeChains.get(path) ?? Promise.resolve();
  const next = previous
    .then(() => writeGoalArtifact(path, goal))
    .catch((err) => {
      logErr("goal artifact write failed:", err);
    })
    .finally(() => {
      // 只清理自己这一环：后续入队的写已经把它替换掉了，误删会把新链断掉
      if (writeChains.get(path) === next) writeChains.delete(path);
    });
  writeChains.set(path, next);
}

/** 测试缝：等所有在飞的产物写入落定（生产路径不需要，fire-and-forget 是有意的） */
export async function flushGoalArtifactsForTest(): Promise<void> {
  while (writeChains.size > 0) {
    await Promise.all([...writeChains.values()]);
  }
}
