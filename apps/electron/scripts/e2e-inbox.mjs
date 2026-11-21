#!/usr/bin/env node
/**
 * 收件箱闭环 e2e（隔离数据目录 + 真实 sidecar + 真实渲染层）：
 *   node apps/electron/scripts/e2e-inbox.mjs
 *   或 bun run --filter kova-electron-main e2e:inbox
 *
 * 隔离性：用 mkdtemp 的 KOVA_DATA_DIR 起独立 Electron 实例，不读写日常 dev 库；
 * 渲染层优先复用已在跑的 next dev（默认 http://localhost:3000），没有则在本仓
 * 自动拉起一个，结束后只杀自己拉起的那个。
 *
 * 覆盖（全部通过真实 DOM 点击）：
 *  1. 历史组头批量归档（组内 2 条一起离开历史）
 *  2. 已归档组头批量恢复（2 条一起回到历史）
 *  3. 整组批量删除：确认框带组名 + 条数
 *  4. 单条事件删除回归（确认文案仍是单条）
 *  5. 重启应用后：恢复的组仍在，删除的组不复活
 *
 * 前置：依赖已安装（playwright-core / electron）、bun 在 PATH（或 BUN_BIN）。
 * 失败时保留临时数据目录与截图，成功时清理；截图目录会打印在结尾。
 */
import { execFileSync, spawn } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repo = resolve(scriptDir, "../../..");
const electronDir = join(repo, "apps", "electron");
const sidecarDir = join(repo, "apps", "sidecar", "pi-agent");
const devUrl = process.env.KOVA_DEV_URL ?? "http://localhost:3000";
/** 必须是绝对路径：宿主 sidecarBinaryPath 用 existsSync(candidate) 判定，
 *  相对 "bun" 永远不存在，会静默回退到过期的编译版 kova-worker（不认新协议字段） */
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
const keep = process.env.KEEP === "1";

const requireFromRepo = createRequire(join(repo, "package.json"));
const { _electron } = requireFromRepo("playwright-core");
const requireFromElectron = createRequire(join(electronDir, "package.json"));
const electronPath = requireFromElectron("electron");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fail(message) {
  throw new Error(message);
}

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

const reachable = async () => {
  try {
    const res = await fetch(devUrl, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
};

/** 起/停 next dev：只杀自己拉起的进程，复用用户已在跑的那个 */
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
    if (await reachable()) {
      console.log("[e2e] next dev ready");
      return;
    }
    await sleep(1000);
  }
  fail(`next dev did not become reachable at ${devUrl} within 120s`);
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
    /* 已退出 */
  }
  nextProc = null;
}

function ensureElectronMain() {
  const out = join(electronDir, "dist", "main.cjs");
  if (existsSync(out)) return;
  console.log("[e2e] building electron main ...");
  execFileSync("node", ["scripts/build.mjs"], { cwd: electronDir, stdio: "inherit" });
}

function seedInbox(dataDir) {
  const now = new Date().toISOString();
  const mk = (taskId, title, runId) => ({
    id: `automation:${taskId}:${runId}`,
    kind: "automation",
    state: "done",
    outcome: "success",
    priority: 2,
    requiresAction: false,
    title: `运行结果：${title}`,
    summary: "运行成功",
    sourceId: runId,
    createdAt: now,
    updatedAt: now,
    actions: ["open", "mark_read", "archive"],
    // schema 必填；详情读不到源时显示 stale，不影响列表/动作
    hasDetail: false,
    meta: { taskId, runId, taskName: title },
  });
  const items = [
    mk("e2e-g1", "E2E G1", "run-1"),
    mk("e2e-g1", "E2E G1", "run-2"),
    mk("e2e-g2", "E2E G2", "run-1"),
    mk("e2e-g3", "E2E G3", "run-1"),
    mk("e2e-g4", "E2E G4", "run-1"),
  ];
  const inbox = join(dataDir, "sessions", "inbox");
  mkdirSync(inbox, { recursive: true });
  writeFileSync(
    join(inbox, "events.jsonl"),
    items.map((item) => JSON.stringify({ v: 1, op: "upsert", at: now, item })).join("\n") + "\n",
  );
  const state = { v: 1, items: {} };
  for (const item of items) state.items[item.id] = { readAt: now };
  state.items[items[3].id].archivedAt = now; // G3 预置为已归档
  writeFileSync(join(inbox, "state.json"), JSON.stringify(state, null, 1));
}

function checkPrereqs() {
  if (!existsSync(electronPath)) fail(`electron binary not found: ${electronPath}`);
  if (!bunBin || !existsSync(bunBin)) {
    fail("bun not found as an absolute path (set BUN_BIN); sidecar runs from source");
  }
  try {
    execFileSync(bunBin, ["--version"], { stdio: "ignore" });
  } catch {
    fail(`bun is not executable: ${bunBin}`);
  }
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
      // 不用 --watch：测试进程要可预测地退出
      KOVA_WORKER_ARGS: JSON.stringify(["src/index.ts"]),
      KOVA_WORKER_CWD: sidecarDir,
      KOVA_DEV_URL: devUrl,
    },
    timeout: 60_000,
  });
  const page = await app.firstWindow({ timeout: 60_000 });
  // 渲染层报错必须冒出来，否则页面被 HMR/异常重挂载时只会看到“元素消失”
  page.on("console", (m) => {
    if (m.type() === "error") console.error(`[renderer:error] ${m.text()}`);
  });
  page.on("pageerror", (e) => console.error(`[renderer:pageerror] ${String(e)}`));
  await page.waitForLoadState("domcontentloaded");
  await sleep(1800);
  // 隔离 userData 的 localStorage 是空的：跳过首次引导，并固定中文
  // （用例按中文字面量定位；CI 的系统语言可能是英文）
  await page.evaluate(() => {
    try {
      localStorage.setItem("onboarding.completed.v1", "1");
      const raw = localStorage.getItem("ui.prefs");
      const prefs = raw ? JSON.parse(raw) : {};
      localStorage.setItem("ui.prefs", JSON.stringify({ ...prefs, locale: "zh" }));
    } catch {
      /* 隐私模式 */
    }
  });
  await page.reload({ waitUntil: "domcontentloaded" });
  await sleep(2200);
  await page.getByText("收件箱", { exact: true }).first().click();
  await sleep(1000);
  return { app, page };
}

let dataDir = "";
let shotsDir = "";
let app = null;
let shotIndex = 0;

async function shot(page, name) {
  shotIndex += 1;
  await page.screenshot({
    path: join(shotsDir, `${String(shotIndex).padStart(2, "0")}-${name}.png`),
  });
}

async function run() {
  checkPrereqs();
  await ensureDevServer();
  ensureElectronMain();

  dataDir = mkdtempSync(join(tmpdir(), "kova-e2e-inbox-data-"));
  shotsDir = mkdtempSync(join(tmpdir(), "kova-e2e-inbox-shots-"));
  seedInbox(dataDir);
  console.log(`[e2e] data: ${dataDir}`);
  console.log(`[e2e] shots: ${shotsDir}`);

  ({ app } = await launch(dataDir));
  const page = await app.firstWindow();
  const row = (key) => page.locator(`[data-inbox-group="${key}"]`);

  // 历史：G1(组内 2 条) / G2 / G4；G3 已归档
  await page.getByRole("button", { name: "历史", exact: true }).click();
  await page.getByText("E2E G1").waitFor({ timeout: 20_000 });
  await page.getByText("E2E G2").waitFor({ timeout: 20_000 });
  await page.getByText("E2E G4").waitFor({ timeout: 20_000 });
  await shot(page, "group-headers");

  // 1) 组头批量归档 G1
  await row("automation:e2e-g1")
    .getByRole("button", { name: "归档", exact: true })
    .click();
  // 归档/删除后列表由服务端应答 + inbox_changed 防抖刷新共同驱动，
  // 固定 sleep 会撞上并发刷新窗口；等行真正消失
  await row("automation:e2e-g1").waitFor({ state: "detached", timeout: 15_000 });
  console.log("[e2e] G1 bulk archived");

  // 2) 已归档组头批量恢复 G1
  await page.getByRole("button", { name: "已归档", exact: true }).click();
  await row("automation:e2e-g1").waitFor({ timeout: 15_000 });
  await row("automation:e2e-g1")
    .getByRole("button", { name: "恢复", exact: true })
    .click();
  await row("automation:e2e-g1").waitFor({ state: "detached", timeout: 15_000 });
  await page.getByRole("button", { name: "历史", exact: true }).click();
  await page.getByText("E2E G1").waitFor({ timeout: 15_000 });
  console.log("[e2e] G1 bulk restored");

  // 展开确认组内两条都在
  const expander = row("automation:e2e-g1")
    .getByRole("button")
    .filter({ hasText: "E2E G1" })
    .first();
  await expander.click();
  await row("automation:e2e-g1").getByText("运行成功").nth(1).waitFor({
    timeout: 10_000,
  });
  const g1Text = await row("automation:e2e-g1").innerText();
  const runCount = (g1Text.match(/运行成功/g) ?? []).length;
  assert(runCount === 2, `G1 should keep 2 events, got ${runCount}`);
  await shot(page, "g1-two-events");
  await expander.click();
  await sleep(300);

  // 3) 组头批量删除 G2：确认框带组名与条数
  await row("automation:e2e-g2")
    .getByRole("button", { name: "删除", exact: true })
    .click();
  const dialog = page.getByRole("alertdialog");
  await dialog.waitFor({ timeout: 10_000 });
  const bulkTitle = await dialog.innerText();
  assert(bulkTitle.includes("E2E G2"), "bulk confirm should name the group");
  assert(bulkTitle.includes("1 条"), "bulk confirm should show the item count");
  await shot(page, "g2-bulk-confirm");
  await dialog.getByRole("button", { name: "删除", exact: true }).click();
  await row("automation:e2e-g2").waitFor({ state: "detached", timeout: 15_000 });
  console.log("[e2e] G2 bulk deleted");

  // 4) 已归档组头批量删除 G3
  await page.getByRole("button", { name: "已归档", exact: true }).click();
  await row("automation:e2e-g3").waitFor({ timeout: 15_000 });
  await row("automation:e2e-g3")
    .getByRole("button", { name: "删除", exact: true })
    .click();
  await dialog.waitFor({ timeout: 10_000 });
  await dialog.getByRole("button", { name: "删除", exact: true }).click();
  await row("automation:e2e-g3").waitFor({ state: "detached", timeout: 15_000 });
  await page.getByRole("button", { name: "历史", exact: true }).click();
  await row("automation:e2e-g4").waitFor({ timeout: 15_000 });
  console.log("[e2e] G3 bulk deleted");

  // 5) 单条事件删除回归
  const g4Expander = row("automation:e2e-g4")
    .getByRole("button")
    .filter({ hasText: "E2E G4" })
    .first();
  await g4Expander.click();
  await sleep(300);
  await row("automation:e2e-g4")
    .getByRole("button", { name: "删除", exact: true })
    .last()
    .click();
  await dialog.waitFor({ timeout: 10_000 });
  const singleTitle = await dialog.innerText();
  assert(
    singleTitle.includes("永久删除这条记录"),
    "single delete should keep the single-item confirm copy",
  );
  await dialog.getByRole("button", { name: "删除", exact: true }).click();
  await row("automation:e2e-g4").waitFor({ state: "detached", timeout: 15_000 });
  console.log("[e2e] G4 single deleted");
  await shot(page, "final-history");

  // 6) 重启：G1 仍在（2 条），G2/G3/G4 的墓碑跨进程保持
  await app.close();
  app = null;
  await sleep(1500);
  ({ app } = await launch(dataDir));
  const page2 = await app.firstWindow();
  await page2.getByRole("button", { name: "历史", exact: true }).click();
  await page2.getByText("E2E G1").waitFor({ timeout: 20_000 });
  const body = await page2.locator("body").innerText();
  assert(body.includes("E2E G1"), "restored G1 should survive restart");
  assert(!body.includes("E2E G2"), "deleted G2 must not resurrect");
  assert(!body.includes("E2E G3"), "deleted G3 must not resurrect");
  assert(!body.includes("E2E G4"), "deleted G4 must not resurrect");
  await shot(page2, "restart");
  console.log("[e2e] restart persistence OK");
}

try {
  await run();
  console.log(`PASS: inbox closed loop (shots: ${shotsDir})`);
} catch (error) {
  console.error(`FAIL: ${error instanceof Error ? error.message : String(error)}`);
  if (app) {
    try {
      const page = await app.firstWindow();
      await shot(page, "failure").catch(() => {});
    } catch {
      /* 已退出 */
    }
  }
  console.error(`[e2e] kept data: ${dataDir}`);
  console.error(`[e2e] shots: ${shotsDir}`);
  process.exitCode = 1;
} finally {
  if (app) {
    try {
      await app.close();
    } catch {
      /* 已退出 */
    }
  }
  stopDevServer();
  if (!keep && process.exitCode !== 1 && dataDir) {
    rmSync(dataDir, { recursive: true, force: true });
  }
}
