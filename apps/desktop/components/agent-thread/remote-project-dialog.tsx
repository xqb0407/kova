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
import { CloudOffIcon, Loader2Icon, PlusIcon } from "lucide-react";
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
    void loadHosts();
  }, [open]);

  if (!open) return null;

  const enabledHosts = hosts.filter((h) => h.enabled);
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
      <DialogContent className="max-w-lg gap-5">
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
            <Input
              id="remote-project-path"
              value={remotePath}
              placeholder="/home/user/project"
              className="font-mono"
              onChange={(e) => setRemotePath(e.target.value)}
            />
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
