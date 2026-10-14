/**
 * 浏览器面板生命周期冒烟（CDP）：
 *   node apps/electron/scripts/e2e-browser.mjs [cdpPort] [fileUrl]
 * 覆盖 invoke 命令面：browser_attach（建视图+导航）、browser:navigated 事件
 * （started/finished/title）、browser_sync_bounds、viewport set/get roundtrip、
 * browser_detach(destroy)。
 * 注：agent 驱动工具（browser_navigate/click/type…）走 sidecar 工具链，
 * 需模型回合触发，本脚本不覆盖（见 PORTING-NOTES）。
 */
import { chromium } from "playwright-core";

const port = process.argv[2] ?? "9223";
const fileUrl = process.argv[3] ?? "file:///tmp/kova-browser-e2e.html";

const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
let page = null;
for (const c of browser.contexts()) for (const p of c.pages()) if (p.url().startsWith("kova://")) page = p;
if (!page) {
  console.error("FAIL: no kova:// page");
  process.exit(1);
}

const out = await page.evaluate(async (fileUrl) => {
  const res = { events: [] };
  window.kovaHost.eventsOn((m) => {
    if (m.event === "browser:navigated") res.events.push({ url: m.payload?.url, phase: m.payload?.phase });
    if (m.event === "browser:viewport") res.events.push({ phase: `viewport:${m.payload?.mode}`, url: null });
  });
  const call = async (cmd, args = {}) => {
    const r = await window.kovaHost.invoke(cmd, args);
    if (!r?.ok) throw new Error(`${cmd}: ${r?.error}`);
    return r.value;
  };
  await call("browser_attach", { url: fileUrl });
  await new Promise((r) => setTimeout(r, 2500));
  await call("browser_sync_bounds", { x: 40, y: 40, width: 800, height: 600 });
  res.viewportFill = await call("browser_viewport_get");
  await call("browser_viewport_set", { mode: "fixed", width: 1280, height: 800 });
  res.viewportFixed = await call("browser_viewport_get");
  await call("browser_viewport_set", { mode: "fill" });
  res.attachAgainSameUrl = await call("browser_attach", { url: fileUrl });
  await call("browser_detach", { destroy: true });
  return res;
}, fileUrl);

console.log(JSON.stringify(out, null, 2));
await browser.close();
