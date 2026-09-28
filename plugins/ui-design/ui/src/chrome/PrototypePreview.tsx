/**
 * PrototypePreview：全屏可交互原型预览（DOM 覆盖层，不碰 leafer 舞台）。
 * 画面 = 当前画板的 SVG（与导出同源 nodesToSvg），热点 = collectHotspots（onTap 节点盒）；
 * 点击热点 → 跳目标画板（history 可回退）；底部画板胶囊可直接切换；Esc 关闭。
 */
import { useEffect, useMemo, useRef, useState, type FC } from "react";
import { ChevronLeft, Play, X } from "lucide-react";
import { allFrames, findNode, type DesignDoc, type FrameNode } from "../doc";
import { nodesToSvg } from "../export";
import { makeMeasure } from "../leafer/measure";
import { collectHotspots, resolveTargetFrame } from "../prototype";
import type { DesignStore } from "../state";

function frameOf(doc: DesignDoc, id: string): FrameNode | null {
  const loc = findNode(doc, id);
  return loc && loc.node.type === "frame" && !loc.parent ? (loc.node as FrameNode) : null;
}

export const PrototypePreview: FC<{ store: DesignStore; startFrameId: string; onClose: () => void }> = ({
  store,
  startFrameId,
  onClose,
}) => {
  const [frameId, setFrameId] = useState(startFrameId);
  const [history, setHistory] = useState<string[]>([]);
  const [svg, setSvg] = useState<string | null>(null);
  const [fit, setFit] = useState(1);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const measureRef = useRef<ReturnType<typeof makeMeasure> | null>(null);
  if (!measureRef.current) measureRef.current = makeMeasure();
  const doc = store.doc;
  const frames = useMemo(() => allFrames(doc), [doc]);
  const frame = frameOf(doc, frameId) ?? frames[0]?.frame ?? null;

  useEffect(() => {
    let dead = false;
    if (!frame) {
      setSvg(null);
      return;
    }
    void nodesToSvg(doc, [frame.id], measureRef.current!).then((r) => {
      if (!dead) setSvg(r?.svg ?? null);
    });
    return () => {
      dead = true;
    };
  }, [doc, frame]);

  // 适配缩放：随舞台尺寸变化重算
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const calc = () => {
      if (!frame) return;
      const k = Math.min(1.5, Math.max(0.1, Math.min((el.clientWidth - 32) / frame.w, (el.clientHeight - 32) / frame.h)));
      setFit(k);
    };
    calc();
    const ro = new ResizeObserver(calc);
    ro.observe(el);
    return () => ro.disconnect();
  }, [frame]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  const goto = (to: string, remember = true) => {
    const target = resolveTargetFrame(doc, to);
    if (!target || !frame) return;
    if (remember) setHistory((h) => [...h.slice(-49), frame.id]);
    setFrameId(target.id);
  };
  const back = () => {
    const prev = history[history.length - 1];
    if (!prev) return;
    setHistory((h) => h.slice(0, -1));
    setFrameId(prev);
  };

  const hotspots = frame ? collectHotspots(frame) : [];
  const pageName = frame ? doc.pages.find((p) => p.id === frames.find((f) => f.frame.id === frame.id)?.pageId)?.name : null;

  return (
    <div ref={stageRef} className="fixed inset-0 z-50 flex flex-col" style={{ background: "#18181b" }}>
      {/* 顶栏 */}
      <div className="flex h-11 shrink-0 items-center gap-2 px-3" style={{ color: "#e4e4e7" }}>
        <button
          type="button"
          title="返回上一屏（←）"
          disabled={history.length === 0}
          onClick={back}
          className="flex h-7 w-7 items-center justify-center rounded-full transition-colors hover:bg-white/10 disabled:opacity-30"
        >
          <ChevronLeft size={15} />
        </button>
        <div className="flex min-w-0 items-center gap-1.5 text-[12px]">
          <Play size={12} style={{ color: "#0d99ff" }} />
          <span className="truncate font-medium">{frame?.name ?? "无画板"}</span>
          {pageName && <span style={{ color: "#71717a" }}>· {pageName}</span>}
          <span className="rounded-full px-2 py-0.5 text-[10px]" style={{ background: "rgba(255,255,255,0.08)", color: "#a1a1aa" }}>
            {frames.findIndex((f) => f.frame.id === frame?.id) + 1}/{frames.length} · 点击高亮区可跳转
          </span>
        </div>
        <div className="flex-1" />
        <button
          type="button"
          title="退出预览（Esc）"
          onClick={onClose}
          className="flex h-7 w-7 items-center justify-center rounded-full transition-colors hover:bg-white/10"
        >
          <X size={15} />
        </button>
      </div>

      {/* 画面：单一缩放容器（SVG 与热点层共用同一 transform，热点坐标=画板局部坐标） */}
      <div className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden">
        {frame ? (
          <div className="relative" style={{ width: frame.w * fit, height: frame.h * fit }}>
            <div
              className="absolute left-0 top-0 origin-top-left overflow-hidden"
              style={{ width: frame.w, height: frame.h, transform: `scale(${fit})`, background: "#fff", boxShadow: "0 12px 48px rgba(0,0,0,0.5)" }}
              dangerouslySetInnerHTML={{ __html: svg ?? "" }}
            />
            <div className="pointer-events-none absolute inset-0">
              {hotspots.map((h) => {
                const ok = !!resolveTargetFrame(doc, h.to);
                return (
                  <button
                    key={h.nodeId}
                    type="button"
                    title={ok ? `点击 → ${frameOf(doc, h.to)?.name ?? h.to}` : "跳转目标已删除"}
                    onClick={() => goto(h.to)}
                    className={`pointer-events-auto absolute rounded-sm transition-all hover:brightness-110 ${ok ? "" : "opacity-40"}`}
                    style={{
                      left: h.box.x * fit,
                      top: h.box.y * fit,
                      width: Math.max(h.box.w, 8) * fit,
                      height: Math.max(h.box.h, 8) * fit,
                      boxShadow: ok ? "inset 0 0 0 1.5px rgba(13,153,255,0.9), 0 0 0 4px rgba(13,153,255,0.15)" : "inset 0 0 0 1.5px rgba(244,63,94,0.8)",
                      background: "rgba(13,153,255,0.06)",
                      cursor: ok ? "pointer" : "not-allowed",
                    }}
                  />
                );
              })}
            </div>
          </div>
        ) : (
          <div className="text-[13px]" style={{ color: "#71717a" }}>
            还没有画板：先画一块画板（F）再预览
          </div>
        )}
      </div>

      {/* 底部画板条 */}
      <div className="flex h-12 shrink-0 items-center justify-center gap-1.5 overflow-x-auto px-3">
        {frames.map((f, i) => (
          <button
            key={f.frame.id}
            type="button"
            onClick={() => goto(f.frame.id, frame?.id !== f.frame.id)}
            className="flex h-7 shrink-0 items-center gap-1 rounded-full px-2.5 text-[11px] transition-colors"
            style={{
              background: f.frame.id === frame?.id ? "rgba(255,255,255,0.95)" : "rgba(255,255,255,0.08)",
              color: f.frame.id === frame?.id ? "#18181b" : "#a1a1aa",
              fontWeight: f.frame.id === frame?.id ? 600 : 400,
            }}
          >
            {i > 0 && <ChevronLeft size={10} style={{ transform: "rotate(180deg)", opacity: 0.5 }} />}
            {f.frame.name}
          </button>
        ))}
      </div>
    </div>
  );
};
