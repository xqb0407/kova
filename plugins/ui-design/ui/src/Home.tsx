/**
 * 设计首页：历史设计档卡片墙（doc.list 摘要）+ 新建（命名 + 设备预设）+ AI 生成。
 *   - 打开已有档：bridge.bindDoc(path)，宿主重绑并推 doc.open；
 *   - 新建：store.createDoc(name, presetKey)（宿主下 = doc.create 建档并自动绑定）；
 *   - 宿主不支持 doc.list（旧版本）→ 退化为"无历史 + 只能新建"，不阻塞。
 */
import { useCallback, useEffect, useRef, useState, type FC } from "react";
import {
  ArrowUpDownIcon,
  ChevronDownIcon,
  FrameIcon,
  PlusIcon,
  RefreshCwIcon,
  SparklesIcon,
  TriangleAlertIcon,
  XIcon,
} from "lucide-react";
import { bridge, type DocListItem } from "./bridge";
import { DEVICE_ORDER, DEVICE_PRESETS } from "./doc";
import type { DesignStore } from "./state";

/** 卡片缩略图：当前页画板布局等比画进 16:10 的盒子 */
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
    const pad = 14;
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
      ctx.strokeStyle = "rgba(0,0,0,0.3)";
      ctx.lineWidth = 0.5;
      ctx.strokeRect(x + 0.25, y + 0.25, w - 0.5, h - 0.5);
    }
  }, [item]);
  return (
    <canvas
      ref={ref}
      className="h-[150px] w-full rounded-lg border"
      style={{ borderColor: "var(--border)", background: "var(--muted)" }}
    />
  );
};

/** 设备预设下拉（首页与画板检视共用外观：触发钮 + 下拉清单） */
const PresetPicker: FC<{ value: string; onChange: (key: string) => void }> = ({ value, onChange }) => {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("pointerdown", onDown);
    return () => window.removeEventListener("pointerdown", onDown);
  }, [open]);
  const label = DEVICE_PRESETS[value]?.label ?? "自定义";
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex h-9 w-[190px] shrink-0 items-center gap-2 rounded-full px-3 text-[12px] transition-all hover:brightness-95"
        style={{ background: "var(--secondary)", color: "var(--foreground)" }}
      >
        <ArrowUpDownIcon className="size-3.5 shrink-0" style={{ color: "var(--muted-foreground)" }} />
        <span className="flex-1 truncate text-left">{label}</span>
        <ChevronDownIcon className="size-3.5 shrink-0" style={{ color: "var(--muted-foreground)" }} />
      </button>
      {open && (
        <div
          className="absolute left-0 top-[calc(100%+4px)] z-30 w-[220px] rounded-xl border p-1 shadow-pop"
          style={{ borderColor: "var(--border)", background: "var(--popover)" }}
        >
          {DEVICE_ORDER.map((key) => {
            const p = DEVICE_PRESETS[key]!;
            return (
              <button
                key={key}
                type="button"
                onClick={() => {
                  onChange(key);
                  setOpen(false);
                }}
                className="flex w-full items-center justify-between rounded px-2 py-1.5 text-left text-[12px] hover:opacity-100"
                style={{
                  background: value === key ? "var(--accent)" : "transparent",
                  color: value === key ? "var(--accent-foreground)" : "var(--foreground)",
                }}
                onMouseEnter={(e) => {
                  if (value !== key) e.currentTarget.style.background = "var(--secondary)";
                }}
                onMouseLeave={(e) => {
                  if (value !== key) e.currentTarget.style.background = "transparent";
                }}
              >
                <span>{p.label}</span>
                <span className="text-[10px] tabular-nums opacity-70">{p.group}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
};

function relativeTime(ms: number): string {
  if (!ms) return "";
  const diff = Date.now() - ms;
  const m = Math.floor(diff / 60000);
  if (m < 1) return "刚刚";
  if (m < 60) return `${m} 分钟前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时前`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d} 天前`;
  return new Date(ms).toLocaleDateString();
}

export const Home: FC<{ store: DesignStore; currentPath: string | null; onEnter: () => void }> = ({
  store,
  currentPath,
  onEnter,
}) => {
  const [items, setItems] = useState<DocListItem[] | null>(null);
  const [unsupported, setUnsupported] = useState(false);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [preset, setPreset] = useState("ios-390");

  const refresh = useCallback(() => {
    setItems(null);
    void bridge.listDocs().then((r) => {
      setUnsupported(r === null);
      setItems(r ?? []);
    });
  }, []);
  useEffect(() => {
    refresh();
  }, [refresh]);
  /** 窗口重获焦点时重列：agent 在别处写了新档，切回面板即可看到卡片 */
  useEffect(() => {
    const onFocus = () => refresh();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refresh]);
  /** 对话框开着时 Esc 兜底关闭（焦点不在输入框上也能退） */
  useEffect(() => {
    if (!creating) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setCreating(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [creating]);

  const open = useCallback(
    (it: DocListItem) => {
      if (it.path !== currentPath) bridge.bindDoc(it.path);
      onEnter();
    },
    [currentPath, onEnter],
  );

  const create = useCallback(
    (ai: boolean) => {
      const nm = name.trim() || "UI 设计";
      store.createDoc(nm, preset);
      if (ai) {
        // 建档即预填生成指令：agent 按 SKILL.md 画板结构逐画板落界面稿
        const p = DEVICE_PRESETS[preset];
        bridge.prefill(
          `请在这份 UI 设计档里按「${p?.label ?? preset}」画板生成一套移动端界面（共 3 个画板）：\n` +
            `1) 「首页」：顶部标题栏、搜索框、内容卡片列表、底部标签栏；\n` +
            `2) 「关键流程」：完成主任务的分步界面；\n` +
            `3) 「详情」：信息层级展示 + 主操作按钮。\n` +
            `要求：遵循 8pt 栅格；文字用 text 节点、卡片/按钮用圆角矩形；颜色克制（黑白灰 + 一个主色 #0d99ff）；画板之间留 80 间距。`,
        );
      }
      onEnter();
    },
    [store, name, preset, onEnter],
  );

  const [aiMode, setAiMode] = useState(false);
  const startCreate = (ai: boolean) => {
    setName(ai ? "AI 界面稿" : "UI 设计");
    setCreating(true);
    setAiMode(ai);
  };

  return (
    <div className="flex h-full flex-col overflow-hidden" style={{ background: "var(--canvas)" }}>
      <div className="min-h-0 flex-1 overflow-auto">
        {/* Hero */}
        <div className="mx-auto flex w-full max-w-[720px] flex-col items-center px-6 pt-16 pb-10 text-center">
          <div
            className="mb-5 flex size-11 items-center justify-center rounded-full"
            style={{ background: "var(--accent)", color: "var(--accent-foreground)", boxShadow: "var(--sh-float)" }}
          >
            <FrameIcon className="size-5.5" />
          </div>
          <h1 className="text-[30px] font-light tracking-[-0.01em]" style={{ color: "var(--foreground)" }}>
            UI 设计
          </h1>
          <p className="mt-2 max-w-[440px] text-[12px] leading-relaxed" style={{ color: "var(--muted-foreground)" }}>
            专业界面设计台：画板、图层、完整属性检视；文档为 <code>*.uidesign.json</code>，agent 可直接读写迭代。
          </p>
          <div className="mt-7 flex flex-wrap items-center justify-center gap-2.5">
            <button
              type="button"
              onClick={() => startCreate(false)}
              className="flex h-9 items-center gap-1.5 rounded-full px-4 text-[12.5px] font-medium transition-transform hover:-translate-y-px"
              style={{ background: "var(--accent)", color: "var(--accent-foreground)", boxShadow: "var(--sh-elev)" }}
            >
              <PlusIcon className="size-4" /> 新建设计
            </button>
            <button
              type="button"
              onClick={() => startCreate(true)}
              className="flex h-9 items-center gap-1.5 rounded-full border px-4 text-[12.5px] font-medium transition-colors hover:bg-[var(--secondary)]"
              style={{ borderColor: "var(--border)", background: "var(--background)", color: "var(--foreground)" }}
            >
              <SparklesIcon className="size-4" style={{ color: "var(--accent)" }} /> 用 AI 生成界面
            </button>
          </div>

        </div>

        {/* 最近设计 */}
        <div className="mx-auto w-full max-w-[1060px] px-6 pb-14">
          <div className="mb-3 flex items-center gap-2">
            <span className="text-[13px] font-semibold" style={{ color: "var(--foreground)" }}>
              最近设计
            </span>
            {items && <span className="text-[11px] tabular-nums" style={{ color: "var(--muted-foreground)" }}>{items.length}</span>}
            <div className="flex-1" />
            <button
              type="button"
              onClick={refresh}
              className="flex items-center gap-1 text-[11px]"
              style={{ color: "var(--muted-foreground)" }}
            >
              <RefreshCwIcon className="size-3" /> 刷新
            </button>
          </div>
          {items === null && (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-4">
              {Array.from({ length: 6 }).map((_, i) => (
                <div key={i} className="rounded-xl border p-2.5" style={{ borderColor: "var(--border)", background: "var(--background)" }}>
                  <div className="h-[150px] animate-pulse rounded-lg" style={{ background: "var(--muted)" }} />
                  <div className="mt-3 h-3 w-2/3 animate-pulse rounded-full" style={{ background: "var(--muted)" }} />
                  <div className="mt-2 h-2.5 w-1/2 animate-pulse rounded-full" style={{ background: "var(--muted)" }} />
                </div>
              ))}
            </div>
          )}
          {items !== null && items.length === 0 && (
            <div
              className="flex flex-col items-center gap-1.5 rounded-xl border px-6 py-12 text-center"
              style={{ borderColor: "var(--border)", background: "var(--background)" }}
            >
              <p className="text-[12.5px]" style={{ color: "var(--foreground)" }}>
                {unsupported ? "当前宿主不支持列出历史文档，直接新建一个开始吧。" : "工作区里还没有设计文档。"}
              </p>
              <p className="text-[11px]" style={{ color: "var(--muted-foreground)" }}>
                用上面的按钮新建，或把 <code>*.uidesign.json</code> 放进工作区后点刷新。
              </p>
            </div>
          )}
          {items !== null && items.length > 0 && (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-4">
              {items.map((it) => (
                <button
                  key={it.path}
                  type="button"
                  onClick={() => open(it)}
                  className="group flex flex-col gap-2 rounded-xl border p-2.5 text-left shadow-hair transition-all hover:-translate-y-0.5 hover:shadow-float"
                  style={{
                    borderColor: it.path === currentPath ? "var(--accent)" : "var(--border)",
                    background: "var(--background)",
                  }}
                >
                  <Preview item={it} />
                  <div className="flex min-w-0 items-center gap-2 px-0.5">
                    <span className="truncate text-[12.5px] font-medium" style={{ color: "var(--foreground)" }}>
                      {it.name}
                    </span>
                    {it.corrupt ? (
                      <span className="shrink-0 rounded px-1.5 py-0.5 text-[10px]" style={{ background: "#fdecea", color: "#b3261e" }}>
                        损坏
                      </span>
                    ) : (
                      <span className="shrink-0 rounded px-1.5 py-0.5 text-[10px]" style={{ background: "var(--secondary)", color: "var(--muted-foreground)" }}>
                        设计
                      </span>
                    )}
                    {it.path === currentPath && (
                      <span className="shrink-0 text-[10px]" style={{ color: "var(--accent)" }}>
                        当前
                      </span>
                    )}
                  </div>
                  {it.corrupt ? (
                    <div className="flex min-w-0 items-center gap-1 px-0.5 text-[10px]" style={{ color: "#b3261e" }}>
                      <TriangleAlertIcon className="size-3 shrink-0" />
                      <span className="min-w-0 truncate">内容已损坏 · 打开不会覆盖原文件</span>
                    </div>
                  ) : (
                    <div className="truncate px-0.5 text-[10.5px]" style={{ color: "var(--muted-foreground)" }}>
                      {it.frames} 画板 · {it.objects} 元素
                      {it.mtime ? ` · ${relativeTime(it.mtime)}` : ""} · {it.path}
                    </div>
                  )}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* 新建对话框 */}
      {creating && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center px-4"
          style={{ background: "rgba(10,10,10,0.45)", backdropFilter: "blur(2px)" }}
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setCreating(false);
          }}
        >
          <div
            role="dialog"
            aria-modal="true"
            className="w-full max-w-[420px] rounded-2xl p-5 text-left"
            style={{ background: "var(--background)", boxShadow: "var(--sh-pop)" }}
          >
            <div className="mb-4 flex items-center gap-2">
              {aiMode && <SparklesIcon className="size-4" style={{ color: "var(--accent)" }} />}
              <div className="flex-1 text-[13px] font-semibold" style={{ color: "var(--foreground)" }}>
                {aiMode ? "新建并由 AI 生成" : "新建设计文档"}
              </div>
              <button
                type="button"
                title="关闭"
                onClick={() => setCreating(false)}
                className="flex h-7 w-7 items-center justify-center rounded-full transition-colors hover:bg-[var(--secondary)]"
                style={{ color: "var(--muted-foreground)" }}
              >
                <XIcon className="size-3.5" />
              </button>
            </div>
            <div className="flex items-center gap-2.5">
              <input
                value={name}
                autoFocus
                placeholder="设计名称"
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => {
                  e.stopPropagation();
                  if (e.key === "Enter") create(aiMode);
                  if (e.key === "Escape") setCreating(false);
                }}
                className="h-9 min-w-0 flex-1 rounded-xl px-3 text-[12px] outline-none transition-shadow focus:shadow-[0_0_0_1px_var(--border),0_0_0_3px_var(--ring)]"
                style={{ background: "var(--secondary)", color: "var(--foreground)" }}
              />
              <PresetPicker value={preset} onChange={setPreset} />
            </div>
            <p className="mt-3 text-[11px] leading-relaxed" style={{ color: "var(--muted-foreground)" }}>
              起始文档包含一块 <b>{DEVICE_PRESETS[preset]?.label}</b> 画板
              {aiMode ? "；创建后会向 AI 预填生成指令，逐画板产出界面稿。" : "，进去即可继续画。"}
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setCreating(false)}
                className="h-9 rounded-full px-4 text-[12px] transition-colors hover:bg-[var(--secondary)]"
                style={{ color: "var(--muted-foreground)" }}
              >
                取消
              </button>
              <button
                type="button"
                disabled={!name.trim()}
                onClick={() => create(aiMode)}
                className="h-9 rounded-full px-4.5 text-[12px] font-medium disabled:opacity-40"
                style={{ background: "var(--accent)", color: "var(--accent-foreground)", boxShadow: "var(--sh-elev)" }}
              >
                {aiMode ? "创建并生成" : "创建"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
