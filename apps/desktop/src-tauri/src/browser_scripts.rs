//! 注入面板 webview 的动作脚本（agent 自动化原语）。
//! 每个脚本都是 IIFE + try/catch 返回 JSON——Windows WebView2 会吞掉
//! 未捕获异常（wry 文档），必须自带兜底，否则 eval_with_callback 收不到结果。
//! 快照脚本给可交互元素打 data-xr-ref 属性；ref 计数器挂在 window.__xrRefSeq
//! 上跨快照持久（元素选取器与历史快照的 ref 不互相踩）；click/type 解析 ref
//! 时回落到选取时登记的 window.__xrSelectors[ref] CSS 选择器。

/// 页面状态：url / readyState / 标题（导航等待轮询与 attach 去重导航用）
pub const STATE_JS: &str = r#"(() => {
  try {
    return JSON.stringify({ ok: true, url: location.href, readyState: document.readyState, title: document.title || "" });
  } catch (err) {
    return JSON.stringify({ ok: false, error: String((err && err.message) || err) });
  }
})()"#;

/// ref → 元素解析段（CLICK/TYPE 模板经 __XR_RESOLVE__ 占位拼入；依赖前置的 var ref）
pub const RESOLVE_JS: &str = r#"var el = document.querySelector("[data-xr-ref=\"" + ref + "\"]");
    if (!el) {
      var sel = (window.__xrSelectors || {})[ref];
      try { if (sel) el = document.querySelector(sel); } catch (e) {}
    }
    if (!el) return JSON.stringify({ ok: false, error: "stale ref: " + ref + " not found — page may have changed, take a new snapshot" });"#;

/// 渲染后的可交互快照：可见性过滤 + 交互元素打 ref，线性树文本给模型阅读。
/// 上限：走 4000 个节点 / 400 行 / 20000 字符，防超大页面失控。
pub const SNAPSHOT_JS: &str = r#"(() => {
  try {
    var MAX_LINES = 400, MAX_CHARS = 20000, MAX_WALKED = 4000;
    window.__xrRefSeq = window.__xrRefSeq || 0;
    var SKIP = { SCRIPT:1, STYLE:1, NOSCRIPT:1, TEMPLATE:1, SVG:1, IFRAME:1, LINK:1, META:1 };
    var INTER_TAGS = { A:1, BUTTON:1, INPUT:1, TEXTAREA:1, SELECT:1, SUMMARY:1 };
    var INTER_ROLES = { button:1, link:1, checkbox:1, radio:1, tab:1, menuitem:1, menuitemcheckbox:1, menuitemradio:1, combobox:1, option:1, switch:1, slider:1, searchbox:1, textbox:1, treeitem:1 };
    var lines = [], walked = 0, truncated = false;
    function hidden(el) {
      var s;
      try { s = getComputedStyle(el); } catch (err) { return true; }
      if (!s || s.display === "none" || s.visibility === "hidden" || s.opacity === "0") return true;
      if (el.closest("[aria-hidden='true'],[hidden]")) return true;
      var r = el.getBoundingClientRect();
      return r.width === 0 && r.height === 0;
    }
    function isInteractive(el) {
      if (el.disabled === true) return false;
      var t = el.tagName;
      if (t === "INPUT" && (el.type || "").toLowerCase() === "hidden") return false;
      if (INTER_TAGS[t]) return true;
      if (el.isContentEditable) return true;
      var role = el.getAttribute("role");
      if (role && INTER_ROLES[role]) return true;
      return el.hasAttribute("onclick") || (el.hasAttribute("tabindex") && el.getAttribute("tabindex") !== "-1");
    }
    function label(el) {
      var v = el.getAttribute("aria-label") || el.getAttribute("placeholder") || el.getAttribute("alt") || el.title || "";
      if (!v && el.tagName === "INPUT") {
        var ty = (el.type || "text").toLowerCase();
        if (["text","search","email","password","tel","url","number"].indexOf(ty) === -1) v = el.value || "";
      }
      if (!v) v = (el.textContent || "").trim();
      return String(v).replace(/\s+/g, " ").slice(0, 120);
    }
    function roleOf(el) {
      var t = el.tagName, role = el.getAttribute("role");
      if (role) return role;
      if (t === "A") return "link";
      if (t === "BUTTON") return "button";
      if (t === "TEXTAREA") return "textbox";
      if (t === "SELECT") return "combobox";
      if (t === "SUMMARY") return "summary";
      if (t === "INPUT") {
        var ty = (el.type || "text").toLowerCase();
        if (["checkbox","radio","button","submit","file","range","image"].indexOf(ty) !== -1) return ty;
        return "textbox";
      }
      if (/^H[1-6]$/.test(t)) return "heading";
      return t.toLowerCase();
    }
    function ownText(el) {
      var out = "";
      for (var n = el.firstChild; n; n = n.nextSibling) if (n.nodeType === 3) out += n.nodeValue;
      return out.replace(/\s+/g, " ").trim().slice(0, 200);
    }
    function walk(el, depth) {
      if (truncated || walked >= MAX_WALKED) return;
      walked++;
      var t = el.tagName;
      if (SKIP[t]) return;
      if (hidden(el)) return;
      var ind = "  ".repeat(Math.min(depth, 4));
      if (isInteractive(el)) {
        var ref = "e" + (++window.__xrRefSeq);
        el.setAttribute("data-xr-ref", ref);
        var extra = (el.tagName === "INPUT" && (el.type || "").toLowerCase() === "password") ? " (password)" : "";
        lines.push(ind + "- " + roleOf(el) + extra + " \"" + label(el) + "\" [ref=" + ref + "]");
        return;
      }
      if (/^H[1-6]$/.test(t)) {
        var h = (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 160);
        if (h) lines.push(ind + "- heading \"" + h + "\" [" + t.toLowerCase() + "]");
      } else if (t === "IMG" && el.alt) {
        lines.push(ind + "- image \"" + String(el.alt).slice(0, 120) + "\"");
      } else {
        var ot = ownText(el);
        if (ot) lines.push(ind + "- text: " + ot);
      }
      var kids = el.children;
      for (var i = 0; i < kids.length; i++) walk(kids[i], depth + 1);
    }
    if (document.body) {
      walk(document.body, 0);
      if (walked >= MAX_WALKED || lines.length >= MAX_LINES) truncated = true;
    }
    var tree = lines.join("\n");
    if (tree.length > MAX_CHARS) { tree = tree.slice(0, MAX_CHARS) + "\n…[截断]"; truncated = true; }
    return JSON.stringify({ ok: true, url: location.href, title: document.title || "", tree: tree, refCount: window.__xrRefSeq, truncated: truncated });
  } catch (err) {
    return JSON.stringify({ ok: false, error: String((err && err.message) || err) });
  }
})()"#;

/// 点击：pointer/mouse 事件序列覆盖多数监听方式（el.click() 对部分 SPA 不够）。
pub const CLICK_JS_TEMPLATE: &str = r#"(() => {
  try {
    var ref = "__XR_REF__";
    __XR_RESOLVE__
    el.scrollIntoView({ block: "center" });
    var r = el.getBoundingClientRect();
    var opts = { bubbles: true, cancelable: true, composed: true, view: window, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: 0 };
    try { el.dispatchEvent(new PointerEvent("pointerdown", opts)); } catch (e) {}
    el.dispatchEvent(new MouseEvent("mousedown", opts));
    try { el.dispatchEvent(new PointerEvent("pointerup", opts)); } catch (e) {}
    el.dispatchEvent(new MouseEvent("mouseup", opts));
    el.dispatchEvent(new MouseEvent("click", opts));
    return JSON.stringify({ ok: true });
  } catch (err) {
    return JSON.stringify({ ok: false, error: String((err && err.message) || err) });
  }
})()"#;

/// 输入：native setter + input/change 事件（React 受控组件兼容）；
/// submit 时派发 Enter 键并在未拦截时请求提交所在表单。
pub const TYPE_JS_TEMPLATE: &str = r#"(() => {
  try {
    var ref = "__XR_REF__";
    var value = __XR_VALUE__;
    var submit = __XR_SUBMIT__;
    __XR_RESOLVE__
    el.focus();
    if (el.isContentEditable) {
      el.textContent = value;
      el.dispatchEvent(new InputEvent("input", { bubbles: true, data: value }));
    } else if (el.tagName === "SELECT") {
      el.value = value;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    } else {
      var proto = el.tagName === "TEXTAREA" ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
      var d = Object.getOwnPropertyDescriptor(proto, "value");
      if (d && d.set) d.set.call(el, value); else el.value = value;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    }
    if (submit) {
      var ke = new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true });
      el.dispatchEvent(ke);
      var form = el.closest("form");
      if (form && !ke.defaultPrevented) { try { form.requestSubmit(); } catch (e) {} }
    }
    return JSON.stringify({ ok: true });
  } catch (err) {
    return JSON.stringify({ ok: false, error: String((err && err.message) || err) });
  }
})()"#;

/// 滚动：窗口级（内嵌可滚动容器不支持，v1 限制）。返回滚动位置供模型判断。
pub const SCROLL_JS_TEMPLATE: &str = r#"(() => {
  try {
    var dir = "__XR_DIR__";
    var amount = __XR_AMOUNT__;
    if (dir === "top") window.scrollTo(0, 0);
    else if (dir === "bottom") window.scrollTo(0, document.documentElement.scrollHeight);
    else window.scrollBy(0, dir === "up" ? -amount : amount);
    var max = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
    return JSON.stringify({ ok: true, scrollY: Math.round(window.scrollY), maxScrollY: Math.round(max) });
  } catch (err) {
    return JSON.stringify({ ok: false, error: String((err && err.message) || err) });
  }
})()"#;

/// 后退（导航结果由外层 wait_stable 轮询确认）
pub const BACK_JS: &str = r#"(() => {
  try { history.back(); return JSON.stringify({ ok: true }); }
  catch (err) { return JSON.stringify({ ok: false, error: String((err && err.message) || err) }); }
})()"#;
