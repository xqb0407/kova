"use client";

/**
 * 交接至新对话：全局单例对话框（顶栏「更多」与侧边栏行菜单共用）。
 *
 * 入口只投一个 sessionId 进模块级 store，Host 在 CloneThreadShell 挂载一次。
 * 确认后 sidecar 生成结构化交接摘要并创建一个只带摘要的新会话（不复制历史
 * 消息）；成功后走 requestOpenSession 统一 reload + 切线程。摘要请求可能跑
 * 一两分钟，期间禁止关闭对话框（服务端 280s / 客户端 300s 超时）。
 */
import { useState, useSyncExternalStore, type FC } from "react";
import { ArrowRightLeftIcon, Loader2Icon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/components/ui/toast";
import { useT } from "@/lib/i18n";
import { requestOpenSession } from "@/lib/pi/open-session";
import { handoffPiSession } from "@/lib/pi/pi-thread-adapter";

/* ------------------- 模块级请求状态（入口 → 对话框） ------------------- */

let requestedSessionId: string | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

/** 打开交接对话框（源会话必须是已落盘会话；调用方负责无 remoteId 时不显示入口） */
export function openHandoffDialog(sessionId: string): void {
  requestedSessionId = sessionId;
  emit();
}

export function closeHandoffDialog(): void {
  requestedSessionId = null;
  emit();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): string | null {
  return requestedSessionId;
}

function getServerSnapshot(): string | null {
  return null;
}

/** 全局挂载一次（CloneThreadShell）：store 有值才渲染，关闭即卸载重置表单 */
export const HandoffDialogHost: FC = () => {
  const sessionId = useSyncExternalStore(
    subscribe,
    getSnapshot,
    getServerSnapshot,
  );
  return sessionId ? <HandoffDialog key={sessionId} sessionId={sessionId} /> : null;
};

const HandoffDialog: FC<{ sessionId: string }> = ({ sessionId }) => {
  const t = useT();
  const [notes, setNotes] = useState("");
  const [archiveSource, setArchiveSource] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const newId = await handoffPiSession(sessionId, {
        ...(notes.trim() ? { notes: notes.trim() } : {}),
        ...(archiveSource ? { archiveSource: true } : {}),
      });
      toast.add({ title: t("chat.handoff.success"), type: "success" });
      closeHandoffDialog();
      // 统一的打开会话总线：base 壳 reload 列表后切到新会话
      requestOpenSession(newId);
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err);
      setError(
        /busy/i.test(raw)
          ? t("chat.handoff.busy")
          : /nothing to hand off/i.test(raw)
            ? t("chat.handoff.nothing")
            : t("chat.handoff.failed", { error: raw }),
      );
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        // 摘要请求不可取消：生成期间不许关闭，避免"关掉后新会话又冒出来"
        if (!next && !busy) closeHandoffDialog();
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ArrowRightLeftIcon className="size-4 shrink-0" />
            {t("chat.handoff.title")}
          </DialogTitle>
          <DialogDescription>{t("chat.handoff.description")}</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-2">
          <label className="text-sm font-medium" htmlFor="handoff-notes">
            {t("chat.handoff.notesLabel")}
          </label>
          <Textarea
            id="handoff-notes"
            value={notes}
            disabled={busy}
            maxLength={4000}
            placeholder={t("chat.handoff.notesPlaceholder")}
            onChange={(event) => setNotes(event.target.value)}
          />
        </div>

        <label className="flex cursor-pointer items-start gap-2.5">
          <Checkbox
            checked={archiveSource}
            disabled={busy}
            className="mt-0.5"
            onCheckedChange={(value) => setArchiveSource(value === true)}
          />
          <span className="min-w-0">
            <span className="block text-sm">{t("chat.handoff.archiveLabel")}</span>
            <span className="text-muted-foreground block text-xs">
              {t("chat.handoff.archiveHint")}
            </span>
          </span>
        </label>

        {error ? (
          <p className="text-destructive text-sm" role="alert">
            {error}
          </p>
        ) : null}

        <DialogFooter>
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => closeHandoffDialog()}
          >
            {t("common.action.cancel")}
          </Button>
          <Button disabled={busy} onClick={() => void submit()}>
            {busy ? <Loader2Icon className="size-4 animate-spin" /> : null}
            {busy ? t("chat.handoff.working") : t("chat.handoff.confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
