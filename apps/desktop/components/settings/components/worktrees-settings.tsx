"use client";

/**
 * Settings → Worktree：受管 git worktree 的管理面（docs/git-worktrees.md）。
 *
 * 版式对齐设置页参照（projects / archive / secrets）：
 * - 行为：创建前获取上游更新 / 自动删除旧 Worktree / 数量上限；
 * - 托管 Worktree：按原始仓库分组，时间过滤 + 刷新 + 一键移除；
 * - 回收站：恢复 / 彻底删除（7 天自动清理）。
 * 闭环：创建（可跟随未提交改动）→ 新建会话在 worktree 里干活 → 收尾建分支
 * 或删除（trash 可恢复）。
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type FC,
  type ReactNode,
} from "react";
import {
  FolderGit2Icon,
  GitBranchIcon,
  Loader2Icon,
  MessageSquarePlusIcon,
  PlusIcon,
  RefreshCwIcon,
  RotateCcwIcon,
  Trash2Icon,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Segmented } from "@/components/custom-ui/segmented";
import { SettingRow } from "@/components/custom-ui/setting-row";
import { toast } from "@/components/ui/toast";
import { invoke } from "@/desktop-bridge/core";
import { getPiChannel } from "@/lib/pi/pi-channel";
import { requestOpenSession } from "@/lib/pi/open-session";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";

type WorktreeRecord = {
  id: string;
  repoRoot: string;
  path: string;
  name?: string;
  base: string;
  baseCommit: string;
  branch?: string;
  includeUncommitted: boolean;
  createdAt: number;
  sessionIds: string[];
  status: "active" | "trashed";
  trashPath?: string;
  trashedAt?: number;
  exists: boolean;
};

type WorktreeRepo = {
  path: string;
  name: string;
  isGit: boolean;
  currentBranch?: string;
};

type WorktreeSettings = {
  fetchBeforeCreate: boolean;
  autoCleanup: boolean;
  autoCleanupLimit: number;
};

type AgeTab = "recent" | "mid" | "old";

const LIMIT_OPTIONS = [5, 10, 15, 20, 30];
const DAY = 24 * 60 * 60 * 1000;

const fmtDate = (ts: number): string => {
  const d = new Date(ts);
  const p2 = (n: number) => String(n).padStart(2, "0");
  return `${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
};

/** 仓库/目录路径的末段，用作分组标题 */
const pathName = (path: string): string => {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
};

/** 行内图标操作：Tooltip + 中文 aria-label（图标按钮的无障碍要求） */
const IconAction: FC<{
  label: string;
  icon: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  destructive?: boolean;
}> = ({ label, icon, onClick, disabled, destructive }) => (
  <Tooltip>
    <TooltipTrigger
      render={
        <Button
          variant="ghost"
          size="icon"
          aria-label={label}
          disabled={disabled}
          onClick={onClick}
          className={cn(
            "text-muted-foreground",
            destructive
              ? "hover:bg-destructive/10 hover:text-destructive"
              : "hover:text-foreground",
          )}
        >
          {icon}
        </Button>
      }
    />
    <TooltipContent>{label}</TooltipContent>
  </Tooltip>
);

/** 单条 Worktree：两行（名称/状态 + 路径/元信息），操作在右侧 */
const WorktreeRow: FC<{
  wt: WorktreeRecord;
  trashed?: boolean;
  disabled: boolean;
  rowBusy: boolean;
  onNewSession?: () => void;
  onCreateBranch?: () => void;
  onRemove?: () => void;
  onRestore?: () => void;
  onPurge?: () => void;
}> = ({
  wt,
  trashed = false,
  disabled,
  rowBusy,
  onNewSession,
  onCreateBranch,
  onRemove,
  onRestore,
  onPurge,
}) => {
  const t = useT();
  const label = wt.name || wt.id;
  const path = trashed ? (wt.trashPath ?? wt.path) : wt.path;

  return (
    <div className="hover:bg-background/60 flex items-center justify-between gap-4 rounded-xl px-3 py-2.5 transition-colors">
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <span
          className="min-w-0 truncate text-sm font-medium"
          title={`${label}\n${path}`}
        >
          {label}
        </span>
        {wt.branch ? (
          <Badge
            variant="outline"
            className="text-muted-foreground max-w-56 gap-1 py-0 font-mono"
            title={wt.branch}
          >
            <GitBranchIcon className="size-3 shrink-0" />
            <span className="truncate">{wt.branch}</span>
          </Badge>
        ) : (
          <span className="text-muted-foreground shrink-0 text-xs">
            {t("settings.worktrees.baseChip", { base: wt.base })}
          </span>
        )}
        {!wt.exists ? (
          <span className="text-destructive shrink-0 text-xs">
            {t("settings.worktrees.missing")}
          </span>
        ) : null}
        <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
          {trashed
            ? `· ${t("settings.worktrees.trashedAt", {
                time: fmtDate(wt.trashedAt ?? wt.createdAt),
              })}`
            : `· ${t("settings.worktrees.sessions", {
                count: wt.sessionIds.length,
              })} · ${fmtDate(wt.createdAt)}`}
        </span>
      </div>

      <div className="flex shrink-0 items-center gap-1">
        {trashed ? (
          <>
            <Button
              size="sm"
              variant="ghost"
              className="h-8 gap-1.5 px-2 text-[13px] font-normal"
              disabled={disabled || !wt.exists}
              onClick={() => onRestore?.()}
            >
              {rowBusy ? (
                <Loader2Icon className="size-4 animate-spin" />
              ) : (
                <RotateCcwIcon className="size-4" />
              )}
              {t("settings.worktrees.restore")}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive h-8 gap-1.5 px-2 text-[13px] font-normal"
              disabled={disabled}
              onClick={() => onPurge?.()}
            >
              <Trash2Icon className="size-4" />
              {t("settings.worktrees.purge")}
            </Button>
          </>
        ) : (
          <>
            <Button
              size="sm"
              variant="ghost"
              className="h-8 gap-1.5 px-2 text-[13px] font-normal"
              disabled={disabled || !wt.exists}
              onClick={() => onNewSession?.()}
            >
              {rowBusy ? (
                <Loader2Icon className="size-4 animate-spin" />
              ) : (
                <MessageSquarePlusIcon className="size-4" />
              )}
              {t("settings.worktrees.newSession")}
            </Button>
            <IconAction
              label={t("settings.worktrees.createBranch")}
              icon={<GitBranchIcon className="size-4" />}
              disabled={disabled || !wt.exists}
              onClick={() => onCreateBranch?.()}
            />
            <IconAction
              label={t("settings.worktrees.delete")}
              icon={<Trash2Icon className="size-4" />}
              disabled={disabled}
              destructive
              onClick={() => onRemove?.()}
            />
          </>
        )}
      </div>
    </div>
  );
};

export const WorktreesSettings: FC<{
  /** 「新建会话」成功后的宿主动作：设置页是全窗覆盖层，需切回聊天视图 */
  onOpenSession?: () => void;
}> = ({ onOpenSession }) => {
  const t = useT();
  const [rows, setRows] = useState<WorktreeRecord[]>([]);
  const [repos, setRepos] = useState<WorktreeRepo[]>([]);
  const [settings, setSettings] = useState<WorktreeSettings>({
    fetchBeforeCreate: false,
    autoCleanup: true,
    autoCleanupLimit: 15,
  });
  const [tab, setTab] = useState<AgeTab>("recent");
  const [loading, setLoading] = useState(true);
  const [actionId, setActionId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [createOpen, setCreateOpen] = useState(false);
  const [repoPath, setRepoPath] = useState("");
  const [base, setBase] = useState("");
  const [name, setName] = useState("");
  const [includeUncommitted, setIncludeUncommitted] = useState(false);
  const [branches, setBranches] = useState<string[]>([]);
  const [branchLoading, setBranchLoading] = useState(false);

  const [branchTarget, setBranchTarget] = useState<WorktreeRecord | null>(null);
  const [branchName, setBranchName] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<WorktreeRecord | null>(null);
  const [purgeTarget, setPurgeTarget] = useState<WorktreeRecord | null>(null);
  const [bulkConfirmOpen, setBulkConfirmOpen] = useState(false);

  const busy = actionId !== null;

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const [list, rs, st] = await Promise.all([
        invoke<{ worktrees: WorktreeRecord[] }>("worktree_list", {}),
        invoke<{ repos: WorktreeRepo[] }>("worktree_repos", {}),
        invoke<WorktreeSettings>("worktree_settings_get", {}),
      ]);
      setRows(Array.isArray(list.worktrees) ? list.worktrees : []);
      setRepos(Array.isArray(rs.repos) ? rs.repos : []);
      setSettings(st);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // 建表单选仓库后拉分支清单（基线选择）
  useEffect(() => {
    if (!createOpen || !repoPath) {
      setBranches([]);
      return;
    }
    let cancelled = false;
    setBranchLoading(true);
    invoke<{ branches: { name: string }[] }>("git_branches", { cwd: repoPath })
      .then((res) => {
        if (cancelled) return;
        const names = res.branches.map((b) => b.name);
        setBranches(names);
        // 当前分支不在清单里（detached/已删除）时回落到第一个分支
        setBase((cur) => (cur && names.includes(cur) ? cur : (names[0] ?? "")));
      })
      .catch(() => {
        if (!cancelled) setBranches([]);
      })
      .finally(() => {
        if (!cancelled) setBranchLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [createOpen, repoPath]);

  /** 统一动作执行：全局禁用 + 行级 loading + 成功后静默刷新清单 */
  const runAction = async (
    fn: () => Promise<string | void>,
    opts: { id?: string; toastTitle?: string } = {},
  ): Promise<void> => {
    setActionId(opts.id ?? "action");
    try {
      const description = await fn();
      if (opts.toastTitle) {
        toast.success({
          title: opts.toastTitle,
          ...(typeof description === "string" && description
            ? { description }
            : {}),
        });
      }
      await load(true);
    } catch (err) {
      toast.error({
        title: t("settings.worktrees.actionFailed"),
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setActionId(null);
    }
  };

  /** 偏好即时生效（乐观更新）；成功后再拉一次清单（降低上限会触发自动清理）；
   *  失败时重读，避免本地与服务端状态漂移 */
  const patchSettings = (patch: Partial<WorktreeSettings>) => {
    setSettings((cur) => ({ ...cur, ...patch }));
    // 不拿应答回写：连续切换时先发出的应答可能覆盖后一次乐观值
    void invoke<WorktreeSettings>("worktree_settings_set", patch)
      .then(() => {
        // 数量上限/自动删除变更会同步触发清理，刷新以反映收敛后的清单
        if (patch.autoCleanup !== undefined || patch.autoCleanupLimit !== undefined) {
          void load(true);
        }
      })
      .catch((err) => {
        void load(true);
        toast.error({
          title: t("settings.worktrees.actionFailed"),
          description: err instanceof Error ? err.message : String(err),
        });
      });
  };

  const openCreate = () => {
    const first = repos[0];
    setRepoPath(first?.path ?? "");
    setBase(first?.currentBranch ?? "");
    setName("");
    setIncludeUncommitted(false);
    setCreateOpen(true);
  };

  const changeRepo = (value: string | null) => {
    const next = value ?? "";
    setRepoPath(next);
    setBase(repos.find((r) => r.path === next)?.currentBranch ?? "");
  };

  const create = () =>
    void runAction(
      async () => {
        const res = await invoke<{
          worktree: WorktreeRecord;
          warnings?: string[];
        }>("worktree_create", {
          repoRoot: repoPath,
          base,
          includeUncommitted,
          ...(name.trim() ? { name: name.trim() } : {}),
        });
        setCreateOpen(false);
        setTab("recent");
        // warnings 作为成功提示的描述（如"已拷贝 N 个未跟踪文件"）
        return res.warnings?.join("；") ?? "";
      },
      { id: "create", toastTitle: t("settings.worktrees.created") },
    );

  const newSession = (wt: WorktreeRecord) =>
    void runAction(
      async () => {
        const res = await getPiChannel().request({
          type: "new_session",
          threadId: `wt-${wt.id}-${Date.now()}`,
          cwd: wt.path,
        });
        if (res.type === "error") throw new Error(res.errorText);
        const sessionId = (res as unknown as { sessionId?: string }).sessionId;
        if (!sessionId) throw new Error("new_session 未返回 sessionId");
        await invoke("worktree_bind_session", { id: wt.id, sessionId });
        requestOpenSession(sessionId);
        onOpenSession?.();
      },
      { id: wt.id },
    );

  const openBranch = (wt: WorktreeRecord) => {
    setBranchName("");
    setBranchTarget(wt);
  };

  const createBranch = () => {
    const wt = branchTarget;
    if (!wt) return;
    const custom = branchName.trim();
    setBranchTarget(null);
    void runAction(
      async () => {
        await invoke("worktree_branch", {
          id: wt.id,
          ...(custom ? { name: custom } : {}),
        });
        setBranchName("");
      },
      { id: wt.id, toastTitle: t("settings.worktrees.branchCreated") },
    );
  };

  const confirmRemove = () => {
    const wt = deleteTarget;
    if (!wt) return;
    setDeleteTarget(null);
    void runAction(
      async () => {
        await invoke("worktree_remove", { id: wt.id });
      },
      { id: wt.id, toastTitle: t("settings.worktrees.movedToTrash") },
    );
  };

  const confirmRemoveAll = () => {
    setBulkConfirmOpen(false);
    void runAction(
      async () => {
        const res = await invoke<{ removed: number }>("worktree_remove_unbound", {});
        return res.removed > 0
          ? t("settings.worktrees.removedDone", { count: res.removed })
          : t("settings.worktrees.removedNone");
      },
      { id: "bulk", toastTitle: t("settings.worktrees.removedTitle") },
    );
  };

  const restore = (wt: WorktreeRecord) =>
    void runAction(
      async () => {
        await invoke("worktree_restore", { id: wt.id });
        // 恢复的可能是旧 worktree：切到它所在的时间页签，避免"恢复后从列表消失"
        const age = Date.now() - wt.createdAt;
        setTab(age < 3 * DAY ? "recent" : age <= 7 * DAY ? "mid" : "old");
      },
      { id: wt.id, toastTitle: t("settings.worktrees.restored") },
    );

  const confirmPurge = () => {
    const wt = purgeTarget;
    if (!wt) return;
    setPurgeTarget(null);
    void runAction(
      async () => {
        await invoke("worktree_purge", { id: wt.id });
      },
      { id: wt.id, toastTitle: t("settings.worktrees.purged") },
    );
  };

  const active = useMemo(
    () => rows.filter((r) => r.status === "active"),
    [rows],
  );
  const trashed = useMemo(
    () =>
      rows
        .filter((r) => r.status === "trashed")
        .sort((a, b) => (b.trashedAt ?? 0) - (a.trashedAt ?? 0)),
    [rows],
  );

  // 时间过滤页签（对齐参照：近 3 天 / 3-7 天前 / 7 天以上）
  const ageFiltered = useMemo(() => {
    const now = Date.now();
    const inRange = (ts: number): boolean => {
      const age = now - ts;
      if (tab === "recent") return age < 3 * DAY;
      if (tab === "mid") return age >= 3 * DAY && age <= 7 * DAY;
      return age > 7 * DAY;
    };
    return active
      .filter((wt) => inRange(wt.createdAt))
      .sort((a, b) => b.createdAt - a.createdAt);
  }, [active, tab]);

  const groupedFiltered = useMemo(() => {
    const map = new Map<string, WorktreeRecord[]>();
    for (const wt of ageFiltered) {
      const list = map.get(wt.repoRoot) ?? [];
      list.push(wt);
      map.set(wt.repoRoot, list);
    }
    // 最近有活动的仓库排在前面
    return [...map.entries()].sort(
      (a, b) => (b[1][0]?.createdAt ?? 0) - (a[1][0]?.createdAt ?? 0),
    );
  }, [ageFiltered]);

  /** 一键移除只处理未绑定会话且目录还在的（与后端 removeAllUnbound 同口径） */
  const unboundCount = useMemo(
    () => active.filter((wt) => wt.exists && wt.sessionIds.length === 0).length,
    [active],
  );

  const limitItems = LIMIT_OPTIONS.map((n) => ({
    value: String(n),
    label: t("settings.worktrees.limitUnit", { count: n }),
  }));
  const repoItems = repos.map((repo) => ({ value: repo.path, label: repo.name }));
  const branchItems = branches.map((b) => ({ value: b, label: b }));
  const ageOptions: { value: AgeTab; label: string }[] = [
    { value: "recent", label: t("settings.worktrees.tabsRecent") },
    { value: "mid", label: t("settings.worktrees.tabsMid") },
    { value: "old", label: t("settings.worktrees.tabsOld") },
  ];

  const deleteDesc = deleteTarget
    ? deleteTarget.sessionIds.length > 0
      ? t("settings.worktrees.deleteDescBound", {
          name: deleteTarget.name || deleteTarget.id,
          count: deleteTarget.sessionIds.length,
        })
      : t("settings.worktrees.deleteDesc", {
          name: deleteTarget.name || deleteTarget.id,
        })
    : "";

  return (
    <TooltipProvider>
      <div className="flex h-full flex-col overflow-y-auto">
        <div className="flex w-full max-w-5xl flex-col gap-8 self-center px-8 py-8">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="flex flex-col gap-1">
              <h1 className="text-2xl font-bold tracking-tight">
                {t("settings.sections.worktrees")}
              </h1>
              <p className="text-muted-foreground max-w-2xl text-sm leading-relaxed">
                {t("settings.worktrees.subtitle")}
              </p>
            </div>
            <Button
              onClick={openCreate}
              disabled={repos.length === 0}
              title={
                repos.length === 0
                  ? t("settings.worktrees.noRepos")
                  : undefined
              }
            >
              <PlusIcon className="size-4" />
              {t("settings.worktrees.add")}
            </Button>
          </div>

          {error ? (
            <div className="border-destructive/30 bg-destructive/10 text-destructive flex items-start justify-between gap-3 rounded-xl border px-3 py-2 text-[13px] leading-5">
              <span className="min-w-0 break-words">{error}</span>
              <Button
                variant="ghost"
                size="sm"
                className="text-destructive hover:bg-destructive/10 hover:text-destructive h-7 shrink-0 px-2 text-[13px]"
                onClick={() => void load()}
              >
                {t("settings.worktrees.retry")}
              </Button>
            </div>
          ) : null}

          {/* 行为设置 */}
          <section className="flex flex-col gap-3">
            <h2 className="text-base font-semibold">
              {t("settings.worktrees.behaviorTitle")}
            </h2>
            <div className="bg-muted/50 flex flex-col gap-1 rounded-2xl p-2">
              <SettingRow
                label={t("settings.worktrees.fetchTitle")}
                desc={t("settings.worktrees.fetchDesc")}
              >
                <Switch
                  checked={settings.fetchBeforeCreate}
                  onCheckedChange={(v) =>
                    patchSettings({ fetchBeforeCreate: v })
                  }
                />
              </SettingRow>
              <SettingRow
                label={t("settings.worktrees.autoDeleteTitle")}
                desc={t("settings.worktrees.autoDeleteDesc")}
              >
                <Switch
                  checked={settings.autoCleanup}
                  onCheckedChange={(v) => patchSettings({ autoCleanup: v })}
                />
              </SettingRow>
              <SettingRow
                label={t("settings.worktrees.limitTitle")}
                desc={t("settings.worktrees.limitDesc")}
              >
                <Select
                  value={String(settings.autoCleanupLimit)}
                  onValueChange={(v) =>
                    patchSettings({ autoCleanupLimit: Number(v ?? 15) })
                  }
                  disabled={!settings.autoCleanup}
                  items={limitItems}
                >
                  <SelectTrigger
                    size="sm"
                    className="w-32 border bg-background"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {limitItems.map((item) => (
                      <SelectItem key={item.value} value={item.value}>
                        {item.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </SettingRow>
            </div>
          </section>

          {/* 托管 Worktree：按原始仓库路径分组 */}
          <section className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-base font-semibold">
                {t("settings.worktrees.groupsTitle")}
              </h2>
              {active.length > 0 ? (
                <span className="text-muted-foreground text-xs tabular-nums">
                  {ageFiltered.length}
                </span>
              ) : null}
              <div className="ml-auto flex flex-wrap items-center gap-2">
                {active.length > 0 ? (
                  <Segmented
                    value={tab}
                    options={ageOptions}
                    onChange={setTab}
                  />
                ) : null}
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        variant="outline"
                        size="icon-sm"
                        aria-label={t("settings.worktrees.refresh")}
                        disabled={busy || loading}
                        onClick={() => void load()}
                      >
                        <RefreshCwIcon
                          className={cn("size-4", loading && "animate-spin")}
                        />
                      </Button>
                    }
                  />
                  <TooltipContent>
                    {t("settings.worktrees.refresh")}
                  </TooltipContent>
                </Tooltip>
                {active.length > 0 ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive h-7 gap-1.5 px-2 text-[13px] leading-5"
                    disabled={busy || unboundCount === 0}
                    onClick={() => setBulkConfirmOpen(true)}
                  >
                    {actionId === "bulk" ? (
                      <Loader2Icon className="size-3.5 animate-spin" />
                    ) : (
                      <Trash2Icon className="size-3.5" />
                    )}
                    {t("settings.worktrees.removeAll")}
                  </Button>
                ) : null}
              </div>
            </div>

            {loading && rows.length === 0 ? (
              <div className="bg-muted/50 flex flex-col gap-1 rounded-2xl p-2">
                {[0, 1, 2].map((i) => (
                  <div
                    key={i}
                    className="flex items-center justify-between gap-4 px-3 py-2.5"
                  >
                    <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                      <Skeleton className="h-3.5 w-40" />
                      <Skeleton className="h-3 w-72 max-w-full" />
                    </div>
                    <Skeleton className="h-8 w-24 rounded-lg" />
                  </div>
                ))}
              </div>
            ) : error && rows.length === 0 ? null : active.length === 0 ? (
              <div className="bg-muted/40 flex flex-col items-center gap-2 rounded-2xl border border-dashed px-6 py-12">
                <FolderGit2Icon className="text-muted-foreground size-6" />
                <p className="text-sm font-medium">
                  {t("settings.worktrees.emptyTitle")}
                </p>
                <p className="text-muted-foreground max-w-md text-center text-[13px] leading-5">
                  {t("settings.worktrees.emptyDesc")}
                </p>
                {repos.length === 0 ? (
                  <p className="text-muted-foreground max-w-md text-center text-[13px] leading-5">
                    {t("settings.worktrees.noRepos")}
                  </p>
                ) : (
                  <Button className="mt-1" onClick={openCreate}>
                    <PlusIcon className="size-3.5" />
                    {t("settings.worktrees.add")}
                  </Button>
                )}
              </div>
            ) : ageFiltered.length === 0 ? (
              <div className="bg-muted/40 text-muted-foreground rounded-2xl border border-dashed px-6 py-10 text-center text-[13px] leading-5">
                {t("settings.worktrees.filteredEmpty")}
              </div>
            ) : (
              <div className="flex flex-col gap-4">
                {groupedFiltered.map(([repoRoot, list]) => (
                  <div key={repoRoot} className="flex flex-col gap-2">
                    <div className="flex min-w-0 items-center gap-2 px-1">
                      <FolderGit2Icon className="text-muted-foreground size-4 shrink-0" />
                      <span
                        className="shrink-0 text-sm font-medium"
                        title={repoRoot}
                      >
                        {pathName(repoRoot)}
                      </span>
                      <span className="text-muted-foreground ml-auto shrink-0 text-xs tabular-nums">
                        {list.length}
                      </span>
                    </div>
                    <div className="bg-muted/50 flex flex-col gap-1 rounded-2xl p-2">
                      {list.map((wt) => (
                        <WorktreeRow
                          key={wt.id}
                          wt={wt}
                          disabled={busy}
                          rowBusy={actionId === wt.id}
                          onNewSession={() => void newSession(wt)}
                          onCreateBranch={() => openBranch(wt)}
                          onRemove={() => setDeleteTarget(wt)}
                        />
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>

          {/* 回收站：7 天后自动清理 */}
          {trashed.length > 0 ? (
            <section className="flex flex-col gap-3">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-base font-semibold">
                  {t("settings.worktrees.trashTitle")}
                </h2>
                <span className="text-muted-foreground text-xs tabular-nums">
                  {trashed.length}
                </span>
                <p className="text-muted-foreground ml-auto text-[13px] leading-5">
                  {t("settings.worktrees.trashDesc")}
                </p>
              </div>
              <div className="bg-muted/40 flex flex-col gap-1 rounded-2xl p-2">
                {trashed.map((wt) => (
                  <WorktreeRow
                    key={`${wt.id}-trashed`}
                    wt={wt}
                    trashed
                    disabled={busy}
                    rowBusy={actionId === wt.id}
                    onRestore={() => restore(wt)}
                    onPurge={() => setPurgeTarget(wt)}
                  />
                ))}
              </div>
            </section>
          ) : null}
        </div>

        {/* 新建 Worktree */}
        <Dialog
          open={createOpen}
          onOpenChange={(open) => {
            if (!open && !busy) setCreateOpen(false);
          }}
        >
          <DialogContent className="sm:max-w-lg">
            <DialogHeader>
              <DialogTitle>{t("settings.worktrees.add")}</DialogTitle>
              <DialogDescription>
                {t("settings.worktrees.createDesc")}
              </DialogDescription>
            </DialogHeader>
            <form
              className="flex flex-col gap-4"
              onSubmit={(e) => {
                e.preventDefault();
                create();
              }}
            >
              <Field>
                <FieldLabel htmlFor="worktree-repo">
                  {t("settings.worktrees.repo")}
                </FieldLabel>
                <Select
                  value={repoPath}
                  onValueChange={changeRepo}
                  items={repoItems}
                  disabled={repos.length === 0}
                >
                  <SelectTrigger id="worktree-repo" className="w-full">
                    <SelectValue
                      placeholder={t("settings.worktrees.repoPlaceholder")}
                    />
                  </SelectTrigger>
                  <SelectContent>
                    {repos.map((repo) => (
                      <SelectItem key={repo.path} value={repo.path}>
                        {repo.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>

              <Field>
                <FieldLabel htmlFor="worktree-base">
                  {t("settings.worktrees.base")}
                </FieldLabel>
                <Select
                  value={base}
                  onValueChange={(v) => setBase(v ?? "")}
                  items={branchItems}
                  disabled={!repoPath || branchLoading}
                >
                  <SelectTrigger id="worktree-base" className="w-full">
                    <SelectValue
                      placeholder={
                        branchLoading
                          ? t("settings.worktrees.loading")
                          : t("settings.worktrees.basePlaceholder")
                      }
                    />
                  </SelectTrigger>
                  <SelectContent>
                    {branchLoading ? (
                      <SelectItem value="__loading" disabled>
                        {t("settings.worktrees.loading")}
                      </SelectItem>
                    ) : (
                      branches.map((b) => (
                        <SelectItem key={b} value={b}>
                          {b}
                        </SelectItem>
                      ))
                    )}
                  </SelectContent>
                </Select>
              </Field>

              <Field>
                <FieldLabel htmlFor="worktree-name">
                  {t("settings.worktrees.name")}
                </FieldLabel>
                <Input
                  id="worktree-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder={t("settings.worktrees.namePlaceholder")}
                />
              </Field>

              <div className="bg-muted/50 rounded-xl p-2">
                <SettingRow
                  label={t("settings.worktrees.includeUncommitted")}
                  desc={t("settings.worktrees.includeUncommittedDesc")}
                >
                  <Switch
                    checked={includeUncommitted}
                    onCheckedChange={setIncludeUncommitted}
                  />
                </SettingRow>
              </div>

              <DialogFooter className="gap-2">
                <Button
                  type="button"
                  variant="outline"
                  disabled={busy}
                  onClick={() => setCreateOpen(false)}
                >
                  {t("settings.worktrees.cancel")}
                </Button>
                <Button
                  type="submit"
                  disabled={busy || !repoPath || !base || branchLoading}
                >
                  {actionId === "create" ? (
                    <Loader2Icon className="size-4 animate-spin" />
                  ) : null}
                  {t("settings.worktrees.create")}
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>

        {/* 创建分支 */}
        <Dialog
          open={branchTarget !== null}
          onOpenChange={(open) => {
            if (!open) setBranchTarget(null);
          }}
        >
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>
                {t("settings.worktrees.createBranch")}
              </DialogTitle>
              <DialogDescription>
                {t("settings.worktrees.branchDesc")}
              </DialogDescription>
            </DialogHeader>
            <form
              className="flex flex-col gap-4"
              onSubmit={(e) => {
                e.preventDefault();
                createBranch();
              }}
            >
              <Field>
                <FieldLabel htmlFor="worktree-branch">
                  {t("settings.worktrees.branchNameLabel")}
                </FieldLabel>
                <Input
                  id="worktree-branch"
                  autoFocus
                  value={branchName}
                  onChange={(e) => setBranchName(e.target.value)}
                  placeholder={t("settings.worktrees.branchPlaceholder")}
                  className="font-mono"
                />
              </Field>
              <DialogFooter className="gap-2">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setBranchTarget(null)}
                >
                  {t("settings.worktrees.cancel")}
                </Button>
                <Button type="submit" disabled={busy}>
                  {actionId === branchTarget?.id ? (
                    <Loader2Icon className="size-4 animate-spin" />
                  ) : null}
                  {t("settings.worktrees.branchOk")}
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>

        {/* 删除确认：移入 trash 可恢复 */}
        <AlertDialog
          open={deleteTarget !== null}
          onOpenChange={(open) => {
            if (!open) setDeleteTarget(null);
          }}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>
                {t("settings.worktrees.deleteTitle")}
              </AlertDialogTitle>
              <AlertDialogDescription>{deleteDesc}</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>
                {t("settings.worktrees.cancel")}
              </AlertDialogCancel>
              <AlertDialogAction
                variant="destructive"
                onClick={confirmRemove}
              >
                {t("settings.worktrees.delete")}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        {/* 一键移除确认 */}
        <AlertDialog
          open={bulkConfirmOpen}
          onOpenChange={setBulkConfirmOpen}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>
                {t("settings.worktrees.removeAll")}
              </AlertDialogTitle>
              <AlertDialogDescription>
                {t("settings.worktrees.removeAllDesc", {
                  count: unboundCount,
                })}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>
                {t("settings.worktrees.cancel")}
              </AlertDialogCancel>
              <AlertDialogAction
                variant="destructive"
                onClick={confirmRemoveAll}
              >
                {t("settings.worktrees.removeAll")}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        {/* 彻底删除确认：不可恢复 */}
        <AlertDialog
          open={purgeTarget !== null}
          onOpenChange={(open) => {
            if (!open) setPurgeTarget(null);
          }}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>
                {t("settings.worktrees.purgeTitle")}
              </AlertDialogTitle>
              <AlertDialogDescription>
                {purgeTarget
                  ? t("settings.worktrees.purgeDesc", {
                      name: purgeTarget.name || purgeTarget.id,
                    })
                  : ""}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>
                {t("settings.worktrees.cancel")}
              </AlertDialogCancel>
              <AlertDialogAction
                variant="destructive"
                onClick={confirmPurge}
              >
                {t("settings.worktrees.purge")}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </TooltipProvider>
  );
};
