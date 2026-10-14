/**
 * 自动布局（Auto Layout）重排引擎 —— 纯函数。
 *
 * 设计取舍（v1）：布局是**确定性重排**，把结果写进子节点的 x/y（grow 子项还会写主轴尺寸），
 * 渲染层（leafer/SVG/导出）零改动即可三端一致。不支持 wrap/HUG（模型没这些字段）。
 *
 * 语义（对齐 Figma 心智）：
 *  - 容器（frame）声明 layout：mode 横/纵、gap、padding [t,r,b,l]、主轴对齐 main、交叉轴 cross
 *  - 子节点 grow > 0 = 弹性：按权重瓜分主轴剩余空间（grow 子项的 w/h 被重写）
 *  - hidden 子节点不占位；locked/蒙版照常占位；rotation 保留（排的是包围盒原点）
 *  - main:"between" = 首尾贴边、其余等分剩余空隙（有 grow 子项时退化为 start，由 grow 填充）
 *  - cross:"stretch" = 子项交叉轴尺寸拉满内容区（写 h/w）
 */
import type { DesignNode, FrameLayout, FrameNode } from "./doc";

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
const r2 = (v: number): number => Math.round(v * 100) / 100;

export const hasLayout = (n: DesignNode): n is FrameNode =>
  n.type === "frame" && n.layout !== undefined;

/** 子画板是否沿「外层 mode 的主/交叉轴」HUG：是 → 外层 grow/stretch 必须跳过它（防 grow↔hug 振荡） */
function hugsAlong(child: DesignNode, outerModeIsH: boolean, axis: "main" | "cross"): boolean {
  if (child.type !== "frame" || !child.layout?.hug) return false;
  const hug = child.layout.hug;
  if (hug === "both") return true;
  const childMainIsX = child.layout.mode === "h";
  const axisIsX = (axis === "main") === outerModeIsH;
  // 轴方向相同 → 主轴对主轴/交叉对交叉；方向相反 → 外层主轴 = 子交叉轴
  return childMainIsX === axisIsX ? axis === "main" : axis === "cross";
}

const padOf = (lo: FrameLayout): [number, number, number, number] => {
  const p = lo.padding;
  if (!p) return [0, 0, 0, 0];
  return [clamp(p[0] ?? 0, 0, 1000), clamp(p[1] ?? 0, 0, 1000), clamp(p[2] ?? 0, 0, 1000), clamp(p[3] ?? 0, 0, 1000)];
};

/** 对单个布局容器重排一层子节点；返回是否有字段改动 */
export function applyLayoutToFrame(frame: FrameNode): boolean {
  const lo = frame.layout;
  if (!lo) return false;
  const [pt, pr, pb, pl] = padOf(lo);
  const kids = frame.children.filter((c) => c.visible !== false);
  if (kids.length === 0) return false;

  const fw0 = frame.w;
  const fh0 = frame.h;
  const before = kids.map((c) => ({ id: c.id, x: c.x, y: c.y, w: c.w, h: c.h }));
  const gap = clamp(lo.gap ?? 0, 0, 2000);
  const growOf = (c: DesignNode) => clamp(c.grow ?? 0, 0, 100);
  const wrap = lo.wrap === true;
  const hug = lo.hug;
  const hugMain = hug === "main" || hug === "both";
  const hugCross = hug === "cross" || hug === "both";

  // HUG 前置（非 wrap）：先按「子项自然尺寸」改写画板尺寸，再用最终内区做排布。
  // wrap 时主轴必须固定（忽略 hugMain），交叉轴 hug 在行/列切分支内按总高/总宽收缩。
  if (hug && !wrap) {
    if (lo.mode === "h") {
      if (hugMain) frame.w = r2(Math.max(1, kids.reduce((s, c) => s + c.w, 0) + gap * (kids.length - 1) + pl + pr));
      if (hugCross) frame.h = r2(Math.max(1, Math.max(...kids.map((c) => c.h)) + pt + pb));
    } else {
      if (hugMain) frame.h = r2(Math.max(1, kids.reduce((s, c) => s + c.h, 0) + gap * (kids.length - 1) + pt + pb));
      if (hugCross) frame.w = r2(Math.max(1, Math.max(...kids.map((c) => c.w)) + pl + pr));
    }
  }

  const innerX = pl;
  const innerY = pt;
  let innerW = Math.max(0, frame.w - pl - pr);
  let innerH = Math.max(0, frame.h - pt - pb);
  // 收尾者 = 最后一个 grow 子项（拿余数吸收浮点漂移；固定尺寸子项绝不能被重写）
  let lastGrow = -1;
  kids.forEach((c, i) => {
    if (growOf(c) > 0) lastGrow = i;
  });

  const growSum = hugMain
    ? 0
    : kids.reduce((s, c) => s + (hugsAlong(c, lo.mode === "h", "main") ? 0 : growOf(c)), 0);

  if (lo.mode === "h" && wrap) {
    // 横向 + 自动换行：按行折；行内主对齐复用 main（between 视作 start），交叉轴逐行生效
    const rows: DesignNode[][] = [];
    let row: DesignNode[] = [];
    let cursor = innerX;
    for (const c of kids) {
      if (row.length && cursor + c.w > innerX + innerW + 0.01) {
        rows.push(row);
        row = [];
        cursor = innerX;
      }
      row.push(c);
      cursor += c.w + gap;
    }
    if (row.length) rows.push(row);
    const rowHs = rows.map((r) => Math.max(...r.map((c) => c.h)));
    const totalH = rowHs.reduce((s, h) => s + h, 0) + gap * (rows.length - 1);
    if (hugCross) {
      frame.h = r2(Math.max(1, totalH + pt + pb));
      innerH = Math.max(0, frame.h - pt - pb);
    }
    let rowY = innerY;
    if (lo.main === "center") rowY = innerY + (innerH - totalH) / 2;
    else if (lo.main === "end") rowY = innerY + innerH - totalH;
    for (let r = 0; r < rows.length; r++) {
      const items = rows[r]!;
      const rh = rowHs[r]!;
      const rowW = items.reduce((s, c) => s + c.w, 0) + gap * (items.length - 1);
      let x = innerX;
      if (lo.main === "center") x = innerX + (innerW - rowW) / 2;
      else if (lo.main === "end") x = innerX + innerW - rowW;
      for (const c of items) {
        c.x = r2(x);
        if (lo.cross === "stretch" && !hugsAlong(c, true, "cross")) {
          c.h = rh;
          c.y = r2(rowY);
        } else if (lo.cross === "center") c.y = r2(rowY + (rh - c.h) / 2);
        else if (lo.cross === "end") c.y = r2(rowY + rh - c.h);
        else c.y = r2(rowY);
        x += c.w + gap;
      }
      rowY += rh + gap;
    }
  } else if (lo.mode === "h") {
    // 主轴（横向）：grow 瓜分剩余宽
    if (growSum > 0) {
      const fixedSum = kids.reduce((s, c) => s + (growOf(c) > 0 ? 0 : c.w), 0);
      const free = innerW - fixedSum - gap * (kids.length - 1);
      if (free > 0) {
        let allocated = 0;
        for (let i = 0; i < kids.length; i++) {
          const c = kids[i]!;
          const g = growOf(c);
          if (g <= 0) continue;
          c.w = i === lastGrow ? r2(free - allocated) : r2((free * g) / growSum);
          allocated += c.w;
        }
      }
    }
    const content = kids.reduce((s, c) => s + c.w, 0) + gap * (kids.length - 1);
    const between = lo.main === "between" && growSum === 0 && kids.length > 1;
    const step = between ? (innerW - (content - gap * (kids.length - 1))) / (kids.length - 1) : gap;
    let cursor = innerX;
    if (lo.main === "center") cursor = innerX + (innerW - content) / 2;
    else if (lo.main === "end") cursor = innerX + innerW - content;
    for (const c of kids) {
      c.x = r2(cursor);
      cursor += c.w + (between ? step : gap);
      // 交叉轴（纵向）
      if (lo.cross === "stretch" && !hugsAlong(c, true, "cross")) {
        c.h = innerH;
        c.y = innerY;
      } else if (lo.cross === "center") c.y = r2(innerY + (innerH - c.h) / 2);
      else if (lo.cross === "end") c.y = r2(innerY + innerH - c.h);
      else c.y = innerY;
    }
  } else if (wrap) {
    // 纵向 + 自动换行：按列折
    const cols: DesignNode[][] = [];
    let col: DesignNode[] = [];
    let cursor = innerY;
    for (const c of kids) {
      if (col.length && cursor + c.h > innerY + innerH + 0.01) {
        cols.push(col);
        col = [];
        cursor = innerY;
      }
      col.push(c);
      cursor += c.h + gap;
    }
    if (col.length) cols.push(col);
    const colWs = cols.map((cl) => Math.max(...cl.map((c) => c.w)));
    const totalW = colWs.reduce((s, w) => s + w, 0) + gap * (cols.length - 1);
    if (hugCross) {
      frame.w = r2(Math.max(1, totalW + pl + pr));
      innerW = Math.max(0, frame.w - pl - pr);
    }
    let colX = innerX;
    if (lo.main === "center") colX = innerX + (innerW - totalW) / 2;
    else if (lo.main === "end") colX = innerX + innerW - totalW;
    for (let r = 0; r < cols.length; r++) {
      const items = cols[r]!;
      const cw = colWs[r]!;
      const colH = items.reduce((s, c) => s + c.h, 0) + gap * (items.length - 1);
      let y = innerY;
      if (lo.main === "center") y = innerY + (innerH - colH) / 2;
      else if (lo.main === "end") y = innerY + innerH - colH;
      for (const c of items) {
        c.y = r2(y);
        if (lo.cross === "stretch" && !hugsAlong(c, false, "cross")) {
          c.w = cw;
          c.x = r2(colX);
        } else if (lo.cross === "center") c.x = r2(colX + (cw - c.w) / 2);
        else if (lo.cross === "end") c.x = r2(colX + cw - c.w);
        else c.x = r2(colX);
        y += c.h + gap;
      }
      colX += cw + gap;
    }
  } else {
    // 纵向：主轴 = 高
    if (growSum > 0) {
      const fixedSum = kids.reduce((s, c) => s + (growOf(c) > 0 ? 0 : c.h), 0);
      const free = innerH - fixedSum - gap * (kids.length - 1);
      if (free > 0) {
        let allocated = 0;
        for (let i = 0; i < kids.length; i++) {
          const c = kids[i]!;
          const g = growOf(c);
          if (g <= 0) continue;
          c.h = i === lastGrow ? r2(free - allocated) : r2((free * g) / growSum);
          allocated += c.h;
        }
      }
    }
    const content = kids.reduce((s, c) => s + c.h, 0) + gap * (kids.length - 1);
    const between = lo.main === "between" && growSum === 0 && kids.length > 1;
    const step = between ? (innerH - (content - gap * (kids.length - 1))) / (kids.length - 1) : gap;
    let cursor = innerY;
    if (lo.main === "center") cursor = innerY + (innerH - content) / 2;
    else if (lo.main === "end") cursor = innerY + innerH - content;
    for (const c of kids) {
      c.y = r2(cursor);
      cursor += c.h + (between ? step : gap);
      // 交叉轴（横向）
      if (lo.cross === "stretch" && !hugsAlong(c, false, "cross")) {
        c.w = innerW;
        c.x = innerX;
      } else if (lo.cross === "center") c.x = r2(innerX + (innerW - c.w) / 2);
      else if (lo.cross === "end") c.x = r2(innerX + innerW - c.w);
      else c.x = innerX;
    }
  }

  const kidsChanged = kids.some((c, i) => {
    const b = before[i]!;
    return b.x !== c.x || b.y !== c.y || b.w !== c.w || b.h !== c.h;
  });
  return kidsChanged || frame.w !== fw0 || frame.h !== fh0;
}

/**
 * 自 frame 向下递归重排：先排自身一层，再对开了 layout 的子 frame 递归
 * （父把 grow 子项尺寸定了，子的布局才有稳定的内容区）。
 */
export function applyLayoutDeep(frame: FrameNode): boolean {
  let changed = false;
  // 定点迭代：内层 HUG 改尺寸会反向影响外层排布，自顶向下重复直到收敛（上限 4 防病态）
  for (let pass = 0; pass < 4; pass++) {
    const c = layoutPass(frame);
    changed = c || changed;
    if (!c) break;
  }
  return changed;
}

/** 一遍自顶向下：自身层 + 全子树（含未开布局容器的内层布局画板） */
function layoutPass(frame: FrameNode): boolean {
  let changed = applyLayoutToFrame(frame);
  const walk = (list: DesignNode[]): void => {
    for (const c of list) {
      if (c.type === "frame" && c.layout) changed = applyLayoutToFrame(c) || changed;
      if (c.type === "frame" || c.type === "group") walk(c.children);
    }
  };
  walk(frame.children);
  return changed;
}

/** 在 nodes 树内找 id 的节点路径（含自身） */
function findPath(list: DesignNode[], id: string, acc: DesignNode[]): DesignNode[] | null {
  for (const n of list) {
    const next = [...acc, n];
    if (n.id === id) return next;
    if (n.type === "frame" || n.type === "group") {
      const hit = findPath(n.children, id, next);
      if (hit) return hit;
    }
  }
  return null;
}

/**
 * 重排 id 所在的布局链：从最外层开了 layout 的祖先到 id 自身（若为布局画板），
 * 自顶向下 deep 重排。id 不存在/无布局链 → 无操作。返回是否有任一改动。
 */
export function reflowWithin(nodes: DesignNode[], id: string): boolean {
  const path = findPath(nodes, id, []);
  if (!path) return false;
  // 最外层布局祖先（含 id 自身若是布局 frame）
  const start = path.findIndex((n) => hasLayout(n));
  if (start < 0) return false;
  let changed = false;
  for (let i = start; i < path.length; i++) {
    const n = path[i]!;
    if (n.type === "frame" && n.layout) changed = applyLayoutDeep(n) || changed;
  }
  return changed;
}
