/**
 * 文档 → 原型运行时载荷（渲染依赖层）。
 *
 * 与 prototype.ts（纯交互语义）和 prototype-runtime.ts（纯 DOM 执行）分开：
 * 这一层是唯一碰 SVG 渲染的地方，把「画板长什么样」和「热点在哪、点了做什么」
 * 装配成一份 JSON 可序列化的载荷。面板预览与 HTML 导出都从这里取载荷，
 * 因此两端不仅共享运行时实现，连输入数据都出自同一个函数。
 */
import { allFrames, type DesignDoc, type FrameNode } from "./doc";
import { buildSvg } from "./svg";
import { collectHotspots, TRIGGER_LABELS } from "./prototype";
import { RUNTIME_TRIGGER_LABELS, type RuntimePayload, type RuntimeHotspot, type RuntimeScrollAxis } from "./prototype-runtime";
import type { MeasureFn } from "./leafer/scene";

export type PayloadOptions = {
  measure: MeasureFn;
  /** 位图资产表（src → dataURL 或外链路径）；缺省 = 位图画灰占位 */
  images?: Map<string, string | null>;
  /**
   * 只收这些顶层画板（按给定顺序），缺省 = 全档按页面顺序。
   * 空数组 = 空载荷（调用方自己判空）。
   */
  frameIds?: string[];
};

/**
 * 把 collectHotspots 的产物压成 JSON 安全（无 undefined / 无 Map）的运行时结构。
 * `screenIds` = 本次实际导出的屏集合：跳转/浮层指向集合外的画板（例如只导单页时的
 * 跨页链接）在这里降级成死链——collectHotspots 是对全档解析的，单页导出必须再筛一遍，
 * 否则运行时拿到一个永远跳不过去的目标，用户点了毫无反应还没有提示。
 */
function toRuntimeHotspots(doc: DesignDoc, frame: FrameNode, screenIds: Set<string>): RuntimeHotspot[] {
  return collectHotspots(frame, doc).map((h) => {
    const actions: RuntimeHotspot["actions"] = [];
    const dead = [...h.dead];
    for (const a of h.actions) {
      const needsScreen = a.action === "navigate" || a.action === "overlay";
      if (needsScreen && (!a.target || !screenIds.has(a.target))) {
        dead.push({ trigger: a.trigger, action: a.action, to: a.target ?? "" });
        continue;
      }
      actions.push({
        trigger: a.trigger,
        action: a.action,
        target: a.target,
        targetName: a.targetName,
        transition: a.transition,
        duration: a.duration,
        position: a.position,
        dismissOnTapOutside: a.dismissOnTapOutside,
        ...(a.scrollPlan ? { scrollPlan: { x: a.scrollPlan.x, y: a.scrollPlan.y } } : {}),
      });
    }
    return { nodeId: h.nodeId, name: h.name, box: { x: h.box.x, y: h.box.y, w: h.box.w, h: h.box.h }, actions, dead };
  });
}

/** SVG 去掉硬尺寸、随容器铺满（画板尺寸由运行时容器给） */
function fluidSvg(svg: string): string {
  return svg.replace(/ width="\d+(\.\d+)?" height="\d+(\.\d+)?"/, ' width="100%" height="100%"');
}

/** 装配载荷；无可用画板时 screens 为空数组（调用方判空给提示） */
export function buildRuntimePayload(doc: DesignDoc, opts: PayloadOptions): RuntimePayload {
  const all = allFrames(doc);
  const picked = opts.frameIds ? opts.frameIds.map((id) => all.find((f) => f.frame.id === id)).filter((f): f is { pageId: string; frame: FrameNode } => !!f) : all;

  const screens: RuntimePayload["screens"] = [];
  const drawn: FrameNode[] = [];
  for (const { frame } of picked) {
    const r = buildSvg(doc, [frame.id], { measure: opts.measure, images: opts.images ?? new Map() });
    if (!r) continue; // 不可见 / 已删：不作为可交互屏
    screens.push({
      id: frame.id,
      name: frame.name,
      w: Math.max(1, Math.round(frame.w)),
      h: Math.max(1, Math.round(frame.h)),
      svg: fluidSvg(r.svg),
      ...(frame.scroll ? { scroll: frame.scroll as RuntimeScrollAxis } : {}),
    });
    drawn.push(frame);
  }

  const screenIds = new Set(screens.map((s) => s.id));
  const hotspots: Record<string, RuntimeHotspot[]> = {};
  for (const frame of drawn) {
    const hs = toRuntimeHotspots(doc, frame, screenIds);
    if (hs.length) hotspots[frame.id] = hs;
  }

  return {
    screens,
    start: screens[0]?.id ?? "",
    hotspots,
    triggerLabels: { ...TRIGGER_LABELS, ...RUNTIME_TRIGGER_LABELS },
  };
}
