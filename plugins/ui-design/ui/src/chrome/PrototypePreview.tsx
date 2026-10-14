/**
 * PrototypePreview：全屏可交互原型预览。
 *
 * 这里**不实现交互**——交互全在 ui/src/prototype-runtime.ts，导出 HTML 内联的是同一份
 * 源码。本组件只负责：备好载荷（画板 SVG + 热点表）、把运行时挂到全屏浮层上、
 * 卸载时销毁。
 */
import { useEffect, useRef, useState, type FC } from "react";
import { allFrames, type DesignDoc } from "../doc";
import { buildRuntimePayload, type PayloadOptions } from "../prototype-payload";
import { prototypeRuntime, RUNTIME_CSS, type RuntimeApi, type RuntimePayload } from "../prototype-runtime";
import { makeMeasure } from "../leafer/measure";
import { resolveImages } from "../export";
import { collectImageSrcs } from "../svg";
import type { DesignStore } from "../state";

/** 样式只注入一次（预览可能反复开关） */
let cssInjected = false;
function ensureCss(): void {
  if (cssInjected || typeof document === "undefined") return;
  const el = document.createElement("style");
  el.setAttribute("data-ui-design", "prototype-runtime");
  el.textContent = RUNTIME_CSS;
  document.head.appendChild(el);
  cssInjected = true;
}

export const PrototypePreview: FC<{ store: DesignStore; startFrameId: string; onClose: () => void }> = ({
  store,
  startFrameId,
  onClose,
}) => {
  const [payload, setPayload] = useState<RuntimePayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const apiRef = useRef<RuntimeApi | null>(null);
  const measureRef = useRef<ReturnType<typeof makeMeasure> | null>(null);
  if (!measureRef.current) measureRef.current = makeMeasure();
  const doc = store.doc;

  // 载荷装配：全部画板的 SVG + 位图 dataURL。异步（位图要过一遍资产缓存）。
  useEffect(() => {
    let dead = false;
    void (async () => {
      try {
        const frames = allFrames(doc);
        if (frames.length === 0) {
          if (!dead) setPayload({ screens: [], start: "", hotspots: {}, triggerLabels: {} });
          return;
        }
        const images = await resolveImages(collectImageSrcs(frames.map((f) => f.frame)));
        const p = buildRuntimePayload(doc, {
          measure: measureRef.current!,
          images,
        });
        if (!dead) setPayload(p);
      } catch (err) {
        if (!dead) setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      dead = true;
    };
  }, [doc]);

  // 挂运行时（载荷换了重建一次，保证预览里的内容与当前文档一致）
  useEffect(() => {
    const host = hostRef.current;
    if (!host || !payload) return;
    ensureCss();
    apiRef.current = prototypeRuntime(host, { ...payload, start: payload.start || startFrameId }, { onExit: onClose });
    return () => {
      apiRef.current?.destroy();
      apiRef.current = null;
    };
  }, [payload, startFrameId, onClose]);

  // Esc 由运行时接管（有浮层先关浮层，否则调 onExit）；这里只兜住载荷就绪前的兜底
  useEffect(() => {
    if (payload) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [payload, onClose]);

  return (
    <div className="fixed inset-0 z-50" style={{ background: "#18181b" }}>
      <div ref={hostRef} className="h-full w-full" />
      {!payload && !error && (
        <div className="absolute inset-0 flex items-center justify-center text-[13px]" style={{ color: "#71717a" }}>
          正在准备原型…
        </div>
      )}
      {error && (
        <div className="absolute inset-0 flex items-center justify-center text-[13px]" style={{ color: "#f87171" }}>
          原型预览失败：{error}
        </div>
      )}
    </div>
  );
};

/** 供导出侧复用：载荷装配选项类型 */
export type { PayloadOptions };
