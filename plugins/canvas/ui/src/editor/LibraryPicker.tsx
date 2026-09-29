/**
 * 图形库选择器：分类标签 + 搜索 + 预览网格；点击插入为 svg 元素（落视口中心）。
 * 预览与插入的墨色都随宿主主题（currentColor 在插入时解析为具体色，落档后可再编辑）。
 */
import { useMemo, useState, type FC } from "react";
import { SearchIcon } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { bridge } from "@/bridge";
import { LIBRARY, libraryPreviewUrl } from "./library";

export const LibraryPicker: FC<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPick: (item: (typeof LIBRARY)[number]["items"][number]) => void;
}> = ({ open, onOpenChange, onPick }) => {
  const [cat, setCat] = useState<string>(LIBRARY[0]?.id ?? "");
  const [query, setQuery] = useState("");
  const ink = bridge.getTheme() === "dark" ? "#f5f5f7" : "#1d1d1f";

  const items = useMemo(() => {
    const q = query.trim().toLowerCase();
    const cat0 = LIBRARY.find((c) => c.id === cat) ?? LIBRARY[0];
    const pool = q ? LIBRARY.flatMap((c) => c.items) : cat0?.items ?? [];
    return q ? pool.filter((it) => it.name.toLowerCase().includes(q)) : pool;
  }, [cat, query]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[560px]">
        <DialogHeader>
          <DialogTitle>图形库</DialogTitle>
        </DialogHeader>
        <div className="flex items-center gap-2">
          <Tabs value={cat} onValueChange={setCat} className="min-w-0 flex-1">
            <TabsList className="flex w-full flex-wrap">
              {LIBRARY.map((c) => (
                <TabsTrigger key={c.id} value={c.id} className="text-[11px]">
                  {c.name}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        </div>
        <div className="flex items-center gap-2">
          <SearchIcon className="text-muted-foreground size-3.5 shrink-0" />
          <Input value={query} placeholder="搜索图形名…" className="h-8 text-xs" onChange={(e) => setQuery(e.target.value)} />
        </div>
        <div className="grid max-h-[46vh] grid-cols-[repeat(auto-fill,minmax(88px,1fr))] gap-2 overflow-y-auto pr-1">
          {items.map((it) => (
            <button
              key={`${it.name}`}
              type="button"
              className="bg-background hover:border-ink/40 flex flex-col items-center gap-1 rounded-xl border border-transparent px-1.5 py-2.5 transition-colors hover:bg-accent"
              onClick={() => {
                onPick(it);
                onOpenChange(false);
              }}
            >
              <img src={libraryPreviewUrl(it, ink)} alt={it.name} className="h-12 w-12" draggable={false} />
              <span className="text-muted-foreground w-full truncate text-center text-[10px]">{it.name}</span>
            </button>
          ))}
          {items.length === 0 && (
            <div className="text-muted-foreground col-span-full py-8 text-center text-xs">没有匹配的图形</div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
};
