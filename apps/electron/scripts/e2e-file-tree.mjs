#!/usr/bin/env node
/**
 * 文件树多选 e2e（隔离数据目录 + 真实渲染层）：
 *   node apps/electron/scripts/e2e-file-tree.mjs
 *   或 bun run --filter kova-electron-main e2e:file-tree
 *
 * 以「资料库」页的文件树为宿主（与右侧文件树共用 FileExplorer/FileTree）：
 *  1. 单击收敛、Cmd/Ctrl 切换、Shift 区间替换、Cmd/Ctrl+Shift 区间并入
 *  2. Esc 清空、Cmd/Ctrl+A 全选、Shift+↑/↓ 扩展
 *  3. 右键未选中行收敛为单项；右键已选行保留多选并出现批量菜单
 *  4. 批量删除（确认框数量、磁盘结果、选区清理）
 *  5. 多选拖拽移动进文件夹（载荷数组、移动后选区跟随、目标目录自动展开）
 *  6. 折叠目录后隐藏的后代从选区剔除
 *
 * 隔离性同 e2e-inbox：mkdtemp 的 KOVA_DATA_DIR，资料库根在
 * <dataDir>/library；优先复用已在跑的 next dev，没有则自动拉起。
 */
import { execFileSync, spawn } from "node:child_process";
import { createRequire } from "node:module";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repo = resolve(scriptDir, "../../..");
const electronDir = join(repo, "apps", "electron");
const sidecarDir = join(repo, "apps", "sidecar", "pi-agent");
const devUrl = process.env.KOVA_DEV_URL ?? "http://localhost:3000";
const keep = process.env.KEEP === "1";
const isMac = process.platform === "darwin";
const modKey = isMac ? "Meta" : "Control";

function resolveBun() {
  if (process.env.BUN_BIN) return resolve(process.env.BUN_BIN);
  if (process.versions.bun) return process.execPath;
  try {
    return execFileSync(
      process.platform === "win32" ? "where" : "which",
      ["bun"],
      { encoding: "utf8" },
    )
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

const reachable = async () => {
  try {
    const res = await fetch(devUrl, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
};

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
  throw new Error(`next dev did not become reachable at ${devUrl} within 120s`);
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

function checkPrereqs() {
  if (!existsSync(electronPath)) throw new Error(`electron binary not found: ${electronPath}`);
  if (!bunBin || !existsSync(bunBin)) {
    throw new Error("bun not found as an absolute path (set BUN_BIN)");
  }
  try {
    execFileSync(bunBin, ["--version"], { stdio: "ignore" });
  } catch {
    throw new Error(`bun is not executable: ${bunBin}`);
  }
}

/** 资料库根：<dataDir>/library。资料库一级页只展示清单里的知识库，
 *  所以种子 = `.knowledge-bases.json` + 用户级 KB 文件夹（知识库/E2E）。 */
function seedLibrary(dataDir) {
  const root = join(dataDir, "library");
  const contentRoot = join(root, "知识库", "E2E");
  mkdirSync(join(contentRoot, "folder-one", "nested"), { recursive: true });
  for (const name of ["alpha.txt", "beta.txt", "gamma.txt", "delta.txt"]) {
    writeFileSync(join(contentRoot, name), `# ${name}\n`);
  }
  writeFileSync(join(contentRoot, "folder-one", "inner.txt"), "# inner\n");
  // 与根层 beta/delta 重名：多选拖拽时必须按 fsMove 的「 (2)」新名跟随选区
  writeFileSync(join(contentRoot, "folder-one", "beta.txt"), "# existing beta\n");
  writeFileSync(
    join(contentRoot, "folder-one", "delta.txt"),
    "# existing delta\n",
  );
  writeFileSync(
    join(contentRoot, "folder-one", "nested", "deep.txt"),
    "# deep\n",
  );
  writeFileSync(
    join(root, ".knowledge-bases.json"),
    JSON.stringify(
      {
        version: 1,
        kbs: [
          {
            id: "kb-e2e",
            name: "E2E",
            folder: "知识库/E2E",
            scope: "user",
            workspaceIds: [],
            createdAt: new Date(0).toISOString(),
          },
        ],
      },
      null,
      2,
    ),
  );
  return contentRoot;
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
  const rendererErrors = [];
  page.on("console", (m) => {
    if (m.type() === "error") {
      rendererErrors.push(m.text().slice(0, 300));
      console.error(`[renderer:error] ${m.text()}`);
    }
  });
  page.on("pageerror", (e) => {
    rendererErrors.push(String(e).slice(0, 300));
    console.error(`[renderer:pageerror] ${String(e)}`);
  });
  await page.waitForLoadState("domcontentloaded");
  await sleep(1800);
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
  // 隔离数据目录会触发「本次更新内容」弹层，先关掉再点侧栏
  const whatsNew = page.getByRole("button", { name: "知道了", exact: true });
  await whatsNew.waitFor({ timeout: 4_000 }).catch(() => {});
  if (await whatsNew.isVisible().catch(() => false)) {
    await whatsNew.click();
    await sleep(300);
  }
  await page.getByText("资料库", { exact: true }).first().click();
  await sleep(1200);
  // 一级页是知识库卡片；进入种子 KB 才有文件树
  const kbCard = page.getByRole("button", { name: /E2E/ }).first();
  await kbCard.waitFor({ timeout: 20_000 });
  await kbCard.click();
  await sleep(1200);
  return { app, page, rendererErrors };
}

let dataDir = "";
let libraryRoot = "";
let shotsDir = "";
let app = null;
let rendererErrors = [];
let shotIndex = 0;

async function shot(page, name) {
  shotIndex += 1;
  await page.screenshot({
    path: join(shotsDir, `${String(shotIndex).padStart(2, "0")}-${name}.png`),
  });
}

function treeLocator(page) {
  return page.locator('[role="tree"][aria-label="资料库文件"]');
}

function rowLocator(page, name) {
  return treeLocator(page)
    .locator('[role="treeitem"]')
    .filter({ hasText: name })
    .first();
}

async function selectedNames(page) {
  const texts = await treeLocator(page)
    .locator('[role="treeitem"][aria-selected="true"]')
    .allInnerTexts();
  return texts.map((text) => text.trim());
}

/** 当前可见行顺序（左侧列表的实际排序，不是字典序） */
async function visibleNames(page) {
  const texts = await treeLocator(page)
    .locator('[role="treeitem"]')
    .allInnerTexts();
  return texts.map((text) => text.trim());
}

function assertSelected(actual, expected, message) {
  for (const name of expected) {
    assert(
      actual.some((text) => text.includes(name)),
      `${message}: expected "${name}" in [${actual.join(", ")}]`,
    );
  }
}

function assertNotSelected(actual, unexpected, message) {
  for (const name of unexpected) {
    assert(
      !actual.some((text) => text.includes(name)),
      `${message}: did not expect "${name}" in [${actual.join(", ")}]`,
    );
  }
}

async function waitForFile(path, present, timeout = 8_000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (existsSync(path) === present) return;
    await sleep(120);
  }
  throw new Error(`${present ? "missing" : "still present"}: ${path}`);
}

async function waitForSelection(page, expected, timeout = 5_000) {
  const started = Date.now();
  let latest = [];
  while (Date.now() - started < timeout) {
    latest = await selectedNames(page);
    if (expected.every((name) => latest.some((text) => text.includes(name)))) {
      return latest;
    }
    await sleep(100);
  }
  throw new Error(
    `selection did not reach [${expected.join(", ")}]; got [${latest.join(", ")}]`,
  );
}

/** 合成 HTML5 拖拽：比真实鼠标拖拽稳定，仍走 React 的 dragstart/drop 处理 */
async function dragRowTo(page, sources, target) {
  await page.evaluate(
    ({ sources, target }) => {
      const rows = Array.from(document.querySelectorAll('[role="treeitem"]'));
      const find = (name) =>
        rows.find((el) => (el.textContent ?? "").includes(name));
      const sourceEl = find(sources[0]);
      const targetEl = find(target);
      if (!sourceEl) throw new Error(`drag source not found: ${sources[0]}`);
      if (!targetEl) throw new Error(`drop target not found: ${target}`);
      const dt = new DataTransfer();
      const fire = (el, type) =>
        el.dispatchEvent(
          new DragEvent(type, {
            bubbles: true,
            cancelable: true,
            dataTransfer: dt,
          }),
        );
      fire(sourceEl, "dragstart");
      fire(targetEl, "dragover");
      fire(targetEl, "drop");
      fire(sourceEl, "dragend");
    },
    { sources, target },
  );
}

async function run() {
  checkPrereqs();
  await ensureDevServer();
  ensureElectronMain();

  dataDir = mkdtempSync(join(tmpdir(), "kova-e2e-file-tree-data-"));
  shotsDir = mkdtempSync(join(tmpdir(), "kova-e2e-file-tree-shots-"));
  libraryRoot = seedLibrary(dataDir);
  // 设置 → 产物：task-workspace 顶层目录 = 会话产物卡
  const artifactsRoot = join(dataDir, "task-workspace", "e2e-artifacts");
  mkdirSync(artifactsRoot, { recursive: true });
  for (const name of ["one.txt", "two.txt", "three.txt"]) {
    writeFileSync(join(artifactsRoot, name), `# ${name}\n`);
  }
  console.log(`[e2e] data: ${dataDir}`);
  console.log(`[e2e] library: ${libraryRoot}`);
  console.log(`[e2e] shots: ${shotsDir}`);

  ({ app, rendererErrors } = await launch(dataDir));
  const page = await app.firstWindow();
  const tree = treeLocator(page);
  await tree.waitFor({ timeout: 25_000 });
  await rowLocator(page, "alpha.txt").waitFor({ timeout: 15_000 });
  await shot(page, "initial");

  // 1) 单击收敛
  await rowLocator(page, "alpha.txt").click();
  await waitForSelection(page, ["alpha.txt"]);
  let names = await selectedNames(page);
  assert(names.length === 1, `plain click should select one, got ${names.length}`);
  console.log("[e2e] plain click OK");

  // 2) Cmd/Ctrl 切换
  await rowLocator(page, "beta.txt").click({ modifiers: [modKey] });
  names = await waitForSelection(page, ["alpha.txt", "beta.txt"]);
  assert(names.length === 2, `modifier click should add one, got ${names.length}`);
  console.log("[e2e] modifier toggle OK");

  // 3) Shift 区间替换（锚点 beta → delta；范围按当前可见顺序，不假定字典序）
  const orderBeforeRange = await visibleNames(page);
  const betaIndex = orderBeforeRange.findIndex((name) => name.includes("beta.txt"));
  const deltaIndex = orderBeforeRange.findIndex((name) => name.includes("delta.txt"));
  assert(betaIndex >= 0 && deltaIndex >= 0, "beta/delta rows should be visible");
  const rangeExpected = orderBeforeRange.slice(
    Math.min(betaIndex, deltaIndex),
    Math.max(betaIndex, deltaIndex) + 1,
  );
  await rowLocator(page, "delta.txt").click({ modifiers: ["Shift"] });
  names = await waitForSelection(page, rangeExpected);
  assert(
    names.length === rangeExpected.length,
    `shift range should replace with ${rangeExpected.length} rows, got ${names.length}`,
  );
  const alphaRangeIndex = orderBeforeRange.findIndex((name) =>
    name.includes("alpha.txt"),
  );
  if (
    alphaRangeIndex >= 0 &&
    (alphaRangeIndex < Math.min(betaIndex, deltaIndex) ||
      alphaRangeIndex > Math.max(betaIndex, deltaIndex))
  ) {
    assertNotSelected(
      names,
      ["alpha.txt"],
      "shift range should replace previous selection",
    );
  }
  console.log("[e2e] shift range replace OK");

  // 4) Cmd/Ctrl+Shift 区间并入（anchored range ∪ 已有选区，按可见顺序）
  const orderBeforeAdd = await visibleNames(page);
  const alphaAddIndex = orderBeforeAdd.findIndex((name) =>
    name.includes("alpha.txt"),
  );
  const betaAddIndex = orderBeforeAdd.findIndex((name) =>
    name.includes("beta.txt"),
  );
  assert(
    alphaAddIndex >= 0 && betaAddIndex >= 0,
    "alpha/beta rows should be visible",
  );
  const addLow = Math.min(alphaAddIndex, betaAddIndex);
  const addHigh = Math.max(alphaAddIndex, betaAddIndex);
  const currentSet = new Set(names);
  const additiveExpected = orderBeforeAdd.filter(
    (name, index) =>
      (index >= addLow && index <= addHigh) || currentSet.has(name),
  );
  await rowLocator(page, "alpha.txt").click({
    modifiers: [modKey, "Shift"],
  });
  names = await waitForSelection(page, additiveExpected);
  assert(
    names.length === additiveExpected.length,
    `additive range should select ${additiveExpected.length} rows, got ${names.length}`,
  );
  await shot(page, "additive-range");
  console.log("[e2e] additive range OK");

  // 5) Esc 清空
  await page.keyboard.press("Escape");
  await sleep(150);
  assert((await selectedNames(page)).length === 0, "Escape should clear selection");

  // 6) Shift+↓ 扩展：按可见顺序取 alpha 之后的两个非占位行
  const orderBeforeArrow = await visibleNames(page);
  const alphaIndex = orderBeforeArrow.findIndex((name) => name.includes("alpha.txt"));
  assert(alphaIndex >= 0, "alpha row should be visible");
  const arrowExpected = orderBeforeArrow.slice(alphaIndex, alphaIndex + 3);
  await rowLocator(page, "alpha.txt").click();
  await page.keyboard.press("Shift+ArrowDown");
  await page.keyboard.press("Shift+ArrowDown");
  names = await waitForSelection(page, arrowExpected);
  assert(
    names.length === arrowExpected.length,
    `Shift+ArrowDown should select ${arrowExpected.length} contiguous rows, got ${names.length}`,
  );
  console.log("[e2e] keyboard range OK");

  // 7) Cmd/Ctrl+A 全选
  const allRows = await visibleNames(page);
  await page.keyboard.press(`${modKey}+a`);
  names = await selectedNames(page);
  assert(
    names.length === allRows.length,
    `select all should select ${allRows.length} rows, got ${names.length}`,
  );
  assertSelected(names, ["alpha.txt", "delta.txt"], "select all");
  await page.screenshot({ path: join(shotsDir, "select-all.png") });
  await page.keyboard.press("Escape");
  await sleep(100);
  console.log("[e2e] select all OK");

  // 8) 右键未选中行 → 收敛为单项，单条菜单
  await rowLocator(page, "alpha.txt").click();
  await rowLocator(page, "beta.txt").click({ modifiers: [modKey] });
  await waitForSelection(page, ["alpha.txt", "beta.txt"]);
  await rowLocator(page, "gamma.txt").click({ button: "right" });
  await waitForSelection(page, ["gamma.txt"]);
  const menuText = await page.getByRole("menu").innerText();
  assert(!menuText.includes("已选择"), "unselected right-click should not show bulk menu");
  await page.keyboard.press("Escape");
  await sleep(150);
  console.log("[e2e] right-click unselected row OK");

  // 9) 右键已选行 → 保留多选，批量菜单带数量
  await rowLocator(page, "alpha.txt").click();
  await rowLocator(page, "gamma.txt").click({ modifiers: [modKey] });
  await waitForSelection(page, ["alpha.txt", "gamma.txt"]);
  await rowLocator(page, "alpha.txt").click({ button: "right" });
  const bulkMenu = page.getByRole("menu");
  await bulkMenu.waitFor({ timeout: 5_000 });
  const bulkText = await bulkMenu.innerText();
  assert(bulkText.includes("已选择 2 项"), `bulk menu count missing: ${bulkText}`);
  assert(bulkText.includes("删除 2 项"), `bulk delete item missing: ${bulkText}`);
  await shot(page, "bulk-menu");
  console.log("[e2e] multi context menu OK");

  // 10) 批量删除
  await page.getByRole("menuitem", { name: "删除 2 项", exact: true }).click();
  const dialog = page.getByRole("alertdialog");
  await dialog.waitFor({ timeout: 5_000 });
  const dialogText = await dialog.innerText();
  assert(dialogText.includes("删除 2 项？"), `bulk delete title: ${dialogText}`);
  await shot(page, "bulk-delete-dialog");
  await dialog.getByRole("button", { name: "删除", exact: true }).click();
  await waitForFile(join(libraryRoot, "alpha.txt"), false);
  await waitForFile(join(libraryRoot, "gamma.txt"), false);
  await rowLocator(page, "alpha.txt").waitFor({ state: "detached", timeout: 10_000 });
  await rowLocator(page, "gamma.txt").waitFor({ state: "detached", timeout: 10_000 });
  await sleep(250);
  assert(
    (await selectedNames(page)).length === 0,
    "selection should be cleared after deleting every selected item",
  );
  await shot(page, "after-bulk-delete");
  console.log("[e2e] bulk delete OK");

  // 11) 多选拖拽：beta + delta → folder-one（目标已有同名文件 → 自动改号，
  //     选区必须跟到落位后的新名，而不是旧 rel）
  await rowLocator(page, "beta.txt").click();
  await rowLocator(page, "delta.txt").click({ modifiers: [modKey] });
  await waitForSelection(page, ["beta.txt", "delta.txt"]);
  await dragRowTo(page, ["beta.txt"], "folder-one");
  await waitForFile(join(libraryRoot, "folder-one", "beta (2).txt"), true);
  await waitForFile(join(libraryRoot, "folder-one", "delta (2).txt"), true);
  await waitForFile(join(libraryRoot, "beta.txt"), false);
  await waitForFile(join(libraryRoot, "delta.txt"), false);
  names = await waitForSelection(page, ["beta (2).txt", "delta (2).txt"]);
  assert(
    names.length === 2 && names.every((name) => name.includes("(2)")),
    `selection should follow collision-renamed paths, got [${names.join(", ")}]`,
  );
  // 右栏正在看的 beta 也应跟到落位后的新路径（不能停在已删除的旧 rel）
  await page
    .getByText(/知识库\/E2E\/folder-one\/beta \(2\)\.txt/)
    .waitFor({ timeout: 8_000 });
  // 目标目录已自动展开，移动后的行可见
  await rowLocator(page, "inner.txt").waitFor({ timeout: 8_000 });
  await rowLocator(page, "beta (2).txt").waitFor({ timeout: 8_000 });
  await shot(page, "after-multi-drag");
  console.log("[e2e] multi drag move OK");

  // 12) 折叠目录：后代从选区剔除，目录自身保留
  await rowLocator(page, "inner.txt").click();
  await rowLocator(page, "folder-one").click({ modifiers: [modKey] });
  await waitForSelection(page, ["inner.txt"]);
  await rowLocator(page, "folder-one").focus();
  await page.keyboard.press("ArrowLeft"); // 收起 folder-one
  await waitForSelection(page, ["folder-one"]);
  const afterCollapse = await selectedNames(page);
  assertNotSelected(afterCollapse, ["inner.txt"], "collapsing should prune descendants");
  await shot(page, "collapsed-prune");
  console.log("[e2e] collapse prune OK");

  // 13) 设置 → 产物：同一 FileExplorer 在该入口也开启多选
  await page.getByText("设置", { exact: true }).first().click();
  await sleep(900);
  await page.getByRole("button", { name: "产物", exact: true }).click();
  const artifactCard = page
    .getByRole("button", { name: /e2e-artifacts/ })
    .first();
  await artifactCard.waitFor({ timeout: 15_000 });
  await artifactCard.click();
  const artifactsTree = page.locator(
    '[role="tree"][aria-label="会话产物文件"]',
  );
  await artifactsTree.waitFor({ timeout: 15_000 });
  assert(
    (await artifactsTree.getAttribute("aria-multiselectable")) === "true",
    "artifacts tree should be multi-selectable",
  );
  const artifactRows = artifactsTree.locator('[role="treeitem"]');
  await artifactRows.filter({ hasText: "one.txt" }).first().click();
  await artifactRows
    .filter({ hasText: "two.txt" })
    .first()
    .click({ modifiers: [modKey] });
  let artifactSelected = 0;
  for (let i = 0; i < 40; i += 1) {
    artifactSelected = await artifactsTree
      .locator('[role="treeitem"][aria-selected="true"]')
      .count();
    if (artifactSelected === 2) break;
    await sleep(100);
  }
  assert(
    artifactSelected === 2,
    `artifacts tree should keep 2 selected rows, got ${artifactSelected}`,
  );
  await shot(page, "artifacts-multiselect");
  console.log("[e2e] artifacts tree multi-select OK");

  assert(
    rendererErrors.length === 0,
    `renderer errors during run: ${rendererErrors.join(" | ")}`,
  );

  const result = {
    filesLeft: existsSync(join(libraryRoot, "folder-one", "beta (2).txt")),
    artifactsSelected: artifactSelected,
    rendererErrors: rendererErrors.length,
  };
  console.log(JSON.stringify(result, null, 2));
}

try {
  await run();
  console.log(`PASS: file tree multi-select (shots: ${shotsDir})`);
} catch (error) {
  console.error(`FAIL: ${error instanceof Error ? error.message : String(error)}`);
  if (app) {
    try {
      await shot(await app.firstWindow(), "failure");
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
