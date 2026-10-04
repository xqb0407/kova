/**
 * leafer/editorLedger.ts — @leafer-in/editor 的节点变换 → CanvasDoc 几何补丁（纯函数，可单测）。
 *
 * 节点侧约定（见 scene.ts commonBoxProps 的恒等变换契约）：
 *   元素根 group 恒 around:"center"，故 x/y = 元素外接框中心在父空间（= doc 同轴容器坐标：
 *   deck 为页局部、board 为画布）的位置；scaleX/scaleY 由编辑器 TransformTool 直接乘写
 *   （负值 = 镜像；rotation≠0 时矩阵分解可能把镜像折进 rotation±180°，见 @leafer/math getLayout）。
 *
 * 换算推导（世界点列在提交前后不变）：doc 中心恒等于节点 x,y（角点集均值，与镜像/折叠无关），
 * 于是 x' = X − |sx|w/2、y' = Y − |sy|h/2、w' = |sx|w、h' = |sy|h、rotation' = normDeg(θ')；
 * 局部点映射 v' = o' + diag(s)·(v − o)（用于折线顶点与线端角重编码）。
 * 注意不含旋转项：doc 约定 rotation 字段承担整体旋转、局部点恒存未旋转系
 * （同 DOM 轨 rebasePoly 的「rotation 原样保留」口径）；节点矩阵 = c + R(θ)·diag(s)·(v−o)
 * 与提交后 c + R(θ')·(v'−o') 对拍，R(θ') 公因子消掉只剩 diag(s)。
 * 负 scale 分解若把镜像折进 rotation±180（rotation≠0 时 getLayout 的行为）也无需特判：
 * 折叠的 R(180)=−I 已由 tr.rotation 承载，映射式原样成立。
 *
 * doc 无 flip 概念：单轴镜像吸收进线语义——两点线 = 端点角点对向（dir 重映射），
 * 折线 = 顶点按上式逐点映射，弧 arrow curve = 翻号（镜像翻转弦法向，比例幅值不变）；
 * 非线元素按绝对尺寸吸收（与 DOM 轨 resizeBox 拖过对边的 min/abs 归一化同款观感）。
 * 解绑口径与 DOM 轨一致：仅纯移动保留 startBind/endBind（commit 后 syncBoundArrows 重锚跟随），
 * 缩放/旋转（含 180° 折叠）一律解绑。
 */
import { normalizeDeg } from "../geometry";
import { LINE_SHAPE_KINDS, type El, type LineDir, type LinePt, type ShapeEl } from "../doc";
import { isPolyline } from "../viewspec";

/** 元素根 group 在 END 时刻的最终变换（x/y = 外接框中心位置，父空间坐标） */
export type EditorNodeTransform = { x: number; y: number; scaleX: number; scaleY: number; rotation: number };

const r1 = (v: number) => Math.round(v * 10) / 10;

/** 旧 bbox 局部坐标 → 新 bbox 局部坐标（世界点不变的闭式解；around 的矩阵合成经 @leafer/math 证实） */
export function editorLocalMap(el: El, tr: EditorNodeTransform, vx: number, vy: number): { x: number; y: number } {
  return {
    x: Math.abs(el.w * tr.scaleX) / 2 + tr.scaleX * (vx - el.w / 2),
    y: Math.abs(el.h * tr.scaleY) / 2 + tr.scaleY * (vy - el.h / 2),
  };
}

/** dir → 起始角的侧向 [sideX, sideY]（1 = 轴远端）；线终点角恒为对角 */
const DIR_START_SIDE: Record<LineDir, readonly [number, number]> = { 0: [0, 0], 1: [0, 1], 2: [1, 1], 3: [1, 0] };
const SIDE_TO_DIR: Record<string, LineDir> = { "00": 0, "01": 1, "11": 2, "10": 3 };

/** 节点变换 → 完整 doc 几何补丁（不与现值比对；比对用 editorPatchIfChanged） */
export function editorTransformToElPatch(el: El, tr: EditorNodeTransform): Partial<El> {
  const wp = Math.abs(el.w * tr.scaleX);
  const hp = Math.abs(el.h * tr.scaleY);
  const patch: Record<string, unknown> = {
    x: r1(tr.x - wp / 2),
    y: r1(tr.y - hp / 2),
    w: r1(wp),
    h: r1(hp),
    rotation: normalizeDeg(tr.rotation),
  };
  if (el.kind === "shape" && LINE_SHAPE_KINDS.includes(el.shape)) {
    const s = el as ShapeEl;
    const mirrored = tr.scaleX * tr.scaleY < 0; // det(M)<0 = 单轴镜像（折叠分解后仍成立）
    if (isPolyline(s)) {
      // 折线：逐点映射；bbox = 点并集在镜像/缩放下自动保持
      patch.pts = (s.pts as LinePt[]).map(([vx, vy]) => {
        const q = editorLocalMap(s, tr, vx, vy);
        return [r1(q.x), r1(q.y)] as LinePt;
      });
    } else {
      // 两点线：角点集映射回角点集，端点角对向即 dir 重编码（world 端点位置不变）
      const [sxs, sys] = DIR_START_SIDE[(s.dir ?? 0) as LineDir];
      const a = editorLocalMap(s, tr, sxs ? s.w : 0, sys ? s.h : 0);
      const nd = SIDE_TO_DIR[`${a.x > wp / 2 ? 1 : 0}${a.y > hp / 2 ? 1 : 0}`];
      if (nd !== undefined && nd !== (s.dir ?? 0)) patch.dir = nd; // 与缺省 0 同值不写：防 editorPatchIfChanged 对 undefined 现值的幻影 diff
      if (mirrored && s.curve) patch.curve = -s.curve;
    }
    const dRot = normalizeDeg(tr.rotation - (s.rotation ?? 0));
    const pureMove = Math.abs(tr.scaleX - 1) < 1e-9 && Math.abs(tr.scaleY - 1) < 1e-9 && Math.abs(dRot) < 1e-9;
    if (!pureMove && (s.startBind || s.endBind)) {
      patch.startBind = undefined;
      patch.endBind = undefined;
    }
  }
  return patch as Partial<El>;
}

const sameVal = (a: unknown, b: unknown): boolean => {
  if (typeof a === "number" && typeof b === "number") return Math.abs(a - b) < 1e-9;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => sameVal(v, b[i]));
  return a === b;
};

/**
 * 与现值比对后（数值先 r1 归一到写入精度）真正有变化的补丁；null = 无变化。
 * 空补丁必须返回 null：否则每次松手（含原地单击）都产生一个空 undo 步。
 */
export function editorPatchIfChanged(el: El, tr: EditorNodeTransform): Partial<El> | null {
  const full = editorTransformToElPatch(el, tr) as Record<string, unknown>;
  const cur = el as unknown as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(full)) {
    const raw = k === "rotation" ? (cur.rotation ?? 0) : cur[k];
    const c = typeof raw === "number" ? r1(raw) : raw;
    if (v === undefined) {
      if (c !== undefined && c !== null) out[k] = undefined;
      continue;
    }
    if (!sameVal(c, v)) out[k] = v;
  }
  return Object.keys(out).length ? (out as Partial<El>) : null;
}
