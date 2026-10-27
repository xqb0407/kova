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

export const RemoteProjectDialog: FC<{
  open: boolean;
  onClose: () => void;
  /** 保存成功后回调（已把 workspace 设为远端路径） */
  onSaved?: (project: RemoteProject) => void;
}> = ({ open, onClose, onSaved }) => {
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
        setBrowseError(res.message || "目录不可访问");
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
      setError("请先选择 SSH 主机");
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
      { value: "__add__", label: "添加远程" },
    ],
    [enabledHosts],
  );
  // 必须显式选主机：静默回退第一台会让人在多主机时绑错目标
  const canSubmit = !busy && Boolean(hostId) && remotePath.trim().startsWith("/");

  if (!open) return null;

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      if (!hostId) {
        setError("请先选择 SSH 主机");
        return;
      }
      // 远端路径必须存在：保存前校验一次（避免会话里才炸）
      const check = (await invoke("ssh_host_check_dir", {
        hostId,
        path: remotePath.trim(),
      })) as { exists: boolean; message: string };
      if (!check.exists) {
        setError(`远端目录不可用：${check.message}`);
        return;
      }
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
          <DialogTitle>新建远程项目</DialogTitle>
          <DialogDescription>
            会话将保持在本机，Bash / 读写文件等操作通过 SSH 在远端执行。
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="remote-project-name">项目名称</Label>
            <Input
              id="remote-project-name"
              value={name}
              placeholder="我的远程项目"
              onChange={(e) => setName(e.target.value)}
              autoFocus
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label>远程主机</Label>
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
                <SelectValue placeholder="选择 SSH 主机" />
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
                    添加远程
                  </span>
                </SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="remote-project-path">源文件夹</Label>
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
                title={hostId ? "浏览远端目录" : "请先选择 SSH 主机"}
              >
                浏览…
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
                          没有子目录
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
                      收起
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
                      选择此目录
                    </Button>
                  </div>
                </div>
              </div>
            )}
            {projects.length > 0 && (
              <div className="text-muted-foreground text-xs">
                已有项目：{projects.map((p) => p.name).join("、")}
              </div>
            )}
          </div>

          {hostsLoaded && enabledHosts.length === 0 && (
            <div className="text-muted-foreground bg-muted/40 flex flex-col items-center gap-2 rounded-xl px-4 py-8 text-sm">
              <CloudOffIcon className="text-muted-foreground/60 size-8" />
              请先在 设置 → 系统 → SSH 主机 中添加并启用一个主机。
            </div>
          )}
          {error && <div className="text-destructive text-xs">{error}</div>}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            取消
          </Button>
          <Button onClick={() => void submit()} disabled={!canSubmit}>
            {busy ? <Loader2Icon className="size-4 animate-spin" /> : null}
            添加项目
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
