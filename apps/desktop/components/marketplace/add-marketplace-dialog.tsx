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
import { useT } from "@/lib/i18n";

export const AddMarketplaceDialog: FC<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
}> = ({ open, onOpenChange }) => {
  const t = useT();
  const [type, setType] = useState<"directory" | "git">("directory");
  const [path, setPath] = useState("");
  const [repo, setRepo] = useState("");
  const [error, setError] = useState<string | null>(null);

  const busy = isPluginOpPending("add_marketplace", type === "git" ? repo : path);

  const browse = async () => {
    try {
      const { open } = await import("@/desktop-bridge/plugin-dialog");
      const dir = await open({
        directory: true,
        multiple: false,
        title: t("marketplace.addSource.chooseDirTitle"),
      });
      if (typeof dir === "string") setPath(dir);
    } catch {
      // 非 桌面壳环境：无原生目录选择器，手输路径
    }
  };

  const submit = () => {
    setError(null);
    if (type === "directory" && !path.trim()) {
      setError(t("marketplace.addSource.pathRequired"));
      return;
    }
    if (type === "git" && !repo.trim()) {
      setError(t("marketplace.addSource.repoRequired"));
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
      <DialogContent className="gap-5 p-6 sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="text-md">
            {t("marketplace.addSource.title")}
          </DialogTitle>
          <DialogDescription className="truncate text-sm">
            {t("marketplace.addSource.desc")}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <Segmented
            className="w-fit"
            value={type}
            onChange={(v) => setType(v as "directory" | "git")}
            options={[
              { value: "directory", label: t("marketplace.addSource.directory") },
              { value: "git", label: t("marketplace.addSource.git") },
            ]}
          />

          {type === "directory" ? (
            <div className="space-y-2">
              <Label htmlFor="marketplace-path">
                {t("marketplace.addSource.pathLabel")}
              </Label>
              <div className="flex gap-2">
                <Input
                  id="marketplace-path"
                  value={path}
                  onChange={(e) => setPath(e.target.value)}
                  placeholder="/path/to/marketplace"
                  className="font-mono"
                />
                <Button variant="outline" size="icon" className="size-9 shrink-0" onClick={() => void browse()}>
                  <FolderOpenIcon className="size-4" />
                </Button>
              </div>
            </div>
          ) : (
            <div className="space-y-2">
              <Label htmlFor="marketplace-repo">
                {t("marketplace.addSource.repoLabel")}
              </Label>
              <Input
                id="marketplace-repo"
                value={repo}
                onChange={(e) => setRepo(e.target.value)}
                placeholder="https://github.com/owner/plugins-marketplace.git"
                className="font-mono"
              />
              <p className="text-muted-foreground text-xs">
                {t("marketplace.addSource.repoHint")}
              </p>
            </div>
          )}

          {error && <p className="text-destructive text-xs">{error}</p>}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("marketplace.common.cancel")}
          </Button>
          <Button disabled={busy} onClick={submit}>
            {busy && <Loader2Icon className="size-3.5 animate-spin" />}
            {t("marketplace.common.add")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
