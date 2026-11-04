import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  APP_DATA_PREFIX,
  backupCollectPlan,
  collectDirFiles,
  HOME_KOVA_PREFIX,
  kovaHomeDir,
  parseHeaderFromPrefix,
  passphraseDecision,
  planRestore,
  readEnvelopeHeader,
  restoreTargets,
  type BackupHeader,
  type BackupSectionFlags,
  type RestoreTarget,
} from "../main/backup-plan";

const dataDir = "/tmp/kova-backup-plan/data";
const homeDir = "/tmp/kova-backup-plan/home/.kova";

function flags(partial: Partial<BackupSectionFlags> = {}): BackupSectionFlags {
  return {
    includeWorkspace: true,
    includeLibrary: true,
    includePersonal: true,
    includeSkillsPlugins: true,
    includeCheckpoints: true,
    ...partial,
  };
}

describe("backupCollectPlan", () => {
  test("核心分区始终收集 sessions（state.db 由 packBackup 单独加入）", () => {
    const plan = backupCollectPlan(
      flags({
        includeWorkspace: false,
        includeLibrary: false,
        includePersonal: false,
        includeSkillsPlugins: false,
        includeCheckpoints: false,
      }),
      dataDir,
      homeDir,
    );
    expect(plan.map((s) => s.rel)).toEqual(["sessions"]);
    expect(plan[0].section).toBe("core");
    expect(plan[0].abs).toBe(join(dataDir, "sessions"));
  });

  test("工作区与资料库按开关收集，落在 v1 的顶层路径", () => {
    const plan = backupCollectPlan(flags(), dataDir, homeDir);
    const rels = plan.map((s) => s.rel);
    expect(rels).toContain("task-workspace");
    expect(rels).toContain("library");
    expect(plan.find((s) => s.rel === "library")?.section).toBe("library");
  });

  test("任务产物根可自定义：收集与恢复都跟随传入的根，包内 rel 保持 task-workspace", () => {
    const custom = "/Volumes/Data/kova-artifacts";
    const plan = backupCollectPlan(flags(), dataDir, homeDir, custom);
    const workspace = plan.find((s) => s.rel === "task-workspace");
    expect(workspace?.abs).toBe(custom);
    expect(workspace?.section).toBe("workspace");

    const targets = restoreTargets(dataDir, homeDir, custom);
    expect(targets.find((t) => t.rel === "task-workspace")?.dest).toBe(custom);
  });

  test("个人配置映射到 home-kova 与 app-data 两个命名空间；OAuth token 不进包", () => {
    const plan = backupCollectPlan(
      flags({ includeWorkspace: false, includeLibrary: false, includeSkillsPlugins: false, includeCheckpoints: false }),
      dataDir,
      homeDir,
    );
    const rels = plan.map((s) => s.rel);
    expect(rels).toContain(`${HOME_KOVA_PREFIX}/soul.md`);
    expect(rels).toContain(`${HOME_KOVA_PREFIX}/rules.md`);
    expect(rels).toContain(`${HOME_KOVA_PREFIX}/AGENTS.md`);
    expect(rels).toContain(`${HOME_KOVA_PREFIX}/mcp.json`);
    expect(rels).toContain(`${HOME_KOVA_PREFIX}/permissions.json`);
    expect(rels).toContain(`${HOME_KOVA_PREFIX}/memory`);
    expect(rels).toContain(`${APP_DATA_PREFIX}/pets`);
    expect(rels).toContain(`${APP_DATA_PREFIX}/browser-site-permissions.json`);
    expect(rels).toContain(`${APP_DATA_PREFIX}/design-md/user`);
    // mcp-oauth.json 是纯 token，可重新登录取回：刻意不进备份
    expect(rels.includes(`${HOME_KOVA_PREFIX}/mcp-oauth.json`)).toBe(false);
    // builtin 设计主题随应用分发，不进包
    expect(rels.includes(`${APP_DATA_PREFIX}/design-md/builtin`)).toBe(false);
    expect(plan.filter((s) => s.section !== "core").every((s) => s.section === "personal")).toBe(true);
  });

  test("插件分区拆成可保留部分：repos/catalogs（可重新拉取）不进包", () => {
    const plan = backupCollectPlan(flags(), dataDir, homeDir).map((s) => s.rel);
    expect(plan).toContain(`${APP_DATA_PREFIX}/skills`);
    expect(plan).toContain(`${APP_DATA_PREFIX}/subagents`);
    expect(plan).toContain(`${APP_DATA_PREFIX}/plugins/marketplaces.json`);
    expect(plan).toContain(`${APP_DATA_PREFIX}/plugins/cache`);
    expect(plan).toContain(`${APP_DATA_PREFIX}/plugins/dev-marketplace`);
    expect(plan.includes(`${APP_DATA_PREFIX}/plugins/repos`)).toBe(false);
    expect(plan.includes(`${APP_DATA_PREFIX}/plugins/catalogs`)).toBe(false);

    const targets = restoreTargets(dataDir, homeDir).map((t) => t.rel);
    expect(targets).toContain(`${APP_DATA_PREFIX}/plugins/cache`);
    expect(targets.includes(`${APP_DATA_PREFIX}/plugins`)).toBe(false);
  });

  test("检查点可关", () => {
    const on = backupCollectPlan(flags(), dataDir, homeDir).map((s) => s.rel);
    expect(on).toContain(`${APP_DATA_PREFIX}/checkpoints`);
    expect(on).toContain(`${HOME_KOVA_PREFIX}/checkpoints`);

    const off = backupCollectPlan(flags({ includeCheckpoints: false }), dataDir, homeDir).map((s) => s.rel);
    expect(off.includes(`${APP_DATA_PREFIX}/checkpoints`)).toBe(false);
    expect(off.includes(`${HOME_KOVA_PREFIX}/checkpoints`)).toBe(false);
  });
});

describe("restoreTargets / planRestore", () => {
  const targets = restoreTargets(dataDir, homeDir);
  const byRel = (rel: string): RestoreTarget => {
    const found = targets.find((t) => t.rel === rel);
    if (!found) throw new Error(`missing target ${rel}`);
    return found;
  };

  test("资料库与个人配置都有恢复落点", () => {
    expect(byRel("library").dest).toBe(join(dataDir, "library"));
    expect(byRel(`${HOME_KOVA_PREFIX}/soul.md`).dest).toBe(join(homeDir, "soul.md"));
    expect(byRel(`${APP_DATA_PREFIX}/skills`).dest).toBe(join(dataDir, "skills"));
    expect(byRel(`${APP_DATA_PREFIX}/design-md/user`).dest).toBe(join(dataDir, "design-md", "user"));
    // core 排在最前（先换库，再换其它）
    expect(targets[0].rel).toBe("state.db");
  });

  test("staging 没有的条目：不移走也不换入（修掉关开关恢复清空产物）", () => {
    const steps = planRestore(
      targets,
      (t) => t.rel === "state.db" || t.rel === "task-workspace",
      (t) => t.rel === "state.db",
    );
    const workspace = steps.find((s) => s.target.rel === "task-workspace")!;
    expect(workspace.moveIn).toBe(false);
    expect(workspace.moveAside).toBe(false);

    const db = steps.find((s) => s.target.rel === "state.db")!;
    expect(db.moveIn).toBe(true);
    expect(db.moveAside).toBe(true);
  });

  test("staging 有而当前没有：只换入不移走", () => {
    const steps = planRestore(
      targets,
      () => false,
      (t) => t.rel === "library",
    );
    const library = steps.find((s) => s.target.rel === "library")!;
    expect(library.moveIn).toBe(true);
    expect(library.moveAside).toBe(false);
  });

  test("旧包（只有 v1 分区）不会触发新分区的换入", () => {
    const legacy = new Set(["state.db", "sessions", "task-workspace"]);
    const steps = planRestore(
      targets,
      () => true,
      (t) => legacy.has(t.rel),
    );
    expect(steps.filter((s) => s.moveIn).map((s) => s.target.rel)).toEqual([
      "state.db",
      "sessions",
      "task-workspace",
    ]);
    expect(steps.find((s) => s.target.rel === "library")?.moveAside).toBe(false);
    expect(steps.find((s) => s.target.rel === `${HOME_KOVA_PREFIX}/soul.md`)?.moveIn).toBe(false);
  });
});

describe("passphraseDecision", () => {
  test("显式输入优先", () => {
    expect(passphraseDecision("abc", true, true, true)).toEqual({ kind: "explicit", passphrase: "abc" });
  });

  test("记住的口令可解时复用", () => {
    expect(passphraseDecision(undefined, true, true, true)).toEqual({ kind: "stored" });
  });

  test("记住的行口令解不开时显式标记（备份侧据此报错）", () => {
    expect(passphraseDecision("", true, true, false)).toEqual({ kind: "stored-unreadable" });
  });

  test("未勾记住口令或从未存过口令 = 不加密", () => {
    expect(passphraseDecision(undefined, false, true, true)).toEqual({ kind: "none" });
    expect(passphraseDecision(undefined, true, false, false)).toEqual({ kind: "none" });
  });
});

/* ------------------------------ 信封 header（P0 回归） ------------------------------ */

function envelopeHeaderJson(fileCount: number, encrypted = true): string {
  const files = Array.from({ length: fileCount }, (_, i) => ({
    path: `sessions/00000000-0000-4000-8000-${String(i).padStart(12, "0")}.jsonl`,
    size: 1024 + i,
    sha256: "a".repeat(64),
  }));
  const header: BackupHeader = {
    formatVersion: 1,
    schemaVersion: 2,
    createdAt: "2026-11-03T10:00:00+08:00",
    device: "e2e-device",
    appVersion: "1.0.0",
    encrypted,
    ...(encrypted
      ? { kdf: { algo: "PBKDF2-SHA256", salt: "s".repeat(24), iterations: 600000, nonce: "n".repeat(16) } }
      : {}),
    files,
    payloadSha256: "b".repeat(64),
    payloadSize: 123,
    sections: ["core", "workspace"],
  };
  return JSON.stringify(header);
}

describe("parseHeaderFromPrefix / readEnvelopeHeader", () => {
  test("超过 8KB 的 header（真实备份常态）也能完整解析", () => {
    const body = envelopeHeaderJson(2000);
    expect(body.length).toBeGreaterThan(8192);
    const prefix = Buffer.concat([Buffer.from("PIABK1\n"), Buffer.from(body), Buffer.from("\n")]);
    const header = parseHeaderFromPrefix(prefix);
    expect(header.files.length).toBe(2000);
    expect(header.encrypted).toBe(true);
  });

  test("被前缀截断的 header 报「header 未完整」", () => {
    const prefix = Buffer.concat([Buffer.from("PIABK1\n"), Buffer.from(envelopeHeaderJson(2000).slice(0, 4096))]);
    expect(() => parseHeaderFromPrefix(prefix)).toThrow(/header 未完整/);
  });

  test("readEnvelopeHeader 增量读取：跨过初始 256KB 缓冲的大 header", () => {
    const dir = mkdtempSync(join(tmpdir(), "kova-bk-header-"));
    try {
      const big = join(dir, "big.piabk");
      writeFileSync(
        big,
        Buffer.concat([
          Buffer.from("PIABK1\n"),
          Buffer.from(envelopeHeaderJson(3000)),
          Buffer.from("\n"),
          Buffer.from("payload-bytes"),
        ]),
      );
      const header = readEnvelopeHeader(big);
      expect(header.files.length).toBe(3000);
      expect(header.encrypted).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("readEnvelopeHeader：截断报错、坏 magic 报错", () => {
    const dir = mkdtempSync(join(tmpdir(), "kova-bk-header-"));
    try {
      const trunc = join(dir, "trunc.piabk");
      writeFileSync(trunc, Buffer.concat([Buffer.from("PIABK1\n"), Buffer.from(envelopeHeaderJson(3000).slice(0, 5000))]));
      expect(() => readEnvelopeHeader(trunc)).toThrow(/header 未完整/);

      const bad = join(dir, "bad.piabk");
      writeFileSync(bad, "not a backup\nsecond line\n");
      expect(() => readEnvelopeHeader(bad)).toThrow(/magic 不匹配/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/* ------------------------------ 收集器（symlink） ------------------------------ */

describe("collectDirFiles", () => {
  test("根内链接收集、根外链接跳过并记录、链接环不会死循环", () => {
    const root = mkdtempSync(join(tmpdir(), "kova-bk-collect-"));
    const outside = mkdtempSync(join(tmpdir(), "kova-bk-outside-"));
    try {
      mkdirSync(join(root, "real"));
      writeFileSync(join(root, "real", "a.txt"), "a");
      writeFileSync(join(root, "top.txt"), "t");
      writeFileSync(join(root, ".DS_Store"), "junk");
      // 根内目录链接（链接安装的插件形态）
      symlinkSync(join(root, "real"), join(root, "link-in"));
      // 根外文件链接：不跟进
      writeFileSync(join(outside, "secret.txt"), "s");
      symlinkSync(join(outside, "secret.txt"), join(root, "link-out"));
      // 链接环：a -> b -> a
      symlinkSync(join(root, "loop-b"), join(root, "loop-a"));
      symlinkSync(join(root, "loop-a"), join(root, "loop-b"));

      const out: [string, string][] = [];
      const stats = { skippedLinks: 0, skippedLinksPaths: [] as string[] };
      collectDirFiles(root, "pkg", out, stats);
      const rels = out.map(([, rel]) => rel);

      expect(rels).toContain("pkg/top.txt");
      expect(rels).toContain("pkg/real/a.txt");
      expect(rels).toContain("pkg/link-in/a.txt");
      expect(rels.some((rel) => rel.includes("secret.txt"))).toBe(false);
      expect(rels.includes("pkg/.DS_Store")).toBe(false);
      expect(stats.skippedLinks).toBeGreaterThanOrEqual(1);
      expect(stats.skippedLinksPaths.join(",")).toContain("link-out");
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

/* ------------------------------ 环境覆盖 ------------------------------ */

describe("kovaHomeDir", () => {
  test("KOVA_BACKUP_HOME_DIR 可覆盖默认 ~/.kova", () => {
    const previous = process.env.KOVA_BACKUP_HOME_DIR;
    process.env.KOVA_BACKUP_HOME_DIR = "/tmp/kova-home-override";
    try {
      expect(kovaHomeDir()).toBe("/tmp/kova-home-override");
    } finally {
      if (previous === undefined) delete process.env.KOVA_BACKUP_HOME_DIR;
      else process.env.KOVA_BACKUP_HOME_DIR = previous;
    }
    expect(kovaHomeDir()).toBe(join(homedir(), ".kova"));
  });
});
