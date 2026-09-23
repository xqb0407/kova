/**
 * E2E 冒烟宿主：/host.html 用 iframe 挂真实 canvas.html，按 xulux-ui-plugin/1
 * 协议应答 handshake/doc.open/asset.reply，收 doc.export 写盘到 ./out/<filename>。
 * ?deck=v1（默认）故意喂 v1 文档 → 验证迁移；?deck=v2 喂混合文档（objects+draw+页框）。
 * 仅测试用，不入库。
 */
import { mkdirSync, writeFileSync } from "node:fs";

const ROOT = import.meta.dir;
const CANVAS = Bun.file("/Users/herther/Desktop/ai-teamplte/plugins/slide-canvas/canvas.html");
const OUT_DIR = `${ROOT}/out`;
mkdirSync(OUT_DIR, { recursive: true });

/** v1 老文档：面板应自动迁移为 v2（frames 网格落位 + objects=[]）并写回 doc.change */
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
      id: "s2", w: 1280, h: 720, background: "#ffffff",
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

/** v2 混合文档：画布级 objects（含手绘笔迹）+ 自由摆放的两个页框 */
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
      id: "f2", x: 620, y: 920, w: 1280, h: 720, type: "slide", background: "#ffffff",
      elements: [
        { kind: "text", id: "ct2", x: 80, y: 64, w: 900, h: 72, runs: [{ text: "第二页：错落摆放", bold: true, size: 44, color: "#1d1d1f" }] },
        { kind: "image", id: "ci1", src: "e2e.canvas-assets/pic.png", x: 480, y: 220, w: 320, h: 240, fit: "cover", radius: 10 },
      ],
    },
  ],
};

const PNG_1PX =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const hostHtml = (deck: unknown) => `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>e2e host</title></head>
<body style="margin:0">
<iframe id="ui" src="/canvas.html" style="width:100vw;height:100vh;border:0"></iframe>
<script>
const PROTO = "xulux-ui-plugin/1";
const DECK = ${JSON.stringify(JSON.stringify(deck, null, 2))};
const PNG_B64 = ${JSON.stringify(PNG_1PX)};
window.__log = [];
window.__export = null;
window.__saved = null;
window.__notify = [];
window.__changes = [];
const frame = document.getElementById("ui");
function toUI(m) { frame.contentWindow.postMessage({ v: PROTO, dir: "host", ...m }, "*"); }
window.addEventListener("message", (ev) => {
  const d = ev.data;
  if (!d || typeof d !== "object" || d.v !== PROTO || d.dir !== "ui") return;
  window.__log.push(d.kind);
  if (d.kind === "ui.ready") {
    toUI({ kind: "handshake", theme: "light", context: { workspaceName: "e2e", fileRelPath: "e2e.canvas.json" } });
  } else if (d.kind === "doc.request") {
    toUI({ kind: "doc.open", rev: 1, json: DECK, path: "e2e.canvas.json", external: true });
  } else if (d.kind === "doc.change") {
    window.__changes.push(d.json);
  } else if (d.kind === "asset.request") {
    toUI({ kind: "asset.reply", reqId: d.reqId, base64: PNG_B64 });
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
      const deck = url.searchParams.get("deck") === "v2" ? DECK_V2 : DECK_V1;
      return new Response(hostHtml(deck), { headers: { "content-type": "text/html; charset=utf-8" } });
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
