/**
 * 内置浏览器端到端冒烟（仅开发构建；CDP 直连）：
 *   node apps/electron/scripts/e2e-browser.mjs [cdpPort] [fixturePath]
 *
 * 覆盖：browser_open_panel → guest 绑定（属主）→ 结构化快照 → CDP 可信点击 →
 * evaluate → 权限默认拒绝 → JS dialog（confirm）→ browser_dialog 接受 →
 * 活页面截图。
 *
 * 前提：应用处于开发构建（browser_debug_* 命令在打包版会拒绝），且已打开一个
 * 会话（面板需要当前会话指针才能开标签）。fixture 必须位于受信根
 * （task-workspace / workspace / 资料库）内；默认写入 task-workspace。
 */
import { chromium } from "playwright-core";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const port = process.argv[2] ?? "9223";

function appDataDir() {
  if (process.env.KOVA_DATA_DIR) return process.env.KOVA_DATA_DIR;
  if (process.platform === "win32") {
    return join(process.env.APPDATA ?? homedir(), "com.kova.assistant.dev");
  }
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", "com.kova.assistant.dev");
  }
  return join(
    process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"),
    "com.kova.assistant.dev",
  );
}

const fixturePath =
  process.argv[3] ?? join(appDataDir(), "task-workspace", "e2e-browser.html");
mkdirSync(join(fixturePath, ".."), { recursive: true });
writeFileSync(
  fixturePath,
  `<!doctype html>
<meta charset="utf-8">
<title>Kova Browser E2E</title>
<h1>Kova browser e2e</h1>
<button id="change">Change text</button>
<p id="status">idle</p>
<button id="confirm">Confirm</button>
<script>
  document.getElementById("change").addEventListener("click", () => {
    document.getElementById("status").textContent = "changed";
  });
  document.getElementById("confirm").addEventListener("click", () => {
    document.getElementById("status").textContent = confirm("Proceed?") ? "accepted" : "dismissed";
  });
</script>
`,
  "utf8",
);

const fileUrl = pathToFileURL(fixturePath).href;

const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
const devUrl = process.env.KOVA_DEV_URL ?? "http://localhost:3000";
const isAppPage = (url) =>
  url.startsWith("kova://") ||
  url.startsWith(devUrl) ||
  /^https?:\/\/(localhost|127\.0\.0\.1):3000\//.test(url);
let page = null;
for (const context of browser.contexts()) {
  for (const candidate of context.pages()) {
    if (isAppPage(candidate.url())) page = candidate;
  }
}
if (!page) {
  console.error("FAIL: no kova:// or dev renderer page found over CDP");
  process.exit(1);
}

const result = await page.evaluate(async ({ fileUrl }) => {
  const out = { steps: [] };
  const invoke = async (cmd, args = {}) => {
    const res = await window.kovaHost.invoke(cmd, args);
    if (!res?.ok) throw new Error(`${cmd}: ${res?.error}`);
    return res.value;
  };
  const raw = (cmd, args = {}) => window.kovaHost.invoke(cmd, args);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  await invoke("browser_open_panel", { url: fileUrl });
  out.steps.push("open-panel");

  let state = null;
  for (let i = 0; i < 40; i += 1) {
    state = await invoke("browser_debug_state");
    if (state?.owner && state?.guestId && state.url) break;
    await sleep(250);
  }
  if (!state?.owner || !state?.guestId) {
    throw new Error(
      `browser panel did not bind a guest (is a conversation open?): ${JSON.stringify(state)}`,
    );
  }
  out.state = state;
  out.steps.push("guest-bound");

  const tool = async (name, params = {}) => {
    const value = await invoke("browser_debug_tool", {
      name,
      params,
      threadId: state.owner,
    });
    if (typeof value?.output !== "string") {
      throw new Error(`${name}: missing output (${JSON.stringify(value)})`);
    }
    return value.output;
  };
  const refFor = (snapshot, label) => {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = snapshot.match(
      new RegExp(`- (?:button|link) "${escaped}" \\[ref=(e\\d+)\\]`),
    );
    return match ? match[1] : null;
  };

  // 复用已有面板时可能残留上一次运行的 dialog：先收掉再刷新到干净态。
  try {
    await raw("browser_debug_tool", {
      name: "browser_dialog",
      params: { accept: true },
      threadId: state.owner,
    });
  } catch {
    /* 没有 dialog：忽略 */
  }
  await tool("browser_reload");

  const snap = await tool("browser_snapshot");
  if (!snap.includes("Kova browser e2e")) {
    throw new Error(`snapshot missing fixture heading:\n${snap.slice(0, 800)}`);
  }
  out.steps.push("snapshot");

  const changeRef = refFor(snap, "Change text");
  if (!changeRef) throw new Error(`change button ref not found:\n${snap.slice(0, 800)}`);
  const afterClick = await tool("browser_click", { ref: changeRef });
  if (!afterClick.includes("changed")) {
    throw new Error(`click did not change status:\n${afterClick.slice(0, 800)}`);
  }
  out.steps.push("cdp-click");

  const title = await tool("browser_evaluate", { expression: "document.title" });
  if (!title.includes("Kova Browser E2E")) {
    throw new Error(`evaluate returned unexpected title: ${title}`);
  }
  out.steps.push("evaluate");

  const permission = await tool("browser_evaluate", {
    expression:
      'navigator.permissions.query({ name: "geolocation" }).then((p) => p.state)',
  });
  if (!permission.includes("denied")) {
    throw new Error(`geolocation should be denied by default, got: ${permission}`);
  }
  out.steps.push("permission-default-deny");

  const confirmRef = refFor(afterClick, "Confirm");
  if (!confirmRef) {
    throw new Error(`confirm button ref not found:\n${afterClick.slice(0, 800)}`);
  }
  // agent 的 CDP 点击不产生 user activation，confirm 会被 Chromium 压掉：
  // 弹窗流程由 browser_evaluate（userGesture el.click()）显式触发。
  const confirmClick = await raw("browser_debug_tool", {
    name: "browser_evaluate",
    params: {
      expression: `window.__kovaRefs.get(${JSON.stringify(confirmRef)}).click(); "clicked"`,
    },
    threadId: state.owner,
  });
  if (confirmClick?.ok) {
    throw new Error(
      `confirm evaluate should report an open JavaScript dialog; output=${JSON.stringify(
        confirmClick.value,
      ).slice(0, 1200)}`,
    );
  }
  if (!String(confirmClick?.error ?? "").includes("browser_dialog")) {
    throw new Error(`confirm evaluate did not point at browser_dialog: ${confirmClick?.error}`);
  }
  const dialogState = await tool("browser_state");
  if (!dialogState.includes("dialog: confirm")) {
    throw new Error(`dialog state missing:\n${dialogState}`);
  }
  const accepted = await tool("browser_dialog", { accept: true });
  if (!accepted.includes("accepted")) {
    throw new Error(`dialog accept did not land:\n${accepted.slice(0, 800)}`);
  }
  out.steps.push("dialog");

  const shot = await invoke("browser_debug_tool", {
    name: "browser_shot",
    params: { maxDim: 1200, format: "jpeg", quality: 80 },
    threadId: state.owner,
  });
  if (typeof shot?.base64 !== "string" || shot.base64.length < 1000) {
    throw new Error(`live screenshot missing payload: ${JSON.stringify(shot).slice(0, 200)}`);
  }
  out.shot = { bytes: shot.bytes, width: shot.width, height: shot.height };
  out.steps.push("live-screenshot");

  out.ok = true;
  return out;
}, { fileUrl });

console.log(JSON.stringify(result, null, 2));
await browser.close();
if (!result?.ok) process.exit(1);
