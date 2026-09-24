"use client";

/**
 * 本地安装插件弹窗：直接选一个插件目录物化安装（不经市场、不要求
 * marketplace.json）。清单三态探测与生态规范化全部复用安装链路——
 * 下载解压的 Claude/Codex 插件目录挑进来即可装。
 *
 * 交互：原生选择器选完目录即自动开始安装（无需再点按钮）；弹窗保持打开
 * 直到 plugin_op_result 帧回流——成功关窗 + toast，失败错误内联在窗内，
 * 关闭弹窗永远不代表操作结束。手输路径场景仍可回车 / 点「安装」提交。
 */
import { useState, type FC } from "react";
import { FolderOpenIcon, Loader2Icon } from "lucide-react";
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
import { installPluginLocal, usePendingOps, waitForPluginOp } from "@/lib/plugins/plugins";
import { toast } from "@/components/ui/toast";

export const InstallLocalDialog: FC<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
}> = ({ open, onOpenChange }) => {
  const [path, setPath] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [installing, setInstalling] = useState(false);

  // 挂起判据随 pendingOps 快照响应式更新（挂起残留曾让重开弹窗永远转圈）
  const pending = usePendingOps();
  const queued = pending.some(
    (p) => p.op === "install_plugin_local" && p.key === path.trim() && p.key !== "",
  );
  const busy = installing || queued;

  const closeAndReset = () => {
    onOpenChange(false);
    setPath("");
    setError(null);
  };

  const runInstall = async (target: string) => {
    setError(null);
    setInstalling(true);
    try {
      const opId = await installPluginLocal(target);
      const result = await waitForPluginOp(opId);
      if (result.ok) {
        toast.success({ title: "本地插件安装完成", description: target });
        closeAndReset();
      } else {
        setError(result.errorText ?? "安装失败");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setInstalling(false);
    }
  };

  const browse = async () => {
    try {
      const { open: openDialog } = await import("@tauri-apps/plugin-dialog");
      const dir = await openDialog({ directory: true, multiple: false, title: "选择插件目录" });
      if (typeof dir === "string") {
        setPath(dir);
        // 选完即装：消除「选完目录还要再点一下、点完没反应」的空档
        void runInstall(dir);
      }
    } catch {
      // 非 Tauri 环境：无原生目录选择器，手输路径
    }
  };

  const submit = () => {
    if (!path.trim()) {
      setError("请填写插件目录路径");
      return;
    }
    void runInstall(path.trim());
  };

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next && !busy) closeAndReset(); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>本地安装插件</DialogTitle>
          <DialogDescription>
            选择一个插件目录根（含 .xulux-plugin / .claude-plugin / .codex-plugin 的
            plugin.json 清单即可，无需市场）。装进「本地安装」市场；更新时重新选择同一目录点安装即可。
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-1.5">
          <Label htmlFor="local-plugin-path">插件目录</Label>
          <div className="flex gap-1.5">
            <Input
              id="local-plugin-path"
              value={path}
              onChange={(e) => setPath(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !busy) submit();
              }}
              placeholder="/path/to/plugins/my-plugin"
              className="font-mono text-xs"
              disabled={busy}
            />
            <Button
              variant="outline"
              size="icon"
              className="size-9 shrink-0"
              onClick={() => void browse()}
              disabled={busy}
              aria-label="选择目录"
            >
              <FolderOpenIcon className="size-4" />
            </Button>
          </div>
          {busy && !error && (
            <p className="text-muted-foreground flex items-center gap-1.5 text-xs">
              <Loader2Icon className="size-3.5 animate-spin" />
              正在安装…
            </p>
          )}
          {error && <p className="text-destructive text-xs">{error}</p>}
        </div>

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={closeAndReset} disabled={busy}>
            取消
          </Button>
          <Button size="sm" disabled={busy} onClick={submit}>
            {busy && <Loader2Icon className="size-3.5 animate-spin" />}
            安装
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
