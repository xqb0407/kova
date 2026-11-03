/**
 * Office 聚合外壳：一个面板承载三类办公文档，统一首页（统一历史卡片墙 + 三类新建）。
 *   `.deck.canvas.json`  → 幻灯片（自研 leafer 引擎，见 ./App.tsx）
 *   `.sheet.univer.json` → 表格（Univer Sheets OSS，见 ./sheet/SheetApp.tsx）
 *   `.doc.univer.json`   → 文档（Univer Docs OSS，见 ./doc/DocApp.tsx）
 * 路由 = 绑定路径后缀；桥 attach 多播，外壳与当前视图各自消费自己关心的帧。
 * 拿到 Univer Pro 授权后，幻灯片视图可整体替换为 @univerjs-pro/slides，外壳不动。
 */
import { type FC, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronRightIcon,
  FileSpreadsheetIcon,
  FileTextIcon,
  Loader2Icon,
  PlusIcon,
  PresentationIcon,
  SearchIcon,
  UploadIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { bridge, type DocListItem } from "@/bridge";
import { deckSeed, docSeed, sheetSeed } from "@/seeds";
import { App as DeckApp } from "@/App";
import { SheetView } from "@/sheet/SheetApp";
import { importCsvToSnapshot, importXlsxToSnapshot } from "@/sheet/xlsx-bridge";
import { importPptxToDeck, type PptxImage } from "@/pptx-bridge";
import { DocView } from "@/doc/DocApp";

type Kind = "deck" | "sheet" | "doc";

/** 绑定路径 → 引擎 kind（后缀即契约） */
function kindOfPath(path: string): Kind | null {
  if (/\.sheet\.univer\.json$/i.test(path)) return "sheet";
  if (/\.doc\.univer\.json$/i.test(path)) return "doc";
  if (/\.deck\.canvas\.json$/i.test(path)) return "deck";
  return null;
}

const KIND_META: Record<Kind, { label: string; suffix: string; icon: typeof FileTextIcon }> = {
  deck: { label: "幻灯片", suffix: ".deck.canvas.json", icon: PresentationIcon },
  sheet: { label: "表格", suffix: ".sheet.univer.json", icon: FileSpreadsheetIcon },
  doc: { label: "文档", suffix: ".doc.univer.json", icon: FileTextIcon },
};

function baseName(path: string): string {
  const file = path.split("/").pop() ?? path;
  for (const { suffix } of Object.values(KIND_META)) {
    if (file.toLowerCase().endsWith(suffix)) return file.slice(0, -suffix.length);
  }
  return file;
}

function safeName(raw: string): string | null {
  const name = raw.trim().replace(/\s+/g, "-");
  if (!name || /[\\/]/.test(name) || name.startsWith(".")) return null;
  return name;
}

export const OfficeApp: FC = () => {
  const [connected, setConnected] = useState(false);
  /** 当前绑定的文档路径；null = 统一首页 */
  const [fileRel, setFileRel] = useState<string | null>(null);
  const themeRef = useRef<"light" | "dark">("light");
  /**
   * pptx 导入的图片队列：等 doc.open 确认绑定路径后再 attach。宿主的
   * tab.path 绑定更新是异步的（React 状态），create 后立即 attachFile 会
   * 打在"未绑定"上把图片丢光。
   */
  const pendingImagesRef = useRef<Map<string, PptxImage[]>>(new Map());

  const notify = useCallback((text: string, level: "info" | "error" = "info") => {
    bridge.notify(text, level);
  }, []);

  /* 桥外壳：握手（连接态/主题/初始绑定）+ 错误提示；doc.open 的内容消费在视图里 */
  useEffect(() => {
    const detach = bridge.attach({
      onHandshake: (theme, ctx) => {
        setConnected(true);
        themeRef.current = theme;
        if (ctx.fileRelPath && kindOfPath(ctx.fileRelPath)) {
          setFileRel(ctx.fileRelPath);
        }
      },
      onDocOpen: (_rev, _json, _external, path) => {
        // 只跟随绑定目标（含 doc.bind/换绑）；内容由对应视图消费，这里不解析
        if (path === null) return;
        if (kindOfPath(path)) setFileRel(path);
        // 绑定确认后落 pptx 图片资产，再请求重读一遍（deck 渲染图片需要）
        const pending = pendingImagesRef.current.get(path);
        if (pending) {
          pendingImagesRef.current.delete(path);
          for (const img of pending) bridge.attachFile(img.name, img.base64);
          bridge.requestDoc();
        }
      },
      onSaved: () => {},
      onDocError: (text) => {
        pendingImagesRef.current.clear();
        notify(text, "error");
      },
      onTheme: (theme) => {
        themeRef.current = theme;
      },
      onAssetReply: () => {},
    });
    return detach;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* 新建（统一首页）：按 kind 组种子快照 → 宿主写盘 → doc.open 带 path 自动路由 */
  const createDoc = useCallback(
    (kind: Kind, name: string) => {
      const safe = safeName(name);
      if (!safe) {
        notify("名称需非空且不含路径分隔符", "error");
        return;
      }
      const rel = `${safe}${KIND_META[kind].suffix}`;
      const seed =
        kind === "deck" ? deckSeed(safe) : kind === "sheet" ? sheetSeed(safe) : docSeed(safe);
      bridge.create(rel, seed);
    },
    [notify],
  );

  /* 导入 xlsx/csv：文件选择器读字节 → 浏览器端转快照 → doc.create 落盘（自动绑定开板）。
   * xlsx 二进制不经过 agent；导入后的 JSON 快照才是 agent 的主场。 */
  const importFile = useCallback(
    async (file: File) => {
      const base = file.name.replace(/\.(xlsx|csv|pptx)$/i, "");
      const safe = safeName(base);
      if (!safe) {
        notify("文件名需非空且不含路径分隔符", "error");
        return;
      }
      try {
        const warnings: string[] = [];
        if (/\.pptx$/i.test(file.name)) {
          // pptx → 幻灯片文档：先落档（自动绑定开板），图片逐个落 <名>-assets/ 再刷新
          const r = await importPptxToDeck(await file.arrayBuffer(), safe, (xml) =>
            new DOMParser().parseFromString(xml, "text/xml"),
          );
          if (r.images.length > 0) pendingImagesRef.current.set(`${safe}.deck.canvas.json`, r.images);
          bridge.create(`${safe}.deck.canvas.json`, JSON.stringify(r.doc, null, 2));
          warnings.push(...r.warnings);
          notify(
            warnings.length
              ? `已导入 ${file.name}（有损项：${[...new Set(warnings)].join("、")}）`
              : `已导入 ${file.name}，可用「放映」预览`,
          );
          return;
        }
        let snapshot: unknown;
        if (/\.csv$/i.test(file.name)) {
          snapshot = importCsvToSnapshot(new TextDecoder().decode(await file.arrayBuffer()), safe).snapshot;
        } else {
          const r = await importXlsxToSnapshot(await file.arrayBuffer(), safe);
          snapshot = r.snapshot;
          warnings.push(...r.warnings);
        }
        bridge.create(`${safe}.sheet.univer.json`, JSON.stringify(snapshot, null, 2));
        notify(
          warnings.length
            ? `已导入 ${file.name}（有损项：${[...new Set(warnings)].join("、")}）`
            : `已导入 ${file.name}`,
        );
      } catch (err) {
        notify(`导入失败：${err instanceof Error ? err.message : String(err)}`, "error");
      }
    },
    [notify],
  );

  if (!connected) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground">
        <Loader2Icon className="size-4 animate-spin" />
      </div>
    );
  }

  const kind = fileRel ? kindOfPath(fileRel) : null;
  return (
    <div className="flex h-full flex-col bg-background">
      {kind === "sheet" && fileRel ? <SheetView key={fileRel} fileRel={fileRel} onHome={() => setFileRel(null)} /> : null}
      {kind === "doc" && fileRel ? <DocView key={fileRel} fileRel={fileRel} onHome={() => setFileRel(null)} /> : null}
      {kind === "deck" && fileRel ? <DeckApp onHome={() => setFileRel(null)} /> : null}
      {kind === null ? (
        <OfficeHome currentPath={fileRel} onOpen={(p) => bridge.bindDoc(p)} onCreate={createDoc} onImport={(f) => void importFile(f)} />
      ) : null}
    </div>
  );
};

/* ---------------- 统一首页：三类文档的历史卡片墙 + 新建 ---------------- */

const OfficeHome: FC<{
  currentPath: string | null;
  onOpen: (path: string) => void;
  onCreate: (kind: Kind, name: string) => void;
  onImport: (file: File) => void;
}> = ({ onOpen, onCreate, currentPath, onImport }) => {
  const fileRef = useRef<HTMLInputElement>(null);
  const [accept, setAccept] = useState(".xlsx,.csv,.pptx");
  const [items, setItems] = useState<DocListItem[] | null>(null);
  const [name, setName] = useState("");
  const [kind, setKind] = useState<Kind>("deck");
  const [query, setQuery] = useState("");

  /** 首页列表：按修改时间倒序（宿主给 mtime），再按名称/路径过滤 */
  const shown = useMemo(() => {
    const sorted = [...(items ?? [])].sort((a, b) => (b.mtime || 0) - (a.mtime || 0));
    const q = query.trim().toLowerCase();
    return q ? sorted.filter((i) => `${i.name} ${i.path}`.toLowerCase().includes(q)) : sorted;
  }, [items, query]);

  useEffect(() => {
    let alive = true;
    void bridge.listDocs().then((all) => {
      if (!alive) return;
      // 本面板只管三类办公档；board/ui 白板档归 canvas 面板
      setItems((all ?? []).filter((i) => i.kind === "deck" || i.kind === "sheet" || i.kind === "doc"));
    });
    return () => {
      alive = false;
    };
  }, []);

  /** 窗口重新获得焦点时重列：agent 在别处写了新档，切回面板即可看到 */
  useEffect(() => {
    const onFocus = () => {
      let alive = true;
      void bridge.listDocs().then((all) => {
        if (!alive) return;
        setItems((all ?? []).filter((i) => i.kind === "deck" || i.kind === "sheet" || i.kind === "doc"));
      });
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);

  return (
    <div className="sc-home min-h-0 flex-1 overflow-auto">
      <div className="mx-auto flex max-w-4xl flex-col gap-7 px-6 py-8">
        <header className="flex flex-col gap-1">
          <h1 className="text-[20px] font-semibold tracking-[-0.01em]">办公</h1>
          <p className="text-muted-foreground text-[12.5px]">幻灯片、表格与文档；也可以直接让对话里的 agent 生成。</p>
        </header>

        {/* 创建条：类型分段 + 名称 + 主按钮 */}
        <div className="flex items-center gap-2">
          <div className="flex h-9 shrink-0 items-center gap-0.5 rounded-full bg-muted p-0.5">
            {(Object.keys(KIND_META) as Kind[]).map((k) => {
              const meta = KIND_META[k];
              const Icon = meta.icon;
              const selected = kind === k;
              return (
                <button
                  key={k}
                  type="button"
                  onClick={() => setKind(k)}
                  className={cn(
                    "flex h-8 cursor-pointer items-center gap-1.5 rounded-full px-3 text-xs transition-colors",
                    selected
                      ? "bg-background text-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  <Icon className="size-3.5" />
                  {meta.label}
                </button>
              );
            })}
          </div>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={`新文档名称，如 季度汇报`}
            className="h-9 flex-1 rounded-full border-border bg-background px-4 text-[13px]"
            onKeyDown={(e) => {
              if (e.key === "Enter" && name.trim()) {
                onCreate(kind, name);
                setName("");
              }
            }}
          />
          <Button
            size="lg"
            className="h-9 shrink-0 rounded-full px-4 text-xs"
            disabled={!name.trim()}
            onClick={() => {
              if (name.trim()) onCreate(kind, name);
              setName("");
            }}
          >
            <PlusIcon className="size-3.5" />
            新建
          </Button>
        </div>

        {/* 导入：次级入口 */}
        <div className="flex items-center gap-2">
          <span className="text-muted-foreground text-[11px] font-medium">导入</span>
          {(
            [
              { label: "Excel / CSV", acc: ".xlsx,.csv" },
              { label: "PPT", acc: ".pptx" },
            ] as const
          ).map(({ label, acc }) => (
            <button
              key={label}
              type="button"
              onClick={() => {
                setAccept(acc);
                requestAnimationFrame(() => fileRef.current?.click());
              }}
              className="border-border bg-background hover:bg-accent flex h-7 cursor-pointer items-center gap-1.5 rounded-full border px-2.5 text-xs transition-colors"
            >
              <UploadIcon className="text-muted-foreground size-3.5" />
              {label}
            </button>
          ))}
          <div className="ml-auto flex items-center gap-1.5">
            <SearchIcon className="text-muted-foreground size-3.5" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.stopPropagation()}
              placeholder="搜索文档"
              aria-label="搜索文档"
              className="h-7 w-44 rounded-full text-xs"
            />
          </div>
          <input
            ref={fileRef}
            type="file"
            accept={accept}
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) onImport(f);
              e.target.value = "";
            }}
          />
        </div>

        {/* 文档列表：紧凑行，像桌面应用的文件列表 */}
        {items === null ? (
          <div className="flex flex-col gap-1.5">
            {[0, 1, 2].map((i) => (
              <div key={i} className="sc-shimmer bg-muted h-12 rounded-2xl" />
            ))}
          </div>
        ) : items.length === 0 ? (
          <div className="flex flex-col items-center gap-2 py-16 text-center">
            <span className="bg-muted flex size-10 items-center justify-center rounded-full">
              <FileTextIcon className="text-muted-foreground size-4" />
            </span>
            <p className="text-[13px] font-medium">暂无文档</p>
            <p className="text-muted-foreground text-xs">新建文档或导入现有文件开始</p>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            <div className="flex items-baseline gap-2">
              <span className="text-[12px] font-medium">全部文档</span>
              <span className="text-muted-foreground text-[11px] tabular-nums">
                {query.trim() ? `${shown.length} / ${items.length}` : items.length}
              </span>
            </div>
            {shown.length === 0 ? (
              <div className="border-border bg-background rounded-2xl border px-4 py-10 text-center">
                <p className="text-[13px] font-medium">没有匹配「{query.trim()}」的文档</p>
                <p className="text-muted-foreground mt-1 text-xs">换个关键词，或清空搜索框</p>
              </div>
            ) : (
            <div className="border-border bg-background divide-border/60 overflow-hidden rounded-2xl border divide-y">
              {shown.map((item) => {
                const itemKind = item.kind === "sheet" || item.kind === "doc" ? item.kind : "deck";
                const meta = KIND_META[itemKind];
                const Icon = meta.icon;
                return (
                  <button
                    key={item.path}
                    type="button"
                    onClick={() => onOpen(item.path)}
                    className={cn(
                      "group hover:bg-accent/50 flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors",
                      item.path === currentPath && "bg-accent/50",
                    )}
                  >
                    <span
                      className={cn(
                        "flex size-8 shrink-0 items-center justify-center rounded-[10px]",
                        item.corrupt ? "bg-destructive/10 text-destructive" : "bg-muted text-foreground",
                      )}
                    >
                      <Icon className="size-4" />
                    </span>
                    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span className="truncate text-[13px] font-medium">{item.name}</span>
                      <span
                        className={cn(
                          "truncate text-[11px]",
                          item.corrupt ? "text-destructive" : "text-muted-foreground",
                        )}
                        title={item.corrupt ? "JSON 解析失败，可修复后再开" : item.path}
                      >
                        {item.corrupt ? "文件解析失败 · 打开不会覆盖原文件" : item.path}
                      </span>
                    </span>
                    {item.corrupt ? (
                      <span className="bg-destructive/10 text-destructive shrink-0 rounded-full px-1.5 py-0.5 text-[10px]">
                        损坏
                      </span>
                    ) : (
                      <span className="text-muted-foreground shrink-0 text-[10px]">{meta.label}</span>
                    )}
                    <ChevronRightIcon className="text-muted-foreground/60 size-3.5 shrink-0 transition-transform group-hover:translate-x-0.5" />
                  </button>
                );
              })}
            </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};
