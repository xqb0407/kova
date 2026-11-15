/**
 * 资料库 HTML 预览（kova://file 直出）注入的脚本：查找引擎 + 右键菜单上报。
 *
 * 预览 iframe 是 sandbox（无 allow-same-origin）跨源文档，宿主渲染进程的
 * JS 摸不到内部 DOM——Ctrl+F 查找与右键「复制」都只能由文档自身提供。
 * 主进程在 kova://file 返回 .html/.htm 时把这段脚本追加到响应体末尾
 * （不改原字节——见 index.ts），脚本自毁式幂等安装，页面自带脚本不受影响。
 *
 * 协议（window ↔ iframe，双向 postMessage）：
 *  查找 宿主 → iframe：{ __kovaFind: true, type: "search"|"clear", query?, index?, seq? }
 *  查找 iframe → 宿主：{ __kovaFindResult: true, ready?: true }
 *                      { __kovaFindResult: true, seq, count }
 *  右键 iframe → 宿主：{ __kovaContext: true, x, y, selection }
 *                      （x/y 是 iframe 视口坐标；选区文本由子文档读取后上报，
 *                       父文档拿不到跨源选区，复制动作在父侧完成）
 * seq 对不上号的是旧请求迟到回包，宿主丢弃；ready 在每次文档加载完成发送。
 *
 * 高亮用 CSS Custom Highlight API（Electron 44 / Chromium 支持），不往
 * 页面 DOM 插任何节点——用户页面的脚本/布局完全无感。样式运行时注入
 * <style>，琥珀两档（全部命中 / 当前命中），暗色自适应页面 .dark 类。
 */

export const PREVIEW_INJECT_SCRIPT = `(function(){"use strict";
if (window.__kovaFindInstalled) return;
window.__kovaFindInstalled = true;

var ALL = "kova-find-all";
var CUR = "kova-find-cur";
var MAX_RANGES = 4000;

function reg() {
  try { return window.CSS && window.CSS.highlights; } catch (e) { return null; }
}
function HighlightCtor() {
  try { return window.Highlight || null; } catch (e) { return null; }
}

function ensureStyle() {
  if (document.getElementById("kova-find-style")) return;
  var s = document.createElement("style");
  s.id = "kova-find-style";
  s.textContent = "::highlight(" + ALL + "){background-color:rgba(245,185,66,.45);color:inherit}" +
    "::highlight(" + CUR + "){background-color:rgba(245,140,26,.75);color:#000}" +
    ".dark ::highlight(" + ALL + "){background-color:rgba(245,185,66,.28);color:inherit}" +
    ".dark ::highlight(" + CUR + "){background-color:rgba(245,140,26,.55);color:#fff}";
  (document.head || document.documentElement).appendChild(s);
}

function clear() {
  var r = reg();
  if (r) { r.delete(ALL); r.delete(CUR); }
}

/* Flattened text scan: collect per-hit start offsets + total count */
function scan(root, query) {
  var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: function(n) {
      var p = n.parentElement;
      if (!p || p.closest("script,style,noscript")) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    }
  });
  var nodes = [], starts = [], text = "";
  for (var n = walker.nextNode(); n; n = walker.nextNode()) {
    starts.push(text.length); nodes.push(n); text += n.data;
  }
  var lower = text.toLowerCase(), q = query.toLowerCase();
  var hits = [], count = 0;
  for (var at = lower.indexOf(q); at >= 0; at = lower.indexOf(q, at + q.length)) {
    if (hits.length < MAX_RANGES) hits.push(at);
    count++;
  }
  return { nodes: nodes, starts: starts, hits: hits, count: count, qLen: query.length };
}

function locate(nodes, starts, off) {
  for (var i = 0; i < nodes.length; i++) {
    var len = nodes[i].data.length;
    if (off <= starts[i] + len) return { node: nodes[i], offset: off - starts[i] };
  }
  return null;
}

function apply(query, index) {
  var r = reg(), H = HighlightCtor();
  if (!r || !H) return 0;
  var s = scan(document.body || document.documentElement, query);
  if (!s.count) { clear(); return 0; }
  var ranges = [];
  for (var i = 0; i < s.hits.length; i++) {
    var a = locate(s.nodes, s.starts, s.hits[i]);
    var b = locate(s.nodes, s.starts, s.hits[i] + s.qLen);
    if (!a || !b) continue;
    var rg = document.createRange();
    rg.setStart(a.node, a.offset);
    rg.setEnd(b.node, b.offset);
    ranges.push(rg);
  }
  if (!ranges.length) { clear(); return 0; }
  ensureStyle();
  r.set(ALL, new H(...ranges));
  var idx = Math.min(Math.max(index, 0), ranges.length - 1);
  r.set(CUR, new H(ranges[idx]));
  var el = ranges[idx];
  var box = el.getBoundingClientRect();
  if (box.height || box.width) {
    var sc = el.startContainer.parentElement;
    while (sc) {
      if (sc.scrollHeight > sc.clientHeight + 4 &&
          getComputedStyle(sc).overflowY !== "visible") {
        sc.scrollTop += box.top - sc.getBoundingClientRect().top - 64;
        break;
      }
      sc = sc.parentElement;
    }
  }
  return s.count;
}

window.addEventListener("message", function(ev) {
  if (ev.source !== window.parent) return;
  var d = ev.data;
  if (!d || d.__kovaFind !== true) return;
  if (d.type === "clear") { clear(); return; }
  if (d.type === "search" && typeof d.query === "string") {
    // Same rule as the host DOM backend: ignore whitespace-only queries
    var q = d.query.trim();
    if (!q) return;
    var count = apply(q, d.index || 0);
    try {
      window.parent.postMessage({ __kovaFindResult: true, seq: d.seq, count: count }, "*");
    } catch (e) { /* host switched preview: nobody receives the reply */ }
  }
});

function announce() {
  try {
    window.parent.postMessage({ __kovaFindResult: true, ready: true }, "*");
  } catch (e) { /* same as above */ }
}
if (document.readyState === "complete") announce();
else window.addEventListener("load", announce);

/* Context menu: parent cannot read a cross-origin iframe selection, so
   report the click point + selected text upward; the parent renders the
   menu and writes the clipboard. Skip when the host page already handled
   the event (defaultPrevented) to respect its own interactions. */
document.addEventListener("contextmenu", function(ev) {
  if (ev.defaultPrevented) return;
  var selection = "";
  try { selection = String(window.getSelection() || ""); } catch (e) {}
  try {
    window.parent.postMessage({
      __kovaContext: true,
      x: ev.clientX,
      y: ev.clientY,
      selection: selection
    }, "*");
  } catch (e) { /* host navigated away: nobody receives it */ }
});
})();
`;
