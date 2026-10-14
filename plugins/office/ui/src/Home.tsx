/**
 * 面板首页：历史画布卡片墙 + 「＋ 新建」（先选类型，再命名/页幅）。
 *   - 打开已有档：bridge.bindDoc(path)，宿主重绑面板并推 doc.open；
 *   - 新建：store.createDoc(name, preset, kind)，类型写入 meta.kind，
 *     之后界面类型由文档决定（不再有白板/幻灯片切换）。
 * 宿主不支持 doc.list（旧版本）时退化为"空历史 + 只能新建"，不阻塞使用。
 */
import { useCallback, useEffect, useRef, useState, type FC } from "react";
import { ChevronLeftIcon, PlusIcon, PresentationIcon, RefreshCwIcon, ShapesIcon, SparklesIcon, TriangleAlertIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { bridge, type DocListItem } from "./bridge";
import type { DocKind, PagePreset } from "./doc";
import { PresetSelect } from "./PresetSelect";
import type { DeckStore } from "./state";
import { cn } from "@/lib/utils";

const KIND_META: Record<DocKind, { label: string; hint: string }> = {
  board: { label: "白板", hint: "无限画布：图形/图片/文本自由摆放，内容不进 PPT" },
  deck: { label: "幻灯片", hint: "逐页编辑页框，可放映、可导出 .pptx" },
  ui: { label: "UI 设计（旧）", hint: "旧格式：编辑表面仍是无限画布；新设计请去「UI 设计」面板" },
};

/** 卡片缩略图：页框布局按比例画进 16:10 的盒子；无页框的白板画点阵底 */
const Preview: FC<{ item: DocListItem }> = ({ item }) => {
  const ref = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const W = 264;
    const H = 165;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    cv.width = Math.round(W * dpr);
    cv.height = Math.round(H * dpr);
    const ctx = cv.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    // 白板底的淡点阵（"无限"暗示；幻灯片是干净底）
    if (item.kind === "board") {
      ctx.fillStyle = "rgba(127,127,127,0.22)";
      for (let y = 6; y < H; y += 10) for (let x = 6; x < W; x += 10) ctx.fillRect(x, y, 1, 1);
    }
    const fs = item.preview;
    if (item.corrupt) {
      // 损坏档没内容可画：斜线占位，一眼区别于"空白画布"
      ctx.strokeStyle = "rgba(220,38,38,0.28)";
      ctx.lineWidth = 1;
      for (let d = -H; d < W; d += 12) {
        ctx.beginPath();
        ctx.moveTo(d, H);
        ctx.lineTo(d + H, 0);
        ctx.stroke();
      }
      return;
    }
    if (fs.length === 0) return;
    const minX = Math.min(...fs.map((f) => f.x));
    const minY = Math.min(...fs.map((f) => f.y));
    const maxX = Math.max(...fs.map((f) => f.x + f.w));
    const maxY = Math.max(...fs.map((f) => f.y + f.h));
    const bw = Math.max(1, maxX - minX);
    const bh = Math.max(1, maxY - minY);
    const pad = 12;
    const s = Math.min((W - pad * 2) / bw, (H - pad * 2) / bh);
    const ox = (W - bw * s) / 2 - minX * s;
    const oy = (H - bh * s) / 2 - minY * s;
    for (const f of fs) {
      const x = f.x * s + ox;
      const y = f.y * s + oy;
      const w = Math.max(3, f.w * s);
      const h = Math.max(3, f.h * s);
      ctx.fillStyle = /^#|^rgb/.test(f.bg) ? f.bg : "#ffffff";
      ctx.fillRect(x, y, w, h);
      ctx.strokeStyle = "rgba(0,0,0,0.28)";
      ctx.lineWidth = 0.5;
      ctx.strokeRect(x + 0.25, y + 0.25, w - 0.5, h - 0.5);
    }
  }, [item]);
  return (
    <canvas
      ref={ref}
      className="border-border/60 h-[165px] w-full rounded-[20px] border"
      style={{ background: item.kind === "board" ? "var(--sc-deck-bg)" : "var(--secondary)" }}
    />
  );
};

export const Home: FC<{ store: DeckStore; currentPath: string | null; onEnter: () => void }> = ({ store, currentPath, onEnter }) => {
  const [items, setItems] = useState<DocListItem[] | null>(null);
  const [unsupported, setUnsupported] = useState(false);
  const [step, setStep] = useState<"list" | "type" | "form">("list");
  const [kind, setKind] = useState<"board" | "deck">("deck"); // office 只做幻灯片（文档/表格后续扩展）
  const [name, setName] = useState("");
  const [preset, setPreset] = useState<PagePreset>("16:9");

  const refresh = useCallback(() => {
    setItems(null);
    void bridge.listDocs().then((r) => {
      setUnsupported(r === null);
      // office 首页只列幻灯片档：白板/UI 档归「无限画布」面板（deck 类型或 .deck 后缀任一命中）
      setItems(
        (r ?? []).filter(
          (it): it is DocListItem & { kind: DocKind } =>
            (it.kind === "deck" || /\.deck\.canvas\.json$/i.test(it.path)) && it.kind !== "sheet" && it.kind !== "doc",
        ),
      );
    });
  }, []);
  useEffect(() => {
    refresh();
  }, [refresh]);
  /** 窗口重新获得焦点时重列：agent 在别处写了新档，用户切回面板即可看到卡片
   *  （宿主在无工作区时 cwd 兜底是异步的，首次列可能打空，焦点刷新也兜住这一拍） */
  useEffect(() => {
    const onFocus = () => refresh();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refresh]);

  const open = useCallback(
    (it: DocListItem) => {
      if (it.path === currentPath) {
        onEnter();
        return;
      }
      bridge.bindDoc(it.path);
      onEnter();
    },
    [currentPath, onEnter],
  );

  const create = useCallback(() => {
    if (!name.trim()) return;
    store.createDoc(name, preset, kind);
    onEnter();
  }, [store, name, preset, kind, onEnter]);

  /* ---------------- 新建：命名（类型在 hero 上已选定） ---------------- */
  if (step === "form") {
    const Icon = kind === "board" ? ShapesIcon : PresentationIcon;
    return (
      <div className="flex h-full items-center justify-center p-6">
        <div className="glass w-[440px] rounded-[30px]! p-7">
          <button type="button" className="text-muted-foreground mb-3 flex items-center gap-1 text-xs hover:underline" onClick={() => setStep("list")}>
            <ChevronLeftIcon className="size-3" /> 返回
          </button>
          <div className="flex items-center gap-2.5">
            <span className="bg-primary/15 text-ink flex size-9 items-center justify-center rounded-full">
              <Icon className="size-4.5" />
            </span>
            <div>
              <div className="text-[19px] font-bold">新建{KIND_META[kind].label}</div>
              <div className="text-muted-foreground text-[12px]">{KIND_META[kind].hint}</div>
            </div>
          </div>
          <div className="mt-6 grid gap-2.5">
            <Label htmlFor="home-doc-name">名称</Label>
            <div className="flex items-center gap-2.5">
              <Input
                id="home-doc-name"
                value={name}
                autoFocus
                placeholder={kind === "board" ? "白板" : "演示文稿"}
                className="h-10 flex-1"
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => {
                  e.stopPropagation();
                  if (e.key === "Enter") create();
                }}
              />
              {kind === "deck" && <PresetSelect value={preset} onChange={setPreset} className="h-10 w-[158px]" />}
            </div>
            <p className="text-muted-foreground text-[11px] leading-relaxed">
              会在工作区创建 <code className="bg-secondary rounded px-1">.deck.canvas.json</code> 并绑定到本面板，agent 之后可直接读写。
            </p>
          </div>
          <div className="mt-6 flex justify-end gap-2">
            <Button variant="secondary" size="lg" onClick={() => setStep("list")}>
              取消
            </Button>
            <Button size="lg" disabled={!name.trim()} onClick={create}>
              创建{KIND_META[kind].label}
            </Button>
          </div>
        </div>
      </div>
    );
  }

  /* ---------------- 落地页：hero + 最近画布 ---------------- */
  return (
    <div className="sc-home flex h-full flex-col overflow-hidden">
      <div className="min-h-0 flex-1 overflow-auto">
        {/* Hero */}
        <div className="mx-auto flex w-full max-w-[860px] flex-col items-center px-6 pt-20 pb-12 text-center">
          <span className="glass glass-sm mb-6 flex items-center gap-1.5 rounded-full! px-3.5 py-1.5 text-[11px] text-muted-foreground">
            <SparklesIcon className="size-3" /> Office · 幻灯片工作台，agent 可直接读写
          </span>
          <h1 className="text-[40px] leading-[1.05] font-black tracking-[-0.02em]">一页一页，把演示做好</h1>
          <p className="text-muted-foreground mt-3.5 max-w-[560px] text-[13px] leading-relaxed">
            逐页编辑、放映与 .pptx 导出；文档以 .deck.canvas.json 落盘，交给 AI 继续排版。
          </p>
          <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
            <Button
              size="lg"
              className="h-11 gap-2 px-5 text-[13px]"
              onClick={() => {
                setKind("deck");
                setName("演示文稿");
                setStep("form");
              }}
            >
              <PresentationIcon className="size-4" /> 新建幻灯片
            </Button>
          </div>
        </div>

        {/* 最近画布 */}
        <div className="mx-auto w-full max-w-[1100px] px-6 pb-12">
          <div className="mb-4 flex items-center gap-2">
            <span className="text-[13px] font-semibold">最近幻灯片</span>
            {items && <span className="text-muted-foreground text-[11px] tabular-nums">{items.length}</span>}
            <div className="flex-1" />
            <button type="button" onClick={refresh} className="text-muted-foreground hover:text-foreground flex items-center gap-1 text-[11px]">
              <RefreshCwIcon className="size-3" /> 刷新
            </button>
          </div>
          {items === null && (
            /* 磨砂骨架屏：卡片形状的占位微光，比转圈更贴最终版式 */
            <div className="grid grid-cols-[repeat(auto-fill,minmax(250px,1fr))] gap-4">
              {Array.from({ length: 6 }).map((_, i) => (
                <div key={i} className="glass rounded-[30px] p-3">
                  <div className="sc-shimmer bg-secondary/70 h-[165px] rounded-[20px]" />
                  <div className="sc-shimmer bg-secondary/80 mt-3 h-3.5 w-2/3 rounded-full" />
                  <div className="sc-shimmer bg-secondary/60 mt-2 mb-0.5 h-2.5 w-1/2 rounded-full" />
                </div>
              ))}
            </div>
          )}
          {items !== null && items.length === 0 && (
            <div className="glass flex flex-col items-center gap-2 rounded-[30px] px-6 py-12 text-center">
              <p className="text-[13px]">{unsupported ? "当前宿主不支持列文档，直接新建一个开始吧。" : "工作区里还没有幻灯片文档。"}</p>
              <p className="text-muted-foreground text-[11px]">用上面的按钮新建，或把 .deck.canvas.json 放进工作区后点刷新。</p>
            </div>
          )}
          {items !== null && items.length > 0 && (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(250px,1fr))] gap-5">
              {items.map((it) => (
                <button
                  key={it.path}
                  type="button"
                  onClick={() => open(it)}
                  className={cn(
                    "glass group flex flex-col gap-2.5 rounded-[30px] border-transparent! p-3 text-left transition-all duration-200 hover:-translate-y-1 hover:border-ink/50! hover:shadow-[0_18px_44px_rgba(14,15,12,0.14)]",
                    it.path === currentPath ? "border-ink/70!" : "border-transparent",
                  )}
                >
                  <Preview item={it} />
                  <div className="flex min-w-0 items-center gap-2 px-0.5">
                    <span className="truncate text-[13px] font-medium">{it.name}</span>
                    {it.corrupt ? (
                      <span className="shrink-0 rounded-md bg-red-500/15 px-1.5 py-0.5 text-[10px] text-red-500">损坏</span>
                    ) : (
                      <span className="bg-secondary text-muted-foreground shrink-0 rounded-md px-1.5 py-0.5 text-[10px]">
                        {KIND_META[it.kind as DocKind]?.label ?? "文档"}
                      </span>
                    )}
                    {it.path === currentPath && <span className="text-primary shrink-0 text-[10px]">当前</span>}
                  </div>
                  {it.corrupt ? (
                    /* truncate 必须挂在块级 span 上：flex 容器的 truncate 对匿名文本节点不生效（溢出裁不住） */
                    <div className="text-red-500/80 flex min-w-0 items-center gap-1 px-0.5 text-[10px]">
                      <TriangleAlertIcon className="size-3 shrink-0" />
                      <span className="min-w-0 truncate">
                        内容已损坏 · 打开不会覆盖原文件，可修复后再开 {it.path}
                      </span>
                    </div>
                  ) : (
                    <div className="text-muted-foreground truncate px-0.5 text-[10px]">
                      {it.kind === "deck" ? `${it.frames} 页` : `${it.frames} 页 · ${it.objects} 元素`} · {it.path}
                    </div>
                  )}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
