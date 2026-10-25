/**
 * 打开一条搜索结果的落点（纯副作用编排，不碰 React 状态）。
 *
 * 各个来源的打开方式不同，集中在这里，视图层只调一个函数：
 * - 会话 / 消息：走 open-session 总线（消息带 seq+query 供跳转高亮）
 * - 产物 / 资料库文件：系统默认应用打开（fs_open 坚持相对路径 + 可信根）
 * - 项目文件 / 代码：应用内面板 file 标签（代码文件不在 fs_open 白名单里）
 * - 历史行：回填查询词，不关闭面板
 * - 操作行：直接执行命令
 *
 * 返回值表示"是否已经关闭搜索"由调用方决定（历史/操作行不关）。
 */
import { fsOpen } from "@/lib/workspace/fs";
import { focusPanelTab } from "@/lib/panels/panel-tabs";
import { requestOpenSession } from "@/lib/pi/open-session";
import { recordSearchHistory } from "@/lib/pi/pi-bridge";
import { taskWorkspaceDir } from "@/lib/workspace/task-workspace";
import { getWorkspace } from "@/lib/workspace/workspace-store";
import { LIBRARY_OWNER_KEY, type SearchHit } from "./search-models";

export type OpenSearchHitResult = "close" | "keep-open";

export type OpenSearchHitDeps = {
  /** 当前查询词（消息跳转高亮 / 历史记录用） */
  query: string;
  /** 历史行点击时回填查询 */
  onQueryChange: (query: string) => void;
};

/**
 * 产物 / 资料库文件 → 系统默认应用。
 * fs_open 的可信根判定按 cwd 解析（resolveRoot），path 必须传**相对**路径：
 * 绝对路径要过 isUnderPath(realpath) 校验，而 taskWorkspaceDir() 可能返回
 * realpath 前的 /var 符号链接路径，两边对不上会被 cwd-not-allowed 拒掉。
 */
async function openArtifactFile(hit: {
  sessionId: string;
  rel: string;
}): Promise<void> {
  if (hit.sessionId === LIBRARY_OWNER_KEY) {
    const { libraryGetRoot } = await import("@/lib/workspace/library-files");
    const root = await libraryGetRoot().catch(() => null);
    if (root?.root) void fsOpen(root.root, hit.rel);
    return;
  }
  const base = await taskWorkspaceDir().catch(() => null);
  if (base) void fsOpen(`${base}/${hit.sessionId}`, hit.rel);
}

export function openSearchHit(
  hit: SearchHit,
  deps: OpenSearchHitDeps,
): OpenSearchHitResult {
  // 真实检索的落点：打开结果才记历史（防抖查询逐字符记会把前缀灌进历史）。
  // 历史/操作行不算一次检索。
  if (hit.kind !== "history" && hit.kind !== "action" && deps.query) {
    void recordSearchHistory(deps.query).catch(() => {});
  }

  switch (hit.kind) {
    case "session":
      requestOpenSession(hit.hit.sessionId);
      return "close";
    case "message":
      requestOpenSession(hit.hit.sessionId, {
        seq: hit.hit.seq,
        query: deps.query,
      });
      return "close";
    case "artifact":
      void openArtifactFile(hit.hit);
      return "close";
    case "projectFile":
    case "projectContent": {
      // 应用内打开（对齐产物卡 openCode）：面板 file 标签走 fs_read_file
      // 实时读盘；代码文件（ts/py 等）不在 fs_open 白名单里，系统打开会 bad-path
      const cwd = getWorkspace();
      if (cwd) {
        focusPanelTab("file", { cwd, path: hit.hit.rel });
        window.dispatchEvent(new Event("agent-panel:open"));
      }
      return "close";
    }
    case "history":
      deps.onQueryChange(hit.hit.query);
      return "keep-open"; // 回填查询词，不关闭面板
    case "action":
      hit.hit.run();
      return "keep-open";
  }
}
