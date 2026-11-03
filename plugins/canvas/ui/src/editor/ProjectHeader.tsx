/**
 * 顶部左侧「项目头」：画布 mark + 当前画布名 + 最近画布下拉（参考 codex-canvas 的 project-header）。
 *   - 点 mark/标题展开下拉，列出宿主扫描到的工作区画布（名字/相对路径/改动时间/损坏标记/当前）；
 *   - 点某一项：非当前 → bridge.bindDoc(path)（宿主推 doc.open，store 会切换内容）；当前 → 仅收起；
 *   - 底部固定「全部画布」回到首页卡片墙（复用 Home 的返回入口）；
 *   - 展开时重新 listDocs，看到 agent 在别处新建的档。
 * 缩写/截断都在标题行，参考项目的 name+path 两级展示。
 */
import { useCallback, useEffect, useState, type FC } from "react";
import { ChevronDownIcon, LayoutGridIcon, LoaderCircleIcon, RefreshCwIcon, ShapesIcon, TriangleAlertIcon } from "lucide-react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { bridge, type DocListItem } from "../bridge";
import { cn } from "@/lib/utils";

function kindTag(k: DocListItem["kind"]): string {
  return k === "ui" ? "UI 设计（旧）" : k === "board" ? "白板" : "文档";
}

/** mtime（ms epoch）→ 简短相对时间；0=宿主未提供 → 空串 */
function fmtMtime(ms: number): string {
  if (!ms) return "";
  const d = Date.now() - ms;
  const m = Math.floor(d / 60_000);
  if (m < 1) return "刚刚";
  if (m < 60) return `${m} 分钟前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时前`;
  const day = Math.floor(h / 24);
  if (day < 30) return `${day} 天前`;
  return new Date(ms).toLocaleDateString();
}

export const ProjectHeader: FC<{
  /** 当前画布显示名（fileRel 去前缀去扩展名） */
  title: string;
  kind: "board" | "ui";
  dirty: boolean;
  /** 当前画布相对路径（用于「当前」标记与命中断言） */
  currentPath: string | null;
  /** 去首页卡片墙 */
  onAll: () => void;
}> = ({ title, kind, dirty, currentPath, onAll }) => {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<DocListItem[] | null>(null);

  const refresh = useCallback(() => {
    setItems(null);
    void bridge.listDocs().then((r) => setItems(r ?? []));
  }, []);
  useEffect(() => {
    if (open) refresh();
  }, [open, refresh]);

  const openDoc = useCallback(
    (it: DocListItem) => {
      if (it.path !== currentPath) bridge.bindDoc(it.path);
      // Radix 选择后自动收起（受控 open 由 onOpenChange 同步）
    },
    [currentPath],
  );

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label="打开最近画布"
          className={cn(
            "flex min-w-0 cursor-pointer items-center gap-1.5 rounded-lg px-1 py-0.5 text-left",
            "hover:bg-black/5 data-[state=open]:bg-black/5",
            "dark:hover:bg-white/10 dark:data-[state=open]:bg-white/10",
          )}
        >
          {/* mark：方形图标块 */}
          <span className="bg-ink text-nowrap grid size-5.5 shrink-0 place-items-center rounded-md text-primary-foreground">
            <ShapesIcon className="size-3.5" />
          </span>
          <span className="min-w-0">
            <span className="flex max-w-[min(240px,calc(100vw-220px))] items-center gap-1 truncate text-xs font-semibold">
              <span className="truncate">{title}</span>
              {kind === "ui" && (
                <span className="bg-secondary text-muted-foreground shrink-0 rounded px-1 py-px text-xs font-normal">旧 UI</span>
              )}
              <span
                className={cn("size-1.5 shrink-0 rounded-full bg-ink transition-opacity", dirty ? "opacity-100" : "opacity-0")}
                title={dirty ? "有未保存改动（800ms 防抖写盘）" : "已保存"}
              />
            </span>
            {currentPath && <span className="text-muted-foreground block w-[min(240px,calc(100vw-220px))] truncate text-xs leading-tight">{currentPath}</span>}
          </span>
          <ChevronDownIcon className="text-muted-foreground size-3 shrink-0" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="bottom" sideOffset={6} className="w-[min(280px,calc(100vw-24px))]">
        <div className="flex items-center justify-between pr-1">
          <DropdownMenuLabel className="text-muted-foreground py-1 text-xs font-semibold">最近画布</DropdownMenuLabel>
          <button
            type="button"
            onClick={refresh}
            aria-label="刷新列表"
            className="text-muted-foreground hover:text-foreground grid size-6 place-items-center rounded-md hover:bg-accent"
          >
            <RefreshCwIcon className="size-3" />
          </button>
        </div>
        {items === null && (
          <div className="text-muted-foreground flex items-center gap-1.5 px-2 py-2 text-xs">
            <LoaderCircleIcon className="size-3 animate-spin" /> 正在列出…
          </div>
        )}
        {items !== null && items.length === 0 && (
          <div className="text-muted-foreground px-2 py-2 text-xs">工作区里还没有其他画布</div>
        )}
        {items !== null &&
          items.length > 0 &&
          items.map((it) => (
            <DropdownMenuItem key={it.path} onSelect={() => openDoc(it)} className="flex flex-col items-stretch gap-0.5 py-1.5">
              <span className="flex min-w-0 items-center gap-1.5">
                <span className="min-w-0 flex-1 truncate font-medium">{it.name}</span>
                {it.corrupt && (
                  <span className="text-red-500 flex shrink-0 items-center gap-0.5 text-xs">
                    <TriangleAlertIcon className="size-3" /> 损坏
                  </span>
                )}
                {it.path === currentPath ? (
                  <span className="text-primary shrink-0 text-xs">当前</span>
                ) : (
                  <span className="bg-secondary text-muted-foreground shrink-0 rounded px-1 py-px text-xs">{kindTag(it.kind)}</span>
                )}
              </span>
              <span className="text-muted-foreground flex min-w-0 items-center gap-1.5 text-xs">
                <span className="min-w-0 truncate">{it.path}</span>
                {fmtMtime(it.mtime) && <span className="shrink-0">{fmtMtime(it.mtime)}</span>}
              </span>
            </DropdownMenuItem>
          ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={onAll}>
          <LayoutGridIcon className="size-3.5" /> 全部画布
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
};
