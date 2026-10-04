/**
 * editTools.ts — leafer 轨的定制编辑器工具（P2：线端点 + 折线顶点）。
 *
 * 路由：元素根 group 的 scene spec 带 editOuter（"sc-line"/"sc-poly"），
 * Editor.updateEditTool 按它从 EditToolCreator 取工具；其余元素走默认 EditTool。
 *
 * 两工具共同协议（与 editorLedger 的「零提交」闭环一致）：
 *   按下时快照 doc 现值（此刻必无 live）；拖动中把 DragEvent 的累计世界位移经
 *   getInnerTotal 映射回 el 局部系（自动逆掉画布缩放与元素旋转；平移变化不影响
 *   向量映射，所以 live 重排 bbox 期间数值仍自洽），算出新几何后只经 host.setLive
 *   推补丁 → CanvasStage 并入 liveMap → scene 重建重绘；松手由 LeaferStage 的
 *   END 挂点调 finishGesture() 一次提交（一次手势 = 一次 commit = 一个 undo 步），
 *   通用节点变换回写（editorLedger）跳过该元素。
 *
 * 绑定语义（与 DOM 轨同口径）：
 *   线端点拖拽 = Excalidraw 落点式：END 时把新端点随 commit 的 gesture 元数据交给
 *   CanvasStage，用 hitElIn re-hit → 压中元素重锚、落空解绑；
 *   折线顶点编辑不动绑定（折线本就非可绑定线）；3 点删中点 = 塌缩回两点对角线。
 */
import { DragEvent, Direction9 } from "leafer-ui";
import { EditPoint, EditTool, type Editor } from "@leafer-in/editor";
import type { El, ShapeEl } from "../doc";
import { isPolyline, lineEnds, polyLocal, rebasePoly } from "../viewspec";
import { collapsePatch, endpointDrag, vertexDrag, type FinishedGesture, type Vec } from "./editToolsMath";

// 纯几何计算内核拆到 editToolsMath（bun test 环境加载不动 leafer-ui）；类型与函数对外签名不变
export type { Vec, FinishedGesture } from "./editToolsMath";

/* ---------------- 工具与宿主的桥 ---------------- */

/** LeaferStage 注入：doc 现值 / 拖拽 live / 直接提交。工具经 editor 弱表找宿主 */
export interface SlideEditHost {
  /** doc 现值（不含 live）：手势数学的基准（按下时快照） */
  getDocEl(elId: string): El | null;
  /** doc+live 合并（屏幕真实值）：把手摆放与选中态刷新 */
  getMergedEl(elId: string): El | null;
  /** 拖动中的 live 补丁（null = 清除该元素 live） */
  setLive(elId: string, patch: Partial<El> | null): void;
  /** END 之外的即时提交（alt 删折点） */
  commitNow(elId: string, patch: Partial<El>): void;
}

const HOSTS = new WeakMap<object, SlideEditHost>();

export function bindSlideEditHost(editor: object, host: SlideEditHost): void {
  HOSTS.set(editor, host);
}

function hostOf(tool: { editor: object | null }): SlideEditHost | null {
  return tool.editor ? HOSTS.get(tool.editor) ?? null : null;
}

/** FinishedGesture 类型见 editToolsMath（随 finishGesture 协议被 CustomGestureTool 引用） */
export interface CustomGestureTool {
  finishGesture(): FinishedGesture | null;
}
/** 当前激活的工具若是我们的定制工具（duck typing，免循环导入 instanceof） */
export function getCustomGesture(editor: Editor): CustomGestureTool | null {
  const t = (editor as unknown as { editTool?: Partial<CustomGestureTool> | null }).editTool;
  return t && typeof t.finishGesture === "function" ? (t as CustomGestureTool) : null;
}

/* ---------------- 宽松结构视图（leafer 运行时属性，不依赖深层 interface 包） ---------------- */

type ElNode = {
  /** scene patch 时打在元素根节点上的 elId 标记（见 LeaferStage.patchTree） */
  __elKey?: string;
  editOuter?: string;
  innerToWorld: (p: Vec, out: Vec | null | false, round?: boolean, target?: unknown) => Vec;
} & Record<string, unknown>;

type PointLike = { x?: number; y?: number; visible?: boolean } & Record<string, unknown>;
type PenLike = { clearPath(): PenLike; moveTo(x: number, y: number): PenLike; lineTo(x: number, y: number): PenLike };
type EditBoxLike = {
  target?: ElNode | null;
  rect: { visible?: boolean; pen: PenLike } & Record<string, unknown>;
  rectBounds: { x: number; y: number };
  resizePoints: PointLike[];
  rotatePoints: PointLike[];
  resizeLines: PointLike[];
  view: { add(n: unknown): unknown } & Record<string, unknown>;
} & Record<string, unknown>;

const nodeElId = (t: unknown): string | null => {
  const n = t as ElNode | null;
  return n && typeof n.__elKey === "string" ? n.__elKey : null;
};

/** 累计世界位移 → 元素局部（未旋转）系：核心 API 是 core DragEvent.getInnerTotal */
const innerTotal = (e: DragEvent, node: unknown): Vec =>
  (e as unknown as { getInnerTotal: (l: unknown) => Vec }).getInnerTotal(node);

/* ---------------- 线端点工具（editOuter: sc-line） ---------------- */

const { left, right } = Direction9; // resizePoints 约定：7(left)=起点把手、3(right)=终点把手（同 LineEditTool）

type ScaleWithDragEvent = { drag: DragEvent; direction: number; lockRatio?: boolean; around?: unknown };

/**
 * 两点线/箭头：隐藏默认 8 向把手，只留首末两端（复用 resizePoints[7]/[3]，官方 LineEditTool 同款手法）。
 * 端点拖拽走 onScaleWithDrag（TransformTool 对带此钩子的工具 + DragEvent 会转发原始拖拽事件），
 * 拖动中只推 live；体拖=默认 move、圈旋转=默认 rotate，均经通用 tryCommit 回写。
 */
export class SlideLineEditTool extends EditTool {
  public get tag() {
    return "sc-line";
  }

  private gesture: { elId: string; last: { patch: Partial<ShapeEl>; start: Vec; end: Vec } | null } | null = null;

  onScaleWithDrag(e: ScaleWithDragEvent): void {
    const host = hostOf(this);
    const editBox = this.editBox as unknown as EditBoxLike;
    const target = editBox.target;
    const elId = target ? nodeElId(target) : null;
    if (!host || !target || !elId) {
      this.gesture = null;
      return;
    }
    const which: "start" | "end" | null = e.direction === left ? "start" : e.direction === right ? "end" : null;
    const doc = host.getDocEl(elId);
    if (!which || !doc || doc.kind !== "shape") {
      this.gesture = null;
      return;
    }
    const total = innerTotal(e.drag, target);
    if (Math.hypot(total.x, total.y) < 2 && !this.gesture?.last) {
      this.gesture = { elId, last: null }; // 死区：纯点把手不产生提交
      return;
    }
    const last = endpointDrag(doc, which, total.x, total.y, { around: !!e.around, axisLock: !!e.lockRatio });
    this.gesture = { elId, last };
    host.setLive(elId, last.patch);
  }

  public finishGesture(): FinishedGesture | null {
    const g = this.gesture;
    this.gesture = null;
    if (!g || !g.last) return null;
    return { elId: g.elId, patch: g.last.patch, endpoints: { start: g.last.start, end: g.last.end } };
  }

  public onUpdate(): void {
    const host = hostOf(this);
    const editBox = this.editBox as unknown as EditBoxLike;
    const { rect, rotatePoints, resizeLines, resizePoints } = editBox;
    const target = editBox.target;
    const elId = target ? nodeElId(target) : null;
    const el = host && elId ? host.getMergedEl(elId) : null;
    if (!el || el.kind !== "shape" || !target) return; // 非本轨元素（多选模拟体等）：不动内置把手
    const e = lineEnds(el.w, el.h, el.dir);
    const from = { x: e.x1, y: e.y1 };
    const to = { x: e.x2, y: e.y2 };
    target.innerToWorld(from, from, false, editBox);
    target.innerToWorld(to, to, false, editBox);
    const { x, y } = editBox.rectBounds;
    rect.pen.clearPath().moveTo(from.x - x, from.y - y).lineTo(to.x - x, to.y - y);
    Object.assign(resizePoints[left], from);
    Object.assign(resizePoints[right], to);
    for (let i = 0; i < 8; i++) {
      if (i < 4) resizeLines[i].visible = false;
      const lr = i === left || i === right;
      resizePoints[i].visible = lr;
      rotatePoints[i].visible = false; // 旋转仍走 circle 把手（默认 EditTool.onRotate → ledger）
    }
  }
}

/* ---------------- 折线顶点工具（editOuter: sc-poly） ---------------- */

/**
 * 折线（pts≥3）：顶点圆点 + 段中点◇插入，逐点拖拽 + Alt 删点 + Shift 15° 吸附 + 3→2 塌缩——
 * DOM 轨 node 模式的交互语义原样移植（死区/中点物化时机一致）。
 * 把手是自己 new 的 EditPoint（内置固定 8 点不够动态点数），挂 editBox.view 上随卸载整体隐藏。
 */
export class SlidePolylineTool extends EditTool {
  public get tag() {
    return "sc-poly";
  }

  private dots: EditPoint[] = [];
  private mids: EditPoint[] = [];
  private gesture: { elId: string; base: ShapeEl; pts: Vec[]; idx: number; insert: number; last: Partial<ShapeEl> | null } | null = null;
  private suppressed = false; // alt 删点后，本次按下不再进入拖拽

  private editBoxOf(): EditBoxLike {
    return this.editBox as unknown as EditBoxLike;
  }

  private pointStyle(): Record<string, unknown> {
    const mc = ((this.editor as unknown as { mergeConfig?: Record<string, unknown> }).mergeConfig ?? {}) as Record<string, unknown>;
    const size = typeof mc.pointSize === "number" ? mc.pointSize : 10;
    return {
      around: "center",
      hitFill: "all",
      hitRadius: 5,
      cursor: "move",
      width: size,
      height: size,
      cornerRadius: typeof mc.pointRadius === "number" ? mc.pointRadius : 0,
      fill: typeof mc.pointFill === "string" ? mc.pointFill : "#ffffff",
      stroke: typeof mc.pointStroke === "string" ? mc.pointStroke : "#836DFF",
      strokeWidth: typeof mc.pointStrokeWidth === "number" ? mc.pointStrokeWidth : 2,
    };
  }

  private sync(n: number): void {
    const view = this.editBoxOf().view;
    const st = this.pointStyle();
    while (this.dots.length < n) {
      const p = new EditPoint(st as never);
      p.on(DragEvent.START, this.dotDown as unknown as (e: unknown) => void);
      p.on(DragEvent.DRAG, this.onDotDrag as unknown as (e: unknown) => void);
      this.dots.push(p);
      view.add(p);
    }
    while (this.mids.length < Math.max(0, n - 1)) {
      const p = new EditPoint({ ...st, width: (st.width as number) - 2, height: (st.height as number) - 2, rotation: 45 } as never);
      p.on(DragEvent.START, this.midDown as unknown as (e: unknown) => void);
      p.on(DragEvent.DRAG, this.onDotDrag as unknown as (e: unknown) => void);
      this.mids.push(p);
      view.add(p);
    }
  }

  private begin(which: "dot" | "mid", index: number, e: DragEvent): void {
    const host = hostOf(this);
    const target = this.editBoxOf().target;
    const elId = target ? nodeElId(target) : null;
    const el = host && elId ? host.getDocEl(elId) : null;
    this.suppressed = false;
    if (!host || !elId || !el || el.kind !== "shape" || !isPolyline(el)) return;
    const pts = polyLocal(el);
    if (which === "dot") {
      // Alt 点内部折点 = 删除：>3 点删点后 rebase；恰 3 点删中点 → 塌缩回两点对角线（DOM 轨同款边界）
      if (e.altKey && index > 0 && index < pts.length - 1) {
        this.suppressed = true;
        const keep = pts.filter((_, i) => i !== index);
        if (keep.length === 2) host.commitNow(elId, collapsePatch(el, keep).patch);
        else host.commitNow(elId, rebasePoly(el, keep) as Partial<El>);
        return;
      }
      if (index >= pts.length) return;
      this.gesture = { elId, base: el, pts: pts.map((p) => ({ x: p.x, y: p.y })), idx: index, insert: -1, last: null };
    } else {
      this.gesture = { elId, base: el, pts: pts.map((p) => ({ x: p.x, y: p.y })), idx: -1, insert: index, last: null };
    }
  }

  private dotDown = (e: DragEvent): void => {
    this.begin("dot", this.dots.indexOf(e.current as unknown as EditPoint), e);
  };

  private midDown = (e: DragEvent): void => {
    this.begin("mid", this.mids.indexOf(e.current as unknown as EditPoint), e);
  };

  private onDotDrag = (e: DragEvent): void => {
    if (this.suppressed) return;
    const g = this.gesture;
    const target = this.editBoxOf().target;
    const host = hostOf(this);
    if (!g || !target || !host) return;
    const total = innerTotal(e, target);
    if (!g.last && Math.hypot(total.x, total.y) < 2) return; // 死区：纯点击不插点、不提交
    if (g.idx < 0) {
      // 中点物化：首次超阈值拖动才在段中点长出折点（DOM 轨一致）
      const a = g.pts[g.insert];
      const b = g.pts[g.insert + 1];
      if (!a || !b) return;
      g.pts.splice(g.insert + 1, 0, { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
      g.idx = g.insert + 1;
    }
    g.last = vertexDrag(g.base, g.pts, g.idx, total.x, total.y, e.shiftKey);
    host.setLive(g.elId, g.last);
  };

  public finishGesture(): FinishedGesture | null {
    const g = this.gesture;
    this.gesture = null;
    this.suppressed = false;
    if (!g || !g.last) return null;
    return { elId: g.elId, patch: g.last, endpoints: null };
  }

  public onUpdate(): void {
    const host = hostOf(this);
    const editBox = this.editBoxOf();
    const { rect, rotatePoints, resizeLines, resizePoints } = editBox;
    const target = editBox.target;
    const elId = target ? nodeElId(target) : null;
    const el = host && elId ? host.getMergedEl(elId) : null;
    const pts = el && el.kind === "shape" && isPolyline(el) ? polyLocal(el) : null;
    for (let i = 0; i < 8; i++) {
      resizePoints[i].visible = false;
      rotatePoints[i].visible = false;
      if (i < 4) resizeLines[i].visible = false;
    }
    if (!pts || !target) return; // 已塌缩/非折线：等 updateEditTool 切工具，这里只收把手
    this.sync(pts.length);
    const { x, y } = editBox.rectBounds;
    // 内置把手约定是 editBox 局部原始坐标（update 直接 resizeP.set(bounds 点)）；pen 才是 rect 局部系
    const placed = pts.map((p) => target.innerToWorld({ x: p.x, y: p.y }, null, false, editBox) as Vec);
    placed.forEach((p, i) => {
      const dot = this.dots[i];
      if (dot) {
        dot.x = p.x;
        dot.y = p.y;
        dot.visible = true;
      }
    });
    this.dots.forEach((d, i) => {
      if (i >= pts.length) d.visible = false;
    });
    this.mids.forEach((m, i) => {
      if (i < pts.length - 1) {
        m.x = (placed[i].x + placed[i + 1].x) / 2;
        m.y = (placed[i].y + placed[i + 1].y) / 2;
        m.visible = true;
      } else m.visible = false;
    });
    // 选择框改画折线轮廓（rect 只经 pen 呈现，保留其 move 命中面）
    rect.pen.clearPath();
    placed.forEach((p, i) => (i ? rect.pen.lineTo(p.x - x, p.y - y) : rect.pen.moveTo(p.x - x, p.y - y)));
  }
}

/* ---------------- 注册（EditToolCreator 按 tag 名索引；重复注册会 debug 警告，幂等即可） ---------------- */

SlideLineEditTool.registerEditTool("sc-line");
SlidePolylineTool.registerEditTool("sc-poly");
