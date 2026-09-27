/**
 * Office 聚合外壳：一个面板承载三类办公文档，统一首页（统一历史卡片墙 + 三类新建）。
 *   `.deck.canvas.json`  → 幻灯片（自研 leafer 引擎，见 ./App.tsx）
 *   `.sheet.univer.json` → 表格（Univer Sheets OSS，见 ./sheet/SheetApp.tsx）
 *   `.doc.univer.json`   → 文档（Univer Docs OSS，见 ./doc/DocApp.tsx）
 * 路由 = 绑定路径后缀；桥 attach 多播，外壳与当前视图各自消费自己关心的帧。
 * 拿到 Univer Pro 授权后，幻灯片视图可整体替换为 @univerjs-pro/slides，外壳不动。
 */
import { type FC, useCallback, useEffect, useRef, useState } from "react";
import {
  FileSpreadsheetIcon,
  FileTextIcon,
  Loader2Icon,
  PlusIcon,
  PresentationIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { bridge, type DocListItem } from "@/bridge";
import { deckSeedJson } from "@/state";
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
        kind === "deck"
          ? deckSeedJson(safe)
          : kind === "sheet"
            ? JSON.stringify(newSheetSeed(safe), null, 2)
            : JSON.stringify(newDocSeed(safe), null, 2);
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
  const [kind, setKind] = useState<Kind>("sheet");

  useEffect(() => {
    let alive = true;
    void bridge.listDocs().then((all) => {
      if (!alive) return;
      // 本面板只管三类办公档；board/ui 白板档归 slide-canvas 面板
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
      <div className="mx-auto flex max-w-3xl flex-col gap-6 px-6 py-10">
        {/* 品牌头：轻字重标题 + 一句话定位（ElevenLabs：排版即门面） */}
        <header className="flex flex-col gap-1.5">
          <h1 className="text-[26px] leading-tight text-black" style={{ fontWeight: 300, letterSpacing: "-0.02em" }}>
            办公
          </h1>
          <p className="text-[13px] text-[#777169]">幻灯片、表格与文档——在这里创建，或让对话里的 agent 替你写。</p>
        </header>

        {/* 创建条：分段选类型 + 名称输入 + 黑药丸 CTA */}
        <div className="flex items-center gap-2">
          <div
            className="flex h-10 shrink-0 items-center gap-0.5 rounded-full p-1"
            style={{ background: "#f5f5f5", boxShadow: "rgba(0,0,0,0.075) 0px 0px 0px 0.5px inset" }}
          >
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
                    "flex h-8 cursor-pointer items-center gap-1.5 rounded-full px-3 text-[12.5px] transition-all",
                    selected
                      ? "bg-black text-white shadow-[rgba(0,0,0,0.4)_0px_0px_1px,rgba(0,0,0,0.04)_0px_4px_4px]"
                      : "text-[#4e4e4e] hover:text-black",
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
            className="h-10 flex-1 rounded-full border-[#e5e5e5] bg-white px-4 text-[13px]"
            style={{ boxShadow: "rgba(0,0,0,0.075) 0px 0px 0px 0.5px inset" }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && name.trim()) {
                onCreate(kind, name);
                setName("");
              }
            }}
          />
          <Button
            size="lg"
            className="h-10 shrink-0 rounded-full px-5 text-[13px]"
            disabled={!name.trim()}
            onClick={() => {
              if (name.trim()) onCreate(kind, name);
              setName("");
            }}
          >
            <PlusIcon className="size-4" />
            新建
          </Button>
        </div>

        {/* 导入：安静的次级入口，三类各自的 accept */}
        <div className="flex items-center gap-2 text-xs text-[#777169]">
          <span>或从已有文件导入</span>
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
              className="flex h-7 cursor-pointer items-center rounded-full bg-white px-3 text-[12px] text-black transition-all hover:-translate-y-px"
              style={{ boxShadow: "rgba(0,0,0,0.06) 0px 0px 0px 1px, rgba(0,0,0,0.04) 0px 1px 2px" }}
            >
              {label}
            </button>
          ))}
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

        {/* 文档列表 */}
        {items === null ? (
          <div className="flex flex-col gap-2 pt-2">
            {[0, 1, 2].map((i) => (
              <div key={i} className="sc-shimmer h-16 rounded-2xl" style={{ background: "#f5f5f5" }} />
            ))}
          </div>
        ) : items.length === 0 ? (
          <div className="flex flex-col items-center gap-3 rounded-[24px] border border-dashed border-[#e5e5e5] py-14 text-center">
            <span
              className="flex size-11 items-center justify-center rounded-full"
              style={{ background: "rgba(245,242,239,0.8)", boxShadow: "rgba(78,50,23,0.04) 0px 6px 16px" }}
            >
              <FileTextIcon className="size-5 text-black" />
            </span>
            <div className="text-[14px] text-black" style={{ fontWeight: 300 }}>
              还没有任何文档
            </div>
            <div className="max-w-sm text-xs leading-relaxed text-[#777169]">
              上面选类型新建，或直接在对话里让 agent 生成；已有的 Excel / CSV / PPT 点导入。
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-5">
            <div className="flex items-baseline gap-2">
              <span className="text-[13px] font-medium text-black">全部文档</span>
              <span className="text-xs text-[#777169]">{items.length}</span>
            </div>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              {items.map((item) => {
                const itemKind = item.kind === "sheet" || item.kind === "doc" ? item.kind : "deck";
                const meta = KIND_META[itemKind];
                const Icon = meta.icon;
                return (
                  <button
                    key={item.path}
                    type="button"
                    onClick={() => onOpen(item.path)}
                    className={cn(
                      "group flex flex-col gap-2.5 rounded-2xl bg-white p-3.5 text-left transition-all duration-200",
                      item.corrupt
                        ? "border border-[#d03238]/30"
                        : "hover:-translate-y-0.5",
                    )}
                    style={
                      item.path === currentPath
                        ? { boxShadow: "rgba(0,0,0,0.75) 0px 0px 0px 1.5px, rgba(0,0,0,0.06) 0px 4px 12px" }
                        : { boxShadow: "rgba(0,0,0,0.06) 0px 0px 0px 1px, rgba(0,0,0,0.04) 0px 1px 2px, rgba(0,0,0,0.04) 0px 2px 4px" }
                    }
                  >
                    <div className="flex w-full items-center gap-2.5">
                      <span
                        className="flex size-8 shrink-0 items-center justify-center rounded-[10px]"
                        style={{ background: "rgba(245,242,239,0.8)" }}
                      >
                        <Icon className="size-4 text-black" />
                      </span>
                      <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-black">{item.name}</span>
                      {item.corrupt ? (
                        <span className="shrink-0 rounded-full bg-[#d03238]/10 px-2 py-0.5 text-[10px] text-[#d03238]">损坏</span>
                      ) : (
                        <span
                          className="shrink-0 rounded-full px-2 py-0.5 text-[10px] text-[#4e4e4e]"
                          style={{ background: "#f5f5f5" }}
                        >
                          {meta.label}
                        </span>
                      )}
                    </div>
                    <div
                      className="truncate text-[11px] text-[#777169]"
                      title={item.corrupt ? "JSON 解析失败，可修复后再开" : item.path}
                    >
                      {item.corrupt ? "文件损坏 · 打开不会覆盖原文件" : item.path}
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

/* ---------------- 各 kind 新建种子（sheet/doc；deck 的在 state.ts） ---------------- */

function newSheetSeed(name: string): Record<string, unknown> {
  const sheetId = "sheet-01";
  return {
    id: `wb-${Date.now().toString(36)}`,
    name,
    sheetOrder: [sheetId],
    styles: {},
    sheets: {
      [sheetId]: { id: sheetId, name: "Sheet1", rowCount: 100, columnCount: 20, cellData: {} },
    },
  };
}

function newDocSeed(name: string): Record<string, unknown> {
  // 只给 id/title：body 由引擎默认空文档补全（手写 body 易缺节分隔符导致空白页）
  return { id: `doc-${Date.now().toString(36)}`, title: name };
}
