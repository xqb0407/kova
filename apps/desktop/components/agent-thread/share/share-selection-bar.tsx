"use client";

/**
 * 分享选择模式的底栏（形态对齐豆包的「选择对话」）：composer 上方一条——
 * 全选、已选计数、取消、生成分享。shrink-0 常规布局，空闲时渲染 null 零影响。
 *
 * 勾选按「轮」联动：轮表在这里从消息列表算出并同步进 store。
 */
import { useAuiState } from "@assistant-ui/react";
import dynamic from "next/dynamic";
import { useEffect, useMemo, useRef, useState, type FC } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  clearShareSelection,
  exitShareMode,
  materializeAutoAll,
  selectAllMessages,
  syncShareTurns,
  useShareState,
  type ShareTurnMap,
} from "@/lib/share/share-store";

// 分享预览/导出按需加载：marked + DOMPurify 不进首屏 chunk
const ShareDialog = dynamic(
  () => import("./share-dialog").then((mod) => mod.ShareDialog),
  { ssr: false },
);

const ID_SEPARATOR = "\u0000";
const FIELD_SEPARATOR = "\u0001";

/** 空闲时不订阅消息列表（每 token 全量 join 没必要），进入选择模式才开始 */
function useShareMessages(selecting: boolean): {
  ids: string[];
  turns: ShareTurnMap;
} {
  const packed = useAuiState((s) =>
    selecting
      ? s.thread.messages
          .map((message) => `${message.id ?? ""}${FIELD_SEPARATOR}${message.role}`)
          .filter((entry) => !entry.startsWith(FIELD_SEPARATOR))
          .join(ID_SEPARATOR)
      : "",
  );
  return useMemo(() => {
    const ids: string[] = [];
    const turns = new Map<string, string[]>();
    if (!packed) return { ids, turns: turns as ShareTurnMap };
    // 一轮 = 一条用户消息 + 它后面直到下一条用户消息之前的所有助手消息
    let current: string[] | null = null;
    for (const entry of packed.split(ID_SEPARATOR)) {
      const split = entry.lastIndexOf(FIELD_SEPARATOR);
      if (split <= 0) continue;
      const id = entry.slice(0, split);
      const role = entry.slice(split + 1);
      if (role === "system") continue;
      if (role === "user" || current === null) current = [id];
      else current.push(id);
      ids.push(id);
      turns.set(id, current);
    }
    return { ids, turns: turns as ShareTurnMap };
  }, [packed]);
}

export const ShareSelectionToolbar: FC = () => {
  const share = useShareState();
  const selecting = share.mode === "selecting";
  const { ids, turns } = useShareMessages(selecting);
  const [dialogOpen, setDialogOpen] = useState(false);

  // globals.css 的 body.share-selecting 规则给每条消息根让出勾选框栏位
  useEffect(() => {
    document.body.classList.toggle("share-selecting", selecting);
    return () => document.body.classList.remove("share-selecting");
  }, [selecting]);

  // 轮表同步 + 「全选」默认意图落地；pendingExpand 变化也要重跑
  // （选择中再次「分享此条」时 ids/turns 不变，只有这个标记翻了）
  useEffect(() => {
    if (!selecting) return;
    syncShareTurns(turns);
    materializeAutoAll(ids);
  }, [selecting, ids, turns, share.pendingExpand]);

  // 切换会话：旧消息 id 对新会话没有意义，直接退出
  const threadId = useAuiState((s) => s.threads.mainThreadId);
  const prevThreadId = useRef(threadId);
  useEffect(() => {
    if (prevThreadId.current === threadId) return;
    prevThreadId.current = threadId;
    exitShareMode();
  }, [threadId]);

  // 再次进入选择模式时兜底关掉上次遗留的弹窗态
  useEffect(() => {
    if (selecting) return;
    setDialogOpen(false);
  }, [selecting]);

  // Esc 退出（弹窗自己会先消费 Esc 关闭；这里兜底选择模式）
  useEffect(() => {
    if (!selecting) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || dialogOpen) return;
      exitShareMode();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [selecting, dialogOpen]);

  if (!selecting) return null;

  const count = share.selected.size;
  const allSelected = ids.length > 0 && ids.every((id) => share.selected.has(id));

  return (
    <>
      <div className="border-border/60 bg-(--composer-bg) mx-1 mb-2 flex shrink-0 items-center gap-2.5 rounded-(--composer-radius) border px-3 py-2 backdrop-blur-xl">
        <label className="flex cursor-pointer items-center gap-2 text-sm select-none">
          <Checkbox
            checked={allSelected}
            onCheckedChange={(checked) => {
              if (checked) selectAllMessages(ids);
              else clearShareSelection();
            }}
          />
          全选
        </label>
        <span className="text-muted-foreground text-xs">
          已选 <b className="text-foreground tabular-nums">{count}</b> 条
        </span>
        <div className="ml-auto flex items-center gap-1.5">
          <Button
            variant="ghost"
            size="sm"
            className="text-muted-foreground h-8 rounded-full px-3.5"
            onClick={exitShareMode}
          >
            取消
          </Button>
          <Button
            size="sm"
            className="h-8 rounded-full px-3.5"
            disabled={count === 0}
            onClick={() => setDialogOpen(true)}
          >
            生成分享
          </Button>
        </div>
      </div>

      {dialogOpen && (
        <ShareDialog
          selected={share.selected}
          onClose={() => setDialogOpen(false)}
        />
      )}
    </>
  );
};
