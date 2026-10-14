/**
 * 原型运行时（可交互预览的执行核）。
 *
 * **为什么是一个自包含函数**：面板预览与 HTML 导出必须行为一致，两套实现必然漂移。
 * `prototypeRuntime` 不引用任何模块级符号，因此导出侧可以直接
 * `prototypeRuntime.toString()` 把**同一份源码**内联进静态 HTML —— 预览与成品
 * 跑的是同一段代码，而不是"两份保持同步的代码"。
 *
 * 职责边界：运行时只认载荷（屏 + 热点表 + 已解析的动作），不读文档模型。
 * 目标校验、缺省转场、时长、浮层锚点、滚动计划都在 ui/src/prototype.ts 里算好传入。
 * 载荷必须 JSON 可序列化（导出侧要写进 HTML）。
 *
 * 层级结构（关键）：`wrap` 是动画平面（尺寸 = 画板尺寸，转场用百分比平移），
 * `fit` 是被缩放的内容盒，**热点层在 fit 内部**——否则热点坐标不会跟着缩放走。
 */

export type RuntimeScrollAxis = "v" | "h" | "both";

export type RuntimeScreen = {
  id: string;
  name: string;
  w: number;
  h: number;
  /** 画板内容的 SVG 字符串（外层尺寸由运行时容器决定） */
  svg: string;
  scroll?: RuntimeScrollAxis;
};

export type RuntimeAction = {
  trigger: string;
  action: string;
  target: string | null;
  targetName: string | null;
  transition: string;
  duration: number;
  position: string;
  dismissOnTapOutside: boolean;
  scrollPlan?: { x: number; y: number } | undefined;
};

export type RuntimeDead = { trigger: string; action: string; to: string };

export type RuntimeHotspot = {
  nodeId: string;
  name: string;
  box: { x: number; y: number; w: number; h: number };
  actions: RuntimeAction[];
  dead: RuntimeDead[];
};

export type RuntimePayload = {
  screens: RuntimeScreen[];
  /** 起始屏 id */
  start: string;
  /** 屏 id → 该屏热点（缺省 = 无交互） */
  hotspots: Record<string, RuntimeHotspot[]>;
  /** 触发方式短名（热点角标用）：{ longPress: "长按", … } */
  triggerLabels?: Record<string, string>;
};

export type RuntimeHooks = {
  /** 点「退出」/ Esc 且无浮层可关时调用（导出侧不给则隐藏该按钮） */
  onExit?: () => void;
  /** 屏幕切换回调（宿主同步标题用） */
  onScreen?: (id: string, index: number) => void;
};

export type RuntimeApi = {
  go: (id: string, transition?: string, duration?: number) => void;
  back: () => void;
  current: () => string;
  destroy: () => void;
};

/* ------------------------------------------------------------------ */
/* 运行时样式：预览与导出共用同一份                                     */
/* ------------------------------------------------------------------ */

export const RUNTIME_CSS = `
.uir{position:relative;display:flex;flex-direction:column;width:100%;height:100%;overflow:hidden;
  background:#18181b;color:#e4e4e7;font:400 12px/1.4 ui-sans-serif,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;
  -webkit-font-smoothing:antialiased}
.uir,.uir *{box-sizing:border-box}
.uir-top{display:flex;flex:none;align-items:center;gap:6px;height:44px;padding:0 12px}
.uir-btn{all:unset;cursor:pointer;display:flex;align-items:center;justify-content:center;width:28px;height:28px;
  border-radius:999px;color:#e4e4e7;font-size:15px;line-height:1}
.uir-btn:hover{background:rgba(255,255,255,.1)}
.uir-btn[disabled]{opacity:.3;cursor:default}
.uir-btn[disabled]:hover{background:none}
.uir-title{display:flex;min-width:0;align-items:center;gap:6px;font-size:12px}
.uir-title b{font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:34vw}
.uir-dot{width:6px;height:6px;border-radius:999px;background:#0d99ff;flex:none}
.uir-page{color:#71717a}
.uir-pill{padding:1px 7px;border-radius:999px;background:rgba(255,255,255,.08);color:#a1a1aa;font-size:10px;white-space:nowrap}
.uir-spacer{flex:1}
.uir-stage{position:relative;flex:1;min-height:0;overflow:hidden;display:flex;align-items:center;justify-content:center;
  touch-action:none;user-select:none;-webkit-user-select:none}
.uir-plane{position:relative;flex:none}
.uir-fit{position:relative;width:100%;height:100%;transform-origin:top left;background:#fff;overflow:hidden}
.uir-wrap{position:absolute;left:0;top:0;will-change:transform,opacity}
.uir-wrap>.uir-fit{box-shadow:0 12px 48px rgba(0,0,0,.5)}
.uir-backdrop{position:absolute;left:0;top:0;width:100%;height:100%;background:rgba(0,0,0,.42);opacity:0;
  transition:opacity .2s ease}
.uir-backdrop.on{opacity:1}
.uir-hot-layer{position:absolute;left:0;top:0;right:0;bottom:0;pointer-events:none}
/* pointer-events:自动 —— 热点层的容器是 none（否则会盖住整屏挡住滚动拖拽），
   必须由每个热点自己把事件收回来，漏了这行整个原型就点不动了 */
.uir-hot{position:absolute;padding:0;border:0;cursor:pointer;pointer-events:auto;border-radius:3px;
  background:rgba(13,153,255,.06);
  box-shadow:inset 0 0 0 1.5px rgba(13,153,255,.9),0 0 0 4px rgba(13,153,255,.14);transition:background .12s ease}
.uir-hot:hover{background:rgba(13,153,255,.2)}
.uir-hot.dead{background:rgba(244,63,94,.08);box-shadow:inset 0 0 0 1.5px rgba(244,63,94,.85);cursor:not-allowed}
.uir-tag{position:absolute;left:0;top:-15px;padding:0 5px;border-radius:999px;background:rgba(13,153,255,.95);
  color:#fff;font-size:9px;line-height:15px;white-space:nowrap;pointer-events:none;font-weight:500}
.uir-hot.dead .uir-tag{background:rgba(244,63,94,.95)}
.uir-bottom{display:flex;flex:none;align-items:center;justify-content:center;gap:6px;height:48px;padding:0 12px;overflow-x:auto}
.uir-chip{all:unset;cursor:pointer;flex:none;height:28px;display:flex;align-items:center;padding:0 10px;border-radius:999px;
  background:rgba(255,255,255,.08);color:#a1a1aa;font-size:11px;white-space:nowrap}
.uir-chip:hover{background:rgba(255,255,255,.16)}
.uir-chip.on{background:rgba(255,255,255,.95);color:#18181b;font-weight:600}
.uir-empty{color:#71717a;font-size:13px}
`;

/* ------------------------------------------------------------------ */
/* 运行时本体                                                          */
/* ------------------------------------------------------------------ */

/**
 * 运行时本体。**函数体必须完全自包含**——不能引用本模块任何顶层标识符，
 * 因为导出侧是 `prototypeRuntime.toString()` 内联进 HTML 的：凡是引用外部名字的地方，
 * 在面板里（模块作用域在）跑得好好的，一导出就 ReferenceError。
 * 所以文案表/阈值这些常量都声明在函数**内部**，test/prototype-runtime.test.ts 有静态断言守着。
 */
export function prototypeRuntime(root: HTMLElement, payload: RuntimePayload, hooks?: RuntimeHooks): RuntimeApi {
  /** 动作中文名（与 prototype.ts 的 ACTION_LABELS 同文案；自包含要求故在函数内定义） */
  const RT_ACTION_TEXT: Record<string, string> = {
    navigate: "跳转画板",
    back: "返回上一屏",
    overlay: "打开浮层",
    closeOverlay: "关闭浮层",
    scrollTo: "滚动到",
    toggleVisible: "显示/隐藏",
  };
  /** 手势角标字形 */
  const RT_TRIGGER_GLYPH: Record<string, string> = {
    doubleTap: "\u00d72",
    longPress: "\u23f1",
    swipeLeft: "\u2190",
    swipeRight: "\u2192",
    swipeUp: "\u2191",
    swipeDown: "\u2193",
  };
  /** 判定「拖动」而非「点击」的位移阈值（px） */
  const RT_DRAG_SLOP = 8;
  /** 判定「滑动」的位移阈值（px） */
  const RT_SWIPE_SLOP = 40;
  /** 长按判定时长（ms） */
  const RT_HOLD_MS = 500;

  const screens: RuntimeScreen[] = payload.screens || [];
  const hotspots = payload.hotspots || {};
  const triggerLabels = payload.triggerLabels || {};
  const hooks0 = hooks || {};
  const byId: Record<string, RuntimeScreen> = {};
  for (let i = 0; i < screens.length; i++) byId[screens[i]!.id] = screens[i]!;

  const cleanupFns: (() => void)[] = [];
  const cache: Record<string, HTMLElement> = {};
  const history: { id: string; transition: string }[] = [];
  const overlays: {
    id: string;
    position: string;
    transition: string;
    el: HTMLElement;
    backdrop: HTMLElement | null;
  }[] = [];
  const toggled: Record<string, boolean> = {};
  const scrollState: Record<string, { x: number; y: number }> = {};
  const extentCache: Record<string, { x: number; y: number }> = {};
  let currentId = "";
  let fit = 1;
  let suppressClick = false;

  root.className = "uir";
  root.innerHTML =
    '<div class="uir-top">' +
    '<button class="uir-btn uir-back" type="button" title="返回上一层（\u2190）">\u2190</button>' +
    '<div class="uir-title"><span class="uir-dot"></span><b class="uir-name"></b><span class="uir-page"></span>' +
    '<span class="uir-pill">点击高亮区可交互</span></div>' +
    '<div class="uir-spacer"></div>' +
    '<button class="uir-btn uir-exit" type="button" title="退出预览（Esc）">\u00d7</button>' +
    "</div>" +
    '<div class="uir-stage"><div class="uir-plane"></div></div>' +
    '<div class="uir-bottom"></div>';

  const stage = root.querySelector(".uir-stage") as HTMLElement;
  const plane = root.querySelector(".uir-plane") as HTMLElement;
  const bottom = root.querySelector(".uir-bottom") as HTMLElement;
  const elName = root.querySelector(".uir-name") as HTMLElement;
  const elPage = root.querySelector(".uir-page") as HTMLElement;
  const btnBack = root.querySelector(".uir-back") as HTMLButtonElement;
  const btnExit = root.querySelector(".uir-exit") as HTMLButtonElement;
  btnExit.style.display = hooks0.onExit ? "" : "none";

  const mk = (tag: string, cls: string): HTMLElement => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    return e;
  };

  /* ---------------- 屏 / 浮层 DOM ---------------- */

  /** 按 id 找屏内节点元素（data-id 由 svg.ts 写；逐个比对，避免选择器转义问题） */
  function nodeEl(scope: HTMLElement, id: string): Element | null {
    const all = scope.querySelectorAll("[data-id]");
    for (let i = 0; i < all.length; i++) if (all[i]!.getAttribute("data-id") === id) return all[i]!;
    return null;
  }

  function applyToggles(scope: HTMLElement, screenId: string): void {
    const all = scope.querySelectorAll("[data-id]");
    for (let i = 0; i < all.length; i++) {
      const nid = all[i]!.getAttribute("data-id") || "";
      const key = screenId + "/" + nid;
      if (Object.prototype.hasOwnProperty.call(toggled, key)) {
        (all[i] as HTMLElement).style.display = toggled[key] ? "" : "none";
      }
    }
  }

  /** 建一块屏（含热点层）；同一「角色:屏 id」复用缓存元素 */
  function buildScreen(sc: RuntimeScreen, role: string): HTMLElement {
    const key = role + ":" + sc.id;
    const cached = cache[key];
    if (cached) {
      applyToggles(cached, sc.id);
      return cached;
    }
    const wrap = mk("div", "uir-wrap " + (role === "ov" ? "uir-ov" : "uir-base"));
    wrap.setAttribute("data-screen", sc.id);
    wrap.style.width = sc.w + "px";
    wrap.style.height = sc.h + "px";

    const fitBox = mk("div", "uir-fit");
    fitBox.innerHTML = sc.svg;

    // 热点层放在 fitBox 内：与 SVG 同一坐标系，缩放自动跟随
    const layer = mk("div", "uir-hot-layer");
    const list = hotspots[sc.id] || [];
    for (let i = 0; i < list.length; i++) {
      const h = list[i]!;
      const acts = h.actions || [];
      const live = acts.length > 0;
      const btn = mk("button", "uir-hot" + (live ? "" : " dead")) as HTMLButtonElement;
      btn.type = "button";
      btn.setAttribute("data-hot", h.nodeId);
      btn.style.left = h.box.x + "px";
      btn.style.top = h.box.y + "px";
      btn.style.width = Math.max(h.box.w, 8) + "px";
      btn.style.height = Math.max(h.box.h, 8) + "px";
      if (!live) {
        btn.title = (h.name || h.nodeId) + "：交互目标已删除";
        btn.appendChild(tagEl("失效"));
      } else {
        const parts: string[] = [];
        let gestureTag = "";
        for (let k = 0; k < acts.length; k++) {
          const a = acts[k]!;
          const tl = triggerLabels[a.trigger] || a.trigger;
          let text = tl + " \u2192 " + (RT_ACTION_TEXT[a.action] || a.action);
          if (a.targetName) text += "「" + a.targetName + "」";
          parts.push(text);
          if (!gestureTag && a.trigger !== "tap") {
            gestureTag = tl + (RT_TRIGGER_GLYPH[a.trigger] ? " " + RT_TRIGGER_GLYPH[a.trigger] : "");
          }
        }
        btn.title = (h.name || h.nodeId) + "：" + parts.join(" / ");
        if (gestureTag) btn.appendChild(tagEl(gestureTag));
      }
      attach(btn, h, sc.id);
      layer.appendChild(btn);
    }
    fitBox.appendChild(layer);
    wrap.appendChild(fitBox);
    cache[key] = wrap;
    applyToggles(wrap, sc.id);
    return wrap;
  }

  function tagEl(text: string): HTMLElement {
    const t = mk("span", "uir-tag");
    t.textContent = text;
    return t;
  }

  /* ---------------- 手势 ---------------- */

  function attach(btn: HTMLElement, h: RuntimeHotspot, screenId: string): void {
    const acts = h.actions || [];
    const find = (t: string): RuntimeAction | undefined => {
      for (let i = 0; i < acts.length; i++) if (acts[i]!.trigger === t) return acts[i]!;
      return undefined;
    };
    const tap = find("tap");
    const dbl = find("doubleTap");
    const hold = find("longPress");
    const swipes = [find("swipeLeft"), find("swipeRight"), find("swipeUp"), find("swipeDown")];
    if (!tap && !dbl && !hold && !swipes[0] && !swipes[1] && !swipes[2] && !swipes[3]) return;

    let downAt = 0;
    let downX = 0;
    let downY = 0;
    let holdTimer: ReturnType<typeof setTimeout> | null = null;
    let holdFired = false;
    let tapTimer: ReturnType<typeof setTimeout> | null = null;

    const clearHold = () => {
      if (holdTimer !== null) clearTimeout(holdTimer);
      holdTimer = null;
    };

    btn.addEventListener("pointerdown", (e) => {
      downAt = Date.now();
      downX = e.clientX;
      downY = e.clientY;
      holdFired = false;
      if (hold) {
        holdTimer = setTimeout(() => {
          holdFired = true;
          run(hold, screenId);
        }, RT_HOLD_MS);
      }
    });
    btn.addEventListener("pointerleave", clearHold);
    btn.addEventListener("pointercancel", clearHold);
    btn.addEventListener("pointerup", (e) => {
      clearHold();
      void downAt;
      if (holdFired) return;
      const dx = e.clientX - downX;
      const dy = e.clientY - downY;
      const adx = Math.abs(dx);
      const ady = Math.abs(dy);
      if (adx > RT_SWIPE_SLOP || ady > RT_SWIPE_SLOP) {
        const idx = adx >= ady ? (dx < 0 ? 0 : 1) : dy < 0 ? 2 : 3;
        const hit = swipes[idx];
        if (hit) run(hit, screenId);
        return; // 划够距离了：不是点击（滚动拖动也走这里）
      }
      if (adx > RT_DRAG_SLOP || ady > RT_DRAG_SLOP) return; // 小拖动：既不算点击也不算滑动
      if (!tap) return;
      if (dbl) {
        // 同时配了双击：延迟单击，给双击留出窗口
        if (tapTimer !== null) clearTimeout(tapTimer);
        tapTimer = setTimeout(() => {
          tapTimer = null;
          run(tap, screenId);
        }, 240);
      } else {
        run(tap, screenId);
      }
    });
    if (dbl) {
      btn.addEventListener("dblclick", (e) => {
        e.preventDefault();
        if (tapTimer !== null) clearTimeout(tapTimer);
        tapTimer = null;
        run(dbl, screenId);
      });
    }
  }

  /* ---------------- 动作执行 ---------------- */

  function run(a: RuntimeAction, fromScreenId: string): void {
    switch (a.action) {
      case "navigate":
        if (!a.target) return;
        clearOverlays();
        goTo(a.target, a.transition, a.duration, true);
        return;
      case "overlay":
        if (a.target) openOverlay(a.target, a.position, a.transition, a.duration, a.dismissOnTapOutside);
        return;
      case "closeOverlay":
        closeTopOverlay(a.transition, a.duration);
        return;
      case "back":
        back();
        return;
      case "scrollTo":
        if (a.scrollPlan) scrollBodyTo(fromScreenId, a.scrollPlan.x, a.scrollPlan.y);
        return;
      case "toggleVisible":
        if (a.target) {
          const key = fromScreenId + "/" + a.target;
          toggled[key] = !toggled[key];
          for (const k in cache) {
            const w = cache[k];
            if (w && w.getAttribute("data-screen") === fromScreenId) applyToggles(w, fromScreenId);
          }
        }
        return;
      default:
        return;
    }
  }

  /* ---------------- 转场 ---------------- */

  type Anim = { from: Record<string, string>; to: Record<string, string> };

  function animFor(t: string, dir: "in" | "out"): Anim {
    const ID = { transform: "translateX(0%) translateY(0%) scale(1)", opacity: "1" };
    const X = (v: number) => ({ transform: "translateX(" + v + "%)", opacity: "1" });
    const Y = (v: number) => ({ transform: "translateY(" + v + "%)", opacity: "1" });
    const FADE_IN = { opacity: "0", transform: "translateX(0%) translateY(0%) scale(1)" };
    const FADE_OUT = { opacity: "0", transform: "translateX(0%) translateY(0%) scale(1)" };
    if (t === "pushLeft") return dir === "in" ? { from: X(100), to: ID } : { from: ID, to: X(-100) };
    if (t === "pushRight") return dir === "in" ? { from: X(-100), to: ID } : { from: ID, to: X(100) };
    if (t === "pushUp") return dir === "in" ? { from: Y(100), to: ID } : { from: ID, to: Y(-100) };
    if (t === "pushDown") return dir === "in" ? { from: Y(-100), to: ID } : { from: ID, to: Y(100) };
    if (t === "slideUp") return dir === "in" ? { from: Y(100), to: ID } : { from: ID, to: Y(100) };
    if (t === "slideDown") return dir === "in" ? { from: Y(-100), to: ID } : { from: ID, to: Y(-100) };
    if (t === "scale") {
      return dir === "in"
        ? { from: { transform: "scale(.92)", opacity: "0" }, to: { transform: "scale(1)", opacity: "1" } }
        : { from: { transform: "scale(1)", opacity: "1" }, to: { transform: "scale(.96)", opacity: "0" } };
    }
    return dir === "in" ? { from: FADE_IN, to: { opacity: "1" } } : { from: { opacity: "1" }, to: FADE_OUT };
  }

  function applyAnim(el2: HTMLElement, s: Record<string, string>): void {
    if (s.transform !== undefined) el2.style.transform = s.transform;
    if (s.opacity !== undefined) el2.style.opacity = s.opacity;
  }

  const EASE = "cubic-bezier(.2,.8,.2,1)";

  function animateIn(el2: HTMLElement, t: string, ms: number): void {
    if (t === "none" || ms <= 0) return;
    const a = animFor(t, "in");
    el2.style.transition = "none";
    applyAnim(el2, a.from);
    void el2.offsetWidth; // 强制回流：让起始态成为过渡起点
    el2.style.transition = "transform " + ms + "ms " + EASE + ",opacity " + ms + "ms ease";
    applyAnim(el2, a.to);
  }

  function animateOut(el2: HTMLElement, t: string, ms: number, done: () => void): void {
    if (t === "none" || ms <= 0) {
      done();
      return;
    }
    const a = animFor(t, "out");
    el2.style.transition = "transform " + ms + "ms " + EASE + ",opacity " + ms + "ms ease";
    applyAnim(el2, a.to);
    setTimeout(done, ms + 20);
  }

  const invert = (t: string): string =>
    t === "pushLeft" ? "pushRight"
    : t === "pushRight" ? "pushLeft"
    : t === "pushUp" ? "pushDown"
    : t === "pushDown" ? "pushUp"
    : t === "slideUp" ? "slideDown"
    : t === "slideDown" ? "slideUp"
    : t;

  /* ---------------- 屏幕栈 ---------------- */

  function applyFit(wrap: HTMLElement): void {
    const inner = wrap.firstElementChild as HTMLElement | null;
    if (inner) inner.style.transform = "scale(" + fit + ")";
  }

  function layoutPlane(sc: RuntimeScreen): void {
    plane.style.width = sc.w * fit + "px";
    plane.style.height = sc.h * fit + "px";
  }

  function indexOf(id: string): number {
    for (let i = 0; i < screens.length; i++) if (screens[i]!.id === id) return i;
    return 0;
  }

  /** 清掉所有浮层（跳转离开本屏时用；瞬时无动画） */
  function clearOverlays(): void {
    while (overlays.length) {
      const ov = overlays.pop()!;
      if (ov.el.parentNode) ov.el.parentNode.removeChild(ov.el);
      if (ov.backdrop && ov.backdrop.parentNode) ov.backdrop.parentNode.removeChild(ov.backdrop);
    }
  }

  function goTo(id: string, transition: string, duration: number, remember: boolean): void {
    const sc = byId[id];
    if (!sc || id === currentId) return;
    const prevId = currentId;
    const prevWrap = currentId ? (plane.querySelector(".uir-base[data-screen=\"" + currentId + "\"]") as HTMLElement | null) : null;
    const t = transition || "pushLeft";
    const ms = duration === undefined ? 300 : duration;

    if (remember && prevId) history.push({ id: prevId, transition: t });
    currentId = id;
    const wrap = buildScreen(sc, "base");
    layoutPlane(sc);
    applyFit(wrap);

    if (prevWrap && prevWrap !== wrap) {
      animateOut(prevWrap, t, ms, () => {
        if (prevWrap.parentNode) prevWrap.parentNode.removeChild(prevWrap);
      });
    }
    plane.appendChild(wrap);
    animateIn(wrap, t, ms);
    scrollState[id] = scrollState[id] || { x: 0, y: 0 };
    syncHud();
    if (hooks0.onScreen) hooks0.onScreen(id, indexOf(id));
  }

  function back(): void {
    if (overlays.length) {
      closeTopOverlay(null, undefined);
      return;
    }
    const prev = history.pop();
    if (!prev) return;
    goTo(prev.id, invert(prev.transition), 300, false);
  }

  /** 浮层锚点（与 prototype.ts 的 overlayAnchor 同规则；运行时自包含故复制一份） */
  function anchorFor(pos: string, screen: RuntimeScreen, layer: RuntimeScreen): { x: number; y: number } {
    if (pos === "top") return { x: Math.round((screen.w - layer.w) / 2), y: 0 };
    if (pos === "bottom") return { x: Math.round((screen.w - layer.w) / 2), y: screen.h - layer.h };
    if (pos === "left") return { x: 0, y: Math.round((screen.h - layer.h) / 2) };
    if (pos === "right") return { x: screen.w - layer.w, y: Math.round((screen.h - layer.h) / 2) };
    return { x: Math.round((screen.w - layer.w) / 2), y: Math.round((screen.h - layer.h) / 2) };
  }

  function placeOverlay(el2: HTMLElement, pos: string, sc: RuntimeScreen): void {
    const screen = currentId ? byId[currentId] : sc;
    const anchor = anchorFor(pos, screen || sc, sc);
    el2.style.left = anchor.x * fit + "px";
    el2.style.top = anchor.y * fit + "px";
  }

  function openOverlay(id: string, position: string, transition: string, duration: number, dismiss: boolean): void {
    const sc = byId[id];
    if (!sc) return;
    const pos = position || "center";
    const wrap = buildScreen(sc, "ov");
    wrap.style.transformOrigin = "center center";
    applyFit(wrap);
    placeOverlay(wrap, pos, sc);

    let backdrop: HTMLElement | null = null;
    if (pos === "center" || pos === "top" || pos === "bottom") {
      backdrop = mk("div", "uir-backdrop");
      plane.appendChild(backdrop);
      void backdrop.offsetWidth;
      backdrop.classList.add("on");
      if (dismiss) backdrop.addEventListener("click", () => closeTopOverlay(null, undefined));
    }
    plane.appendChild(wrap);
    const t = transition || "scale";
    animateIn(wrap, t, duration === undefined ? 240 : duration);
    overlays.push({ id, position: pos, transition: t, el: wrap, backdrop });
    syncHud();
  }

  function closeTopOverlay(transition: string | null, duration: number | undefined): void {
    const top = overlays.pop();
    if (!top) return;
    const t = transition && transition !== "none" ? transition : invert(top.transition);
    const ms = duration === undefined ? 240 : duration;
    if (top.backdrop) {
      top.backdrop.classList.remove("on");
      const bd = top.backdrop;
      setTimeout(() => {
        if (bd.parentNode) bd.parentNode.removeChild(bd);
      }, 240);
    }
    animateOut(top.el, t, ms, () => {
      if (top.el.parentNode) top.el.parentNode.removeChild(top.el);
    });
    syncHud();
  }

  /* ---------------- 滚动 ---------------- */

  /** 滚动体的内容范围：对 <g data-scroll-body> 取 getBBox（含子项的 translate，不受自身 transform 影响） */
  function contentExtent(screenId: string): { x: number; y: number } {
    const hit = extentCache[screenId];
    if (hit) return hit;
    const w = plane.querySelector(".uir-base[data-screen=\"" + screenId + "\"]");
    const body = w ? (w.querySelector("[data-scroll-body]") as unknown as { getBBox?: () => DOMRect }) : null;
    let out = { x: 0, y: 0 };
    if (body && typeof body.getBBox === "function") {
      try {
        const bb = body.getBBox();
        out = { x: bb.x + bb.width, y: bb.y + bb.height };
      } catch {
        /* 未渲染的 SVG 取不到包围盒：退化为不可滚 */
      }
    }
    if (out.x || out.y) extentCache[screenId] = out;
    return out;
  }

  function scrollBodyTo(screenId: string, x: number, y: number): void {
    const wrap = plane.querySelector(".uir-base[data-screen=\"" + screenId + "\"]");
    if (!wrap) return;
    const body = wrap.querySelector("[data-scroll-body]") as SVGElement | null;
    if (!body) return;
    const sc = byId[screenId];
    if (!sc) return;
    const axis = body.getAttribute("data-scroll-body") || "";
    const ext = contentExtent(screenId);
    const maxY = Math.max(0, ext.y - sc.h);
    const maxX = Math.max(0, ext.x - sc.w);
    const ny = axis === "v" || axis === "both" ? Math.min(Math.max(0, y), maxY) : 0;
    const nx = axis === "h" || axis === "both" ? Math.min(Math.max(0, x), maxX) : 0;
    scrollState[screenId] = { x: nx, y: ny };
    body.setAttribute("transform", "translate(" + -nx + " " + -ny + ")");
  }

  function attachScroll(): void {
    let dragging = false;
    let lastX = 0;
    let lastY = 0;
    let moved = false;
    const cur = (): RuntimeScreen | undefined => (currentId ? byId[currentId] : undefined);

    stage.addEventListener(
      "wheel",
      (e) => {
        const s = cur();
        if (!s || !s.scroll) return;
        e.preventDefault();
        const st = scrollState[s.id] || { x: 0, y: 0 };
        scrollBodyTo(s.id, st.x + e.deltaX, st.y + e.deltaY);
      },
      { passive: false },
    );
    stage.addEventListener("pointerdown", (e) => {
      const s = cur();
      if (!s || !s.scroll) return;
      dragging = true;
      moved = false;
      lastX = e.clientX;
      lastY = e.clientY;
    });
    stage.addEventListener("pointermove", (e) => {
      if (!dragging) return;
      const s = cur();
      if (!s) return;
      const dx = e.clientX - lastX;
      const dy = e.clientY - lastY;
      if (Math.abs(dx) + Math.abs(dy) > 3) moved = true;
      lastX = e.clientX;
      lastY = e.clientY;
      const st = scrollState[s.id] || { x: 0, y: 0 };
      scrollBodyTo(s.id, st.x - dx / fit, st.y - dy / fit);
    });
    const end = (): void => {
      if (dragging && moved) {
        // 刚拖动过：抑制紧随其后的 click，避免滚动时误触热点
        suppressClick = true;
        setTimeout(() => {
          suppressClick = false;
        }, 0);
      }
      dragging = false;
    };
    stage.addEventListener("pointerup", end);
    stage.addEventListener("pointercancel", end);
    stage.addEventListener(
      "click",
      (e) => {
        if (suppressClick) {
          e.stopPropagation();
          e.preventDefault();
        }
      },
      true,
    );
  }

  /* ---------------- 界面同步 ---------------- */

  function syncHud(): void {
    const sc = currentId ? byId[currentId] : undefined;
    elName.textContent = sc ? sc.name : "无画板";
    elPage.textContent = sc ? indexOf(sc.id) + 1 + "/" + screens.length : "";
    btnBack.disabled = overlays.length === 0 && history.length === 0;
    const chips = bottom.children;
    for (let i = 0; i < chips.length; i++) {
      const c = chips[i] as HTMLElement;
      if (c.getAttribute("data-target") === currentId) c.classList.add("on");
      else c.classList.remove("on");
    }
  }

  function doFit(): void {
    const sc = currentId ? byId[currentId] : screens[0];
    if (!sc || !stage.clientWidth) return;
    fit = Math.min(1.5, Math.max(0.1, Math.min((stage.clientWidth - 32) / sc.w, (stage.clientHeight - 32) / sc.h)));
    layoutPlane(sc);
    for (const key in cache) {
      const w = cache[key];
      if (!w) continue;
      applyFit(w);
      if (key.indexOf("ov:") === 0) {
        const ov = overlays.find((o) => o.el === w);
        const scr = byId[w.getAttribute("data-screen") || ""];
        if (ov && scr) placeOverlay(w, ov.position, scr);
      }
    }
  }

  /* ---------------- 交互装配 ---------------- */

  const onKey = (e: KeyboardEvent): void => {
    if (e.key === "Escape") {
      if (overlays.length) {
        closeTopOverlay(null, undefined);
        return;
      }
      if (hooks0.onExit) hooks0.onExit();
      return;
    }
    if (overlays.length) return;
    if (e.key === "ArrowLeft" && history.length) back();
    if (e.key === "ArrowRight") {
      const i = (currentId ? indexOf(currentId) : 0) + 1;
      if (i < screens.length) goTo(screens[i]!.id, "pushLeft", 300, true);
    }
  };
  window.addEventListener("keydown", onKey);
  cleanupFns.push(() => window.removeEventListener("keydown", onKey));

  btnBack.addEventListener("click", () => back());
  if (hooks0.onExit) btnExit.addEventListener("click", () => hooks0.onExit!());
  attachScroll();

  for (let i = 0; i < screens.length; i++) {
    const s = screens[i]!;
    const chip = mk("button", "uir-chip") as HTMLButtonElement;
    chip.type = "button";
    chip.textContent = s.name;
    chip.setAttribute("data-target", s.id);
    chip.addEventListener("click", () => {
      if (overlays.length || s.id === currentId) return;
      goTo(s.id, "fade", 200, true);
    });
    bottom.appendChild(chip);
  }

  /* ---------------- 启动 ---------------- */

  if (screens.length === 0) {
    plane.innerHTML = '<div class="uir-empty">还没有画板：先画一块画板（F）再预览</div>';
  } else {
    let startId = payload.start;
    if (!byId[startId]) startId = screens[0]!.id;
    const sc = byId[startId]!;
    currentId = startId;
    if (stage.clientWidth) {
      fit = Math.min(1.5, Math.max(0.1, Math.min((stage.clientWidth - 32) / sc.w, (stage.clientHeight - 32) / sc.h)));
    }
    layoutPlane(sc);
    const first = buildScreen(sc, "base");
    applyFit(first);
    plane.appendChild(first);
    syncHud();
    if (hooks0.onScreen) hooks0.onScreen(startId, indexOf(startId));
  }

  let ro: ResizeObserver | null = null;
  if (typeof ResizeObserver !== "undefined") {
    ro = new ResizeObserver(() => doFit());
    ro.observe(stage);
  }
  window.addEventListener("resize", doFit);
  cleanupFns.push(() => window.removeEventListener("resize", doFit));

  return {
    go: (id: string, transition?: string, duration?: number) => {
      if (overlays.length) return;
      goTo(id, transition || "fade", duration === undefined ? 200 : duration, true);
    },
    back: () => back(),
    current: () => currentId,
    destroy: () => {
      if (ro) ro.disconnect();
      for (const f of cleanupFns) f();
      root.innerHTML = "";
    },
  };
}

/** 运行时源码（导出侧 `toString()` 内联用）：函数不引用模块级符号，内联后行为与预览完全一致 */
export function prototypeRuntimeSource(): string {
  return prototypeRuntime.toString();
}

/** 供导出侧引用的公共资源（样式表；热点的动作文案在运行时内部） */
export const RUNTIME_TRIGGER_LABELS = {
  tap: "单击",
  doubleTap: "双击",
  longPress: "长按",
  swipeLeft: "左滑",
  swipeRight: "右滑",
  swipeUp: "上滑",
  swipeDown: "下滑",
} as Record<string, string>;
