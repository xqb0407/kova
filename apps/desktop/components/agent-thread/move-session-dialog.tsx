"use client";

import { useMemo, useState, useSyncExternalStore, type FC } from "react";
import { useAui } from "@assistant-ui/react";
import { CheckIcon, FolderIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { toast } from "@/components/ui/toast";
import {
  piSessionCwdMap,
  piSessionIdForThread,
  piSessionProjectIdMap,
  useSessionPrefsVersion,
} from "@/lib/pi/pi-thread-adapter";
import { useThreadItems } from "@/lib/thread-list/thread-items";
import {
  listProjectDirectories,
  moveSessionToDirectory,
} from "@/lib/pi/pi-session-move";
import { usePendingInteractionKind } from "@/lib/pi/pi-interactions";
import { usePiSessionRunning } from "@/lib/pi/pi-running";
import {
  pathBasename,
  setWorkspace,
} from "@/lib/workspace/workspace-store";
import {
  projectLabelFor,
  useProjectDisplayNamesVersion,
} from "@/lib/projects/project-display-name";
import {
  projectDisplayName,
  projectPrimaryPath,
  useProjectRegistry,
} from "@/lib/pi/pi-projects";

/* ------------------- 模块级请求状态（行菜单 → 对话框） ------------------- */

let requestedSessionId: string | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

/** 打开"移动会话到项目"对话框（目标只能是已有项目） */
export function openMoveSessionDialog(sessionId: string): void {
  requestedSessionId = sessionId;
  emit();
}

export function closeMoveSessionDialog(): void {
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

/**
 * 全局挂载一次（CloneThreadShell）：行菜单里的「移动到项目…」把会话 id
 * 投进上面的 store，这里弹项目选择框。
 *
 * 生命周期：请求为 null 时不渲染任何内容；打开期间订阅项目清单版本，
 * 侧栏会话分组变化（另一端移动/删除会话）会即时反映到列表。
 */
export const MoveSessionDialogHost: FC = () => {
  const sessionId = useSyncExternalStore(
    subscribe,
    getSnapshot,
    getServerSnapshot,
  );
  return sessionId ? <MoveSessionDialog sessionId={sessionId} /> : null;
};

const MoveSessionDialog: FC<{ sessionId: string }> = ({ sessionId }) => {
  const aui = useAui();
  const threadItems = useThreadItems();
  // 项目清单来自会话镜像；列表刷新（sessions_changed）时重算
  const prefsVersion = useSessionPrefsVersion();
  // 自定义显示名变化时重算排序/标签
  const displayNamesVersion = useProjectDisplayNamesVersion();
  const running = usePiSessionRunning(sessionId);
  const pendingKind = usePendingInteractionKind(sessionId);
  const [selected, setSelected] = useState<string | null>(null);
  const [moving, setMoving] = useState(false);

  type MoveTarget = {
    key: string;
    cwd: string;
    label: string;
    projectId?: string;
  };

  const currentCwd = piSessionCwdMap.get(sessionId) ?? "";
  const currentProjectId = piSessionProjectIdMap.get(sessionId);
  // 项目实体优先：空项目也能作为移动目标，多目录项目只出现一次（主目录）。
  // 注册表未就绪时回退“按现有会话 cwd 去重”的旧清单。
  const registry = useProjectRegistry();
  const targets = useMemo<MoveTarget[]>(() => {
    // prefsVersion 是镜像原地的重算触发器（普通 Map 不会通知）；
    // threadItems 限定"当前清单里仍存在的会话"，避免已删会话的幽灵项目
    void prefsVersion;
    void displayNamesVersion;
    const live = registry.filter(
      (project) => !project.archived && !project.hiddenFromSidebar,
    );
    if (live.length > 0) {
      const out: MoveTarget[] = [];
      for (const project of live) {
        if (project.id === currentProjectId) continue;
        const cwd = projectPrimaryPath(project);
        if (!cwd) continue;
        // 共享同一 primary 的项目是两个不同目标：key 用 projectId
        out.push({
          key: `project:${project.id}`,
          cwd,
          label: projectDisplayName(project),
          projectId: project.id,
        });
      }
      return out.sort(
        (a, b) => a.label.localeCompare(b.label) || a.cwd.localeCompare(b.cwd),
      );
    }
    // 归档会话不在侧栏可见分组里，其 cwd 不算"现有项目"
    const liveSessionIds = threadItems.flatMap((item) =>
      item.remoteId && item.status !== "archived" ? [item.remoteId] : [],
    );
    return listProjectDirectories(liveSessionIds, currentCwd || undefined)
      .map((cwd) => ({
        key: `cwd:${cwd}`,
        cwd,
        label: projectLabelFor(cwd),
      }))
      .sort(
        (a, b) => a.label.localeCompare(b.label) || a.cwd.localeCompare(b.cwd),
      );
  }, [
    prefsVersion,
    displayNamesVersion,
    threadItems,
    currentCwd,
    currentProjectId,
    registry,
  ]);

  const blocked = running || pendingKind != null;
  const selectedTarget = targets.find((target) => target.key === selected) ?? null;
  const selectionValid = selectedTarget != null;

  const close = () => {
    if (!moving) closeMoveSessionDialog();
  };

  const confirm = async () => {
    const target = selectedTarget;
    if (!target || moving || blocked) return;
    setMoving(true);
    try {
      const result = await moveSessionToDirectory(
        sessionId,
        target.cwd,
        target.projectId,
      );
      if (result.kind === "same-dir") {
        toast.add({
          title: "会话已在该项目",
          description: result.cwd,
          type: "info",
        });
        closeMoveSessionDialog();
        return;
      }
      // 当前打开的会话：Git/工作目录胶囊与面板立即跟随新项目。await 期间
      // 用户可能已切走：以**结算时**的当前会话为准——渲染期捕获的
      // mainThreadId 是唤起瞬间值，切走后会把旧会话的 cwd 套给新当前会话
      if (
        piSessionIdForThread(aui.threads.getState().mainThreadId) === sessionId
      )
        setWorkspace(result.cwd, "session", piSessionProjectIdMap.get(sessionId) ?? null);
      try {
        await aui.threads.reload();
      } catch (err) {
        // 移动已经生效；列表刷新失败由 sessions_changed 兜底，不报成移动失败
        console.error("threads.reload after move failed:", err);
      }
      toast.add({
        title: "会话已移动",
        description: result.cwd,
        type: "success",
      });
      closeMoveSessionDialog();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      toast.add({
        title: "移动失败",
        description: /session is busy/i.test(message)
          ? "会话正在运行，等本轮结束后再试"
          : /pending approvals/i.test(message)
            ? "有挂起的审批/问题，先处理完再移动"
            : message,
        type: "error",
      });
    } finally {
      setMoving(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => (!open ? close() : undefined)}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>移动会话到项目</DialogTitle>
          <DialogDescription>
            会话 ID 与历史保持不变；历史消息中的绝对路径与旧检查点仍指向原项目。
          </DialogDescription>
        </DialogHeader>

        {blocked ? (
          <p className="text-muted-foreground px-1 py-6 text-sm">
            {running
              ? "会话正在运行，等本轮结束后再移动。"
              : "有挂起的审批/问题，先处理完再移动。"}
          </p>
        ) : targets.length === 0 ? (
          <p className="text-muted-foreground px-1 py-6 text-sm">
            还没有其他项目。先在侧栏选择工作目录并新建对话，之后再移动。
          </p>
        ) : (
          <Command className="border-border/60 rounded-lg border">
            <CommandInput placeholder="搜索项目…" />
            <CommandList className="max-h-64">
              <CommandEmpty>没有匹配的项目</CommandEmpty>
              <CommandGroup>
                {targets.map((target) => (
                  <CommandItem
                    key={target.key}
                    value={target.key}
                    keywords={[pathBasename(target.cwd), target.label, target.cwd]}
                    onSelect={() => setSelected(target.key)}
                    className="gap-2"
                  >
                    <FolderIcon className="text-muted-foreground size-4 shrink-0" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm">
                        {target.label}
                      </span>
                      <span className="text-muted-foreground block truncate text-xs">
                        {target.cwd}
                      </span>
                    </span>
                    {selected === target.key && (
                      <CheckIcon className="text-primary size-4 shrink-0" />
                    )}
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={close} disabled={moving}>
            取消
          </Button>
          <Button
            onClick={() => void confirm()}
            disabled={!selectionValid || moving || blocked}
          >
            {moving ? "移动中…" : "移动"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
