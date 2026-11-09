"use client";

/**
 * 「引用资料库文件…」选择器（composer「+」菜单入口）：
 * 大尺寸多选 Dialog——搜索 + 表格列（名称/标签/位置/最近修改）+ 底部
 * 「已选择 N 项 / 取消 / 确定」。只扫资料库根（AI 产物不参与引用）。
 *
 * 选中即把 `:library[...]` 引用芯片插到输入框光标处——引用是指针，内容不
 * 复制；文件之后被移动/删除由草稿守卫（library-ref-guard）标记并拦截发送。
 */

import { useEffect, useState, type FC } from "react";
import { CheckIcon, Loader2Icon, SearchIcon } from "lucide-react";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { FileTypeIcon } from "@/components/agent-thread/agent-panel/file-type-icon";
import { toast } from "@/components/ui/toast";
import { cn } from "@/lib/utils";
import {
  formatBackupTime,
} from "@/lib/settings/backup-config";
import { insertIntoComposer } from "@/components/agent-thread/cm-composer-input";
import {
  buildLibraryDirective,
  joinFsPath,
} from "@/lib/composer/library-reference";
import {
  searchLibrary,
  type LibraryIndexEntry,
} from "@/lib/workspace/library-index";
import { useLibraryRoot } from "@/lib/workspace/library-root";
import { isDesktop } from "@/lib/desktop-env";
import { t, useT } from "@/lib/i18n";

const dirOf = (rel: string): string => {
  const slash = rel.lastIndexOf("/");
  return slash < 0 ? t("library.referencePicker.rootDir") : rel.slice(0, slash);
};

const ROW_GRID =
  "grid grid-cols-[20px_minmax(0,2fr)_minmax(0,1.4fr)_minmax(0,1.2fr)_110px] items-center gap-3";

export const LibraryReferencePicker: FC<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
}> = ({ open, onOpenChange }) => {
  const tt = useT();
  const info = useLibraryRoot();
  const root = info?.root ?? null;
  const exists = info?.exists ?? false;
  const [query, setQuery] = useState("");
  const debounced = useDebouncedValue(query, 200);
  const [selected, setSelected] = useState<Map<string, LibraryIndexEntry>>(
    new Map(),
  );
  const [state, setState] = useState<{
    entries: LibraryIndexEntry[];
    loading: boolean;
    truncated: boolean;
    rootMissing: boolean;
  }>({ entries: [], loading: false, truncated: false, rootMissing: false });

  // 关闭时清空搜索与已选，下次打开回到「最近文件」视图
  useEffect(() => {
    if (!open) {
      setQuery("");
      setSelected(new Map());
    }
  }, [open]);

  // 资料库根切换：已选项的 rel 是相对旧根的，必须清空，否则确认时会拼错路径
  useEffect(() => {
    setSelected(new Map());
  }, [root]);

  useEffect(() => {
    if (!open || !isDesktop() || !root || !exists) {
      setState({
        entries: [],
        loading: false,
        truncated: false,
        rootMissing: Boolean(root) && !exists,
      });
      return;
    }
    let alive = true;
    setState((s) => ({ ...s, loading: true }));
    searchLibrary(debounced, { fresh: debounced === "" })
      .then((r) => {
        if (alive) {
          setState({
            entries: r.entries,
            loading: false,
            truncated: r.truncated,
            rootMissing: r.rootMissing,
          });
        }
      })
      .catch(() => {
        if (alive) setState((s) => ({ ...s, loading: false }));
      });
    return () => {
      alive = false;
    };
  }, [open, debounced, root, exists]);

  const toggle = (entry: LibraryIndexEntry) => {
    setSelected((prev) => {
      const next = new Map(prev);
      if (next.has(entry.rel)) next.delete(entry.rel);
      else next.set(entry.rel, entry);
      return next;
    });
  };

  const confirm = () => {
    if (!root) {
      toast.error(tt("library.referencePicker.notReady"));
      return;
    }
    const tokens = [...selected.values()].map((entry) =>
      buildLibraryDirective({
        rel: entry.rel,
        // 芯片 label 与树/查看器一致用文件名；派生标题只参与搜索
        name: entry.name,
        absPath: joinFsPath(root, entry.rel),
      }),
    );
    if (tokens.length === 0) return;
    if (!insertIntoComposer(tokens.join(" "))) {
      toast.error(tt("library.referencePicker.composerNotReady"));
      return;
    }
    onOpenChange(false);
  };

  const emptyText = query.trim()
    ? tt("library.referencePicker.noMatch", { query: query.trim() })
    : tt("library.referencePicker.empty");

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-[min(92vw,64rem)] gap-4 overflow-y-auto p-6 sm:max-w-[min(92vw,64rem)]">
        <DialogHeader>
          <DialogTitle className="text-lg">{tt("library.referencePicker.title")}</DialogTitle>
          <DialogDescription>
            {tt("library.referencePicker.description")}
          </DialogDescription>
        </DialogHeader>

        <div className="relative">
          <SearchIcon className="text-muted-foreground/70 pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={tt("library.referencePicker.searchPlaceholder")}
            autoFocus
            spellCheck={false}
            className="h-10 rounded-lg pl-10 text-sm"
          />
        </div>

        <div className="border-border/60 overflow-hidden rounded-xl border">
          <div
            className={cn(
              ROW_GRID,
              "bg-muted/40 text-muted-foreground border-b px-4 py-2.5 text-xs font-medium",
            )}
          >
            <span />
            <span>{tt("library.referencePicker.colName")}</span>
            <span>{tt("library.referencePicker.colTags")}</span>
            <span>{tt("library.referencePicker.colLocation")}</span>
            <span className="text-right">{tt("library.referencePicker.colModified")}</span>
          </div>

          {/* 固定高度：空态/加载/搜索结果多少都不让弹窗跳高度 */}
          <div className="h-[min(56vh,520px)] overflow-y-auto">
            {state.loading ? (
              <div className="text-muted-foreground flex items-center justify-center gap-2 py-16 text-sm">
                <Loader2Icon className="size-4 animate-spin" />
                {tt("library.common.searching")}
              </div>
            ) : state.rootMissing ? (
              <p className="text-muted-foreground/70 px-4 py-16 text-center text-sm">
                {tt("library.referencePicker.rootMissing")}
              </p>
            ) : state.entries.length === 0 ? (
              <p className="text-muted-foreground px-4 py-16 text-center text-sm">
                {emptyText}
              </p>
            ) : (
              state.entries.map((entry) => {
                const checked = selected.has(entry.rel);
                return (
                  <button
                    key={entry.rel}
                    type="button"
                    onClick={() => toggle(entry)}
                    aria-pressed={checked}
                    title={entry.title && entry.title !== entry.name ? entry.title : undefined}
                    className={cn(
                      ROW_GRID,
                      "hover:bg-muted/50 w-full border-b border-border/40 px-4 py-2.5 text-left transition-colors last:border-b-0",
                      checked && "bg-muted/60",
                    )}
                  >
                    <span
                      className={cn(
                        "grid size-4 place-items-center rounded border transition-colors",
                        checked
                          ? "bg-primary border-primary text-primary-foreground"
                          : "border-border/80",
                      )}
                      aria-hidden
                    >
                      {checked && <CheckIcon className="size-3" strokeWidth={3} />}
                    </span>
                    <span className="flex min-w-0 items-center gap-2">
                      <FileTypeIcon path={entry.name} className="size-4 shrink-0" />
                      <span className="truncate text-sm">{entry.name}</span>
                    </span>
                    <span className="text-muted-foreground min-w-0 truncate text-xs">
                      {entry.tags.length > 0
                        ? entry.tags.map((tag) => `#${tag}`).join(" ")
                        : "—"}
                    </span>
                    <span className="text-muted-foreground/70 min-w-0 truncate font-mono text-xs">
                      {dirOf(entry.rel)}
                    </span>
                    <span className="text-muted-foreground truncate text-right text-xs whitespace-nowrap tabular-nums">
                      {entry.modified ? formatBackupTime(entry.modified) : ""}
                    </span>
                  </button>
                );
              })
            )}
          </div>
        </div>

        <DialogFooter className="items-center sm:justify-between">
          <span className="text-muted-foreground text-xs">
            {tt("library.referencePicker.selectedCount", { count: selected.size })}
            {state.truncated ? tt("library.referencePicker.truncatedSuffix") : ""}
          </span>
          <div className="flex items-center gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              {tt("common.action.cancel")}
            </Button>
            <Button disabled={selected.size === 0} onClick={confirm}>
              {tt("common.action.confirm")}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
