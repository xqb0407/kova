"use client";

/**
 * 添加插件市场弹窗：本地目录（原生目录选择器或手输路径）或 Git 仓库地址。
 * 提交即受理（git clone 耗时，结果经 plugin_op_result 帧回流，错误 toast 由
 * 调用方注册的 setPluginOpHandler 呈现）。
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
import { Segmented } from "@/components/custom-ui/segmented";
import { addMarketplace, isPluginOpPending } from "@/lib/plugins/plugins";

export const AddMarketplaceDialog: FC<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
}> = ({ open, onOpenChange }) => {
  const [type, setType] = useState<"directory" | "git">("directory");
  const [path, setPath] = useState("");
  const [repo, setRepo] = useState("");
  const [error, setError] = useState<string | null>(null);

  const busy = isPluginOpPending("add_marketplace", type === "git" ? repo : path);

  const browse = async () => {
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const dir = await open({ directory: true, multiple: false, title: "选择插件市场目录" });
      if (typeof dir === "string") setPath(dir);
    } catch {
      // 非 Tauri 环境：无原生目录选择器，手输路径
    }
  };

  const submit = () => {
    setError(null);
    if (type === "directory" && !path.trim()) {
      setError("请填写市场目录路径");
      return;
    }
    if (type === "git" && !repo.trim()) {
      setError("请填写 Git 仓库地址");
      return;
    }
    void addMarketplace({
      type,
      ...(type === "git" ? { repo: repo.trim() } : { path: path.trim() }),
    })
      .then(() => {
        onOpenChange(false);
        setPath("");
        setRepo("");
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : String(err));
      });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>添加插件市场</DialogTitle>
          <DialogDescription>
            市场根目录需包含 marketplace.json 清单（插件目录里的插件以相对路径声明）。
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <Segmented
            value={type}
            onChange={(v) => setType(v as "directory" | "git")}
            options={[
              { value: "directory", label: "本地目录" },
              { value: "git", label: "Git 仓库" },
            ]}
          />

          {type === "directory" ? (
            <div className="space-y-1.5">
              <Label htmlFor="marketplace-path">市场目录</Label>
              <div className="flex gap-1.5">
                <Input
                  id="marketplace-path"
                  value={path}
                  onChange={(e) => setPath(e.target.value)}
                  placeholder="/path/to/marketplace"
                  className="font-mono text-xs"
                />
                <Button variant="outline" size="icon" className="size-9 shrink-0" onClick={() => void browse()}>
                  <FolderOpenIcon className="size-4" />
                </Button>
              </div>
            </div>
          ) : (
            <div className="space-y-1.5">
              <Label htmlFor="marketplace-repo">Git 仓库地址</Label>
              <Input
                id="marketplace-repo"
                value={repo}
                onChange={(e) => setRepo(e.target.value)}
                placeholder="https://github.com/owner/plugins-marketplace.git"
                className="font-mono text-xs"
              />
              <p className="text-muted-foreground text-xs">
                将浅克隆仓库并读取其中的 marketplace.json；未安装 git 时不可用。
              </p>
            </div>
          )}

          {error && <p className="text-destructive text-xs">{error}</p>}
        </div>

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button size="sm" disabled={busy} onClick={submit}>
            {busy && <Loader2Icon className="size-3.5 animate-spin" />}
            添加
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
