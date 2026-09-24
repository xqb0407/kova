/**
 * E2E 冒烟宿主：/host.html 用 iframe 挂真实 canvas.html，按 xulux-ui-plugin/1
 * 协议应答 handshake/doc.open/asset.reply，收 doc.export 写盘到 ./out/<filename>。
 * ?deck=v1（默认）故意喂 v1 文档 → 验证迁移 + 纯页框自动进幻灯片模式；
 * ?deck=v2 喂混合文档（objects+draw+页框）→ 无记忆时默认白板模式，顶栏可切幻灯片。
 * 仅测试用，不入库。
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

const ROOT = import.meta.dir;
const CANVAS = Bun.file("/Users/herther/Desktop/ai-teamplte/plugins/slide-canvas/canvas.html");
const OUT_DIR = `${ROOT}/out`;
mkdirSync(OUT_DIR, { recursive: true });

/** v1 老文档：面板应自动迁移为 v2（slides→frames，objects=[]）并写回 doc.change；纯页框 → 自动幻灯片模式 */
const DECK_V1 = {
  version: 1,
  meta: { name: "E2E 演示", pagePreset: "16:9" },
  slides: [
    {
      id: "s1", w: 1280, h: 720, background: "#111318",
      elements: [
        {
          kind: "text", id: "t1", x: 128, y: 260, w: 1024, h: 140,
          runs: [{ text: "E2E 演示文稿", bold: true, size: 64, color: "#f5f5f7" }],
          align: "center", vAlign: "middle",
        },
        { kind: "shape", id: "r1", shape: "rect", x: 560, y: 470, w: 160, h: 8, fill: "#0a84ff", radius: 4 },
      ],
    },
    {
      id: "s2", w: 1280, h: 720, background: "#ffffff", transition: "fade",
      elements: [
        { kind: "text", id: "t2", x: 80, y: 64, w: 900, h: 72, runs: [{ text: "流程与图片", bold: true, size: 44, color: "#1d1d1f" }] },
        {
          kind: "mermaid", id: "m1", x: 120, y: 180, w: 620, h: 420,
          code: "graph TD\n  A[需求] --> B[设计]\n  B --> C[实现]\n  C --> D{验收}\n  D -->|通过| E[发布]\n  D -->|不通过| B",
        },
        { kind: "image", id: "i1", src: "e2e.canvas-assets/pic.png", x: 820, y: 240, w: 300, h: 220, fit: "cover", radius: 8 },
      ],
    },
  ],
};

/** v2 混合文档：白板 objects（含手绘笔迹）+ 两个页框（幻灯片模式逐页编辑，x/y 仅存档） */
const DECK_V2 = {
  version: 2,
  meta: { name: "E2E 混合", pagePreset: "16:9" },
  objects: [
    {
      kind: "text", id: "n0", x: -420, y: 160, w: 360, h: 60,
      runs: [{ text: "讨论区：涂鸦不进导出", size: 22, color: "#ff9f0a" }],
    },
    {
      kind: "draw", id: "n1", x: -40, y: 300, w: 200, h: 80,
      points: [[0, 40], [24, 10], [70, 0], [130, 8], [180, 34], [200, 62], [150, 78], [80, 80], [26, 66], [0, 40]],
      stroke: "#ff9f0a", strokeWidth: 3,
    },
    { kind: "shape", id: "n2", shape: "arrow", x: 180, y: 320, w: 140, h: 40, stroke: "#ff9f0a", strokeWidth: 3 },
  ],
  frames: [
    {
      id: "f1", x: 380, y: 80, w: 1280, h: 720, type: "slide", name: "封面", background: "#111318",
      elements: [
        {
          kind: "text", id: "ct1", x: 128, y: 260, w: 1024, h: 140,
          runs: [{ text: "V2 混合文档", bold: true, size: 64, color: "#f5f5f7" }],
          align: "center", vAlign: "middle",
        },
        {
          kind: "draw", id: "cd1", x: 480, y: 460, w: 320, h: 36,
          points: Array.from({ length: 33 }, (_, i) => [i * 10, 18 + Math.round(14 * Math.sin(i / 3.2))]),
          stroke: "#0a84ff", strokeWidth: 4,
        },
      ],
    },
    {
      id: "f2", x: 620, y: 920, w: 1280, h: 720, type: "slide", background: "linear-gradient(135deg,#0a84ff55,#5a5100ff 60%,#111318)",
      elements: [
        { kind: "text", id: "ct2", x: 80, y: 64, w: 900, h: 72, runs: [{ text: "第二页：错落摆放", bold: true, size: 44, color: "#1d1d1f" }] },
        { kind: "image", id: "ci1", src: "e2e.canvas-assets/pic.png", x: 480, y: 220, w: 320, h: 240, fit: "cover", radius: 10 },
      ],
    },
  ],
};

/**
 * 素材图：640×360 非对称图案（渐变+四角标记+对角线+白边框）。
 * 刻意不用 1×1 纯色——纯色拉伸后仍是纯色，检测不到 cover/contain/stretch 裁切几何差异，
 * 而 1×1 半透明源在 DOM(GPU 最近邻) 与 leafer(canvas 双线性) 下永远对不齐。
 */
/** 纯幻灯片两页（deck 模式）：第二页长渐变背景——验证页面板「取色」行不横向溢出 */
const DECK_GRAD = {
  version: 2,
  meta: { name: "E2E 渐变", pagePreset: "16:9" },
  objects: [],
  frames: [
    { id: "g1", x: 0, y: 0, w: 1280, h: 720, type: "slide", name: "第一页", background: "#ffffff", elements: [] },
    {
      id: "g2", x: 0, y: 800, w: 1280, h: 720, type: "slide", name: "第二页",
      background: "linear-gradient(135deg,#0a84ff55,#5a5100ff 60%,#111318)",
      elements: [],
    },
  ],
};

const PNG_ASSET_B64 = readFileSync(`${ROOT}/pic640.png`).toString("base64");

/** 全空文档：验证白板空态提示与幻灯片 0 页空态 */
const DECK_BLANK = { version: 2, meta: { name: "E2E 空白", pagePreset: "16:9" }, objects: [], frames: [] };

/** embed + svg 新元素（白板）：iframe 网页嵌入（双击交互）+ 内嵌 SVG 源码 */
const DECK_EMBED = {
  version: 2,
  meta: { name: "E2E 嵌入", pagePreset: "16:9", kind: "board" },
  objects: [
    { kind: "text", id: "e0", x: 0, y: -70, w: 480, h: 48,
      runs: [{ text: "svg 元素（源码进档，矢量导出）", size: 22, color: "#1d1d1f" }] },
    {
      kind: "svg", id: "e1", x: 0, y: 0, w: 480, h: 360,
      code: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 180"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#166534"/><stop offset="1" stop-color="#0a84ff"/></linearGradient></defs><rect width="240" height="180" rx="16" fill="url(#g)"/><circle cx="70" cy="70" r="30" fill="#f4f692"/><circle cx="170" cy="110" r="44" fill="#ffffff" opacity="0.85"/><path d="M20 150 Q70 120 120 150 T220 150" stroke="#ffffff" stroke-width="6" fill="none" stroke-linecap="round"/><text x="120" y="36" text-anchor="middle" font-family="sans-serif" font-size="16" fill="#ffffff">SVG 元素</text></svg>',
    },
    { kind: "text", id: "e2", x: 560, y: -70, w: 640, h: 48,
      runs: [{ text: "embed 元素（双击进网页交互，Esc 退出）", size: 22, color: "#1d1d1f" }] },
    { kind: "embed", id: "e3", url: "https://www.youtube.com/watch?v=aqz-KE-bpKQ",
      x: 560, y: 0, w: 640, h: 400, title: "Big Buck Bunny" },
    { kind: "text", id: "e4", x: 0, y: 430, w: 480, h: 48,
      runs: [{ text: "动画 SVG（SMIL/CSS 应在播放）", size: 22, color: "#1d1d1f" }] },
    {
      kind: "svg", id: "e5", x: 0, y: 490, w: 480, h: 200,
      code: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 100"><rect width="240" height="100" rx="12" fill="#0e0f0c"/><circle r="14" fill="#9fe870" cx="40" cy="50"><animate attributeName="cx" values="40;200;40" dur="1.2s" repeatCount="indefinite"/></circle><rect x="205" y="35" width="30" height="30" rx="6" fill="#0a84ff"><animateTransform attributeName="transform" type="rotate" from="0 220 50" to="360 220 50" dur="2s" repeatCount="indefinite"/></rect></svg>',
    },
  ],
  frames: [],
};

/** embed + svg 新元素（幻灯片）：走导出etrack（pptx 占位+链接 / svg 链接卡 / html 活 iframe） */
const DECK_EMBED_DECK = {
  version: 2,
  meta: { name: "E2E 嵌入页", pagePreset: "16:9", kind: "deck" },
  objects: [],
  frames: [
    {
      id: "ef1", x: 0, y: 0, w: 1280, h: 720, type: "slide", name: "嵌入页", background: "#ffffff",
      elements: [
        { kind: "text", id: "et1", x: 80, y: 48, w: 900, h: 72,
          runs: [{ text: "嵌入元素演示", bold: true, size: 44, color: "#1d1d1f" }] },
        { kind: "svg", id: "es1", x: 80, y: 180, w: 480, h: 360,
          code: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 180"><rect width="240" height="180" rx="16" fill="#166534"/><circle cx="70" cy="70" r="30" fill="#f4f692"/><circle cx="170" cy="110" r="44" fill="#ffffff" opacity="0.85"/></svg>' },
        { kind: "embed", id: "ee1", url: "https://www.youtube.com/watch?v=aqz-KE-bpKQ",
          x: 640, y: 180, w: 560, h: 340, title: "产品视频" },
      ],
    },
  ],
};

const hostHtml = (deck: unknown, theme: string) => `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>e2e host</title></head>
<body style="margin:0;overflow:hidden">
<iframe id="ui" src="/canvas.html" style="width:100%;height:100vh;border:0"></iframe>
<script>
const PROTO = "xulux-ui-plugin/1";
const DECK = ${JSON.stringify(JSON.stringify(deck, null, 2))};
// 首页"历史卡片墙"用的假工作区：两份固定档（多份便于验证卡片点击与类型徽标）
const DOC_A = ${JSON.stringify(JSON.stringify(DECK_V1, null, 2))};
const DOC_B = ${JSON.stringify(JSON.stringify(DECK_V2, null, 2))};
const PNG_B64 = ${JSON.stringify(PNG_ASSET_B64)};
window.__log = [];
window.__export = null;
window.__saved = null;
window.__notify = [];
window.__changes = [];
window.__prefill = null;
window.__rev = 1;
window.__docs = {};
window.__docs["示例/演示文稿.canvas.json"] = { json: DOC_A };
window.__docs["示例/白板.canvas.json"] = { json: DOC_B };
window.__noDoc = new URLSearchParams(location.search).get("home") === "1";
window.__boundPath = window.__noDoc ? null : "e2e.canvas.json";
window.__summarize = (path, rec) => {
  const d = typeof rec.json === "string" ? JSON.parse(rec.json) : rec.json || {};
  const meta = d.meta || {};
  const frames = Array.isArray(d.frames) ? d.frames : Array.isArray(d.slides) ? d.slides : [];
  const objects = Array.isArray(d.objects) ? d.objects : [];
  const kind = meta.kind === "deck" || meta.kind === "board" || meta.kind === "ui" ? meta.kind : (frames.length > 0 && objects.length === 0 ? "deck" : "board");
  return {
    path,
    name: String(meta.name || path.split("/").pop().replace(/\.canvas\.json$/i, "")),
    kind,
    mtime: 0,
    frames: frames.length,
    objects: objects.length,
    preview: frames.slice(0, 24).map((f) => ({ x: f.x || 0, y: f.y || 0, w: f.w || 1280, h: f.h || 720, bg: f.background || "#ffffff" })),
  };
};
const frame = document.getElementById("ui");
function toUI(m) { frame.contentWindow.postMessage({ v: PROTO, dir: "host", ...m }, "*"); }
window.addEventListener("message", (ev) => {
  const d = ev.data;
  if (!d || typeof d !== "object" || d.v !== PROTO || d.dir !== "ui") return;
  window.__log.push(d.kind);
  if (d.kind === "ui.ready") {
    toUI({ kind: "handshake", theme: ${JSON.stringify(theme)}, context: { workspaceName: "e2e", fileRelPath: window.__noDoc ? null : "e2e.canvas.json" } });
    toUI({ kind: "theme.update", theme: ${JSON.stringify(theme)} });
  } else if (d.kind === "doc.request") {
    if (window.__noDoc || !window.__boundPath) {
      toUI({ kind: "doc.error", errorText: "面板尚未绑定文档文件" });
    } else {
      const rec = window.__docs[window.__boundPath];
      toUI({ kind: "doc.open", rev: ++window.__rev, json: rec ? rec.json : DECK, path: window.__boundPath, external: true });
    }
  } else if (d.kind === "doc.list") {
    const items = Object.keys(window.__docs).map((path) => window.__summarize(path, window.__docs[path]));
    toUI({ kind: "doc.list.reply", reqId: d.reqId, items });
  } else if (d.kind === "doc.bind") {
    if (window.__docs[d.path]) {
      window.__boundPath = d.path;
      window.__noDoc = false;
      window.__log.push("doc.bind:" + d.path);
      toUI({ kind: "doc.open", rev: ++window.__rev, json: window.__docs[d.path].json, path: d.path });
    } else {
      toUI({ kind: "doc.error", errorText: "打不开：" + d.path });
    }
  } else if (d.kind === "doc.create") {
    window.__docs[d.path] = { json: d.json };
    window.__boundPath = d.path;
    window.__noDoc = false;
    window.__log.push("doc.create:" + d.path);
    toUI({ kind: "doc.open", rev: ++window.__rev, json: d.json, path: d.path });
  } else if (d.kind === "doc.change") {
    window.__changes.push(d.json);
  } else if (d.kind === "asset.request") {
    toUI({ kind: "asset.reply", reqId: d.reqId, base64: PNG_B64 });
  } else if (d.kind === "agent.prefill") {
    window.__prefill = d.text;
  } else if (d.kind === "ui.notify") {
    window.__notify.push(d.text);
  } else if (d.kind === "doc.export") {
    window.__export = { filename: d.filename, b64len: d.base64.length };
    fetch("/save?name=" + encodeURIComponent(d.filename), { method: "POST", body: d.base64 })
      .then((r) => r.text()).then((t) => { window.__saved = t; });
  }
});
</script></body></html>`;

const server = Bun.serve({
  port: 8937,
  hostname: "127.0.0.1",
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/host.html") {
      const q = url.searchParams.get("deck");
      const deck =
        q === "v2" ? DECK_V2 : q === "grad" ? DECK_GRAD : q === "blank" ? DECK_BLANK : q === "embed" ? DECK_EMBED : q === "embeddeck" ? DECK_EMBED_DECK : DECK_V1;
      const theme = url.searchParams.get("theme") === "dark" ? "dark" : "light";
      return new Response(hostHtml(deck, theme), { headers: { "content-type": "text/html; charset=utf-8" } });
    }
    if (url.pathname === "/canvas.html") {
      return new Response(CANVAS, { headers: { "content-type": "text/html; charset=utf-8" } });
    }
    if (url.pathname === "/save") {
      const name = url.searchParams.get("name") ?? "export.bin";
      const b64 = await req.text();
      const safe = name.replace(/[^\w.\-一-鿿]/g, "_");
      Bun.write(`${OUT_DIR}/${safe}`, Buffer.from(b64, "base64"));
      writeFileSync(`${OUT_DIR}/${safe}.check`, String(b64.length));
      return new Response(`saved ${safe}`);
    }
    if (url.pathname === "/health") return new Response("ok");
    return new Response("not found", { status: 404 });
  },
});
console.log("e2e host on http://127.0.0.1:8937/host.html");
