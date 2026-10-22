/**
 * 项目虚拟目录可信根解析：合法配置、缺失根、脏 JSON、去重。
 * 纯 node 模块，不 import electron，可直接在 bun test 下跑。
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { trustedProjectRoots } from "./project-roots";

const root = realpathSync(mkdtempSync(join(tmpdir(), "kova-project-roots-")));
const main = join(root, "frontend");
const backend = join(root, "backend");
mkdirSync(main, { recursive: true });
mkdirSync(backend, { recursive: true });
writeFileSync(join(root, "not-a-dir"), "x");

describe("trustedProjectRoots", () => {
  test("主目录与附加根都进入可信清单（realpath）", () => {
    const raw = JSON.stringify({
      [main]: [{ path: backend, label: "backend" }],
    });
    expect(trustedProjectRoots(raw).sort()).toEqual(
      [realpathSync(main), realpathSync(backend)].sort(),
    );
  });

  test("缺失/非目录的根不授权", () => {
    const raw = JSON.stringify({
      [main]: [
        { path: join(root, "missing"), label: "missing" },
        { path: join(root, "not-a-dir"), label: "file" },
        { path: backend, label: "backend" },
      ],
    });
    expect(trustedProjectRoots(raw)).toEqual([realpathSync(main), realpathSync(backend)]);
  });

  test("脏 JSON / 非对象 / 空值 → 空清单", () => {
    expect(trustedProjectRoots("{")).toEqual([]);
    expect(trustedProjectRoots("[1,2]")).toEqual([]);
    expect(trustedProjectRoots("null")).toEqual([]);
    expect(trustedProjectRoots(null)).toEqual([]);
    expect(trustedProjectRoots(undefined)).toEqual([]);
  });

  test("跨项目重复根去重", () => {
    const raw = JSON.stringify({
      [main]: [{ path: backend, label: "backend" }],
      [backend]: [{ path: backend, label: "self" }],
    });
    const out = trustedProjectRoots(raw);
    expect(out.filter((p) => p === realpathSync(backend))).toHaveLength(1);
  });
});
