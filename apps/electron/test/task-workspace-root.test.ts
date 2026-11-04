import { describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  decideMigrateRecovery,
  migrateTaskWorkspaceDir,
  validateTaskWorkspaceRoot,
  type TaskWorkspaceMigrateMarker,
} from "../main/task-workspace-root";

const dataDir = "/tmp/kova-task-root/app-data";
const homeDir = "/tmp/kova-task-root/home";

function marker(partial: Partial<TaskWorkspaceMigrateMarker>): TaskWorkspaceMigrateMarker {
  return {
    from: "/old/task-workspace",
    to: "/new/task-workspace",
    staging: "/new/task-workspace/.migrate-20261104-101010",
    phase: "copying",
    startedAt: "2026-11-04T10:10:10+08:00",
    ...partial,
  };
}

describe("validateTaskWorkspaceRoot", () => {
  const opts = { appDataDir: dataDir, homeDir };

  test("普通绝对路径通过（Windows 盘符形式同样放行）", () => {
    expect(validateTaskWorkspaceRoot("/Volumes/Data/kova-artifacts", opts)).toBeNull();
    expect(validateTaskWorkspaceRoot("D:\\kova-artifacts", opts)).toBeNull();
  });

  test("相对路径、文件系统根与盘根拒绝", () => {
    expect(validateTaskWorkspaceRoot("relative/path", opts)).toBe("bad-path");
    expect(validateTaskWorkspaceRoot("/", opts)).toBe("bad-path");
    expect(validateTaskWorkspaceRoot("C:\\", opts)).toBe("bad-path");
  });

  test("家目录本体拒绝", () => {
    expect(validateTaskWorkspaceRoot(homeDir, opts)).toBe("home-not-allowed");
  });

  test("appDataDir 及其祖先/内部非缺省目录拒绝", () => {
    expect(validateTaskWorkspaceRoot(dataDir, opts)).toBe("app-data-not-allowed");
    expect(validateTaskWorkspaceRoot("/tmp/kova-task-root", opts)).toBe("app-data-not-allowed");
    expect(validateTaskWorkspaceRoot(join(dataDir, "task-workspace/sub"), opts)).toBe(
      "app-data-not-allowed",
    );
  });

  test("缺省任务产物目录本身放行（允许切回缺省位置）", () => {
    expect(validateTaskWorkspaceRoot(join(dataDir, "task-workspace"), opts)).toBeNull();
  });
});

describe("decideMigrateRecovery", () => {
  test("copying 中断：丢弃暂存，保持旧根", () => {
    expect(decideMigrateRecovery(marker({ phase: "copying" }), () => true)).toBe("discard");
  });

  test("renaming 后目标在、源不在：补切根", () => {
    const m = marker({ phase: "renaming", staging: "" });
    expect(decideMigrateRecovery(m, (p) => p === "/new/task-workspace")).toBe("flip");
  });

  test("renaming 未执行（源还在）：丢弃标记", () => {
    const m = marker({ phase: "renaming", staging: "" });
    expect(decideMigrateRecovery(m, (p) => p === "/old/task-workspace")).toBe("discard");
  });

  test("finalizing 且暂存仍在：续跑收尾", () => {
    const m = marker({ phase: "finalizing" });
    expect(decideMigrateRecovery(m, (p) => p === m.staging)).toBe("resume-finalize");
  });

  test("verify 阶段与 finalizing 同路：复制已完成，暂存续跑收尾", () => {
    const m = marker({ phase: "verify" });
    expect(decideMigrateRecovery(m, (p) => p === m.staging)).toBe("resume-finalize");
    expect(
      decideMigrateRecovery(marker({ phase: "verify" }), (p) => p === "/new/task-workspace"),
    ).toBe("flip");
  });

  test("finalizing 且暂存已清、目标在位：收尾已完成，补切根", () => {
    expect(
      decideMigrateRecovery(marker({ phase: "finalizing" }), (p) => p === "/new/task-workspace"),
    ).toBe("flip");
  });

  test("finalizing 暂存与目标都丢失（盘未挂载/被手动删）：丢弃，不切根", () => {
    expect(decideMigrateRecovery(marker({ phase: "finalizing" }), () => false)).toBe("discard");
  });
});

describe("migrateTaskWorkspaceDir", () => {
  function tempRoot(prefix: string): string {
    return mkdtempSync(join(tmpdir(), prefix));
  }

  test("同盘 + 目标不存在：整目录 rename，内容与源一致", async () => {
    const base = tempRoot("kova-task-move-");
    try {
      const from = join(base, "old");
      const to = join(base, "new");
      mkdirSync(join(from, "session-a"), { recursive: true });
      writeFileSync(join(from, "session-a", "note.md"), "hello");
      writeFileSync(join(from, "top.txt"), "world");

      const phases: string[] = [];
      const result = await migrateTaskWorkspaceDir(from, to, {
        staging: join(to, ".migrate-test"),
        onPhase: (p) => phases.push(p),
      });

      expect(result.usedRename).toBe(true);
      expect(result.movedFiles).toBe(2);
      expect(readFileSync(join(to, "session-a", "note.md"), "utf8")).toBe("hello");
      expect(readFileSync(join(to, "top.txt"), "utf8")).toBe("world");
      expect(phases).toContain("renaming");
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("目标已存在：复制合并，同名加序号，源数据原样保留", async () => {
    const base = tempRoot("kova-task-merge-");
    try {
      const from = join(base, "old");
      const to = join(base, "new");
      mkdirSync(from, { recursive: true });
      mkdirSync(to, { recursive: true });
      writeFileSync(join(from, "same.txt"), "from");
      writeFileSync(join(to, "same.txt"), "existing");
      writeFileSync(join(from, "only-old.txt"), "keep");

      const result = await migrateTaskWorkspaceDir(from, to, {
        staging: join(to, ".migrate-test"),
        forceCopy: true,
      });

      expect(result.usedRename).toBe(false);
      // 源未被删除（清理由调用方在切根后做）
      expect(readFileSync(join(from, "same.txt"), "utf8")).toBe("from");
      expect(readFileSync(join(to, "same.txt"), "utf8")).toBe("existing");
      expect(readFileSync(join(to, "same (2).txt"), "utf8")).toBe("from");
      expect(readFileSync(join(to, "only-old.txt"), "utf8")).toBe("keep");
      // 暂存目录收尾后不残留
      expect(() => readFileSync(join(to, ".migrate-test"))).toThrow();
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("复制路径校验通过后才收尾：子目录/空文件/符号链接都可迁移，且保留 mtime", async () => {
    const base = tempRoot("kova-task-copy-");
    try {
      const from = join(base, "old");
      const to = join(base, "new");
      mkdirSync(join(from, "s1", "nested"), { recursive: true });
      writeFileSync(join(from, "s1", "nested", "a.txt"), "a");
      writeFileSync(join(from, "empty.txt"), "");
      const stamp = new Date("2024-05-06T07:08:09Z");
      utimesSync(join(from, "s1", "nested", "a.txt"), stamp, stamp);
      symlinkSync(join(from, "s1", "nested", "a.txt"), join(from, "link.txt"));
      mkdirSync(to, { recursive: true });

      const result = await migrateTaskWorkspaceDir(from, to, {
        staging: join(to, ".migrate-test"),
        forceCopy: true,
      });

      expect(result.movedFiles).toBe(3);
      expect(readFileSync(join(to, "s1", "nested", "a.txt"), "utf8")).toBe("a");
      expect(readFileSync(join(to, "empty.txt"), "utf8")).toBe("");
      // 符号链接保持为链接（读取跟随目标）
      expect(readFileSync(join(to, "link.txt"), "utf8")).toBe("a");
      // mtime 保留（文件列表按修改时间展示）
      const got = statSync(join(to, "s1", "nested", "a.txt")).mtime.getTime();
      expect(Math.abs(got - stamp.getTime()) < 2000).toBe(true);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("目标路径是文件：报错且源数据不动", async () => {
    const base = tempRoot("kova-task-fail-");
    try {
      const from = join(base, "old");
      const to = join(base, "occupied");
      mkdirSync(from, { recursive: true });
      writeFileSync(join(from, "keep.txt"), "safe");
      writeFileSync(to, "i am a file");

      let threw = false;
      try {
        await migrateTaskWorkspaceDir(from, to, { staging: join(base, ".migrate-test") });
      } catch {
        threw = true;
      }
      expect(threw).toBe(true);
      expect(readFileSync(join(from, "keep.txt"), "utf8")).toBe("safe");
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("源为空目录：直接建目标并清空源（无内容可丢）", async () => {
    const base = tempRoot("kova-task-empty-");
    try {
      const from = join(base, "old");
      const to = join(base, "new");
      mkdirSync(from, { recursive: true });
      const result = await migrateTaskWorkspaceDir(from, to, { staging: join(to, ".migrate-test") });
      expect(result.movedFiles).toBe(0);
      expect(() => readFileSync(from)).toThrow();
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
