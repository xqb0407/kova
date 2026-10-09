/**
 * 设计体检引擎（*.uidesign.json 的可验证判据）—— 纯函数，无 DOM、无 IO。
 *
 * 定位：面板与 MCP 共用本模块。skills 里的规范/反 slop 提示是**建议**，这里是**判据**——
 * agent 改完稿跑一次 lint_doc，拿到带 nodeId + code + suggestion 的问题清单，
 * 再配合 screenshot_doc 看图，逐条改到干净为止。
 *
 * 规则表数据驱动（LINT_RULES），加一条规则 = 加一个 detect，不改引擎骨架。
 * v1 只报不修：每条 issue 带 code 与 suggestion，由 agent 自己改，避免自动修复
 * 把稿子改成另一种错法。
 *
 * 实例节点经 instanceView 展开后一并体检，id 形如 "实例id/内部id" —— 正是
 * update_nodes 已支持的寻址口径，报告里的 nodeId 可直接拿去改。
 */
import {
  allFrames,
  hasInteraction,
  instanceView,
  isVarRef,
  nodeInteractions,
  resolveVarColor,
  varRefId,
  type DesignDoc,
  type DesignNode,
  type Effect,
  type Fill,
  type FrameNode,
  type TextRun,
} from "./doc";
import {
  ACTION_LABELS,
  TRIGGER_LABELS,
  checkInteractionTarget,
  topLevelFrameOf,
} from "./prototype";
import { hueOf, parseColor, compositeOver, effectiveContrast, toHex, type RGBA } from "./color";
import { resolveIconName } from "./icons";
import { hasLayout, applyLayoutToFrame } from "./layout";

export type LintSeverity = "error" | "warning" | "info";

const SEVERITY_ORDER: Record<LintSeverity, number> = { error: 0, warning: 1, info: 2 };

export type LintIssue = {
  code: string;
  severity: LintSeverity;
  page: string;
  nodeId: string;
  nodeName: string;
  message: string;
  detail?: Record<string, unknown>;
  suggestion: string;
};

export type LintOptions = {
  /** 只体检某一页（页 id 或名称） */
  page?: string;
  /** 只体检这些顶层节点（子树整体纳入）；省略 = 该页全部顶层节点 */
  ids?: string[];
  /** 最低级别：warning = 只看 error+warning */
  minSeverity?: LintSeverity;
  /** 规则白名单；省略 = 全部规则 */
  codes?: string[];
};

export type LintReport = {
  scanned: { frames: number; nodes: number };
  counts: Record<LintSeverity, number>;
  issues: LintIssue[];
};

/* ---------------- 遍历索引 ---------------- */

/** 展开实例后的一条节点记录：带父链、深度、所属页、同层兄弟与其所属顶层画板 */
type Entry = {
  node: DesignNode;
  parent: DesignNode | null;
  depth: number;
  pageId: string;
  pageName: string;
  siblings: DesignNode[];
  /** 所属顶层节点的 id（tap-target 这类「按画板口径判定」的规则要用） */
  rootId: string;
  /** 祖先链（紧邻父 → 根），供「向上找有效背景」这类判定用 */
  ancestors: DesignNode[];
};

const isContainer = (n: DesignNode): n is FrameNode => n.type === "frame" || n.type === "group";

function childrenOf(doc: DesignDoc, n: DesignNode): DesignNode[] {
  if (isContainer(n)) return n.children;
  if (n.type === "instance") return instanceView(doc, n) ?? [];
  return [];
}

/**
 * 展开树：实例内部节点 id 已带 "实例id/" 前缀，父子关系取自展开视图。
 * instances 记录「展开出来的节点属于哪个实例」——tap-target 之类按实例整体尺寸判的规则要用。
 */
function collectEntries(doc: DesignDoc, roots: DesignNode[], pageId: string, pageName: string): Entry[] {
  const out: Entry[] = [];
  const walk = (list: DesignNode[], parent: DesignNode | null, depth: number, rootId: string, ancestors: DesignNode[]): void => {
    for (const n of list) {
      const rid = depth === 0 ? n.id : rootId;
      out.push({ node: n, parent, depth, pageId, pageName, siblings: list, rootId: rid, ancestors });
      const kids = childrenOf(doc, n);
      if (kids.length) walk(kids, n, depth + 1, rid, [n, ...ancestors]);
    }
  };
  walk(roots, null, 0, "", []);
  return out;
}

/* ---------------- 取值助手 ---------------- */

const visible = (n: DesignNode): boolean => n.visible !== false;

/** 节点的首个不透明纯色填充（无则 null） */
function ownBackdrop(doc: DesignDoc, n: DesignNode): string | null {
  const fills = (n as { fills?: Fill[] }).fills;
  if (!fills) return null;
  for (const f of fills) {
    if (f.visible === false || f.type !== "solid" || !f.color) continue;
    const rgba = parseColor(resolveVarColor(doc, f.color));
    if (rgba && rgba.a >= 0.85) return f.color;
  }
  return null;
}

/** 节点是否有一个可见的纯色底（不管透不透明）——用于半透明叠加链 */
function ownPaint(doc: DesignDoc, n: DesignNode): RGBA | null {
  const fills = (n as { fills?: Fill[] }).fills;
  if (!fills) return null;
  for (const f of fills) {
    if (f.visible === false || f.type !== "solid" || !f.color) continue;
    const rgba = parseColor(resolveVarColor(doc, f.color));
    if (rgba && rgba.a > 0.02) return rgba;
  }
  return null;
}

/** cover 是否完整盖住 inner（同容器局部坐标，留 0.5 容差） */
const covers = (cover: DesignNode, inner: DesignNode): boolean =>
  cover.x - 0.5 <= inner.x &&
  cover.y - 0.5 <= inner.y &&
  cover.x + cover.w + 0.5 >= inner.x + inner.w &&
  cover.y + cover.h + 0.5 >= inner.y + inner.h;

/**
 * 文字真正压在什么颜色上——按**绘制顺序**解析，而不是只沿父链找。
 *
 * 绘制顺序自底向上：祖先背景先画（根→父），再按 z 序依次画子节点。所以文字
 * 脚下最上层的那层不透明色，可能来自祖先，也可能来自**绘制在它下方、且盒完整
 * 盖住它的同层兄弟**。后者是按钮的常见画法：色块和文字作为平级兄弟叠放，
 * 只查父链会一路穿到深色画板，把浅底上的深字误判成「深底深字 1.01:1」。
 *
 * 返回从最底到最顶的绘制链，交给 compositeBackdrop 叠出实际颜色。
 */
function backdropChain(doc: DesignDoc, e: Entry): RGBA[] {
  const chain: RGBA[] = [];
  // 祖先：根 → 紧邻父（自底向上）
  for (let i = e.ancestors.length - 1; i >= 0; i--) {
    const p = ownPaint(doc, e.ancestors[i]!);
    if (p) chain.push(p);
  }
  // 同层中绘制在下方、且完整盖住本节点的兄弟（z 序靠后者更靠上，故从大到小）
  const idx = e.siblings.indexOf(e.node);
  if (idx > 0) {
    for (let i = idx - 1; i >= 0; i--) {
      const s = e.siblings[i]!;
      if (!visible(s) || !covers(s, e.node)) continue;
      const p = ownPaint(doc, s);
      if (p) chain.push(p);
    }
  }
  // 自身（最上层）
  const self = ownPaint(doc, e.node);
  if (self) chain.push(self);
  return chain;
}

/** 把自底向上的绘制链叠成实际背景色（半透明压半透明），兜底纯白 */
function compositeBackdrop(doc: DesignDoc, e: Entry): { color: string; rgba: RGBA } | null {
  const chain = backdropChain(doc, e);
  if (chain.length === 0) return null;
  let acc = chain[0]!;
  for (let i = 1; i < chain.length; i++) acc = compositeOver(chain[i]!, acc);
  return { color: toHex({ ...acc, a: 1 }), rgba: acc };
}

/** 文字的有效背景色（hex），无任何底色时兜底纯白 */
function effectiveBackdrop(doc: DesignDoc, e: Entry): string {
  return compositeBackdrop(doc, e)?.color ?? "#ffffff";
}

/** 圆角统一值口径（数组取左上角） */
function radiusOf(n: DesignNode): number {
  const r = (n as { radius?: number | [number, number, number, number] }).radius;
  if (typeof r === "number") return r;
  if (Array.isArray(r)) return r[0] ?? 0;
  return 0;
}

const visibleEffects = (n: DesignNode): Effect[] =>
  ((n as { effects?: Effect[] }).effects ?? []).filter((fx) => fx.visible !== false);

const hasShadow = (n: DesignNode): boolean => visibleEffects(n).some((fx) => fx.type !== "layer-blur");

/** 文字是否「大字」：≥24px，或 ≥19px 且粗体（weight≥600，与面板渲染口径一致） */
const isLargeText = (size: number, weight: number): boolean => size >= 24 || (weight >= 600 && size >= 19);

const runSize = (r: TextRun): number => r.size ?? 14;
const runWeight = (r: TextRun): number => r.weight ?? 400;
const runColor = (r: TextRun): string => r.color ?? "#111111";

/** 判定为「可点区域」：挂了任何原型交互，或名字像按钮的 frame/rect */
const BUTTONISH = /(按钮|button|btn|chip|tag|tab)$/i;
function interactiveKind(doc: DesignDoc, e: Entry): "interaction" | "buttonish" | null {
  if (hasInteraction(e.node)) return "interaction";
  if ((e.node.type === "frame" || e.node.type === "rect") && BUTTONISH.test(e.node.name)) return "buttonish";
  return null;
}

/* ---------------- 规则 ---------------- */

type Rule = {
  code: string;
  severity: LintSeverity;
  detect: (doc: DesignDoc, entries: Entry[]) => LintIssue[];
};

const mk = (
  e: Entry,
  code: string,
  severity: LintSeverity,
  message: string,
  suggestion: string,
  detail?: Record<string, unknown>,
): LintIssue => ({
  code,
  severity,
  page: e.pageName,
  nodeId: e.node.id,
  nodeName: e.node.name,
  message,
  detail,
  suggestion,
});

/** 文字对比度：WCAG AA（普通 4.5 / 大字 3.0）。取每个 run 里最差的一条 */
const ruleTextContrast: Rule = {
  code: "text-contrast",
  severity: "error",
  detect: (doc, entries) => {
    const out: LintIssue[] = [];
    for (const e of entries) {
      if (e.node.type !== "text") continue;
      const runs = e.node.runs ?? [];
      if (runs.length === 0) continue;
      const bg = effectiveBackdrop(doc, e);
      let worst: { run: TextRun; ratio: number; fg: string } | null = null;
      for (const r of runs) {
        if (!r.text.trim()) continue;
        const got = effectiveContrast(resolveVarColor(doc, runColor(r)), resolveVarColor(doc, bg));
        if (!got) continue;
        if (!worst || got.ratio < worst.ratio) worst = { run: r, ratio: got.ratio, fg: got.fg };
      }
      if (!worst) continue;
      const need = isLargeText(runSize(worst.run), runWeight(worst.run)) ? 3 : 4.5;
      if (worst.ratio >= need) continue;
      out.push(
        mk(
          e,
          "text-contrast",
          "error",
          `文字对比度 ${worst.ratio.toFixed(2)}:1，低于 ${need}:1`,
          `把文字色改到与背景对比 ≥${need}:1（深底配浅字、浅底配深字），或调整背景明度`,
          {
            fg: worst.fg,
            bg: toHex(parseColor(resolveVarColor(doc, bg)) ?? { r: 255, g: 255, b: 255, a: 1 }),
            ratio: Math.round(worst.ratio * 100) / 100,
            required: need,
            text: worst.run.text.slice(0, 40),
          },
        ),
      );
    }
    return out;
  },
};

/** var: 引用指向不存在的变量（渲染期会变成警示粉） */
const ruleDanglingVar: Rule = {
  code: "dangling-var",
  severity: "error",
  detect: (doc, entries) => {
    const known = new Set((doc.variables ?? []).map((v) => v.id));
    const out: LintIssue[] = [];
    const scan = (e: Entry, color: unknown): void => {
      if (!isVarRef(color)) return;
      const id = varRefId(color);
      if (known.has(id)) return;
      out.push(
        mk(e, "dangling-var", "error", `变量引用 var:${id} 未定义`, `用 edit_variables set 补建该变量，或把该处颜色改成具体色值`, {
          variableId: id,
        }),
      );
    };
    for (const e of entries) {
      const rec = e.node as unknown as Record<string, unknown>;
      for (const f of (rec.fills as Fill[] | undefined) ?? []) {
        scan(e, f.color);
        for (const s of f.stops ?? []) scan(e, s.color);
      }
      for (const s of (rec.strokes as { color?: string }[] | undefined) ?? []) scan(e, s.color);
      for (const fx of (rec.effects as Effect[] | undefined) ?? []) if (fx.type !== "layer-blur") scan(e, fx.color);
      for (const r of (rec.runs as TextRun[] | undefined) ?? []) scan(e, r.color);
      scan(e, rec.color);
    }
    return out;
  },
};

/** 图标名不在 lucide 集内（渲染成占位方块） */
const ruleUnknownIcon: Rule = {
  code: "unknown-icon",
  severity: "warning",
  detect: (doc, entries) => {
    const out: LintIssue[] = [];
    for (const e of entries) {
      if (e.node.type !== "icon") continue;
      if (resolveIconName(e.node.icon)) continue;
      out.push(
        mk(e, "unknown-icon", "warning", `图标名「${e.node.icon}」不在内置 lucide 集`, `先 list_icons 搜到规范名再用 update_nodes 改 icon 字段`, {
          icon: e.node.icon,
        }),
      );
    }
    return out;
  },
};

/** 触控目标过小（只在移动端宽度画板内判：44pt 最小可点区） */
const ruleTapTarget: Rule = {
  code: "tap-target-small",
  severity: "warning",
  detect: (doc, entries) => {
    const out: LintIssue[] = [];
    // 顶层画板宽度 ≤480 视为移动端画板
    const mobileRoots = new Set(
      entries.filter((e) => e.depth === 0 && e.node.type === "frame" && e.node.w <= 480).map((e) => e.node.id),
    );
    if (mobileRoots.size === 0) return out;
    for (const e of entries) {
      const kind = interactiveKind(doc, e);
      if (!kind) continue;
      if (!mobileRoots.has(e.rootId)) continue;
      if (e.node.w >= MIN_TAP_TARGET && e.node.h >= MIN_TAP_TARGET) continue;
      out.push(
        mk(e, "tap-target-small", "warning", `可点区域 ${e.node.w}×${e.node.h}，小于 ${MIN_TAP_TARGET}×${MIN_TAP_TARGET}`, `把该节点放大到至少 ${MIN_TAP_TARGET}×${MIN_TAP_TARGET}（留出可点热区），或用空白内边距撑开`, {
          w: e.node.w,
          h: e.node.h,
          min: MIN_TAP_TARGET,
          by: kind,
        }),
      );
    }
    return out;
  },
};

/**
 * 内容被 clip 画板裁掉（子节点局部盒越出父画板）。
 *
 * 滚动区域是有意为之的超框：**滚动轴上的溢出不算问题**（那正是要滚的部分），
 * 只有非滚动轴上的溢出仍然够不着——那种才报，并在提示里说清是哪条轴。
 */
const ruleOverflow: Rule = {
  code: "overflow-clipped",
  severity: "warning",
  detect: (doc, entries) => {
    const out: LintIssue[] = [];
    for (const e of entries) {
      const p = e.parent;
      if (!p || p.type !== "frame" || p.clip === false) continue;
      if (!visible(e.node)) continue;
      const scroll = p.type === "frame" ? p.scroll : undefined;
      const reachable = (axis: "x" | "y"): boolean => (axis === "x" ? scroll === "h" || scroll === "both" : scroll === "v" || scroll === "both");
      const over: string[] = [];
      if (e.node.x < -0.5 && !reachable("x")) over.push("左");
      if (e.node.y < -0.5 && !reachable("y")) over.push("上");
      if (e.node.x + e.node.w > p.w + 0.5 && !reachable("x")) over.push("右");
      if (e.node.y + e.node.h > p.h + 0.5 && !reachable("y")) over.push("下");
      if (over.length === 0) continue;
      const scrolled = !!scroll;
      out.push(
        mk(
          e,
          "overflow-clipped",
          "warning",
          scrolled
            ? `内容超出画板${over.join("/")}侧；画板虽然开了滚动（${scroll}），但这几侧不在滚动轴上，滚不到`
            : `内容超出画板${over.join("/")}侧，且画板开启了裁切`,
          scrolled
            ? `把该节点挪回${scroll === "v" ? "左右" : "上下"}边界内，或把画板 scroll 改成 "both"（长内容用 scroll:"v"，横向溢出用 scroll:"h"）`
            : `把该节点挪回画板内、缩小尺寸；若是长页面请给画板加 scroll:"v"（原型预览里就能滚了），或给父画板设 clip:false`,
          { edges: over, frame: p.id, frameName: p.name, scroll: scroll ?? null },
        ),
      );
    }
    return out;
  },
};

/** 交互目标解析失败：预览/导出里点了没反应的那种（原型最隐蔽的坏味道） */
const ruleDanglingInteraction: Rule = {
  code: "dangling-interaction",
  severity: "error",
  detect: (doc, entries) => {
    const out: LintIssue[] = [];
    for (const e of entries) {
      const list = nodeInteractions(e.node);
      if (list.length === 0) continue;
      const frame = topLevelFrameOf(doc, e.node.id);
      list.forEach((it, i) => {
        const check = checkInteractionTarget(doc, frame, it);
        if (check.ok) return;
        const where = list.length > 1 ? `第 ${i + 1} 条交互` : "交互";
        out.push(
          mk(
            e,
            "dangling-interaction",
            "error",
            `${where}（${TRIGGER_LABELS[it.trigger]} → ${ACTION_LABELS[it.action]}）的目标不可用：${check.reason}`,
            it.action === "navigate" || it.action === "overlay"
              ? "把 to 改成某块顶层画板的 id（read_doc 看 frames）；浮层做法是把浮层也做成一块画板再 overlay 到它"
              : "scrollTo/toggleVisible 的 to 必须是同一块画板内的节点 id",
            { trigger: it.trigger, action: it.action, to: it.to ?? null, reason: check.reason },
          ),
        );
      });
    }
    return out;
  },
};

/**
 * 原型流程完整性：**只在档里确实接了交互时才跑**（否则纯视觉稿会被刷屏）。
 * 孤儿屏 = 没有任何交互跳得进去；断头屏 = 跳得出去但回不来/走不下去。
 */
const rulePrototypeFlow: Rule = {
  code: "prototype-flow",
  severity: "info",
  detect: (doc, entries) => {
    const out: LintIssue[] = [];
    const frames = allFrames(doc);
    if (frames.length < 2) return out;
    const total = entries.reduce((n, e) => n + nodeInteractions(e.node).length, 0);
    if (total === 0) return out; // 没有原型链接：不是原型稿，不评流程

    const inbound = new Map<string, number>();
    const outbound = new Map<string, number>();
    for (const f of frames) {
      inbound.set(f.frame.id, 0);
      outbound.set(f.frame.id, 0);
    }
    for (const e of entries) {
      const from = topLevelFrameOf(doc, e.node.id);
      for (const it of nodeInteractions(e.node)) {
        // 出口 = 能把演示带离本屏的动作（back 也算：按返回键就走得下去）
        if (from && (it.action === "navigate" || it.action === "overlay" || it.action === "back")) {
          outbound.set(from.id, (outbound.get(from.id) ?? 0) + 1);
        }
        if (!it.to) continue;
        if (it.action === "navigate" || it.action === "overlay") {
          if (inbound.has(it.to)) inbound.set(it.to, (inbound.get(it.to) ?? 0) + 1);
        }
      }
    }

    const entryFrameId = frames[0]!.frame.id; // 全档第一块视为主入口，不要求被指回来
    for (const { frame } of frames) {
      const e = entries.find((x) => x.node.id === frame.id && x.depth === 0);
      if (!e) continue; // 页面级游离/嵌套的情况不在此规则范围
      const orphan = frame.id !== entryFrameId && (inbound.get(frame.id) ?? 0) === 0;
      const deadEnd = (outbound.get(frame.id) ?? 0) === 0;
      if (!orphan && !deadEnd) continue;
      // 引擎按 code@nodeId 去重（一环一屏只留一条），所以两种毛病合成一条报
      const kinds = [orphan ? "unreachable" : null, deadEnd ? "dead-end" : null].filter((k): k is string => !!k);
      const what = orphan && deadEnd ? "没有任何交互跳进这块画板，它也没有任何出口" : orphan ? "没有任何交互跳进这块画板（孤儿屏）" : "这块画板没有任何出口交互（断头屏，演示走到这里就走不下去了）";
      const how = orphan
        ? `给能到它的按钮加 interactions（如 { trigger:"tap", action:"navigate", to:"${frame.id}" }）；若它只是备用稿，可忽略`
        : `按流程接上：返回箭头加 { trigger:"tap", action:"back" }，主按钮加 navigate 到下一屏`;
      out.push(mk(e, "prototype-flow", "info", what, how, { kind: kinds.length === 1 ? kinds[0] : "isolated", kinds }));
    }
    return out;
  },
};

/** 嵌套过深：每条顶层链只报第一次越界处，避免长链刷屏 */
const ruleNesting: Rule = {
  code: "nesting-depth",
  severity: "warning",
  detect: (doc, entries) => {
    const MAX = 8;
    const out: LintIssue[] = [];
    const seenChain = new Set<string>();
    for (const e of entries) {
      if (e.depth <= MAX) continue;
      const chain = `${e.pageId}:${e.node.id.slice(0, e.node.id.lastIndexOf("/") + 1)}`;
      if (seenChain.has(chain)) continue;
      seenChain.add(chain);
      out.push(
        mk(e, "nesting-depth", "warning", `图层嵌套 ${e.depth} 层，超过 ${MAX} 层`, `把中间的包裹 frame 拆平——用 auto layout（layout 字段）代替纯定位嵌套`, {
          depth: e.depth,
          max: MAX,
        }),
      );
    }
    return out;
  },
};

/** 空容器：有面积但一个可见子节点都没有 */
const ruleEmptyContainer: Rule = {
  code: "empty-container",
  severity: "info",
  detect: (doc, entries) => {
    const out: LintIssue[] = [];
    for (const e of entries) {
      if (!isContainer(e.node)) continue;
      if (e.node.w <= 0 || e.node.h <= 0) continue;
      const kids = childrenOf(doc, e.node).filter(visible);
      if (kids.length > 0) continue;
      out.push(
        mk(e, "empty-container", "info", "容器里没有可见子节点", `补上内容，或删掉这个空容器`, {
          children: childrenOf(doc, e.node).length,
        }),
      );
    }
    return out;
  },
};

/** 同层等尺寸卡片的圆角不一致 */
const ruleMixedRadius: Rule = {
  code: "mixed-sibling-radius",
  severity: "warning",
  detect: (doc, entries) => {
    const out: LintIssue[] = [];
    for (const e of entries) {
      if (!isContainer(e.node)) continue;
      const groups = new Map<string, DesignNode[]>();
      for (const c of childrenOf(doc, e.node).filter(visible)) {
        if (!isContainer(c) && c.type !== "rect") continue;
        const key = `${Math.round(c.w)}x${Math.round(c.h)}`;
        groups.set(key, [...(groups.get(key) ?? []), c]);
      }
      for (const [size, group] of groups) {
        if (group.length < 3) continue;
        const radii = new Set(group.map(radiusOf));
        if (radii.size <= 1) continue;
        out.push(
          mk(
            e,
            "mixed-sibling-radius",
            "warning",
            `${group.length} 个同尺寸（${size}）的兄弟节点圆角不一致：${[...radii].join(" / ")}`,
            `统一成同一个圆角值——同尺寸卡片看起来就是一套，混用圆角是最常见的廉价感来源`,
            { size, radii: [...radii] },
          ),
        );
      }
    }
    return out;
  },
};

/** 「看起来像卡片」：有圆角、或有阴影、或有非白底色。
 *  注意 newFrame 默认就带 #ffffff 填充，所以「有填充」本身毫无区分度，必须排除默认白底；
 *  一张白底卡片要读作卡片，靠的本来也是圆角/阴影/描边。裸行（无底无圆角无影）不算卡片——
 *  否则设置项列表/导航行会全线误报，而它们在结构上与「三卡功能区」完全同形。 */
function looksLikeCard(doc: DesignDoc, n: DesignNode): boolean {
  if (radiusOf(n) >= 4) return true;
  if (hasShadow(n)) return true;
  return ((n as { fills?: Fill[] }).fills ?? []).some((f) => {
    if (f.visible === false || f.type !== "solid" || !f.color) return false;
    const c = resolveVarColor(doc, f.color).toLowerCase();
    return c !== "#ffffff" && c !== "#fff";
  });
}

/** AI 味三卡功能区：同层连续 3 个等尺寸、等间距、且都读作「卡片」的兄弟 */
const ruleThreeCardRow: Rule = {
  code: "slop-three-card-row",
  severity: "warning",
  detect: (doc, entries) => {
    const out: LintIssue[] = [];
    const near = (a: number, b: number, eps = 1): boolean => Math.abs(a - b) <= eps;
    for (const e of entries) {
      if (!isContainer(e.node)) continue;
      const kids = childrenOf(doc, e.node).filter(visible);
      if (kids.length < 3) continue;
      const sameSize = (a: DesignNode, b: DesignNode, c: DesignNode): boolean =>
        near(a.w, b.w) && near(a.h, b.h) && near(b.w, c.w) && near(b.h, c.h);
      for (let i = 0; i + 2 < kids.length; i++) {
        const [a, b, c] = [kids[i]!, kids[i + 1]!, kids[i + 2]!];
        if (!sameSize(a, b, c)) continue;
        if (!looksLikeCard(doc, a) || !looksLikeCard(doc, b) || !looksLikeCard(doc, c)) continue;
        const g1 = b.x - (a.x + a.w);
        const g2 = c.x - (b.x + b.w);
        if (!near(g1, g2)) continue;
        out.push(
          mk(e, "slop-three-card-row", "warning", "同层出现 3 个等尺寸、等间距的卡片（典型 AI 生成功能区套路）", `打破对称：改成 2+1 布局、拉开其中一个的尺寸，或让其中一张成为主视觉（更大/带图）`, {
            gap: Math.round(g1),
            size: `${Math.round(a.w)}×${Math.round(a.h)}`,
          }),
        );
        break;
      }
    }
    return out;
  },
};

/** 满屏圆角卡片墙：同层 ≥4 个大圆角 + 阴影的卡片 */
const ruleRoundedCardWall: Rule = {
  code: "slop-rounded-card-wall",
  severity: "warning",
  detect: (doc, entries) => {
    const out: LintIssue[] = [];
    for (const e of entries) {
      if (!isContainer(e.node)) continue;
      const kids = childrenOf(doc, e.node).filter(visible);
      if (kids.length < 4) continue;
      const wall = kids.filter((c) => radiusOf(c) >= 16 && hasShadow(c));
      if (wall.length < 4 || wall.length < kids.length) continue;
      out.push(
        mk(e, "slop-rounded-card-wall", "warning", `${wall.length} 个兄弟节点全部是「大圆角 + 阴影」卡片`, `去掉一部分卡片的圆角或阴影，或用分隔线/留白代替卡片——层层卡片是廉价感的头号来源`, {
          cards: wall.length,
        }),
      );
    }
    return out;
  },
};

/** 紫色渐变 + 大模糊阴影 = 廉价光晕 */
const rulePurpleGlow: Rule = {
  code: "slop-purple-glow",
  severity: "warning",
  detect: (doc, entries) => {
    const out: LintIssue[] = [];
    const isPurple = (raw: unknown): boolean => {
      if (typeof raw !== "string") return false;
      const c: RGBA | null = parseColor(resolveVarColor(doc, raw));
      if (!c) return false;
      const h = hueOf(c);
      return h !== null && h >= 260 && h <= 320;
    };
    for (const e of entries) {
      const fills = (e.node as { fills?: Fill[] }).fills ?? [];
      const grads = fills.filter((f) => f.type === "linear" || f.type === "radial");
      if (grads.length === 0) continue;
      const purple = grads.filter((g) => (g.stops ?? []).length > 0 && (g.stops ?? []).every((s) => isPurple(s.color)));
      if (purple.length === 0) continue;
      const glow = visibleEffects(e.node).some((fx) => fx.type === "drop-shadow" && (fx.blur ?? 0) >= 24);
      if (!glow) continue;
      out.push(
        mk(e, "slop-purple-glow", "warning", "紫色渐变叠加大范围模糊阴影（廉价 AI 光晕）", `换成品牌主色或中性色系，并收紧阴影的模糊半径——大范围紫光晕是生成稿最明显的破绽`, {
          stops: (purple[0]!.stops ?? []).map((s) => s.color),
        }),
      );
    }
    return out;
  },
};

/**
 * 布局漂移：开了 auto layout 的画板里，子节点被手动挪过、位置与重排引擎算出的不一致。
 * 克隆一份子树跑 applyLayoutToFrame 比对——不动真文档。
 */
const ruleLayoutDrift: Rule = {
  code: "layout-drift",
  severity: "info",
  detect: (doc, entries) => {
    const out: LintIssue[] = [];
    for (const e of entries) {
      if (!hasLayout(e.node)) continue;
      if (e.node.children.length === 0) continue;
      const clone = structuredClone(e.node) as FrameNode;
      applyLayoutToFrame(clone);
      const drifted: string[] = [];
      for (const c of clone.children) {
        const orig = e.node.children.find((o) => o.id === c.id);
        if (!orig) continue;
        if (Math.abs(orig.x - c.x) > 1 || Math.abs(orig.y - c.y) > 1 || Math.abs(orig.w - c.w) > 1 || Math.abs(orig.h - c.h) > 1)
          drifted.push(c.id);
      }
      if (drifted.length === 0) continue;
      out.push(
        mk(e, "layout-drift", "info", `${drifted.length} 个子节点的位置与自动布局重算结果不一致（被手动挪过）`, `要么调 layout 字段（gap/padding/main/cross）来表达这个位置，要么对该画板跑 apply_layout 让排布回归确定性`, {
          drifted: drifted.slice(0, 8),
        }),
      );
    }
    return out;
  },
};

export const LINT_RULES: Rule[] = [
  ruleTextContrast,
  ruleDanglingVar,
  ruleTapTarget,
  ruleOverflow,
  ruleNesting,
  ruleMixedRadius,
  ruleThreeCardRow,
  ruleRoundedCardWall,
  rulePurpleGlow,
  ruleUnknownIcon,
  ruleEmptyContainer,
  ruleLayoutDrift,
  ruleDanglingInteraction,
  rulePrototypeFlow,
];

export const LINT_CODES: string[] = LINT_RULES.map((r) => r.code);

/** 严重级别名（agent 友好）：供 issue.suggestion 之外的机器消费 */
export const LINT_SEVERITIES: LintSeverity[] = ["error", "warning", "info"];

/** 最小触控区（移动端画板内） */
export const MIN_TAP_TARGET = 44;

/** WCAG AA 阈值：普通文字 4.5，大字 3.0 */
export const CONTRAST_MIN_NORMAL = 4.5;
export const CONTRAST_MIN_LARGE = 3;

/* ---------------- 入口 ---------------- */

export function lintDoc(doc: DesignDoc, opts: LintOptions = {}): LintReport {
  const pages = opts.page
    ? doc.pages.filter((p) => p.id === opts.page || p.name === opts.page)
    : doc.pages;
  const wanted = opts.codes?.length ? new Set(opts.codes) : null;
  const rules = LINT_RULES.filter((r) => !wanted || wanted.has(r.code));
  // minSeverity 语义是「保留到哪一级」：warning = 保留 error+warning。order 越小越严重，
  // 故上限取该级的 order；不给则 +Infinity（全留）。
  const maxOrder = opts.minSeverity ? SEVERITY_ORDER[opts.minSeverity] : Number.POSITIVE_INFINITY;

  const entries: Entry[] = [];
  let frames = 0;
  for (const page of pages) {
    const roots = opts.ids?.length
      ? page.nodes.filter((n) => opts.ids!.includes(n.id))
      : page.nodes;
    const got = collectEntries(doc, roots, page.id, page.name);
    for (const e of got) if (e.node.type === "frame") frames++;
    entries.push(...got);
  }

  const issues: LintIssue[] = [];
  for (const rule of rules) {
    for (const issue of rule.detect(doc, entries)) {
      if (SEVERITY_ORDER[issue.severity] > maxOrder) continue;
      issues.push(issue);
    }
  }

  // 同 code+nodeId 只留一条（多规则可能落到同一节点上），再按严重度→页面→节点排序
  const seen = new Set<string>();
  const deduped = issues.filter((i) => {
    const k = `${i.code}@${i.nodeId}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  deduped.sort(
    (a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || a.page.localeCompare(b.page) || a.nodeId.localeCompare(b.nodeId),
  );

  const counts: Record<LintSeverity, number> = { error: 0, warning: 0, info: 0 };
  for (const i of deduped) counts[i.severity]++;
  return { scanned: { frames, nodes: entries.length }, counts, issues: deduped };
}

/** 写操作返回里用的一行汇总（完整报告仍需显式调 lint_doc） */
export function lintSummary(doc: DesignDoc, opts: LintOptions = {}, topN = 3): { counts: Record<LintSeverity, number>; top: string[] } {
  const r = lintDoc(doc, { minSeverity: "warning", ...opts });
  return {
    counts: r.counts,
    top: r.issues.slice(0, topN).map((i) => `${i.code}@${i.nodeId}`),
  };
}