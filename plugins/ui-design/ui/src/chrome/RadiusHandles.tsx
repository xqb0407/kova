/**
 * 圆角手柄：选中矩形/画板/图片时，四角各一个小圆点，往里拖即改圆角（墨刀 / Figma 手感）。
 *
 * 手柄位置 = 圆角弧的圆心（角点沿对角线内移 r）。半径很小时会贴住角点被缩放手柄压住，
 * 所以有一个**屏幕像素**的最小内移量兜底——保证任何时候都抓得到。
 *
 * 语义（Figma 同款）：
 *   · 节点圆角是统一值 → 拖任一角 = 四角一起变（保持"统一"这种清白状态）
 *   · 节点圆角已是四角数组 → 只改拖的那一角
 *   · 按住 Alt 拖 → 强制拆成四角，只改当前角（顺手把统一值拆开）
 *   · 拖回 0 → 摘掉 radius 字段（不留 0 值，diff 干净）
 *
 * 已知取舍：旋转过的节点用未旋转的外接盒定位（圆角拖拽在原型稿里几乎总在正放的
 * 矩形/画板上发生，跟随旋转是后续项）。
 */
import { useState, type FC } from "react";
import { findNode } from "../doc";
import { worldBoxOf } from "../geometry";
import { hasRadiusField, handleAt, maxRadius, radiiOf, radiusFromPointer, withCornerRadius, cornerAt } from "../radius";
import { scrubSession, type DesignStore } from "../state";

/** 手柄距角点的最小屏幕内移量（px）：半径小的时候也要抓得住 */
const MIN_INSET_PX = 11;
/** 手柄圆点直径（px） */
const DOT = 11;

export const RadiusHandles: FC<{ store: DesignStore }> = ({ store }) => {
  const { doc, selIds, tool, editingTextId, view } = store;
  const [drag, setDrag] = useState<{ corner: number; r: number } | null>(null);

  if (tool !== "select" || editingTextId || selIds.length !== 1) return null;
  const n = findNode(doc, selIds[0]!)?.node;
  if (!n || !hasRadiusField(n) || n.locked) return null;
  const wb = worldBoxOf(doc, selIds[0]!);
  if (!wb) return null;

  const radii = radiiOf(n);
  const maxR = maxRadius(wb);
  const minInset = MIN_INSET_PX / view.s;
  const toScreen = (wx: number, wy: number) => ({ left: wx * view.s + view.tx, top: wy * view.s + view.ty });

  const startDrag = (i: number, ev: React.PointerEvent) => {
    ev.preventDefault();
    ev.stopPropagation();
    const host = (ev.currentTarget as HTMLElement).parentElement!;
    (ev.currentTarget as HTMLElement).setPointerCapture(ev.pointerId);
    scrubSession.active = true; // 一次拖拽 = 一步撤销

    const apply = (clientX: number, clientY: number, altKey: boolean) => {
      const hostRect = host.getBoundingClientRect();
      const p = { x: (clientX - hostRect.left - view.tx) / view.s, y: (clientY - hostRect.top - view.ty) / view.s };
      const r = radiusFromPointer(cornerAt(wb, i), p, maxR);
      setDrag({ corner: i, r });
      // Alt = 拆角：只改当前这一角（本来已是四角数组时同样只改一角）
      store.updateNode(selIds[0]!, (m) => withCornerRadius(m, i, r, { split: altKey }), { coalesce: true });
    };

    const onMove = (e: PointerEvent) => apply(e.clientX, e.clientY, e.altKey);
    const onUp = () => {
      scrubSession.active = false;
      setDrag(null);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    apply(ev.clientX, ev.clientY, ev.altKey);
  };

  return (
    <div className="pointer-events-none absolute inset-0 z-20">
      {[0, 1, 2, 3].map((i) => {
        const hp = handleAt(wb, i, radii[i]!, minInset);
        const pos = toScreen(hp.x, hp.y);
        const live = drag?.corner === i;
        return (
          <div
            key={i}
            role="button"
            tabIndex={-1}
            data-corner={i}
            title={`拖我改圆角（当前 ${Math.round(radii[i]!)}）· 按住 Alt 只改这一角`}
            onPointerDown={(e) => startDrag(i, e)}
            className="pointer-events-auto absolute rounded-full border-2"
            style={{
              left: pos.left - DOT / 2,
              top: pos.top - DOT / 2,
              width: DOT,
              height: DOT,
              borderColor: live ? "#0d99ff" : "#0b7fd4",
              background: live ? "#0d99ff" : "#ffffff",
              boxShadow: "0 1px 3px rgba(0,0,0,0.28)",
              cursor: "grab",
            }}
          />
        );
      })}
      {drag && (
        <div
          className="pointer-events-none absolute rounded px-1.5 py-0.5 font-mono"
          style={{
            left: toScreen(wb.x + wb.w / 2, wb.y).left,
            top: toScreen(wb.x + wb.w / 2, wb.y).top - 26,
            transform: "translateX(-50%)",
            background: "rgba(24,24,27,.92)",
            color: "#e4e4e7",
            fontSize: 11,
            lineHeight: "16px",
          }}
        >
          {Math.round(drag.r)}
        </div>
      )}
    </div>
  );
};
