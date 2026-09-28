/**
 * leafer/ledger.ts — @leafer-in/editor 的根组变换（END 时刻）→ DesignDoc 几何补丁（纯函数，可单测）。
 *
 * 场景约定（见 scene.ts）：每个节点的根 Group 恒 `around:"center"` + 显式 width/height。
 * leafer 的 around 只改变锚点落位（x/y = 盒中心在父内层空间的坐标；内层原点仍是
 * 父盒左上角——slide-canvas 元素 rect 子节点 x:0 能贴左上角渲染即为证），于是恒等式：
 *   tr.x = doc.x + w/2（doc 为提交前节点几何；frame/group 子节点的 doc.x 本就相对父盒左上角）
 * 编辑器缩放走 scaleX/scaleY（负值 = 镜像，rotation≠0 时 getLayout 可能把镜像折进
 * rotation±180°，折叠的 R(180)=−I 由 tr.rotation 承载，公式仍成立），docs 层吸收为
 * 绝对尺寸：w' = |sx|·w0，锚点（=中心）不动反推左上角：
 *   doc.x' = tr.x − |sx|·w0/2
 *
 * 各类型语义（Figma 口径）：
 *   frame —— 只改盒子，子节点保持相对左上角的局部坐标（重新渲染后自动贴新框）；
 *   group —— 缩放按「缩放内容」传播：整棵子树逐层做绕组中心的端点映射（镜像时
 *            区间取 [min, |Δ|] 自动翻转，递归天然成立）；
 *   line/arrow —— 起点角经 editorLocalMap 映射后落在新盒哪角，dir 重编码（世界端点不变）；
 *   text —— 盒子各向缩放，字号按 |sx| 同步缩放（Figma 语义），runs 复制替换。
 *
 * 空补丁必须返回 null：否则每次松手（含原地单击）都产生一个空 undo 步。
 */
import type { DesignNode, LineDir, TextNode } from "../doc";

/** 节点根 group 在 END 时刻的最终变换（inner 空间坐标，见模块头恒等式） */
export type EditorNodeTransform = {
  x: number;
  y: number;
  scaleX: number;
  scaleY: number;
  rotation: number;
};

/** 一条落账结果：doc 节点 id + 补丁字段（含 group/frame 的 children 替换） */
export type LedgerPatch = { id: string; patch: Record<string, unknown> };

const r1 = (v: number) => Math.round(v * 10) / 10;

/** 角度归一到 [0,360) */
export function normDeg(a: number): number {
  let t = a % 360;
  if (t < 0) t += 360;
  // 359.9997 这类浮点尾巴归 0，防幻影 diff
  return t > 359.999 ? 0 : Math.round(t * 1000) / 1000;
}

/** 旧盒局部点 → 新盒局部点（绕中心缩放，含镜像；世界点不变的闭式解，移植自 slide-canvas editorLedger） */
export function editorLocalMap(
  w0: number,
  h0: number,
  tr: EditorNodeTransform,
  vx: number,
  vy: number,
): { x: number; y: number } {
  return {
    x: Math.abs(w0 * tr.scaleX) / 2 + tr.scaleX * (vx - w0 / 2),
    y: Math.abs(h0 * tr.scaleY) / 2 + tr.scaleY * (vy - h0 / 2),
  };
}

/** dir → 起始角的侧向 [sideX, sideY]（1 = 轴远端）；终点角恒为对角 */
const DIR_START_SIDE: Record<LineDir, readonly [number, number]> = {
  0: [0, 0],
  1: [0, 1],
  2: [1, 1],
  3: [1, 0],
};
const SIDE_TO_DIR: Record<string, LineDir> = { "00": 0, "01": 1, "11": 2, "10": 3 };

/* ---------------- 子树缩放传播（group） ---------------- */

/** 一维区间 [p0, p1] 绕中心 c 按 s 缩放（含镜像）→ [左, 宽] */
function scale1(p0: number, p1: number, s: number, c: number): [number, number] {
  const a = c + s * (p0 - c);
  const b = c + s * (p1 - c);
  return a <= b ? [a, b - a] : [b, a - b];
}

/** 镜像奇偶翻向：0=↘ 1=↗ 2=↖ 3=↙（flipX 左右换 0↔3/1↔2，flipY 上下换 0↔1/2↔3） */
const remapDir = (dir: LineDir, flipX: boolean, flipY: boolean): LineDir => {
  let d = dir;
  if (flipX) d = ([3, 2, 1, 0] as LineDir[])[d];
  if (flipY) d = ([1, 0, 3, 2] as LineDir[])[d];
  return d;
};

/** 把 (sx,sy) 缩放按 Figma「缩放内容」语义传播进整棵子树，返回新 children 数组 */
export function scaleChildren(
  children: DesignNode[],
  sx: number,
  sy: number,
  parentW: number,
  parentH: number,
): DesignNode[] {
  return children.map((ch) => {
    const [x, w] = scale1(ch.x, ch.x + ch.w, sx, parentW / 2);
    const [y, h] = scale1(ch.y, ch.y + ch.h, sy, parentH / 2);
    const next = { ...ch, x: r1(x), y: r1(y), w: r1(Math.max(1, w)), h: r1(Math.max(1, h)) } as DesignNode;
    const flipX = sx < 0;
    const flipY = sy < 0;
    if (next.type === "line" || next.type === "arrow") {
      if (next.dir !== undefined) next.dir = remapDir(next.dir, flipX, flipY);
    } else if (next.type === "text") {
      const t = next as TextNode;
      const s = Math.abs(sx);
      t.runs = t.runs.map((run) => ({ ...run, size: r1(Math.max(1, (run.size ?? 14) * s)) }));
    } else if (next.type !== "frame" && "children" in next) {
      // group：子坐标相对本节点左上角，旧局部尺寸下继续绕自身中心递归缩放
      next.children = scaleChildren(next.children, sx, sy, ch.w, ch.h);
    }
    // frame：只随父缩放盒子（内容重渲染时贴新框，不传播）
    return next;
  });
}

/* ---------------- 比对工具（移植 editorPatchIfChanged） ---------------- */

const sameVal = (a: unknown, b: unknown): boolean => {
  if (typeof a === "number" && typeof b === "number") return Math.abs(a - b) < 1e-9;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => sameVal(v, b[i]));
  return a === b;
};

/** 与现值比对（数值先 r1 归一到写入精度）后真正有变化的字段；无变化返回 {} */
export function diffPatch(cur: Record<string, unknown>, full: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(full)) {
    const raw = cur[k];
    const c = typeof raw === "number" ? r1(raw) : raw;
    if (v === undefined) {
      if (c !== undefined && c !== null) out[k] = undefined;
      continue;
    }
    if (!sameVal(c, v)) out[k] = v;
  }
  return out;
}

/* ---------------- 主入口 ---------------- */

/**
 * 单节点编辑落账：node = 提交前 doc 节点；tr = 编辑器根组 END 变换（x/y = 锚点中心，
 * 父内层空间坐标）。纯移动时不碰子树/字号。
 */
export function ledgerFor(node: DesignNode, tr: EditorNodeTransform): LedgerPatch | null {
  const wp = Math.abs(node.w * tr.scaleX);
  const hp = Math.abs(node.h * tr.scaleY);
  const pureTransform =
    Math.abs(tr.scaleX - 1) < 1e-9 && Math.abs(tr.scaleY - 1) < 1e-9 && Math.abs(normDeg(tr.rotation - (node.rotation || 0))) < 1e-9;

  const rot = normDeg(tr.rotation);
  const full: Record<string, unknown> = {
    x: r1(tr.x - wp / 2),
    y: r1(tr.y - hp / 2),
    w: r1(Math.max(1, wp)),
    h: r1(Math.max(1, hp)),
    // 缺省值不写（rotation:0 省略是序列化幂等约定）：现值为 0/缺省时置 undefined 走删除分支
    rotation: rot === 0 ? undefined : rot,
  };

  if (pureTransform) {
    // 移动/旋转：line 的 dir、text 字号、子树都不动
  } else if (node.type === "line" || node.type === "arrow") {
    const dir = (node.dir ?? 0) as LineDir;
    const [sxs, sys] = DIR_START_SIDE[dir];
    const a = editorLocalMap(node.w, node.h, tr, sxs ? node.w : 0, sys ? node.h : 0);
    const nd = SIDE_TO_DIR[`${a.x > wp / 2 ? 1 : 0}${a.y > hp / 2 ? 1 : 0}`];
    if (nd !== undefined && nd !== dir) full.dir = nd === 0 ? undefined : nd;
  } else if (node.type === "group") {
    full.children = scaleChildren(node.children, tr.scaleX, tr.scaleY, node.w, node.h);
  } else if (node.type === "text") {
    const s = Math.abs(tr.scaleX);
    full.runs = node.runs.map((run) => ({ ...run, size: r1(Math.max(1, (run.size ?? 14) * s)) }));
  }
  // frame / 形状 / image：仅盒子补丁（上面已含）

  const patch = diffPatch(node as unknown as Record<string, unknown>, full);
  return Object.keys(patch).length ? { id: node.id, patch } : null;
}

/**
 * 批量落账签名（DragEvent/MoveEvent END 去重：同一次松手可能多事件）。
 * 与 slide-canvas 同款：对补丁数组序列化比对。
 */
export function ledgerSignature(results: (LedgerPatch | null)[]): string {
  return JSON.stringify(results.filter(Boolean));
}
