"use client";

import { useMemo, useState, type FC } from "react";
import { useAui, useAuiState } from "@assistant-ui/react";
import {
  ArchiveRestoreIcon,
  ArchiveIcon,
  FolderIcon,
  MessageSquareIcon,
  Trash2Icon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { piSessionCwdMap } from "@/lib/pi-thread-adapter";
import { pathBasename } from "@/lib/workspace-store";

type ArchivedItem = {
  id: string;
  title: string;
  /** 有 cwd = 项目会话；空 = 任务会话 */
  cwd: string;
  lastMessageAt: number;
};

/** 归档管理页：列出全部归档会话，恢复后侧栏列表实时同步（同一 aui 状态源） */
export const ArchiveSettings: FC = () => {
  const aui = useAui();
  const archivedThreadIds = useAuiState((s) => s.threads.archivedThreadIds);
  const threadItems = useAuiState((s) => s.threads.threadItems);

  const items = useMemo<ArchivedItem[]>(() => {
    const byId = new Map(threadItems.map((item) => [item.id, item]));
    return archivedThreadIds
      .map((id) => {
        const item = byId.get(id);
        if (!item) return null;
        const cwd =
          (item.remoteId && piSessionCwdMap.get(item.remoteId)) || "";
        return {
          id,
          title: item.title || "新会话",
          cwd,
          lastMessageAt: item.lastMessageAt?.getTime() ?? 0,
        };
      })
      .filter((v): v is ArchivedItem => v !== null)
      .sort((a, b) => b.lastMessageAt - a.lastMessageAt);
  }, [archivedThreadIds, threadItems]);

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <div className="flex w-full max-w-5xl flex-col gap-8 self-center px-8 py-8">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-bold tracking-tight">归档</h1>
          <p className="text-muted-foreground text-sm">
            归档的会话（含整个项目批量归档）不在侧栏展示，这里集中查看、恢复或删除。
          </p>
        </div>

        <section className="flex flex-col gap-3">
          <h2 className="text-base font-semibold">
            已归档会话{items.length > 0 ? ` · ${items.length}` : ""}
          </h2>
          {items.length === 0 ? (
            <div className="bg-muted/50 text-muted-foreground flex min-h-24 items-center justify-center gap-2 rounded-2xl text-sm">
              <ArchiveIcon className="size-4" />
              暂无归档会话，侧栏会话/项目菜单的「Archive / 归档项目」可移到这里
            </div>
          ) : (
            <div className="bg-muted/50 flex flex-col gap-1 rounded-2xl p-2">
              {items.map((item) => (
                <ArchivedRow
                  key={item.id}
                  item={item}
                  onRestore={() =>
                    aui.threads.item({ id: item.id }).unarchive()
                  }
                  onDelete={() => aui.threads.item({ id: item.id }).delete()}
                />
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
};

const ArchivedRow: FC<{
  item: ArchivedItem;
  onRestore: () => void;
  onDelete: () => void;
}> = ({ item, onRestore, onDelete }) => {
  const [confirming, setConfirming] = useState(false);

  const del = () => {
    // 两步确认：首次点击进入确认态，3 秒不点自动退出
    if (!confirming) {
      setConfirming(true);
      setTimeout(() => setConfirming(false), 3000);
      return;
    }
    setConfirming(false);
    onDelete();
  };

  return (
    <div className="flex min-h-11 items-center justify-between gap-4 rounded-xl px-3 py-2">
      <div className="min-w-0">
        <div className="truncate text-sm font-medium">{item.title}</div>
        <div className="text-muted-foreground flex items-center gap-1.5 text-xs">
          {item.cwd ? (
            <>
              <FolderIcon className="size-3 shrink-0" />
              <span className="truncate" title={item.cwd}>
                {pathBasename(item.cwd)}
              </span>
            </>
          ) : (
            <>
              <MessageSquareIcon className="size-3 shrink-0" />
              <span>任务</span>
            </>
          )}
          {item.lastMessageAt > 0 && (
            <span className="shrink-0">· {formatTime(item.lastMessageAt)}</span>
          )}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <Button
          variant="ghost"
          size="sm"
          className="h-7 gap-1.5 px-2 text-xs"
          onClick={onRestore}
        >
          <ArchiveRestoreIcon className="size-3.5" />
          恢复
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className={confirming
            ? "h-7 gap-1.5 bg-destructive/10 px-2 text-xs text-destructive hover:bg-destructive/15 hover:text-destructive"
            : "text-muted-foreground hover:text-destructive h-7 gap-1.5 px-2 text-xs hover:bg-destructive/10"}
          onClick={del}
        >
          <Trash2Icon className="size-3.5" />
          {confirming ? "确认删除" : "删除"}
        </Button>
      </div>
    </div>
  );
};

const formatTime = (ts: number): string => {
  const d = new Date(ts);
  const now = new Date();
  const sameYear = d.getFullYear() === now.getFullYear();
  const date = d.toLocaleDateString("zh-CN", {
    ...(sameYear ? {} : { year: "numeric" }),
    month: "numeric",
    day: "numeric",
  });
  return `${date} ${d.toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
  })}`;
};
