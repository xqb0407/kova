/**
 * 内置浏览器快照（对齐 X SNAPSHOT_SCRIPT 的字段模型，单主框架版）：
 * - elements：可交互元素，带 ref / role / accessible name / value / checked /
 *   disabled / selector / rect / inViewport / parentRef / 有界属性；
 * - dom：可见语义节点（heading/paragraph/list/table/image…），供模型读正文；
 * - ref 存在 window.__kovaRefs（每次快照重建），不再向页面写 data-xr-ref——
 *   旧 ref 立即失效，也不会污染页面 DOM；
 * - 主进程把结构格式化成有界文本（400 行 / 20k 字符），截断在格式化阶段生效。
 *
 * 脚本是注入页面的纯 JS 字符串；bun test 只覆盖格式化与脚本常量。
 */

export interface BrowserSnapshotElement {
  ref: string;
  tag: string;
  role?: string;
  name?: string;
  text?: string;
  value?: string;
  disabled?: boolean;
  checked?: boolean;
  selector: string;
  rect: { x: number; y: number; width: number; height: number };
  inViewport: boolean;
  parentRef?: string;
  attributes?: Record<string, string>;
}

export interface BrowserSnapshotDomNode {
  tag: string;
  depth: number;
  inViewport: boolean;
  ref?: string;
  role?: string;
  name?: string;
  text?: string;
}

export interface BrowserSnapshotData {
  ok?: boolean;
  error?: string;
  url?: string;
  title?: string;
  scrollX?: number;
  scrollY?: number;
  innerWidth?: number;
  innerHeight?: number;
  elements?: BrowserSnapshotElement[];
  dom?: BrowserSnapshotDomNode[];
  elementsTruncated?: boolean;
  domTruncated?: boolean;
}

export const MAX_SNAPSHOT_ELEMENTS = 200;
export const MAX_SNAPSHOT_DOM_NODES = 300;
export const SNAPSHOT_MAX_LINES = 400;
export const SNAPSHOT_MAX_CHARS = 20_000;

export const SNAPSHOT_JS = `(() => {
  try {
    var MAX_ELEMENTS = ${MAX_SNAPSHOT_ELEMENTS}, MAX_DOM = ${MAX_SNAPSHOT_DOM_NODES};
    var ACTION_SEL = 'a[href], button, input, textarea, select, [role], [onclick], [tabindex], summary, label, [contenteditable]';
    var DOM_SEL = 'body, main, nav, header, footer, aside, section, article, h1, h2, h3, h4, h5, h6, p, ul, ol, li, dl, dt, dd, blockquote, pre, code, table, caption, thead, tbody, tfoot, tr, th, td, form, fieldset, legend, figure, figcaption, img, canvas, a[href], button, input, textarea, select, option, summary, label, [role], [aria-label], [contenteditable]';
    var TEXT_TAGS = { H1:1, H2:1, H3:1, H4:1, H5:1, H6:1, P:1, LI:1, DT:1, DD:1, BLOCKQUOTE:1, PRE:1, CODE:1, CAPTION:1, TH:1, TD:1, LABEL:1, SUMMARY:1, BUTTON:1, A:1, OPTION:1, LEGEND:1, FIGCAPTION:1 };
    var refs = new Map();
    try { window.__kovaRefs = refs; } catch (e) {}
    var vw = window.innerWidth || document.documentElement.clientWidth || 0;
    var vh = window.innerHeight || document.documentElement.clientHeight || 0;

    function textOf(el, max) {
      var t = '';
      try { t = el.innerText || el.textContent || ''; } catch (e) { t = ''; }
      return String(t).replace(/\\s+/g, ' ').trim().slice(0, max || 300);
    }
    function hidden(el) {
      var s;
      try { s = getComputedStyle(el); } catch (e) { return true; }
      if (!s || s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0') return true;
      try {
        if (el.closest("[aria-hidden='true'],[hidden]")) return true;
      } catch (e) {}
      var r = el.getBoundingClientRect();
      return r.width <= 0 && r.height <= 0;
    }
    function cssEscape(value) {
      if (window.CSS && CSS.escape) return CSS.escape(value);
      return String(value).replace(/[^a-zA-Z0-9_-]/g, '\\\\$&');
    }
    function byIdText(id) {
      try {
        var n = document.getElementById(id);
        return n ? textOf(n, 120) : '';
      } catch (e) { return ''; }
    }
    function accessibleName(el, tag) {
      var labelledby = el.getAttribute('aria-labelledby');
      if (labelledby) {
        var parts = labelledby.split(/\\s+/).map(byIdText).filter(Boolean);
        if (parts.length) return parts.join(' ').slice(0, 120);
      }
      var aria = el.getAttribute('aria-label');
      if (aria) return String(aria).replace(/\\s+/g, ' ').trim().slice(0, 120);
      // 关联 label：for/id 或祖先 label（checkbox/radio 的名字靠这条）
      if (el.id) {
        try {
          var forLabel = document.querySelector('label[for="' + cssEscape(el.id) + '"]');
          var forText = forLabel ? textOf(forLabel, 120) : '';
          if (forText) return forText;
        } catch (e) {}
      }
      try {
        var wrap = el.closest('label');
        var wrapText = wrap ? textOf(wrap, 120) : '';
        if (wrapText) return wrapText;
      } catch (e) {}
      var type = (el.getAttribute('type') || '').toLowerCase();
      if (tag === 'input' && (type === 'button' || type === 'submit' || type === 'reset')) {
        return String(el.value || type).slice(0, 120);
      }
      var alt = el.getAttribute('alt') || el.getAttribute('title') || el.getAttribute('placeholder');
      if (alt) return String(alt).replace(/\\s+/g, ' ').trim().slice(0, 120);
      if (TEXT_TAGS[el.tagName]) return textOf(el, 120);
      return '';
    }
    function roleOf(el, tag) {
      var role = el.getAttribute('role');
      if (role) return role;
      if (tag === 'a') return el.getAttribute('href') != null ? 'link' : 'generic';
      if (tag === 'button' || tag === 'summary') return 'button';
      if (tag === 'textarea') return 'textbox';
      if (tag === 'select') return 'combobox';
      if (tag === 'input') {
        var ty = (el.getAttribute('type') || 'text').toLowerCase();
        if (ty === 'checkbox' || ty === 'radio' || ty === 'range' || ty === 'file') return ty;
        if (ty === 'button' || ty === 'submit' || ty === 'reset') return 'button';
        if (ty === 'search') return 'searchbox';
        return 'textbox';
      }
      if (/^h[1-6]$/.test(tag)) return 'heading';
      return tag;
    }
    function valueOf(el, tag, role) {
      if (tag !== 'input' && tag !== 'textarea' && tag !== 'select') return '';
      if (role === 'checkbox' || role === 'radio' || role === 'file') return '';
      var v = el.value;
      if (v == null) return '';
      var s = String(v);
      if (tag === 'input' && (el.getAttribute('type') || '').toLowerCase() === 'password') {
        return s.length > 0 ? '••••' : '';
      }
      return s.replace(/\\s+/g, ' ').slice(0, 120);
    }
    function selectorOf(el) {
      if (el.id) {
        try { if (document.querySelectorAll('#' + cssEscape(el.id)).length === 1) return '#' + el.id; } catch (e) {}
      }
      var parts = [];
      var node = el;
      var depth = 0;
      while (node && node.nodeType === 1 && depth < 6) {
        var tag = node.tagName.toLowerCase();
        if (node.id) {
          try { if (document.querySelectorAll('#' + cssEscape(node.id)).length === 1) { parts.unshift('#' + node.id); break; } } catch (e) {}
        }
        var index = 1;
        var sib = node.previousElementSibling;
        while (sib) {
          if (sib.tagName === node.tagName) index += 1;
          sib = sib.previousElementSibling;
        }
        parts.unshift(tag + ':nth-of-type(' + index + ')');
        node = node.parentElement;
        depth += 1;
        if (node === document.body || node === document.documentElement) break;
      }
      return parts.join(' > ');
    }
    function depthOf(el) {
      var d = 0;
      var p = el.parentElement;
      while (p && p !== document.body) { d += 1; p = p.parentElement; }
      return d;
    }
    var ATTR_KEYS = ['id', 'name', 'type', 'href', 'placeholder', 'title', 'alt', 'role', 'aria-label', 'data-testid', 'data-test', 'data-qa'];
    function attrsOf(el) {
      var out = {};
      for (var i = 0; i < ATTR_KEYS.length; i++) {
        var v = el.getAttribute(ATTR_KEYS[i]);
        if (v != null && String(v).trim() !== '') out[ATTR_KEYS[i]] = String(v).trim().slice(0, 240);
      }
      return out;
    }

    var elements = [];
    var elRef = new WeakMap();
    var nodes = document.querySelectorAll(ACTION_SEL);
    var elementsTruncated = false;
    var SCAN_CAP = 8000;
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      if (i >= SCAN_CAP) { elementsTruncated = true; break; }
      if (hidden(el)) continue;
      if (elements.length >= MAX_ELEMENTS) { elementsTruncated = true; break; }
      var tag = el.tagName.toLowerCase();
      var role = roleOf(el, tag);
      var ref = 'e' + (elements.length + 1);
      refs.set(ref, el);
      elRef.set(el, ref);
      var r = el.getBoundingClientRect();
      var out = {
        ref: ref,
        tag: tag,
        role: role,
        name: accessibleName(el, tag),
        selector: selectorOf(el),
        rect: { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) },
        inViewport: r.top < vh && r.bottom > 0 && r.left < vw && r.right > 0
      };
      var text = TEXT_TAGS[el.tagName] ? textOf(el, 200) : '';
      if (text && text !== out.name) out.text = text;
      var value = valueOf(el, tag, role);
      if (value) out.value = value;
      if (role === 'checkbox' || role === 'radio') out.checked = el.checked === true;
      if (el.disabled === true || el.getAttribute('aria-disabled') === 'true') out.disabled = true;
      var attrs = attrsOf(el);
      if (Object.keys(attrs).length > 0) out.attributes = attrs;
      var p = el.parentElement;
      while (p) {
        var pr = elRef.get(p);
        if (pr) { out.parentRef = pr; break; }
        p = p.parentElement;
      }
      elements.push(out);
    }

    var dom = [];
    var domTruncated = false;
    var domNodes = document.querySelectorAll(DOM_SEL);
    for (var d = 0; d < domNodes.length; d++) {
      var node = domNodes[d];
      if (d >= SCAN_CAP) { domTruncated = true; break; }
      if (hidden(node)) continue;
      if (dom.length >= MAX_DOM) { domTruncated = true; break; }
      var dTag = node.tagName.toLowerCase();
      var dr = node.getBoundingClientRect();
      var dn = {
        tag: dTag,
        depth: depthOf(node),
        inViewport: dr.top < vh && dr.bottom > 0 && dr.left < vw && dr.right > 0
      };
      var refOfNode = elRef.get(node);
      if (refOfNode) dn.ref = refOfNode;
      var dRole = node.getAttribute('role') || '';
      if (dRole) dn.role = dRole;
      var dName = node.getAttribute('alt') || node.getAttribute('aria-label') || '';
      if (dName) dn.name = String(dName).replace(/\\s+/g, ' ').slice(0, 120);
      if (TEXT_TAGS[node.tagName]) {
        var dText = textOf(node, 300);
        if (dText) dn.text = dText;
      }
      dom.push(dn);
    }

    return {
      ok: true,
      url: location.href,
      title: document.title || '',
      scrollX: Math.round(window.scrollX || 0),
      scrollY: Math.round(window.scrollY || 0),
      innerWidth: vw,
      innerHeight: vh,
      elements: elements,
      dom: dom,
      elementsTruncated: elementsTruncated,
      domTruncated: domTruncated
    };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
})()`;

/** 解析 ref → 视口中心点。默认 scrollIntoView；scroll=false 用于拖拽：
 *  两个端点必须共享同一滚动状态，否则解析终点会把起点坐标滚走。 */
export function resolveScript(ref: string, scroll = true): string {
  const literal = JSON.stringify(ref);
  const safeRef = ref.replace(/"/g, "");
  const scrollLine = scroll
    ? 'el.scrollIntoView({ block: "center", inline: "center" });'
    : "";
  const viewportCheck = scroll
    ? ""
    : `if (cx < 0 || cy < 0 || cx >= (window.innerWidth || 0) || cy >= (window.innerHeight || 0)) {
      return { ok: false, error: "ref ${safeRef} is outside the viewport — scroll both drag endpoints into view first" };
    }`;
  return `(() => {
  try {
    var map = window.__kovaRefs;
    var el = map && map.get(${literal});
    if (!el || !el.isConnected) {
      return { ok: false, error: "stale ref: ${safeRef} not found — the page changed, take a new snapshot" };
    }
    ${scrollLine}
    var r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) {
      return { ok: false, error: "ref ${safeRef} is not visible — take a new snapshot" };
    }
    var cx = Math.round(r.left + r.width / 2);
    var cy = Math.round(r.top + r.height / 2);
    ${viewportCheck}
    return {
      ok: true,
      cx: cx,
      cy: cy,
      ax: Math.round(r.left + (window.scrollX || 0)),
      ay: Math.round(r.top + (window.scrollY || 0)),
      width: Math.round(r.width),
      height: Math.round(r.height)
    };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
})()`;
}

export function selectScript(ref: string, values: readonly string[]): string {
  return `(() => {
  try {
    var map = window.__kovaRefs;
    var el = map && map.get(${JSON.stringify(ref)});
    if (!el) return { ok: false, error: "stale ref: ${ref.replace(/"/g, "")}" };
    if (!el.tagName || el.tagName.toLowerCase() !== "select") return { ok: false, error: "element is not a <select>" };
    var wanted = ${JSON.stringify(values)};
    var matched = 0;
    for (var i = 0; i < el.options.length; i++) el.options[i].selected = false;
    for (var w = 0; w < wanted.length; w++) {
      var want = String(wanted[w]);
      for (var j = 0; j < el.options.length; j++) {
        var opt = el.options[j];
        if (String(opt.value) === want || String(opt.textContent || "").trim() === want) {
          opt.selected = true;
          matched += 1;
          break;
        }
      }
    }
    if (matched === 0) return { ok: false, error: "no <option> matched " + JSON.stringify(wanted) };
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
})()`;
}

export function checkScript(ref: string, checked: boolean): string {
  return `(() => {
  try {
    var map = window.__kovaRefs;
    var el = map && map.get(${JSON.stringify(ref)});
    if (!el) return { ok: false, error: "stale ref: ${ref.replace(/"/g, "")}" };
    var type = (el.getAttribute("type") || "").toLowerCase();
    if (el.tagName !== "INPUT" || (type !== "checkbox" && type !== "radio")) {
      return { ok: false, error: "element is not a checkbox/radio" };
    }
    if (el.checked !== ${checked ? "true" : "false"}) el.click();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
})()`;
}

export function focusScript(ref: string): string {
  return `(() => {
  try {
    var map = window.__kovaRefs;
    var el = map && map.get(${JSON.stringify(ref)});
    if (!el || !el.isConnected) return { ok: false, error: "stale ref: ${ref.replace(/"/g, "")} not found — take a new snapshot" };
    el.scrollIntoView({ block: "center", inline: "center" });
    if (typeof el.focus === "function") el.focus();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
})()`;
}

/** 聚焦并全选：CDP Input.insertText 是「在光标处插入」，全选后插入才等价于
 *  「替换现有文本」（browser_type 的历史契约）。顺带回传可编辑性与原值：
 *  调用方据此在 insert 前后核对输入到底有没有落到这个元素上。 */
export function selectTextScript(ref: string): string {
  return `(() => {
  try {
    var map = window.__kovaRefs;
    var el = map && map.get(${JSON.stringify(ref)});
    if (!el || !el.isConnected) return { ok: false, error: "stale ref: ${ref.replace(/"/g, "")} not found — take a new snapshot" };
    el.scrollIntoView({ block: "center", inline: "center" });
    if (typeof el.focus === "function") el.focus();
    var tag = el.tagName ? el.tagName.toLowerCase() : "";
    var editable = tag === "input" || tag === "textarea" || el.isContentEditable === true;
    var before = tag === "input" || tag === "textarea" ? String(el.value) : String(el.textContent || "");
    if (tag === "input" || tag === "textarea") {
      if (typeof el.select === "function") el.select();
    } else if (el.isContentEditable && window.getSelection && document.createRange) {
      var range = document.createRange();
      range.selectNodeContents(el);
      var sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    }
    return { ok: true, tag: tag, editable: editable, value: before };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
})()`;
}

/** 回读输入结果：browser_type 在 insertText 之后核对目标元素是否真的拿到了
 *  文本——输入没落到页面上时明确报错，别让工具包一个「成功」的快照回去。 */
export function readValueScript(ref: string): string {
  return `(() => {
  try {
    var map = window.__kovaRefs;
    var el = map && map.get(${JSON.stringify(ref)});
    if (!el || !el.isConnected) return { ok: false, error: "stale ref: ${ref.replace(/"/g, "")} not found — take a new snapshot" };
    var tag = el.tagName ? el.tagName.toLowerCase() : "";
    var value = tag === "input" || tag === "textarea" ? el.value : (el.textContent || "");
    return { ok: true, tag: tag, focused: document.activeElement === el, value: String(value) };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
})()`;
}

/** 页面侧文本写入（browser_type 主路径）：替换选中内容并回传插入前后的值。
 *
 *  CDP 的 Input.insertText 在 <webview> guest 上按「浏览器进程当前聚焦的
 *  RenderWidgetHost」路由：宿主窗口里聊天输入框还握着焦点时，字会写进聊天框
 *  而不是页面。execCommand 在页面内完成替换，不依赖浏览器焦点，也不会把用户
 *  正在输入的光标抢走。execCommand 被页面拦掉时由调用方退回 CDP（届时必须
 *  先把焦点移进 guest）。 */
export function typeTextScript(ref: string, text: string): string {
  return `(() => {
  try {
    var map = window.__kovaRefs;
    var el = map && map.get(${JSON.stringify(ref)});
    if (!el || !el.isConnected) return { ok: false, error: "stale ref: ${ref.replace(/"/g, "")} not found — take a new snapshot" };
    var tag = el.tagName ? el.tagName.toLowerCase() : "";
    var type = (el.getAttribute && el.getAttribute("type") || "").toLowerCase();
    var editable = tag === "input" || tag === "textarea" || el.isContentEditable === true;
    if (!editable) return { ok: false, error: "element is not an input/textarea/contenteditable (" + tag + ")" };
    if (tag === "input" && (type === "checkbox" || type === "radio" || type === "file" || type === "button" || type === "submit" || type === "reset" || type === "image")) {
      return { ok: false, error: "input type=" + type + " does not accept text" };
    }
    if (el.disabled === true) return { ok: false, error: "element is disabled" };
    if (el.readOnly === true) return { ok: false, error: "element is read-only" };
    var text = ${JSON.stringify(text)};
    var before = tag === "input" || tag === "textarea" ? String(el.value) : String(el.textContent || "");
    el.scrollIntoView({ block: "center", inline: "center" });
    if (typeof el.focus === "function") el.focus();
    if (tag === "input" || tag === "textarea") {
      if (typeof el.select === "function") el.select();
    } else if (window.getSelection && document.createRange) {
      var range = document.createRange();
      range.selectNodeContents(el);
      var sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    }
    var exec = false;
    try { exec = document.execCommand("insertText", false, text); } catch (e) { exec = false; }
    var after = tag === "input" || tag === "textarea" ? String(el.value) : String(el.textContent || "");
    return { ok: true, tag: tag, exec: exec, before: before, value: after, focused: document.activeElement === el };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
})()`;
}

/** 页面探测：wait_for / state 用。selector 与文本条件互斥（selector 优先）。 */
export function probeScript(input: {
  selector?: string;
  text?: string;
  textGone?: string;
}): string {
  return `(() => {
  try {
    var selector = ${JSON.stringify(input.selector ?? "")};
    var text = ${JSON.stringify(input.text ?? "")};
    var textGone = ${JSON.stringify(input.textGone ?? "")};
    var bodyText = "";
    try { bodyText = document.body ? (document.body.innerText || document.body.textContent || "") : ""; } catch (e) {}
    var result = { ok: true, selectorFound: null, textFound: null, textGone: null, url: location.href, title: document.title || "" };
    if (selector) result.selectorFound = !!document.querySelector(selector);
    if (text) result.textFound = bodyText.indexOf(text) !== -1;
    if (textGone) result.textGone = bodyText.indexOf(textGone) === -1;
    return result;
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
})()`;
}

function clampText(value: string, max: number): string {
  const cleaned = value.replace(/\s+/g, " ").replace(/"/g, "'").trim();
  return cleaned.length > max ? `${cleaned.slice(0, max)}…` : cleaned;
}

export interface FormattedSnapshot {
  output: string;
  truncated: boolean;
  empty: boolean;
}

/** 结构 → 模型可读文本；行数/字符数在这里硬裁。 */
export function formatSnapshot(data: BrowserSnapshotData): FormattedSnapshot {
  const elements = Array.isArray(data.elements) ? data.elements : [];
  const dom = Array.isArray(data.dom) ? data.dom : [];
  const lines: string[] = [];
  let chars = 0;
  let truncated = data.elementsTruncated === true || data.domTruncated === true;

  const push = (line: string): boolean => {
    if (lines.length >= SNAPSHOT_MAX_LINES) {
      truncated = true;
      return false;
    }
    if (chars + line.length + 1 > SNAPSHOT_MAX_CHARS) {
      truncated = true;
      return false;
    }
    lines.push(line);
    chars += line.length + 1;
    return true;
  };

  push(String(data.url ?? ""));
  push(String(data.title ?? ""));
  push(
    `scroll=${Number(data.scrollX ?? 0)},${Number(data.scrollY ?? 0)} ` +
      `viewport=${Number(data.innerWidth ?? 0)}x${Number(data.innerHeight ?? 0)}`,
  );

  push("交互元素：");
  if (elements.length === 0) {
    push("（无）");
  } else {
    for (const el of elements) {
      const role = el.role || el.tag || "element";
      const name = clampText(String(el.name ?? ""), 120);
      const parts = [`- ${role} "${name}"`, `[ref=${el.ref}]`];
      if (el.value) parts.push(`value="${clampText(String(el.value), 120)}"`);
      if (el.checked !== undefined) parts.push(el.checked ? "checked" : "unchecked");
      if (el.disabled === true) parts.push("disabled");
      if (el.inViewport === false) parts.push("offscreen");
      if (el.selector) parts.push(`sel=${clampText(String(el.selector), 160)}`);
      if (!push(parts.join(" "))) break;
    }
  }

  if (lines.length < SNAPSHOT_MAX_LINES && !truncated) {
    push("页面文本：");
    if (dom.length === 0) {
      push("（无）");
    } else {
      for (const node of dom) {
        const indent = "  ".repeat(Math.min(Number(node.depth) || 0, 6));
        const label = node.text || node.name || node.role || "";
        const refSuffix = node.ref ? ` [ref=${node.ref}]` : "";
        const line = `${indent}- ${node.tag}${refSuffix}${label ? ` "${clampText(String(label), 160)}"` : ""}`;
        if (!push(line)) break;
      }
    }
  }

  if (truncated) {
    // 截断提示本身不占预算：追加在最后。
    lines.push("（快照被截断：滚动到目标区域后重新 browser_snapshot，或缩小范围）");
  }

  return {
    output: lines.join("\n"),
    truncated,
    empty: elements.length === 0 && dom.length === 0,
  };
}
