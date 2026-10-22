/**
 * 项目虚拟目录：归属解析、生效清单、增删校验与持久化。
 * 这里的路径规则是「一个目录只能属于一个项目」的边界，测试方向是找绕过。
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addProjectDir,
  canonicalProjectCwd,
  effectiveProjectDirs,
  initProjectDirs,
  projectCwdFor,
  projectRootsFor,
  removeProjectDir,
  resetProjectDirsForTest,
  seedProjectDirsForTest,
} from "../../src/agent/project-dirs";
import { MAX_EXTERNAL_DIRS } from "../../src/agent/external-dirs";
import { initLocalStorage, resetStorageForTest } from "../../src/storage/hostdb";

// macOS /tmp 是软链：模块统一走 realpath，夹具也用真实路径
const tmp = realpathSync(mkdtempSync(join(tmpdir(), "project-dirs-")));
const main = join(tmp, "frontend");
const backend = join(tmp, "backend");
const shared = join(tmp, "shared");
const extra = join(tmp, "extra");
const otherMain = join(tmp, "other");
for (const dir of [main, backend, shared, extra, otherMain]) {
  mkdirSync(dir, { recursive: true });
}

beforeAll(() => {
  initLocalStorage(join(tmp, "state.db"));
});

afterAll(() => {
  resetProjectDirsForTest();
  resetStorageForTest();
});

function seedDefault(): void {
  seedProjectDirsForTest({
    [main]: [{ path: backend, label: "backend" }],
  });
}

describe("归属解析", () => {
  test("主目录与附加根都归到主目录；无关目录为 undefined", () => {
    seedDefault();
    expect(projectCwdFor(main)).toBe(main);
    expect(projectCwdFor(backend)).toBe(main);
    expect(projectCwdFor(shared)).toBeUndefined();
    expect(canonicalProjectCwd(main)).toBe(main);
    expect(canonicalProjectCwd(backend)).toBe(main);
    expect(canonicalProjectCwd("")).toBeUndefined();
  });

  test("projectRootsFor：主目录在前，未配置项目也回主目录", () => {
    seedDefault();
    expect(projectRootsFor(main)?.roots.map((r) => r.path)).toEqual([main, backend]);
    expect(projectRootsFor(otherMain)?.roots.map((r) => r.path)).toEqual([otherMain]);
  });
});

describe("生效附加目录", () => {
  test("主目录 → 全部附加根；附加根 → 主目录 + 其余根（排除自己）", () => {
    seedProjectDirsForTest({
      [main]: [
        { path: backend, label: "backend" },
        { path: shared, label: "shared" },
      ],
    });
    expect(effectiveProjectDirs(main).map((d) => d.path)).toEqual([backend, shared]);
    expect(effectiveProjectDirs(backend).map((d) => d.path)).toEqual([main, shared]);
    expect(effectiveProjectDirs(shared).map((d) => d.path)).toEqual([main, backend]);
  });

  test("普通任务（无 cwd / 无项目）为空", () => {
    seedDefault();
    expect(effectiveProjectDirs("")).toEqual([]);
    expect(effectiveProjectDirs(otherMain)).toEqual([]);
  });
});

describe("addProjectDir", () => {
  test("追加根并持久化（重启后 init 可回放）", async () => {
    seedDefault();
    const roots = await addProjectDir(main, shared);
    expect(roots.roots.map((r) => r.path)).toEqual([main, backend, shared]);

    resetProjectDirsForTest();
    await initProjectDirs();
    expect(effectiveProjectDirs(main).map((d) => d.path)).toEqual([backend, shared]);
  });

  test("从附加根发起也落到同一个项目", async () => {
    seedDefault();
    await addProjectDir(backend, shared);
    expect(projectRootsFor(main)?.roots.map((r) => r.path)).toContain(shared);
  });

  test("拒绝：不存在 / 与主目录重叠 / 与已有根重叠", async () => {
    seedDefault();
    await expect(addProjectDir(main, join(tmp, "nope"))).rejects.toThrow(/does not exist/);
    await expect(addProjectDir(main, join(main))).rejects.toThrow(/overlaps/);
    mkdirSync(join(backend, "sub"), { recursive: true });
    await expect(addProjectDir(main, join(backend, "sub"))).rejects.toThrow(/overlaps/);
    await expect(addProjectDir(main, tmp)).rejects.toThrow(/overlaps/);
  });

  test("拒绝：已被其它项目占用（任一方向重叠）", async () => {
    seedProjectDirsForTest({
      [otherMain]: [{ path: extra, label: "extra" }],
    });
    await expect(addProjectDir(main, extra)).rejects.toThrow(/another project/);
    await expect(addProjectDir(main, otherMain)).rejects.toThrow(/another project/);
    mkdirSync(join(extra, "nested"), { recursive: true });
    await expect(addProjectDir(main, join(extra, "nested"))).rejects.toThrow(/another project/);
  });

  test("数量上限", async () => {
    seedProjectDirsForTest({});
    const roots = Array.from({ length: MAX_EXTERNAL_DIRS }, (_, i) => {
      const dir = join(tmp, `bulk-${i}`);
      mkdirSync(dir, { recursive: true });
      return dir;
    });
    for (const dir of roots) await addProjectDir(main, dir);
    await expect(addProjectDir(main, shared)).rejects.toThrow(
      new RegExp(String(MAX_EXTERNAL_DIRS)),
    );
  });
});

describe("脏配置归一", () => {
  test("与主目录重叠的根被剔除", () => {
    mkdirSync(join(main, "inner"), { recursive: true });
    seedProjectDirsForTest({
      [main]: [
        { path: join(main, "inner"), label: "inner" },
        { path: backend, label: "backend" },
      ],
    });
    expect(effectiveProjectDirs(main).map((d) => d.path)).toEqual([backend]);
  });

  test("同一目录写进两个项目：先见者胜，后者整条被剔除", () => {
    seedProjectDirsForTest({
      [main]: [{ path: shared, label: "shared" }],
      [extra]: [{ path: shared, label: "shared-again" }],
    });
    expect(projectCwdFor(shared)).toBe(main);
    // extra 的根被剔除后没有剩余根，条目不被保留
    expect(projectRootsFor(extra)?.roots.map((r) => r.path)).toEqual([extra]);
  });
});

describe("removeProjectDir", () => {
  test("移除一个根；移除最后一个后项目归属消失", async () => {
    seedDefault();
    await addProjectDir(main, shared);
    let roots = await removeProjectDir(main, shared);
    expect(roots.roots.map((r) => r.path)).toEqual([main, backend]);

    roots = await removeProjectDir(main, backend);
    expect(roots.roots.map((r) => r.path)).toEqual([main]);
    expect(projectCwdFor(backend)).toBeUndefined();
  });

  test("主目录本身不会被当作可移除项（只过滤附加根）", async () => {
    seedDefault();
    const roots = await removeProjectDir(main, main);
    expect(roots.roots.map((r) => r.path)).toEqual([main, backend]);
  });
});
