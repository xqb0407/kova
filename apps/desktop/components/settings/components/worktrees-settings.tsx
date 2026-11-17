"use client";

/**
 * Settings → Worktree：受管 git worktree 的管理面（docs/git-worktrees.md）。
 *
 * 闭环：选仓库/基线 → 创建（可跟随未提交改动与 .worktreeinclude）→
 * 「新建会话」在该 worktree 里开会话并跳转 → 收尾「创建分支」（kova/<slug>）
 * 或「删除」（进 trash 可恢复，7 天自动清理）。
 * 数据面全部走宿主命令（worktree_*）；会话创建走既有 new_session 协议。
 */
import { useCallback, useEffect, useMemo, useState, type FC } from "react";
import {
  FolderGit2Icon,
  GitBranchIcon,
  Loader2Icon,
  MessageSquarePlusIcon,
  PlusIcon,
  RotateCcwIcon,
  Trash2Icon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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

/** 触发器应答同款：这些应答不在全局 PiResponse 联合里，走通道原语收窄 */
async function worktreeRequest<T>(payload: Record<string, unknown>): Promise<T> {
  const response = await getPiChannel().request(payload);
  if (response.type === "error") throw new Error(response.errorText);
  return response as unknown as T;
}

const fmtDate = (ts: number): string => {
  const d = new Date(ts);
  const p2 = (n: number) => String(n).padStart(2, "0");
  return `${d.getMonth() + 1}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
};

export const WorktreesSettings: FC<{
  /** 「新建会话」成功后的宿主动作：设置页是全窗覆盖层，需切回聊天视图 */
  onOpenSession?: () => void;
}> = ({ onOpenSession }) => {
  const t = useT();
  const [rows, setRows] = useState<WorktreeRecord[]>([]);
  const [repos, setRepos] = useState<WorktreeRepo[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [creating, setCreating] = useState(false);
  const [repoPath, setRepoPath] = useState("");
  const [base, setBase] = useState("");
  const [name, setName] = useState("");
  const [includeUncommitted, setIncludeUncommitted] = useState(false);
  const [branches, setBranches] = useState<string[]>([]);
  const [branchLoading, setBranchLoading] = useState(false);

  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [branchEditId, setBranchEditId] = useState<string | null>(null);
  const [branchName, setBranchName] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [list, rs] = await Promise.all([
        invoke<{ worktrees: WorktreeRecord[] }>("worktree_list", {}),
        invoke<{ repos: WorktreeRepo[] }>("worktree_repos", {}),
      ]);
      setRows(Array.isArray(list.worktrees) ? list.worktrees : []);
      setRepos(Array.isArray(rs.repos) ? rs.repos : []);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // 建表单选仓库后拉分支清单（基线选择）
  useEffect(() => {
    if (!creating || !repoPath) {
      setBranches([]);
      return;
    }
    let cancelled = false;
    setBranchLoading(true);
    invoke<{ branches: { name: string }[] }>("git_branches", { cwd: repoPath })
      .then((res) => {
        if (!cancelled) setBranches(res.branches.map((b) => b.name));
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
  }, [creating, repoPath]);

  const active = useMemo(() => rows.filter((r) => r.status === "active"), [rows]);
  const trashed = useMemo(() => rows.filter((r) => r.status === "trashed"), [rows]);
  const grouped = useMemo(() => {
    const map = new Map<string, WorktreeRecord[]>();
    for (const wt of active) {
      const list = map.get(wt.repoRoot) ?? [];
      list.push(wt);
      map.set(wt.repoRoot, list);
    }
    return [...map.entries()];
  }, [active]);

  const run = async (fn: () => Promise<string | void>, okTitle?: string): Promise<void> => {
    setBusy(true);
    try {
      const message = await fn();
      if (okTitle) {
        toast.success({
          title: okTitle,
          ...(typeof message === "string" && message ? { description: message } : {}),
        });
      }
      await load();
    } catch (err) {
      toast.error({
        title: t("settings.worktrees.actionFailed"),
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setBusy(false);
    }
  };

  const startCreate = () => {
    const first = repos[0];
    setRepoPath(first?.path ?? "");
    setBase(first?.currentBranch ?? "");
    setName("");
    setIncludeUncommitted(false);
    setCreating(true);
  };

  const create = () =>
    run(async () => {
      const res = await invoke<{ worktree: WorktreeRecord; warnings?: string[] }>(
        "worktree_create",
        {
          repoRoot: repoPath,
          base,
          includeUncommitted,
          ...(name.trim() ? { name: name.trim() } : {}),
        },
      );
      setCreating(false);
      // warnings 作为成功提示的描述（如"已拷贝 N 个未跟踪文件"）
      return res.warnings?.join("；") ?? "";
    }, t("settings.worktrees.created"));

  const newSession = (wt: WorktreeRecord) =>
    run(async () => {
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
    });

  const createBranch = (wt: WorktreeRecord, custom?: string) =>
    run(async () => {
      const finalName = (custom ?? branchName).trim();
      await invoke("worktree_branch", {
        id: wt.id,
        ...(finalName ? { name: finalName } : {}),
      });
      setBranchEditId(null);
      setBranchName("");
    }, t("settings.worktrees.branchCreated"));

  const remove = (wt: WorktreeRecord) =>
    run(async () => {
      if (confirmId !== wt.id) {
        setConfirmId(wt.id);
        window.setTimeout(() => {
          setConfirmId((cur) => (cur === wt.id ? null : cur));
        }, 3000);
        return;
      }
      setConfirmId(null);
      await invoke("worktree_remove", { id: wt.id });
    });

  const restore = (wt: WorktreeRecord) => run(() => invoke("worktree_restore", { id: wt.id }));
  const purge = (wt: WorktreeRecord) => run(() => invoke("worktree_purge", { id: wt.id }));

  const row = (wt: WorktreeRecord, trashed: boolean) => {
    const label = wt.name || wt.id;
    return (
      <div
        key={`${wt.id}-${trashed ? "t" : "a"}`}
        className="border-border/60 flex flex-col gap-1.5 rounded-xl border px-3 py-2.5"
      >
        <div className="flex min-w-0 items-center gap-2">
          <GitBranchIcon className="text-muted-foreground size-4 shrink-0" />
          <span
            className={cn(
              "min-w-0 flex-1 truncate text-sm font-medium",
              trashed && "text-muted-foreground",
            )}
            title={wt.path}
          >
            {label}
          </span>
          {wt.branch ? (
            <span className="text-primary bg-primary/10 shrink-0 rounded-full px-2 py-0.5 text-2xs tabular-nums">
              {wt.branch}
            </span>
          ) : (
            <span className="text-muted-foreground bg-muted shrink-0 rounded-full px-2 py-0.5 text-2xs">
              {wt.base}
            </span>
          )}
          {trashed ? null : (
            <Button
              size="xs"
              variant="ghost"
              className="gap-1"
              disabled={busy || !wt.exists}
              onClick={() => void newSession(wt)}
            >
              <MessageSquarePlusIcon className="size-3" />
              {t("settings.worktrees.newSession")}
            </Button>
          )}
        </div>
        <div className="text-muted-foreground flex flex-wrap items-center gap-x-2 gap-y-1 text-2xs">
          <span className="min-w-0 truncate font-mono" title={wt.path}>
            {wt.path}
          </span>
          <span>· {fmtDate(wt.createdAt)}</span>
          <span>
            ·{" "}
            {trashed
              ? t("settings.worktrees.trashedAt", { time: fmtDate(wt.trashedAt ?? wt.createdAt) })
              : t("settings.worktrees.sessions", { count: wt.sessionIds.length })}
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          {trashed ? (
            <>
              <Button size="xs" variant="outline" className="gap-1" disabled={busy || !wt.trashPath} onClick={() => void restore(wt)}>
                <RotateCcwIcon className="size-3" />
                {t("settings.worktrees.restore")}
              </Button>
              <Button
                size="xs"
                variant="ghost"
                className="text-muted-foreground hover:text-destructive"
                disabled={busy}
                onClick={() => void purge(wt)}
              >
                {t("settings.worktrees.purge")}
              </Button>
            </>
          ) : (
            <>
              {branchEditId === wt.id ? (
                <>
                  <Input
                    value={branchName}
                    onChange={(e) => setBranchName(e.target.value)}
                    placeholder={t("settings.worktrees.branchPlaceholder")}
                    className="h-6 flex-1 text-xs"
                    autoFocus
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void createBranch(wt);
                      if (e.key === "Escape") setBranchEditId(null);
                    }}
                  />
                  <Button size="xs" disabled={busy} onClick={() => void createBranch(wt)}>
                    {t("settings.worktrees.branchOk")}
                  </Button>
                  <Button size="xs" variant="ghost" onClick={() => setBranchEditId(null)}>
                    {t("settings.worktrees.cancel")}
                  </Button>
                </>
              ) : (
                <>
                  <Button
                    size="xs"
                    variant="ghost"
                    className="gap-1"
                    disabled={busy || !wt.exists}
                    onClick={() => {
                      setBranchEditId(wt.id);
                      setBranchName("");
                    }}
                  >
                    <GitBranchIcon className="size-3" />
                    {t("settings.worktrees.createBranch")}
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    className={cn(
                      "size-6",
                      confirmId === wt.id
                        ? "text-destructive"
                        : "text-muted-foreground hover:text-destructive",
                    )}
                    disabled={busy}
                    title={
                      confirmId === wt.id
                        ? t("settings.worktrees.deleteConfirm")
                        : t("settings.worktrees.delete")
                    }
                    onClick={() => void remove(wt)}
                  >
                    <Trash2Icon className="size-3.5" />
                  </Button>
                </>
              )}
            </>
          )}
        </div>
      </div>
    );
  };

  return (
    // 设置页标准骨架（对齐 general/projects/webhooks）：滚动容器 + 居中窄栏
    <div className="flex h-full flex-col overflow-y-auto">
    <div className="flex w-full max-w-5xl flex-col gap-8 self-center px-8 py-8">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">{t("settings.sections.worktrees")}</h1>
        <p className="text-muted-foreground mt-1 text-sm">{t("settings.worktrees.subtitle")}</p>
      </div>

      {error ? (
        <p className="text-destructive text-sm">{error}</p>
      ) : loading ? (
        <p className="text-muted-foreground flex items-center gap-2 text-sm">
          <Loader2Icon className="size-4 animate-spin" />
          {t("settings.worktrees.loading")}
        </p>
      ) : null}

      {/* 新建 */}
      <section className="flex flex-col gap-3">
        <h2 className="text-base font-semibold">{t("settings.worktrees.add")}</h2>
      {creating ? (
        <div className="border-border/60 flex flex-col gap-2.5 rounded-xl border p-3">
          <div className="flex items-center gap-2">
            <span className="text-muted-foreground w-20 shrink-0 text-xs">
              {t("settings.worktrees.repo")}
            </span>
            <Select
              value={repoPath}
              onValueChange={(v) => {
                const next = v ?? "";
                setRepoPath(next);
                const repo = repos.find((r) => r.path === next);
                setBase(repo?.currentBranch ?? "");
              }}
            >
              <SelectTrigger className="flex-1">
                <SelectValue placeholder={t("settings.worktrees.repoPlaceholder")} />
              </SelectTrigger>
              <SelectContent>
                {repos.map((repo) => (
                  <SelectItem key={repo.path} value={repo.path}>
                    {repo.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-muted-foreground w-20 shrink-0 text-xs">
              {t("settings.worktrees.base")}
            </span>
            <Select value={base} onValueChange={(v) => setBase(v ?? "")}>
              <SelectTrigger className="flex-1">
                <SelectValue placeholder={t("settings.worktrees.basePlaceholder")} />
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
          </div>
          <div className="flex items-center gap-2">
            <span className="text-muted-foreground w-20 shrink-0 text-xs">
              {t("settings.worktrees.name")}
            </span>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t("settings.worktrees.namePlaceholder")}
              className="flex-1"
            />
          </div>
          <div className="flex items-center gap-2">
            <span className="text-muted-foreground w-20 shrink-0 text-xs">
              {t("settings.worktrees.includeUncommitted")}
            </span>
            <Switch checked={includeUncommitted} onCheckedChange={setIncludeUncommitted} />
            <span className="text-muted-foreground text-2xs">
              {t("settings.worktrees.includeUncommittedDesc")}
            </span>
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => setCreating(false)}>
              {t("settings.worktrees.cancel")}
            </Button>
            <Button size="sm" disabled={busy || !repoPath || !base} onClick={() => void create()}>
              {t("settings.worktrees.create")}
            </Button>
          </div>
        </div>
      ) : (
        <Button variant="outline" className="gap-1.5" onClick={startCreate} disabled={repos.length === 0}>
          <PlusIcon className="size-3.5" />
          {t("settings.worktrees.add")}
        </Button>
      )}
      {repos.length === 0 && !loading ? (
        <p className="text-muted-foreground text-sm">{t("settings.worktrees.noRepos")}</p>
      ) : null}
      </section>

      {/* 按仓库分组的活跃 worktree */}
      <section className="flex flex-col gap-3">
        <h2 className="text-base font-semibold">{t("settings.worktrees.groupsTitle")}</h2>
        {grouped.map(([repoRoot, list]) => (
          <div key={repoRoot} className="flex flex-col gap-2">
            <p className="text-muted-foreground flex min-w-0 items-center gap-1.5 text-xs">
              <FolderGit2Icon className="size-3.5 shrink-0" />
              <span className="min-w-0 truncate font-mono" title={repoRoot}>
                {repoRoot}
              </span>
            </p>
            {list.map((wt) => row(wt, false))}
          </div>
        ))}
        {active.length === 0 && !loading && !creating ? (
          <p className="text-muted-foreground text-sm">{t("settings.worktrees.empty")}</p>
        ) : null}
      </section>

      {/* trash */}
      {trashed.length > 0 ? (
        <section className="flex flex-col gap-3">
          <h2 className="text-base font-semibold">{t("settings.worktrees.trash")}</h2>
          {trashed.map((wt) => row(wt, true))}
        </section>
      ) : null}
    </div>
    </div>
  );
};
