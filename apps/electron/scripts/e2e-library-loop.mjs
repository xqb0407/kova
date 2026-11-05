/**
 * 资料库闭环冒烟（CDP 直连，只读）：
 *   node apps/electron/scripts/e2e-library-loop.mjs [cdpPort]
 *
 * 前置：Electron 以 --remote-debugging-port 启动（同 e2e-smoke）。
 * 校验：桥命令面（library_get_root / library_scan / file_meta / knowledge_refs_stats）、
 * 资料库页可进入、搜索框与文件树就位、composer 存在。
 * 不写库、不改资料库内容——视觉/交互细节走 docs/e2e/library-loop/ACCEPTANCE.md。
 */
import { chromium } from "playwright-core";
import { writeFileSync } from "node:fs";

const port = process.argv[2] ?? "9222";

const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
let page = null;
for (const context of browser.contexts()) {
  for (const candidate of context.pages()) {
    if (candidate.url().startsWith("kova://")) page = candidate;
  }
}
if (!page) {
  console.error("FAIL: no kova:// page found over CDP");
  process.exit(1);
}

const errors = [];
page.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text().slice(0, 300));
});
page.on("pageerror", (e) => errors.push(`pageerror: ${String(e).slice(0, 300)}`));

const bridge = await page.evaluate(async () => {
  const call = async (cmd, args = {}) => {
    try {
      const res = await window.kovaHost.invoke(cmd, args);
      return res?.ok ? res.value : { error: res?.error ?? "failed" };
    } catch (error) {
      return { error: String(error) };
    }
  };
  const root = await call("library_get_root");
  const scan = await call("library_scan", {});
  const meta = await call("library_file_meta_list", {
    root: root?.root ?? "",
  });
  const stats = await call("knowledge_refs_stats", {
    source: "library",
    scopeId: root?.root ?? "",
    path: "__e2e_probe_never_exists__",
  });
  return {
    host: typeof window.kovaHost === "object" && window.kovaHost !== null,
    root,
    scan: {
      entries: Array.isArray(scan?.entries) ? scan.entries.length : null,
      truncated: scan?.truncated ?? null,
      error: scan?.error ?? null,
    },
    meta: {
      rootMissing: meta?.rootMissing ?? null,
      entries: Array.isArray(meta?.entries) ? meta.entries.length : null,
      error: meta?.error ?? null,
    },
    stats,
  };
});

// composer 只在聊天页存在：进资料库前先记一笔
const chatDom = await page.evaluate(() => ({
  composer: Boolean(document.querySelector(".cm-content")),
}));

// 进入资料库页：侧栏菜单项文案是「资料库」
const clickedLibrary = await page.evaluate(() => {
  const nodes = Array.from(
    document.querySelectorAll('button, a, [role="button"]'),
  );
  const item = nodes.find(
    (node) => (node.textContent ?? "").trim() === "资料库",
  );
  if (!item) return false;
  item.click();
  return true;
});
await page.waitForTimeout(600);

const dom = await page.evaluate(() => {
  const search = Array.from(document.querySelectorAll("input")).find(
    (input) => input.getAttribute("placeholder") === "搜索笔记与文件…",
  );
  return {
    searchInput: Boolean(search),
    tree: Boolean(document.querySelector('[aria-label="资料库文件"]')),
  };
});

await page.screenshot({ path: "/tmp/kova-library-loop.png" });

const failures = [];
if (!bridge.host) failures.push("bridge missing");
if (!bridge.root?.root) failures.push("library_root missing");
if (bridge.root?.exists === false) failures.push("library root missing on disk");
if (bridge.scan?.error) failures.push(`library_scan: ${bridge.scan.error}`);
if (bridge.scan?.entries === null) failures.push("library_scan shape");
if (bridge.meta?.error) failures.push(`file_meta: ${bridge.meta.error}`);
if (bridge.stats?.count !== 0) failures.push("knowledge_refs_stats probe");
if (!clickedLibrary) failures.push("sidebar 资料库 item not found");
if (!dom.searchInput) failures.push("library search input not found");
if (!dom.tree) failures.push("library file tree not found");
if (!chatDom.composer) failures.push("composer not found");

const result = {
  bridge,
  clickedLibrary,
  chatDom,
  dom,
  consoleErrors: errors,
  failures,
};
writeFileSync(
  "/tmp/kova-library-loop-result.json",
  JSON.stringify(result, null, 2),
);
console.log(JSON.stringify(result, null, 2));

await browser.close();
process.exit(failures.length === 0 ? 0 : 1);
