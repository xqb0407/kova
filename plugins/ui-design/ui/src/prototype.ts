/**
 * 原型交互共享逻辑：画板 → 可交互热点（触发方式 × 动作 × 转场）。
 *
 * 这里是**唯一的口径来源**：面板预览（chrome/PrototypePreview.tsx）与 HTML 导出
 * （html.ts）都消费同一份 `collectHotspots` 产物 + 同一组策略函数（缺省转场、
 * 时长、浮层锚点、滚动计划），所以「预览所见 = 导出所得」不是靠两处对齐维护，
 * 而是靠结构上只解析一次。运行时的 DOM 机械动作（CSS transition / scrollTop 赋值）
 * 才各自实现。
 *
 * 约定：hidden（visible=false）子树整支跳过；rotation 不参与热点盒换算（原型按钮
 * 绝大多数不转，v1 取舍）；嵌套 frame 深入（弹窗画板套按钮的场景）；实例展开后
 * 沿用 "实例id/内部id" 寻址。
 */
import {
  bakeInstanceNodes,
  findNode,
  nodeInteractions,
  type DesignDoc,
  type DesignNode,
  type FrameNode,
  type InstanceNode,
  type Interaction,
  type InteractionAction,
  type InteractionTrigger,
  type OverlayPosition,
  type PrototypeTransition,
} from "./doc";
import type { Box } from "./geometry";

/* ---------------- 解析产物 ---------------- */

/** 一条已解析的交互：目标已校验、缺省值已填好，运行时可直接执行 */
export type ResolvedAction = {
  trigger: InteractionTrigger;
  action: InteractionAction;
  /** navigate/overlay = 顶层画板 id；scrollTo/toggleVisible = 本屏内节点 id；back/closeOverlay = null */
  target: string | null;
  /** 目标显示名（预览里的悬浮提示用） */
  targetName: string | null;
  transition: PrototypeTransition;
  /** 毫秒；transition 为 none 时是 0 */
  duration: number;
  position: OverlayPosition;
  dismissOnTapOutside: boolean;
  /**
   * scrollTo 的预计算滚动计划（scrollLeft / scrollTop）。在这里算而不是留给运行时，
   * 是为了让运行时完全不依赖文档模型——预览与 HTML 导出因此能共用同一份运行时实现。
   */
  scrollPlan?: { x: number; y: number };
};

/** 目标缺失/类型不对的交互：数据里保留（用户可改回），渲染侧画红圈提示 */
export type DeadLink = { trigger: InteractionTrigger; action: InteractionAction; to: string };

export type Hotspot = {
  nodeId: string;
  name: string;
  /** 相对所属画板左上角的点击盒 */
  box: Box;
  /** 有效交互（按声明序；同名触发器命中第一条） */
  actions: ResolvedAction[];
  dead: DeadLink[];
};

/* ---------------- 策略：缺省转场 / 时长 / 锚点 ---------------- */

/**
 * 缺省转场：只写 trigger/action/to 也能得到像样的动画（对标墨刀的「智能缺省」）。
 * 显式写 `"transition": "none"` 关闭。
 */
export function defaultTransition(action: InteractionAction, position: OverlayPosition = "center"): PrototypeTransition {
  switch (action) {
    case "navigate":
      return "pushLeft";
    case "back":
      return "pushRight";
    case "overlay":
      return position === "bottom" ? "slideUp" : position === "top" ? "slideDown" : position === "left" ? "pushLeft" : position === "right" ? "pushRight" : "scale";
    case "closeOverlay":
      // 运行时按「打开时用的转场取反」执行；显式写 transition 则以此为准
      return "none";
    default:
      return "none";
  }
}

/** 转场时长缺省值（ms）：推入类最长，淡入最短 */
export function transitionDuration(t: PrototypeTransition): number {
  switch (t) {
    case "none":
      return 0;
    case "fade":
      return 200;
    case "scale":
      return 220;
    case "slideUp":
    case "slideDown":
      return 260;
    default:
      return 300;
  }
}

/** 反向转场：返回 / 关浮层时把入场动画放一遍相反方向 */
export function invertTransition(t: PrototypeTransition): PrototypeTransition {
  switch (t) {
    case "pushLeft":
      return "pushRight";
    case "pushRight":
      return "pushLeft";
    case "pushUp":
      return "pushDown";
    case "pushDown":
      return "pushUp";
    case "slideUp":
      return "slideDown";
    case "slideDown":
      return "slideUp";
    default:
      return t; // none / fade / scale 自逆
  }
}

/**
 * 浮层锚点：按停靠位把浮层画板贴到当前屏上（浮层画板自身的 x/y 不参与，
 * 它的 w/h 就是浮层尺寸）。预览与导出同此一处，保证位置一致。
 */
export function overlayAnchor(
  pos: OverlayPosition,
  screen: { w: number; h: number },
  layer: { w: number; h: number },
): { x: number; y: number } {
  switch (pos) {
    case "top":
      return { x: Math.round((screen.w - layer.w) / 2), y: 0 };
    case "bottom":
      return { x: Math.round((screen.w - layer.w) / 2), y: screen.h - layer.h };
    case "left":
      return { x: 0, y: Math.round((screen.h - layer.h) / 2) };
    case "right":
      return { x: screen.w - layer.w, y: Math.round((screen.h - layer.h) / 2) };
    default:
      return { x: Math.round((screen.w - layer.w) / 2), y: Math.round((screen.h - layer.h) / 2) };
  }
}

/** 浮层带遮罩（居中/上下停靠的弹窗式浮层需要；左右抽屉不要） */
export function overlayHasBackdrop(pos: OverlayPosition): boolean {
  return pos === "center" || pos === "top" || pos === "bottom";
}

/* ---------------- 目标解析 ---------------- */

/** 热点目标解析：frame id → 画板（跨页）；死链返回 null */
export function resolveTargetFrame(doc: DesignDoc, id: string): FrameNode | null {
  const loc = findNode(doc, id);
  return loc && loc.node.type === "frame" && !loc.parent ? (loc.node as FrameNode) : null;
}

/** 选中节点向上爬到的顶层画板（自身即顶层画板也算）；不在画板内返回 null */
export function topLevelFrameOf(doc: DesignDoc, nodeId: string): FrameNode | null {
  let loc = findNode(doc, nodeId);
  while (loc && loc.parent) loc = findNode(doc, loc.parent.id);
  return loc && loc.node.type === "frame" ? (loc.node as FrameNode) : null;
}

/** 起始画板：优先选中节点所在顶层画板 → 当前页第一个 → 全档第一个 */
export function firstPlayableFrame(doc: DesignDoc, selIds: string[]): FrameNode | null {
  for (const id of selIds) {
    const f = topLevelFrameOf(doc, id);
    if (f) return f;
  }
  const page = doc.pages.find((x) => x.id === doc.activePage) ?? doc.pages[0];
  const inPage = page?.nodes.find((n) => n.type === "frame");
  if (inPage) return inPage as FrameNode;
  for (const p of doc.pages) {
    const f = p.nodes.find((n) => n.type === "frame");
    if (f) return f as FrameNode;
  }
  return null;
}

/**
 * 节点在所属画板局部坐标系里的盒子（含实例展开、含嵌套容器偏移；可见性不参与，
 * 因为 toggleVisible 要能定位到隐藏节点）。找不到返回 null。
 */
export function findBoxInFrame(doc: DesignDoc, frame: FrameNode, id: string): Box | null {
  if (id === frame.id) return { x: 0, y: 0, w: frame.w, h: frame.h };
  let hit: Box | null = null;
  const walk = (list: DesignNode[], ox: number, oy: number) => {
    for (const n of list) {
      if (hit) return;
      const x = ox + n.x;
      const y = oy + n.y;
      if (n.id === id) {
        hit = { x, y, w: n.w, h: n.h };
        return;
      }
      if (n.type === "instance" && doc) {
        const baked = bakeInstanceNodes(doc, n as InstanceNode);
        if (baked) {
          walk(baked, x, y);
          continue;
        }
      }
      if ("children" in n) walk(n.children, x, y);
    }
  };
  walk(frame.children, 0, 0);
  return hit;
}

/**
 * scrollTo 的滚动计划：把目标带进视口所需的 scrollLeft / scrollTop（轴由画板的
 * scroll 决定，未开滚动的轴恒 0）。已在视口内的目标贴顶；越界的目标整块带入
 * （贴底优先，这样「滚到页脚」不会只露一半）。
 */
export function scrollPlanFor(doc: DesignDoc, frame: FrameNode, id: string): { x: number; y: number } | null {
  const box = findBoxInFrame(doc, frame, id);
  if (!box) return null;
  const axis = frame.scroll;
  const useX = axis === "h" || axis === "both";
  const useY = axis === "v" || axis === "both";
  const along = (start: number, size: number, viewport: number): number => {
    if (size >= viewport) return Math.max(0, start); // 目标比视口还高：对齐顶部
    const visible = start >= 0 && start + size <= viewport;
    return Math.max(0, visible ? start : start + size - viewport);
  };
  return {
    x: useX ? along(box.x, box.w, frame.w) : 0,
    y: useY ? along(box.y, box.h, frame.h) : 0,
  };
}

/* ---------------- 热点收集 ---------------- */

/**
 * 校验一条交互的目标是否可用。**唯一判据**：热点收集（渲染侧降级）、MCP 写入后的
 * 即时反馈、lint 体检三处都调它，避免"写入时说行、预览时说不行"。
 * `frame` = 该交互所属的顶层画板（屏内动作要它才能校验）；未知时屏内动作判失败。
 */
export function checkInteractionTarget(
  doc: DesignDoc,
  frame: FrameNode | null,
  it: Pick<Interaction, "action" | "to">,
): { ok: true } | { ok: false; reason: string } {
  if (it.action === "back" || it.action === "closeOverlay") return { ok: true };
  const to = (it.to ?? "").trim();
  if (!to) return { ok: false, reason: `动作 ${it.action} 需要 to（目标 id）` };
  if (it.action === "scrollTo" || it.action === "toggleVisible") {
    if (!frame) return { ok: false, reason: "找不到该节点所属的顶层画板，屏内动作无从校验" };
    if (!findBoxInFrame(doc, frame, to)) return { ok: false, reason: `目标节点不在当前画板内：${to}` };
    return { ok: true };
  }
  if (!resolveTargetFrame(doc, to)) return { ok: false, reason: `目标不是顶层画板或已删除：${to}（navigate/overlay 必须指向一块顶层画板）` };
  return { ok: true };
}

/** 把一条声明解析成可执行动作；目标不存在/类型不对 → 记进 dead 而不是丢弃 */
function resolveOne(doc: DesignDoc | undefined, frame: FrameNode, it: Interaction): ResolvedAction | DeadLink {
  const action = it.action;
  const position: OverlayPosition = it.position ?? "center";
  const transition = it.transition ?? defaultTransition(action, position);
  const base = {
    trigger: it.trigger,
    action,
    transition,
    duration: it.duration ?? transitionDuration(transition),
    position,
    dismissOnTapOutside: it.dismissOnTapOutside !== false,
  };
  if (action === "back" || action === "closeOverlay") {
    return { ...base, target: null, targetName: null };
  }
  const to = (it.to ?? "").trim();
  if (!doc || !checkInteractionTarget(doc, frame, it).ok) return { trigger: it.trigger, action, to };
  const screenScoped = action === "scrollTo" || action === "toggleVisible";
  const targetName = screenScoped ? findNode(doc, to)?.node.name ?? null : resolveTargetFrame(doc, to)?.name ?? null;
  return {
    ...base,
    target: to,
    targetName,
    ...(action === "scrollTo" ? { scrollPlan: scrollPlanFor(doc, frame, to) ?? undefined } : {}),
  };
}

const isDead = (x: ResolvedAction | DeadLink): x is DeadLink => !("duration" in x);

export function collectHotspots(frame: FrameNode, doc?: DesignDoc): Hotspot[] {
  const out: Hotspot[] = [];
  const walk = (list: DesignNode[], ox: number, oy: number) => {
    for (const n of list) {
      if (n.visible === false) continue;
      const x = ox + n.x;
      const y = oy + n.y;
      const declared = nodeInteractions(n);
      if (declared.length) {
        const resolved = declared.map((it) => resolveOne(doc, frame, it));
        out.push({
          nodeId: n.id,
          name: n.name,
          box: { x, y, w: n.w, h: n.h },
          actions: resolved.filter((r): r is ResolvedAction => !isDead(r)),
          dead: resolved.filter(isDead).map(({ trigger, action, to }) => ({ trigger, action, to })),
        });
      }
      // 实例：有 doc 时展开解析视图（bake 产物以实例盒左上定位，与 children 同口径；
      // id 带 "实例id/" 前缀仍可寻址）。交互常放在组件按钮上，必须能点。
      if (n.type === "instance" && doc) {
        const baked = bakeInstanceNodes(doc, n as InstanceNode);
        if (baked) {
          walk(baked, x, y);
          continue;
        }
      }
      if ("children" in n) walk(n.children, x, y);
    }
  };
  walk(frame.children, 0, 0);
  return out;
}

/** 本屏是否有任何交互（空态提示用） */
export function frameHasInteractions(frame: FrameNode, doc?: DesignDoc): boolean {
  return collectHotspots(frame, doc).length > 0;
}

/** 各触发方式的中文名（面板/报告共用） */
export const TRIGGER_LABELS: Record<InteractionTrigger, string> = {
  tap: "单击",
  doubleTap: "双击",
  longPress: "长按",
  swipeLeft: "左滑",
  swipeRight: "右滑",
  swipeUp: "上滑",
  swipeDown: "下滑",
};

export const ACTION_LABELS: Record<InteractionAction, string> = {
  navigate: "跳转画板",
  back: "返回上一屏",
  overlay: "打开浮层",
  closeOverlay: "关闭浮层",
  scrollTo: "滚动到",
  toggleVisible: "显示/隐藏",
};

export const TRANSITION_LABELS: Record<PrototypeTransition, string> = {
  none: "无",
  pushLeft: "左推入",
  pushRight: "右推入",
  pushUp: "上推入",
  pushDown: "下推入",
  fade: "淡入",
  scale: "缩放",
  slideUp: "底部滑入",
  slideDown: "顶部滑入",
};

export const POSITION_LABELS: Record<OverlayPosition, string> = {
  center: "居中",
  top: "顶部",
  bottom: "底部",
  left: "左侧",
  right: "右侧",
};
