#!/usr/bin/env node
/**
 * 图片能力三态 e2e（隔离数据目录 + 真实 sidecar + 真实渲染层 + 本地 mock provider）。
 *
 *   node apps/electron/scripts/e2e-media-capability.mjs
 *   或 bun run --filter kova-electron-main e2e:media
 *
 * 覆盖：
 *  1. 模型明确 input=["text"]：provider request 不含 image_url，包含带附件标识的
 *     中性占位（[Attached image/png: [image #1]] + Media omitted...）。
 *  2. 模型未声明输入能力（input_json=NULL）：首次请求带 image_url；mock 返回
 *     400 拒图后，sidecar 剥图重试，第二次请求落中性占位，会话正常完成。
 *
 * 前置：依赖已安装（playwright-core / electron）、bun 在 PATH（或 BUN_BIN）；
 * 渲染层优先复用 localhost:3000 的 next dev。
 */
import { execFileSync, spawn } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repo = resolve(scriptDir, "../../..");
const electronDir = join(repo, "apps", "electron");
const sidecarDir = join(repo, "apps", "sidecar", "pi-agent");
const devUrl = process.env.KOVA_DEV_URL ?? "http://localhost:3000";
const PROMPT = "E2E_IMAGE_PROBE";
const ASSISTANT_TEXT = "E2E_OK";
const MEDIA_OMITTED_NOTE =
  "[Media omitted from provider request because the selected model does not support image input.]";
const PNG_1X1 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const keep = process.env.KEEP === "1";

function resolveBun() {
  if (process.env.BUN_BIN) return resolve(process.env.BUN_BIN);
  if (process.versions.bun) return process.execPath;
  try {
    return execFileSync(process.platform === "win32" ? "where" : "which", ["bun"], {
      encoding: "utf8",
    })
      .split(/\r?\n/)[0]
      .trim();
  } catch {
    return "";
  }
}
const bunBin = resolveBun();
const requireFromRepo = createRequire(join(repo, "package.json"));
const { _electron } = requireFromRepo("playwright-core");
const requireFromElectron = createRequire(join(electronDir, "package.json"));
const electronPath = requireFromElectron("electron");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const assert = (cond, message) => {
  if (!cond) throw new Error(message);
};

async function reachable() {
  try {
    const res = await fetch(devUrl, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

let nextProc = null;
async function ensureDevServer() {
  if (await reachable()) {
    console.log(`[e2e] reuse dev server: ${devUrl}`);
    return;
  }
  console.log(`[e2e] starting next dev on ${devUrl} ...`);
  nextProc = spawn("bun", ["run", "--filter", "desktop", "dev"], {
    cwd: repo,
    stdio: "inherit",
    detached: process.platform !== "win32",
  });
  for (let i = 0; i < 120; i += 1) {
    if (await reachable()) return;
    await sleep(1000);
  }
  throw new Error(`next dev did not become reachable at ${devUrl}`);
}

function stopDevServer() {
  if (!nextProc) return;
  try {
    if (process.platform === "win32") {
      execFileSync("taskkill", ["/T", "/F", "/PID", String(nextProc.pid)], {
        stdio: "ignore",
      });
    } else {
      process.kill(-nextProc.pid, "SIGTERM");
    }
  } catch {
    /* already exited */
  }
  nextProc = null;
}

function ensureElectronMain() {
  const out = join(electronDir, "dist", "main.cjs");
  if (existsSync(out)) return;
  console.log("[e2e] building electron main ...");
  execFileSync("node", ["scripts/build.mjs"], { cwd: electronDir, stdio: "inherit" });
}

/** 本地 OpenAI-compatible mock：记录请求；未知能力场景首图请求返回 400。 */
function startMockServer({ rejectFirstImage }) {
  const requests = [];
  let rejectedImageRequests = 0;
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => {
      let body = null;
      try {
        body = JSON.parse(raw);
      } catch {
        body = raw;
      }
      requests.push(body);
      const serialized = JSON.stringify(body);
      const hasImage = serialized.includes('"image_url"');
      const hasProbe = serialized.includes(PROMPT);
      // 拒绝所有带图探测请求（标题生成等旁路请求也可能先到），直到请求侧剥图；
      // 上限防止实现异常时无限重试。
      if (hasProbe && rejectFirstImage && hasImage && rejectedImageRequests < 5) {
        rejectedImageRequests += 1;
        res.writeHead(400, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            error: { message: "The selected model does not support image input." },
          }),
        );
        return;
      }
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      const now = Math.floor(Date.now() / 1000);
      const chunk = (delta, finish = null) =>
        `data: ${JSON.stringify({
          id: "chatcmpl-e2e",
          object: "chat.completion.chunk",
          created: now,
          model: body?.model ?? "e2e",
          choices: [{ index: 0, delta, finish_reason: finish }],
        })}\n\n`;
      res.write(chunk({ role: "assistant", content: ASSISTANT_TEXT }));
      res.write(chunk({}, "stop"));
      res.write(
        `data: ${JSON.stringify({
          id: "chatcmpl-e2e",
          object: "chat.completion.chunk",
          created: now,
          model: body?.model ?? "e2e",
          choices: [],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        })}\n\n`,
      );
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  return new Promise((resolveServer) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolveServer({
        requests,
        port: address.port,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

function seedDataDir(dataDir, providerPort, modelId, inputJson) {
  // 用 bun:sqlite 建隔离库：e2e 已要求 bun，避免额外依赖宿主 Node 版本的
  // node:sqlite 可用性。
  const seedScript = `
const { Database } = require("bun:sqlite");
const db = new Database(process.env.E2E_DB_PATH);
db.exec(\`
  CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS custom_providers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    base_url TEXT NOT NULL,
    models TEXT NOT NULL DEFAULT '[]',
    api TEXT NOT NULL DEFAULT 'openai-chat',
    enabled INTEGER NOT NULL DEFAULT 1,
    auto_discover INTEGER NOT NULL DEFAULT 0,
    headers TEXT NOT NULL DEFAULT '{}'
  );
  CREATE TABLE IF NOT EXISTS models (
    provider TEXT NOT NULL,
    model_id TEXT NOT NULL,
    name TEXT,
    reasoning INTEGER,
    context_window INTEGER,
    max_tokens INTEGER,
    input_json TEXT,
    cost_json TEXT,
    prompt_cache_json TEXT,
    enabled INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (provider, model_id)
  );
\`);
const inputJson = process.env.E2E_INPUT_JSON || null;
db.query("INSERT OR REPLACE INTO custom_providers (id, name, base_url, models, api, enabled, auto_discover, headers) VALUES (?, ?, ?, '[]', 'openai-chat', 1, 0, '{}')")
  .run("e2e-mock", "E2E Mock", "http://127.0.0.1:" + process.env.E2E_PORT + "/v1");
db.query("INSERT OR REPLACE INTO models (provider, model_id, name, reasoning, context_window, max_tokens, input_json, cost_json, enabled) VALUES (?, ?, ?, 0, 128000, 8192, ?, NULL, 1)")
  .run("e2e-mock", process.env.E2E_MODEL_ID, process.env.E2E_MODEL_ID, inputJson);
const modelKey = JSON.stringify({ provider: "e2e-mock", modelId: process.env.E2E_MODEL_ID });
db.query("INSERT OR REPLACE INTO kv (key, value) VALUES ('pi.model', ?)").run(modelKey);
db.query("INSERT OR REPLACE INTO kv (key, value) VALUES ('pi.model.lastUsed', ?)").run(modelKey);
db.close();
`;
  execFileSync(bunBin, ["-e", seedScript], {
    env: {
      ...process.env,
      E2E_DB_PATH: join(dataDir, "state.db"),
      E2E_PORT: String(providerPort),
      E2E_MODEL_ID: modelId,
      E2E_INPUT_JSON: inputJson ?? "",
    },
    stdio: "inherit",
  });
}

async function launch(dataDir) {
  const app = await _electron.launch({
    executablePath: electronPath,
    args: [".", "--dev"],
    cwd: electronDir,
    env: {
      ...process.env,
      KOVA_DATA_DIR: dataDir,
      KOVA_WORKER_BIN: bunBin,
      KOVA_WORKER_ARGS: JSON.stringify(["src/index.ts"]),
      KOVA_WORKER_CWD: sidecarDir,
      KOVA_DEV_URL: devUrl,
    },
    timeout: 60_000,
  });
  const page = await app.firstWindow({ timeout: 60_000 });
  page.on("console", (m) => {
    if (m.type() === "error") console.error(`[renderer:error] ${m.text()}`);
  });
  page.on("pageerror", (e) => console.error(`[renderer:pageerror] ${String(e)}`));
  await page.waitForLoadState("domcontentloaded");
  await sleep(1800);
  await page.evaluate(() => {
    try {
      localStorage.setItem("onboarding.completed.v1", "1");
      const raw = localStorage.getItem("ui.prefs");
      const prefs = raw ? JSON.parse(raw) : {};
      localStorage.setItem("ui.prefs", JSON.stringify({ ...prefs, locale: "zh" }));
    } catch {
      /* private mode */
    }
  });
  await page.reload({ waitUntil: "domcontentloaded" });
  await sleep(2500);
  return { app, page };
}

async function pasteImage(page) {
  const target = page.locator(".cm-content").first();
  await target.waitFor({ timeout: 30_000 });
  await target.click().catch(() => {});
  await page.evaluate((base64) => {
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    const file = new File([bytes], "e2e-image.png", { type: "image/png" });
    const data = new DataTransfer();
    data.items.add(file);
    const el = document.querySelector(".cm-content") ?? document.querySelector(".cm-editor");
    if (!el) throw new Error("composer editor not found");
    el.dispatchEvent(
      new ClipboardEvent("paste", {
        clipboardData: data,
        bubbles: true,
        cancelable: true,
      }),
    );
  }, PNG_1X1);
  await sleep(1200);
  const attachments = await page.locator(".aui-attachment-root").count();
  assert(attachments > 0, "image attachment did not appear in composer");
}

async function sendPrompt(page) {
  // 粘贴后可能残留命令菜单/浮层；Esc 收掉后直接聚焦编辑器，避开浮层拦截点击
  await page.keyboard.press("Escape").catch(() => {});
  await page.evaluate(() => {
    const el = document.querySelector(".cm-content");
    el?.focus?.();
  });
  await page.waitForTimeout(200);
  await page.keyboard.type(PROMPT, { delay: 15 });
  await page.waitForTimeout(300);
  await page.keyboard.press("Enter");
  await page
    .locator('[data-slot="aui_assistant-message-content"]')
    .filter({ hasText: ASSISTANT_TEXT })
    .first()
    .waitFor({ timeout: 90_000 });
}

async function runScenario({ modelId, inputJson, rejectFirstImage, check }) {
  const mock = await startMockServer({ rejectFirstImage });
  const dataDir = mkdtempSync(join(tmpdir(), `kova-e2e-media-${modelId}-`));
  let app = null;
  try {
    seedDataDir(dataDir, mock.port, modelId, inputJson);
    console.log(`[e2e] scenario=${modelId} data=${dataDir} mock=${mock.port}`);
    ({ app } = await launch(dataDir));
    const page = await app.firstWindow();
    await pasteImage(page);
    await sendPrompt(page);
    await sleep(1000);
    const userImages = await page
      .locator('[data-slot="aui_user-message-root"] img.aui-attachment-tile-image')
      .count();
    assert(userImages > 0, `[${modelId}] sent user message lost its image attachment`);
    check(mock.requests);
    console.log(`[e2e] scenario ${modelId} passed (${mock.requests.length} requests)`);
  } finally {
    try {
      await app?.close();
    } catch {
      /* ignore */
    }
    await mock.close();
    if (!keep) rmSync(dataDir, { recursive: true, force: true });
  }
}

async function main() {
  assert(bunBin && existsSync(bunBin), "bun not found as an absolute path (set BUN_BIN)");
  assert(existsSync(electronPath), `electron binary not found: ${electronPath}`);
  await ensureDevServer();
  ensureElectronMain();

  await runScenario({
    modelId: "e2e-text",
    inputJson: JSON.stringify(["text"]),
    rejectFirstImage: false,
    check: (requests) => {
      const json = JSON.stringify(requests);
      assert(!json.includes('"image_url"'), "explicit text model received image_url");
      assert(
        json.includes("[Attached image/png: [image #1]]"),
        "explicit text model request missing attachment placeholder",
      );
      assert(json.includes(MEDIA_OMITTED_NOTE), "explicit text model request missing omission note");
    },
  });

  await runScenario({
    modelId: "e2e-unknown",
    inputJson: null,
    rejectFirstImage: true,
    check: (requests) => {
      const json = JSON.stringify(requests);
      assert(json.includes('"image_url"'), "unknown capability model did not receive image_url");
      assert(json.includes(MEDIA_OMITTED_NOTE), "retry missing neutral omission note");
      const retry = requests.filter((r) => JSON.stringify(r).includes(MEDIA_OMITTED_NOTE));
      assert(
        retry.length > 0 && retry.every((r) => !JSON.stringify(r).includes('"image_url"')),
        "retry still carried image_url",
      );
    },
  });

  console.log("[e2e] all media capability scenarios passed");
}

main()
  .catch((err) => {
    console.error("[e2e] FAIL:", err instanceof Error ? err.stack : err);
    process.exitCode = 1;
  })
  .finally(() => {
    stopDevServer();
  });
