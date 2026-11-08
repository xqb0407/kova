"use client";

/**
 * 新建远程项目对话框：项目名称 / 远程主机（SSH 主机下拉）/ 源文件夹（远端路径）。
 * 确定后写入 remote.projects 并把 workspace 设为远端路径——下一轮 createThread
 * 按 workspace 反查远程项目，把 remote 绑定随 new_session 下发（见
 * lib/workspace/remote-projects.ts 与 pi-client-base）。
 */

import { useEffect, useMemo, useState, type FC } from "react";
import { invoke } from "@/desktop-bridge/core";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
import { CloudOffIcon, FolderOpenIcon, Loader2Icon, PlusIcon } from "lucide-react";
import { SshConnectionDialog } from "@/components/settings/components/ssh-connection-dialog";
import {
  saveRemoteProject,
  useRemoteProjects,
  type RemoteProject,
  type SshHost,
} from "@/lib/workspace/remote-projects";
import { useT } from "@/lib/i18n";

export const RemoteProjectDialog: FC<{
  open: boolean;
  onClose: () => void;
  /** 保存成功后回调（已把 workspace 设为远端路径） */
  onSaved?: (project: RemoteProject) => void;
}> = ({ open, onClose, onSaved }) => {
  const t = useT();
  const { projects } = useRemoteProjects();
  const [hosts, setHosts] = useState<SshHost[]>([]);
  const [hostsLoaded, setHostsLoaded] = useState(false);
  const [connDialogOpen, setConnDialogOpen] = useState(false);
  const [name, setName] = useState("");
  const [hostId, setHostId] = useState("");
  const [remotePath, setRemotePath] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 源文件夹浏览（SSH 远端目录）
  const [browseOpen, setBrowseOpen] = useState(false);
  const [browsePath, setBrowsePath] = useState("/");
  const [browseDirs, setBrowseDirs] = useState<string[]>([]);
  const [browseBusy, setBrowseBusy] = useState(false);
  const [browseError, setBrowseError] = useState<string | null>(null);
  /** 目录存在但不可写：警告但允许继续（环境问题不应拦住建项目） */
  const [pathWarning, setPathWarning] = useState<string | null>(null);

  const loadHosts = async () => {
    try {
      setHosts(((await invoke("ssh_host_list", {})) as SshHost[]) ?? []);
    } catch {
      setHosts([]);
    } finally {
      setHostsLoaded(true);
    }
  };

  useEffect(() => {
    if (!open) return;
    setError(null);
    setPathWarning(null);
    setHostsLoaded(false);
    setBrowseOpen(false);
    void loadHosts();
  }, [open]);

  /** 列远端目录（cd 后 pwd + ls -1p；密码主机走 ssh2 探针） */
  const loadRemoteDirs = async (path: string) => {
    if (!hostId) return;
    setBrowseBusy(true);
    setBrowseError(null);
    try {
      const res = (await invoke("ssh_host_list_dirs", {
        hostId,
        path,
      })) as { ok: boolean; path?: string; dirs?: string[]; message?: string };
      if (!res.ok) {
        setBrowseError(res.message || t("remote.project.dirUnavailable"));
        setBrowseDirs([]);
        return;
      }
      setBrowsePath(res.path ?? path);
      setBrowseDirs(res.dirs ?? []);
    } catch (e) {
      setBrowseError(String(e));
      setBrowseDirs([]);
    } finally {
      setBrowseBusy(false);
    }
  };

  const openBrowse = () => {
    if (!hostId) {
      setError(t("remote.project.chooseHostFirst"));
      return;
    }
    const start = remotePath.trim().startsWith("/") ? remotePath.trim() : "/";
    setBrowseOpen(true);
    setBrowsePath(start);
    setBrowseDirs([]);
    void loadRemoteDirs(start);
  };

  // 所有 hook 必须在任何提前 return 之前：关闭态 return null 后 hook 数不能变
  const enabledHosts = useMemo(() => hosts.filter((h) => h.enabled), [hosts]);
  // base-ui 需要 items 映射才能在触发器上显示选中项 label（否则回填成 placeholder）
  const hostItems = useMemo(
    () => [
      ...enabledHosts.map((h) => ({ value: h.id, label: h.name })),
      { value: "__add__", label: t("remote.project.addRemote") },
    ],
    [enabledHosts, t],
  );
  // 必须显式选主机：静默回退第一台会让人在多主机时绑错目标
  const canSubmit = !busy && Boolean(hostId) && remotePath.trim().startsWith("/");

  if (!open) return null;

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      if (!hostId) {
        setError(t("remote.project.chooseHostFirst"));
        return;
      }
      // 远端路径必须存在：保存前校验一次（避免会话里才炸）；
      // 存在但不可写 → 警告后继续（agent 写文件会报权限错误）
      const check = (await invoke("ssh_host_check_dir", {
        hostId,
        path: remotePath.trim(),
      })) as { exists: boolean; writable?: boolean; message: string };
      if (!check.exists) {
        setError(t("remote.project.remoteDirUnavailable", { message: check.message }));
        return;
      }
      setPathWarning(check.writable === false ? check.message : null);
      const saved = await saveRemoteProject({
        name: name.trim(),
        hostId,
        remotePath: remotePath.trim(),
      });
      const { setWorkspace } = await import("@/lib/workspace/workspace-store");
      setWorkspace(saved.remotePath);
      onSaved?.(saved);
      onClose();
      setName("");
      setRemotePath("");
      setHostId("");
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(v) => (!v ? onClose() : undefined)}>
      <DialogContent className="gap-5 sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t("remote.project.title")}</DialogTitle>
          <DialogDescription>
            {t("remote.project.desc")}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="remote-project-name">{t("remote.project.projectName")}</Label>
            <Input
              id="remote-project-name"
              value={name}
              placeholder={t("remote.project.namePlaceholder")}
              onChange={(e) => setName(e.target.value)}
              autoFocus
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label>{t("remote.project.hostLabel")}</Label>
            <Select
              value={hostId || undefined}
              items={hostItems}
              onValueChange={(v) => {
                if (!v) return;
                if (v === "__add__") {
                  setConnDialogOpen(true);
                  return;
                }
                setHostId(v);
              }}
            >
              <SelectTrigger className="w-full">
                <SelectValue placeholder={t("remote.project.hostPlaceholder")} />
              </SelectTrigger>
              <SelectContent>
                {enabledHosts.map((host) => (
                  <SelectItem key={host.id} value={host.id}>
                    {host.name}
                  </SelectItem>
                ))}
                <SelectItem value="__add__">
                  <span className="text-muted-foreground inline-flex items-center gap-1.5">
                    <PlusIcon className="size-3.5" />
                    {t("remote.project.addRemote")}
                  </span>
                </SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="remote-project-path">{t("remote.project.sourceFolder")}</Label>
            <div className="flex gap-2">
              <Input
                id="remote-project-path"
                value={remotePath}
                placeholder="/home/user/project"
                className="flex-1 font-mono"
                onChange={(e) => setRemotePath(e.target.value)}
              />
              <Button
                type="button"
                variant="outline"
                disabled={!hostId}
                onClick={openBrowse}
                title={hostId ? t("remote.project.browseTitle") : t("remote.project.chooseHostFirst")}
              >
                {t("remote.project.browse")}
              </Button>
            </div>
            {browseOpen && (
              <div className="mt-1 flex flex-col rounded-xl border">
                <div className="text-muted-foreground flex items-center justify-between border-b px-3 py-2 font-mono text-xs">
                  <span className="truncate" title={browsePath}>
                    {browsePath}
                  </span>
                  {browseBusy ? <Loader2Icon className="size-3.5 animate-spin" /> : null}
                </div>
                <div className="flex max-h-52 min-h-[120px] flex-col overflow-y-auto p-1">
                  {browseError ? (
                    <div className="text-destructive px-2 py-3 text-xs">{browseError}</div>
                  ) : (
                    <>
                      <button
                        type="button"
                        className="hover:bg-muted/60 flex items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm"
                        onClick={() => {
                          const parent =
                            browsePath.replace(/\/+$/, "").replace(/\/[^/]+$/, "") || "/";
                          void loadRemoteDirs(parent);
                        }}
                      >
                        <FolderOpenIcon className="text-muted-foreground size-3.5 shrink-0" />
                        ..
                      </button>
                      {browseDirs.map((name) => (
                        <button
                          key={name}
                          type="button"
                          className="hover:bg-muted/60 flex items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm"
                          onClick={() => {
                            const next = `${browsePath.replace(/\/+$/, "")}/${name}`;
                            void loadRemoteDirs(next);
                          }}
                        >
                          <FolderOpenIcon className="text-muted-foreground size-3.5 shrink-0" />
                          <span className="truncate">{name}</span>
                        </button>
                      ))}
                      {!browseBusy && browseDirs.length === 0 ? (
                        <div className="text-muted-foreground px-2 py-3 text-xs">
                          {t("remote.project.noSubdirs")}
                        </div>
                      ) : null}
                    </>
                  )}
                </div>
                <div className="flex items-center justify-between border-t px-3 py-2">
                  <span className="text-muted-foreground max-w-[60%] truncate font-mono text-xs">
                    {browsePath}
                  </span>
                  <div className="flex items-center gap-2">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => setBrowseOpen(false)}
                    >
                      {t("common.action.collapse")}
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      disabled={browseBusy || Boolean(browseError)}
                      onClick={() => {
                        setRemotePath(browsePath);
                        setBrowseOpen(false);
                      }}
                    >
                      {t("remote.project.selectDir")}
                    </Button>
                  </div>
                </div>
              </div>
            )}
            {projects.length > 0 && (
              <div className="text-muted-foreground text-xs">
                {t("remote.project.existingProjects", {
                  names: projects
                    .map((p) => p.name)
                    .join(t("remote.project.listSeparator")),
                })}
              </div>
            )}
          </div>

          {hostsLoaded && enabledHosts.length === 0 && (
            <div className="text-muted-foreground bg-muted/40 flex flex-col items-center gap-2 rounded-xl px-4 py-8 text-sm">
              <CloudOffIcon className="text-muted-foreground/60 size-8" />
              {t("remote.project.noHostsHint")}
            </div>
          )}
          {pathWarning && (
            <div className="rounded-lg bg-amber-500/10 px-3 py-2 text-xs text-amber-600">
              {t("remote.project.pathWarning", {
                message: pathWarning,
                path: remotePath.trim() || t("remote.project.targetDir"),
              })}
            </div>
          )}
          {error && <div className="text-destructive text-xs">{error}</div>}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            {t("common.action.cancel")}
          </Button>
          <Button onClick={() => void submit()} disabled={!canSubmit}>
            {busy ? <Loader2Icon className="size-4 animate-spin" /> : null}
            {t("remote.project.addProject")}
          </Button>
        </DialogFooter>
      </DialogContent>

      {/* 添加远程：新建连接后自动选中并刷新下拉 */}
      <SshConnectionDialog
        open={connDialogOpen}
        onClose={() => setConnDialogOpen(false)}
        onSaved={(saved) => {
          setConnDialogOpen(false);
          void loadHosts();
          setHostId(saved.id);
        }}
      />
    </Dialog>
  );
};
