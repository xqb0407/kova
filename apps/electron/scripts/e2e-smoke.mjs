/**
 * Electron 渲染层冒烟（CDP 直连，仅测试用）：
 *   node apps/electron/scripts/e2e-smoke.mjs [cdpPort]
 * 校验：kova:// 页面加载、桥标记（__TAURI_INTERNALS__）、invoke 往返、
 * 主界面 DOM 结构、会话列表渲染、渲染层错误日志；并截取渲染内容 PNG。
 */
import { chromium } from "playwright-core";
import { writeFileSync } from "node:fs";

const port = process.argv[2] ?? "9222";
const outPng = process.argv[3] ?? "/tmp/kova-renderer.png";

const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
let page = null;
for (const c of browser.contexts()) {
  for (const p of c.pages()) {
    if (p.url().startsWith("kova://")) page = p;
  }
}
if (!page) {
  console.error("FAIL: no kova:// page found over CDP");
  process.exit(1);
}

const consoleErrors = [];
page.on("console", (m) => {
  if (m.type() === "error") consoleErrors.push(m.text().slice(0, 300));
});
page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${String(e).slice(0, 300)}`));

const info = await page.evaluate(async () => {
  const out = {};
  out.url = location.href;
  out.title = document.title;
  out.hasHost = typeof window.kovaHost === "object" && window.kovaHost !== null;
  out.hasInternals = "__TAURI_INTERNALS__" in window;
  out.bodyChars = (document.body?.innerText ?? "").length;
  // 桥往返：kv_set → kv_get
  try {
    await window.kovaHost.invoke("kv_set", { key: "e2e.probe", value: "hello-" + Date.now() });
    const r = await window.kovaHost.invoke("kv_get", { key: "e2e.probe" });
    out.kvRoundtrip = r?.ok === true ? r.value : { fail: r };
  } catch (e) {
    out.kvRoundtrip = { error: String(e) };
  }
  // 命令面抽样：app 元信息 / 参数缺失错误的形状
  try {
    const v = await window.kovaHost.invoke("bridge_app_version", {});
    out.appVersion = v?.value ?? null;
  } catch (e) {
    out.appVersionErr = String(e);
  }
  try {
    const bad = await window.kovaHost.invoke("no_such_command", {});
    out.unknownCmd = bad;
  } catch (e) {
    out.unknownCmdErr = String(e);
  }
  // 会话列表渲染迹象：侧栏文本与条目数
  const text = document.body?.innerText ?? "";
  out.hasSidebarNewChat = text.includes("新对话");
  out.hasWorkspaceSection = text.includes("我的文件") || text.includes("自动化");
  out.buttons = Array.from(document.querySelectorAll("button"))
    .map((b) => (b.innerText || "").trim())
    .filter(Boolean)
    .slice(0, 24);
  out.textSample = text.slice(0, 260);
  return out;
});

await page.screenshot({ path: outPng, fullPage: false });
writeFileSync("/tmp/kova-e2e-result.json", JSON.stringify({ info, consoleErrors }, null, 2));
console.log(JSON.stringify({ info, consoleErrors }, null, 2));
await browser.close();
