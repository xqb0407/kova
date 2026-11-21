"use client";

/**
 * 远端源文件夹选择：绝对路径输入 + 远端目录浏览器。
 * 新建远程项目与「新建工作区 → 文件所在位置 = 远程主机」共用，
 * 避免两处各维护一套 ssh_host_list_dirs 展开逻辑。
 */
import { useEffect, useState, type FC } from "react";
import { invoke } from "@/desktop-bridge/core";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useT } from "@/lib/i18n";
import { FolderOpenIcon, Loader2Icon } from "lucide-react";

export const RemotePathPicker: FC<{
  hostId: string;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  /** 输入框 id（配合 Label htmlFor） */
  inputId?: string;
}> = ({ hostId, value, onChange, disabled, inputId }) => {
  const t = useT();
  const [browseOpen, setBrowseOpen] = useState(false);
  const [browsePath, setBrowsePath] = useState("/");
  const [browseDirs, setBrowseDirs] = useState<string[]>([]);
  const [browseBusy, setBrowseBusy] = useState(false);
  const [browseError, setBrowseError] = useState<string | null>(null);

  // 切换主机后旧目录列表属于另一台机器：直接收起，避免误选到上一台的路径
  useEffect(() => {
    setBrowseOpen(false);
    setBrowseDirs([]);
    setBrowseError(null);
  }, [hostId]);

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
    if (!hostId) return;
    const start = value.trim().startsWith("/") ? value.trim() : "/";
    setBrowseOpen(true);
    setBrowsePath(start);
    setBrowseDirs([]);
    void loadRemoteDirs(start);
  };

  return (
    <>
      <div className="flex gap-2">
        <Input
          id={inputId}
          value={value}
          placeholder="/home/user/project"
          className="flex-1 font-mono"
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
        />
        <Button
          type="button"
          variant="outline"
          disabled={!hostId || disabled}
          onClick={openBrowse}
          title={
            hostId
              ? t("remote.project.browseTitle")
              : t("remote.project.chooseHostFirst")
          }
        >
          {t("remote.project.browse")}
        </Button>
      </div>
      {browseOpen ? (
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
                  onChange(browsePath);
                  setBrowseOpen(false);
                }}
              >
                {t("remote.project.selectDir")}
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
};
