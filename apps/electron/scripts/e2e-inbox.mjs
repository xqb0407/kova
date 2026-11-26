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
import { createServer } from "node:http";
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
  // 外部来源条目：待关注里未读 + 需要动作，用于验证来源 chips / 外部行 /
  // 本地归档动作。github 连接器不参与本 e2e（没有真实 Token），条目直接种投影。
  items.push({
    id: "external:github:github.com/e2e/repo#42",
    kind: "external",
    state: "done",
    outcome: "needs_action",
    priority: 1,
    requiresAction: true,
    title: "E2E GitHub PR：修复登录跳转",
    summary: "请求你评审 · e2e/repo",
    sourceId: "github.com/e2e/repo#42",
    createdAt: now,
    updatedAt: now,
    actions: ["open", "mark_read", "archive"],
    deepLink: { url: "https://github.com/e2e/repo/pull/42" },
    external: {
      provider: "github",
      type: "pull_request",
      key: "e2e/repo#42",
      url: "https://github.com/e2e/repo/pull/42",
      status: "Open",
      sourceName: "e2e/repo",
      reason: "review_requested",
    },
    meta: {
      provider: "github",
      connectorId: "github",
      reason: "review_requested",
    },
    hasDetail: true,
  });
  const inbox = join(dataDir, "sessions", "inbox");
  mkdirSync(inbox, { recursive: true });
  writeFileSync(
    join(inbox, "events.jsonl"),
    items.map((item) => JSON.stringify({ v: 1, op: "upsert", at: now, item })).join("\n") + "\n",
  );
  const state = { v: 1, items: {} };
  for (const item of items) {
    // 外部项保持未读，才能出现在「待关注」验证 chips 与动作
    if (item.kind === "external") continue;
    state.items[item.id] = { readAt: now };
  }
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
    if (m.text().includes("[sent-agent]")) console.log(m.text());
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

  /**
   * 全新数据目录 localStorage 没有已读版本号：带更新日志的版本首启会弹
   * whats-new 弹窗挡住主区。有则关掉；重启时已读版本已持久化，1.5s 内没弹就继续。
   */
  const dismissWhatsNew = async (p) => {
    try {
      await p
        .getByRole("button", { name: "知道了", exact: true })
        .click({ timeout: 1_500 });
      console.log("[e2e] whats-new dismissed");
      await sleep(450);
    } catch {
      /* 未弹：继续 */
    }
  };

  /** 视图（待关注/历史/已归档）在左栏顶部的分段切换 */
  const setView = async (p, label) => {
    await p.getByRole("tab", { name: label, exact: true }).click();
    await sleep(700);
  };

  await dismissWhatsNew(page);

  // 1) 待关注：外部 GitHub 事项 + 来源下拉（e2e 未配置连接器，只有全部/任务）
  await page
    .getByText("E2E GitHub PR", { exact: false })
    .first()
    .waitFor({ timeout: 20_000 });
  await page
    .getByRole("button", { name: "来源：全部", exact: true })
    .first()
    .waitFor({ timeout: 10_000 });
  await shot(page, "issue-inbox");

  const externalGroupKey = "external:github:e2e/repo#42";
  await row(externalGroupKey).click();
  await page
    .getByText("E2E GitHub PR", { exact: false })
    .first()
    .waitFor({ timeout: 10_000 });

  // 1b) 阅读窗主路径：详情占位错误（未配连接器）→ Ask 填入 composer → 回链菜单
  await page
    .getByText("该来源尚未接入", { exact: false })
    .first()
    .waitFor({ timeout: 10_000 });
  await page.getByRole("button", { name: "Ask", exact: true }).click();
  await page.waitForTimeout(2000);
  // 芯片是 CM 的原子 Decoration：文档文本被替换成 widget DOM，断言要看芯片
  // 可交互芯片 widget 用 data-directive-type 标记；label 在 .aui-directive-chip-label
  const chipInfo = await page.evaluate(() => {
    const el =
      document.querySelector("textarea") ??
      document.querySelector('[contenteditable="true"]');
    const chip = el
      ? el.querySelector('[data-directive-type="inbox"] .aui-directive-chip-label')
      : null;
    return { present: Boolean(chip), text: chip?.textContent ?? "" };
  });
  assert(
    chipInfo.present && chipInfo.text.includes("E2E GitHub PR"),
    `Ask should insert an issue chip, got: ${JSON.stringify(chipInfo).slice(0, 120)}`,
  );
  console.log("[e2e] ask inserted issue chip into composer");
  await page.getByText("收件箱", { exact: true }).first().click();
  await page.waitForTimeout(1500);
  // 行选中态在离开/回来后仍保留；阅读窗标题出现即说明右栏跟随正确
  const detailTitle = page
    .getByText("E2E GitHub PR", { exact: false })
    .first();
  if (!(await detailTitle.isVisible().catch(() => false))) {
    await row(externalGroupKey).click();
    await detailTitle.waitFor({ timeout: 10_000 });
  }
  await page.waitForTimeout(800);
  await page.getByRole("button", { name: "更多操作", exact: true }).click();
  await page
    .getByRole("menuitem", { name: "查看会话", exact: true })
    .click({ timeout: 5_000 });
  // 点击后应切回聊天视图（新线程还在）
  await page.waitForTimeout(1500);
  const backInChat = await page.evaluate(() => {
    const el =
      document.querySelector("textarea") ??
      document.querySelector('[contenteditable="true"]');
    return Boolean(el) && (el.value ?? el.innerText ?? "").length > 0;
  });
  assert(backInChat, "查看会话 should switch back to the chat thread");
  console.log("[e2e] sent-to-agent backlink opens the thread");

  // 右侧阅读窗 ⋯ 菜单归档；归档后行离开待关注
  await page.getByText("收件箱", { exact: true }).first().click();
  await page.waitForTimeout(1500);
  // 重进收件箱会重挂左栏：选中态不保留，重新选中行并等阅读窗稳定
  await row(externalGroupKey).click();
  await page
    .getByText("E2E GitHub PR", { exact: false })
    .first()
    .waitFor({ timeout: 10_000 });
  await page.waitForTimeout(800);
  await page.getByRole("button", { name: "更多操作", exact: true }).click();
  await page.getByRole("menuitem", { name: "归档", exact: true }).click();
  await row(externalGroupKey).waitFor({ state: "detached", timeout: 15_000 });
  console.log("[e2e] external item archived");

  // 2) 历史：G1(组内 2 条) / G2 / G4；G3 已归档
  await setView(page, "历史");
  await page.getByText("E2E G1").first().waitFor({ timeout: 20_000 });
  await page.getByText("E2E G2").first().waitFor({ timeout: 20_000 });
  await page.getByText("E2E G4").first().waitFor({ timeout: 20_000 });
  await shot(page, "history");

  /** 选中一行 → 阅读窗 ⋯ → 删除 → 确认框 → 行消失 */
  const deleteSelected = async (key, title) => {
    await row(key).click();
    await page.getByText(title, { exact: false }).first().waitFor({ timeout: 10_000 });
    await page.getByRole("button", { name: "更多操作", exact: true }).click();
    await page.getByRole("menuitem", { name: "删除", exact: true }).click();
    const dialog = page.getByRole("alertdialog");
    await dialog.waitFor({ timeout: 10_000 });
    const text = await dialog.innerText();
    assert(
      text.includes("永久删除这条记录"),
      "single delete should keep the single-item confirm copy",
    );
    await dialog.getByRole("button", { name: "删除", exact: true }).click();
    await row(key).waitFor({ state: "detached", timeout: 15_000 });
  };

  await deleteSelected("automation:e2e-g2", "运行结果：E2E G2");
  console.log("[e2e] G2 deleted");
  await deleteSelected("automation:e2e-g4", "运行结果：E2E G4");
  console.log("[e2e] G4 deleted");

  // 3) 已归档 G3
  await setView(page, "已归档");
  await row("automation:e2e-g3").waitFor({ timeout: 15_000 });
  await deleteSelected("automation:e2e-g3", "运行结果：E2E G3");
  console.log("[e2e] G3 deleted");

  // 4) G1 组内 2 条仍在
  await setView(page, "历史");
  await row("automation:e2e-g1").click();
  await page.getByText("2 条更新", { exact: false }).first().waitFor({ timeout: 10_000 });
  const g1Text = await page.locator("body").innerText();
  assert(
    (g1Text.match(/运行成功/g) ?? []).length >= 2,
    "G1 should keep 2 events",
  );
  await shot(page, "g1-updates");

  // 5) 重启：G1 仍在（2 条），G2/G3/G4 的墓碑跨进程保持
  await app.close();
  app = null;
  await sleep(1500);
  ({ app } = await launch(dataDir));
  const page2 = await app.firstWindow();
  await dismissWhatsNew(page2);
  await setView(page2, "历史");
  await page2.getByText("E2E G1").first().waitFor({ timeout: 20_000 });
  const body = await page2.locator("body").innerText();
  assert(body.includes("E2E G1"), "restored G1 should survive restart");
  assert(!body.includes("E2E G2"), "deleted G2 must not resurrect");
  assert(!body.includes("E2E G3"), "deleted G3 must not resurrect");
  assert(!body.includes("E2E G4"), "deleted G4 must not resurrect");
  await shot(page2, "restart");
  console.log("[e2e] restart persistence OK");

  // --------------------------------------------------------------------
  // 闭环补充（隔离实例继续跑）：已读/未读、全部已读、搜索、任务类型筛选、
  // 连接异常横幅（假 Jira Server 永远 401 → needs_auth → 重新连接 → 断开）
  // --------------------------------------------------------------------

  // 1) 标记未读：历史里的 G1 → 未读后回到待关注
  await setView(page2, "历史");
  await page2.getByText("E2E G1").first().click();
  await page2.waitForTimeout(800);
  await page2.getByRole("button", { name: "更多操作", exact: true }).click();
  await page2.getByRole("menuitem", { name: "标记未读", exact: true }).click();
  await setView(page2, "待关注");
  await page2
    .getByText("E2E G1", { exact: false })
    .first()
    .waitFor({ timeout: 10_000 });
  console.log("[e2e] mark unread returns item to attention");

  // 2) 全部已读：待关注清空（按钮在视图 tabs 右侧）
  await page2.getByRole("button", { name: "全部已读", exact: true }).click();
  await page2
    .getByText("暂时没有需要关注的事项", { exact: false })
    .first()
    .waitFor({ timeout: 10_000 });
  console.log("[e2e] mark all read empties attention");

  // 3) 搜索：命中与不命中（搜索框常驻在左栏顶部）
  await setView(page2, "历史");
  const searchBox = page2.getByPlaceholder("搜索收件箱");
  await searchBox.fill("E2E G1");
  await page2.getByText("E2E G1").first().waitFor({ timeout: 10_000 });
  await searchBox.fill("绝对不存在的关键词xyz");
  await page2
    .getByText("没有匹配的条目", { exact: false })
    .first()
    .waitFor({ timeout: 10_000 });
  await page2.getByRole("button", { name: "清除搜索", exact: true }).click();
  await page2.getByText("E2E G1").first().waitFor({ timeout: 10_000 });
  console.log("[e2e] search filter works");

  // 4) 任务 tab + 任务类型筛选
  await page2.getByRole("button", { name: "来源：任务", exact: true }).click();
  await page2.waitForTimeout(700);
  await page2.getByRole("button", { name: /筛选/ }).click();
  await page2.getByRole("menuitemradio", { name: "自动化", exact: true }).click();
  await page2.getByText("E2E G1").first().waitFor({ timeout: 10_000 });
  await page2.waitForTimeout(400);
  await page2.getByRole("button", { name: /筛选/ }).click();
  const approvalFilter = page2.getByRole("menuitemradio", {
    name: "审批",
    exact: true,
  });
  await approvalFilter.waitFor({ timeout: 5_000 });
  await approvalFilter.click();
  await page2
    .getByText("没有匹配的条目", { exact: false })
    .first()
    .waitFor({ timeout: 10_000 });
  console.log("[e2e] task-type filter narrows the list");

  // 5) 连接异常闭环：假 Jira Server 永远 401 → needs_auth → 收件箱横幅 →
  //    重新连接跳设置 → 断开后横幅消失
  const fakeJira = createServer((req, res) => {
    res.writeHead(401, { "content-type": "application/json" });
    res.end(JSON.stringify({ message: "unauthorized" }));
  });
  await new Promise((resolve) => fakeJira.listen(0, "127.0.0.1", resolve));
  const fakePort = fakeJira.address().port;
  try {
    // 侧栏进设置（显式等页面切过去，避免点完还在原视图）
    await page2.keyboard.press("Escape");
    await page2.getByText("设置", { exact: true }).first().click();
    await page2
      .getByText("收件箱与 Webhook", { exact: true })
      .first()
      .waitFor({ timeout: 15_000 });
    await page2.getByText("收件箱与 Webhook", { exact: true }).first().click();
    const jiraRow = page2.locator("div.rounded-xl", { hasText: "Jira" }).first();
    await jiraRow.waitFor({ timeout: 15_000 });
    // Jira 行的「连接」→ 配置弹窗：站点指向假服务器 + 任意邮箱/Token
    await jiraRow.getByRole("button", { name: "连接", exact: true }).click();
    const dialog = page2.getByRole("dialog");
    await dialog.waitFor({ timeout: 10_000 });
    await dialog
      .getByPlaceholder("https://your-domain.atlassian.net")
      .fill(`http://127.0.0.1:${fakePort}`);
    await dialog.getByPlaceholder("you@company.com").fill("e2e@example.com");
    await dialog.getByPlaceholder("粘贴 Token").fill("pat-e2e");
    await dialog
      .getByRole("button", { name: "连接", exact: true })
      .last()
      .click();
    // 保存后首轮同步（1.5s）：401 → needs_auth；状态徽标挂在 Jira 行内
    await jiraRow
      .getByText("需要重新授权", { exact: false })
      .waitFor({ timeout: 30_000 });
    console.log("[e2e] connector enters needs_auth on 401");

    // 设置是全屏浮层，回收件箱要走它自己的「返回应用」出口
    await page2.getByText("返回应用", { exact: true }).first().click();
    await page2.waitForTimeout(1000);
    const banner = page2.getByText("Jira：", { exact: false }).first();
    await banner.waitFor({ timeout: 10_000 });
    await page2
      .getByRole("button", { name: "重新连接", exact: true })
      .first()
      .click();
    await page2
      .getByText("收件箱来源", { exact: true })
      .first()
      .waitFor({ timeout: 10_000 });
    console.log("[e2e] inbox banner reconnect jumps to settings");

    // 断开：重新连接已把页面带到设置的收件箱来源段，直接开 Jira 行菜单
    await page2
      .locator("div.rounded-xl", { hasText: "Jira" })
      .first()
      .getByRole("button", { name: "更多操作", exact: true })
      .click();
    await page2.getByRole("menuitem", { name: "断开", exact: true }).click();
    const confirm = page2.getByRole("alertdialog");
    await confirm.waitFor({ timeout: 10_000 });
    await confirm.getByRole("button", { name: "断开", exact: true }).click();
    // 从设置的浮层里退回应用，再验证横幅消失
    await page2.getByText("返回应用", { exact: true }).first().click();
    await page2.waitForTimeout(1000);
    await page2
      .getByText("Jira：", { exact: false })
      .first()
      .waitFor({ state: "detached", timeout: 10_000 });
    console.log("[e2e] disconnect clears the banner");
  } finally {
    fakeJira.close();
  }

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
