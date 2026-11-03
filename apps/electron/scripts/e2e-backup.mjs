/**
 * 备份/恢复端到端（CDP + 磁盘断言），两阶段：
 *
 *   node apps/electron/scripts/e2e-backup.mjs <cdpPort> <outDir>                # 阶段 1
 *   node apps/electron/scripts/e2e-backup.mjs <cdpPort> <outDir> --phase=after  # 重启后阶段 2
 *
 * 阶段 1：config get/set（含秘密字段 Set 位与三个新开关）→ 备份（明文/加密 +
 * 关工作区各一份）→ peek_header → restore（staging + 待恢复标记）→ 校验
 * staging 内新分区（library / home-kova / app-data）与残行修剪。
 * 阶段 2（重启后）：校验换入结果（资料库/个人配置回来、关掉工作区的包不碰
 * 现有 task-workspace、restore-applied 标记被清理、pre-restore-* 保留旧数据）。
 *
 * 环境：
 *   KOVA_DATA_DIR         数据目录（默认 /tmp/kova-e2e-bk）
 *   KOVA_BACKUP_HOME_DIR  个人配置沙箱（<dir> 即 ~/.kova 的备份视角；不设置则
 *                         跳过 personal 断言，并且绝不写真实 ~/.kova）
 */
import { chromium } from "playwright-core";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const port = process.argv[2] ?? "9229";
const outDir = process.argv[3] ?? "/tmp/kova-bk-out";
const phase = process.argv.includes("--phase=after") ? "after" : "before";
const dataDir = process.env.KOVA_DATA_DIR ?? "/tmp/kova-e2e-bk";
const homeDir = process.env.KOVA_BACKUP_HOME_DIR ?? "";

const staging = join(dataDir, "restore-staging", "content");
const fixtures = {
  library: join(dataDir, "library", "e2e-note.md"),
  skill: join(dataDir, "skills", "e2e-skill.md"),
  workspace: join(dataDir, "task-workspace", "e2e-keep.txt"),
  soul: homeDir ? join(homeDir, "soul.md") : "",
  memory: homeDir ? join(homeDir, "memory", "e2e-memory.md") : "",
};

function writeFixture(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf8");
}

/** 阶段 1 之前由调用方（或本脚本）准备的固定数据；不覆盖已有内容 */
function ensureFixtures() {
  if (!existsSync(fixtures.library)) writeFixture(fixtures.library, "library note\n");
  if (!existsSync(fixtures.skill)) writeFixture(fixtures.skill, "# e2e skill\n");
  if (!existsSync(fixtures.workspace)) writeFixture(fixtures.workspace, "keep me\n");
  if (fixtures.soul && !existsSync(fixtures.soul)) writeFixture(fixtures.soul, "# e2e soul\n");
  if (fixtures.memory && !existsSync(fixtures.memory)) writeFixture(fixtures.memory, "# e2e memory\n");
  // 大 header 回归：header 含逐文件清单，2400 个小文件 ≈ 300KB（越过读取器的初始缓冲）
  const bigDir = join(dataDir, "sessions", "e2e-big");
  mkdirSync(bigDir, { recursive: true });
  for (let i = 0; i < 2400; i++) {
    const p = join(bigDir, `f${String(i).padStart(4, "0")}.jsonl`);
    if (!existsSync(p)) writeFileSync(p, '{"type":"message"}\n');
  }
}

async function connect() {
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  let page = null;
  for (const c of browser.contexts()) for (const p of c.pages()) if (p.url().startsWith("kova://")) page = p;
  if (!page) {
    await browser.close();
    throw new Error("no kova:// page");
  }
  return { browser, page };
}

async function connectWithRetry(timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return await connect();
    } catch (e) {
      if (Date.now() > deadline) throw e;
      await new Promise((r) => setTimeout(r, 500));
    }
  }
}

const { browser, page } = await connectWithRetry();
const call = (cmd, args = {}) =>
  page.evaluate(
    async ({ cmd, args }) => {
      const r = await window.kovaHost.invoke(cmd, args);
      if (!r?.ok) throw new Error(`${cmd}: ${r?.error}`);
      return r.value;
    },
    { cmd, args },
  );

/* ------------------------------- 阶段 2：重启后 ------------------------------- */

if (phase === "after") {
  // sanitize 在 whenReady 早期执行；窗口出现后 marker 应已清理（留 10s 余量）
  const markerPath = join(dataDir, "restore-applied.json");
  const deadline = Date.now() + 10_000;
  while (existsSync(markerPath) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 300));

  const prefixed = readdirSync(dataDir)
    .filter((n) => n.startsWith("pre-restore-"))
    .sort();
  const latest = prefixed.length > 0 ? join(dataDir, prefixed[prefixed.length - 1]) : "";
  const outAfter = {
    phase: "after",
    dataDir,
    homeDir: homeDir || null,
    libraryRestored: existsSync(fixtures.library) && readFileSync(fixtures.library, "utf8") === "library note\n",
    skillRestored: existsSync(fixtures.skill) && readFileSync(fixtures.skill, "utf8") === "# e2e skill\n",
    workspaceKept: existsSync(fixtures.workspace) && readFileSync(fixtures.workspace, "utf8") === "keep me\n",
    personalRestored: fixtures.soul
      ? existsSync(fixtures.soul) && readFileSync(fixtures.soul, "utf8") === "# e2e soul\n"
      : null,
    memoryRestored: fixtures.memory
      ? existsSync(fixtures.memory) && readFileSync(fixtures.memory, "utf8") === "# e2e memory\n"
      : null,
    restoreAppliedMarkerGone: !existsSync(markerPath),
    preRestoreDir: latest || null,
    preRestoreHasDb: latest ? existsSync(join(latest, "state.db")) : false,
    preRestoreHasSessions: latest ? existsSync(join(latest, "sessions")) : false,
    preRestoreLibraryAside: latest ? existsSync(join(latest, "library")) : false,
  };
  console.log(JSON.stringify(outAfter, null, 2));
  await browser.close();
  process.exit(0);
}

/* ------------------------------- 阶段 1 ------------------------------- */

ensureFixtures();

const out = {};
out.config0 = await call("backup_config_get");
const set = await call("backup_config_set", {
  config: {
    ...out.config0,
    provider: "off",
    includeWorkspace: true,
    includeLibrary: true,
    includePersonal: true,
    includeSkillsPlugins: true,
    includeCheckpoints: false,
    deviceName: "e2e-device",
    rememberPassphrase: false,
    s3SecretAccessKey: "sk-secret-e2e-123456",
    davPassword: "",
    passphrase: "",
  },
});
out.configSet = {
  deviceName: set.deviceName,
  s3SecretSet: set.s3SecretAccessKeySet,
  davSet: set.davPasswordSet,
  includePersonal: set.includePersonal,
  includeSkillsPlugins: set.includeSkillsPlugins,
  includeCheckpoints: set.includeCheckpoints,
};

const plainPath = join(outDir, "plain.piabk");
out.runPlain = await call("backup_run", { target: "local", localPath: plainPath });

const encPath = join(outDir, "enc.piabk");
out.runEncrypted = await call("backup_run", { target: "local", localPath: encPath, passphrase: "口令-pass-42" });

out.peekPlain = await call("backup_peek_header", { path: plainPath });
out.peekEnc = await call("backup_peek_header", { path: encPath });

// 恢复（本地明文）→ staging + 待恢复标记
out.restore = await call("backup_restore", { source: { localPath: plainPath } });

// 磁盘断言：staging 内容 + 残行修剪 + 新分区 + 标记文件
out.disk = {
  stagingDb: existsSync(join(staging, "state.db")),
  stagingSessions: existsSync(join(staging, "sessions")) ? readdirSync(join(staging, "sessions")) : [],
  marker: existsSync(join(dataDir, "pending-restore.json")),
  tornTrimmed: existsSync(join(staging, "sessions", "s1.jsonl"))
    ? readFileSync(join(staging, "sessions", "s1.jsonl"), "utf8") ===
      '{"type":"message","id":1}\n{"type":"message","id":2}\n{"type":"message","id":3}\n'
    : null,
  workspaceBackedUp: existsSync(join(staging, "task-workspace", "e2e-keep.txt")),
  libraryBackedUp: existsSync(join(staging, "library", "e2e-note.md")),
  skillsBackedUp: existsSync(join(staging, "app-data", "skills", "e2e-skill.md")),
  personalBackedUp: homeDir
    ? existsSync(join(staging, "home-kova", "soul.md")) &&
      existsSync(join(staging, "home-kova", "memory", "e2e-memory.md"))
    : null,
  checkpointsExcluded: !existsSync(join(staging, "app-data", "checkpoints")),
  envelopeSize: existsSync(plainPath) ? statSync(plainPath).size : 0,
};
out.markerContent = existsSync(join(dataDir, "pending-restore.json"))
  ? JSON.parse(readFileSync(join(dataDir, "pending-restore.json"), "utf8"))
  : null;

// 错误口令恢复应失败且清掉 staging
let errMsg = "";
try {
  await call("backup_restore", { source: { localPath: encPath, passphrase: "wrong-pass" } });
} catch (e) {
  errMsg = String(e.message ?? e);
}
out.wrongPassphrase = {
  errorHead: errMsg.slice(0, 120),
  stagingCleaned: !existsSync(join(dataDir, "restore-staging")),
};

// 正确口令恢复（加密包）
out.restoreEncrypted = await call("backup_restore", { source: { localPath: encPath, passphrase: "口令-pass-42" } });

// 关掉「任务工作区」的备份：恢复时不得移走/清空现有产物（阶段 2 继续断言）
out.configNoWorkspace = await call("backup_config_set", {
  config: { ...set, includeWorkspace: false },
});
const noWsPath = join(outDir, "no-workspace.piabk");
out.runNoWorkspace = await call("backup_run", { target: "local", localPath: noWsPath });
out.restoreNoWorkspace = await call("backup_restore", { source: { localPath: noWsPath } });
out.diskNoWorkspace = {
  marker: existsSync(join(dataDir, "pending-restore.json")),
  stagingWorkspaceAbsent: !existsSync(join(staging, "task-workspace")),
  stagingLibraryPresent: existsSync(join(staging, "library", "e2e-note.md")),
  currentWorkspaceIntact: existsSync(fixtures.workspace) && readFileSync(fixtures.workspace, "utf8") === "keep me\n",
};

// 模拟「换入会覆盖当前数据」：删掉当前资料库/技能/个人配置，阶段 2 应由 staging 恢复
rmSync(fixtures.library, { force: true });
rmSync(fixtures.skill, { force: true });
if (fixtures.soul) rmSync(fixtures.soul, { force: true });
if (fixtures.memory) rmSync(fixtures.memory, { force: true });

console.log(JSON.stringify(out, null, 2));
await browser.close();
