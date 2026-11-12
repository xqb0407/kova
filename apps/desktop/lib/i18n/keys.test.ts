import { describe, expect, it } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { zh } from "./locales/zh";
import { en } from "./locales/en";

/**
 * 词典健康度守卫：字面量 t("ns.key") 必须真实存在于 zh 词典，且 zh/en 键位
 * 一一对应——两侧同时缺键时 parity 检查发现不了（曾出现
 * `library.common.importFolder` 直接上屏的事故），这里从源码侧兜住。
 */

const DESKTOP_ROOT = join(import.meta.dir, "../..");

const NAMESPACES = new Set(Object.keys(zh));

function keyPaths(value: unknown, prefix = ""): string[] {
  if (typeof value !== "object" || value === null) return [prefix];
  return Object.entries(value as Record<string, unknown>).flatMap(([k, v]) =>
    keyPaths(v, prefix ? `${prefix}.${k}` : k),
  );
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "out" || name === ".next") continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      walk(full, out);
    } else if (/\.(ts|tsx)$/u.test(name) && !full.includes("/locales/")) {
      out.push(full);
    }
  }
  return out;
}

/** 源码里 t("...") / tt("...") 的字面量 key（只认已知命名空间前缀） */
function literalKeys(dir: string): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const file of walk(dir)) {
    const src = readFileSync(file, "utf8");
    for (const m of src.matchAll(/\b(?:t|tt)\(\s*["`]([\w.]+)["`]/g)) {
      const key = m[1]!;
      if (!NAMESPACES.has(key.split(".")[0]!)) continue;
      const files = found.get(key) ?? [];
      files.push(file);
      found.set(key, files);
    }
  }
  return found;
}

describe("i18n 词典", () => {
  it("zh 与 en 键位一一对应", () => {
    const zk = new Set(keyPaths(zh));
    const ek = new Set(keyPaths(en));
    expect([...zk].filter((k) => !ek.has(k))).toEqual([]);
    expect([...ek].filter((k) => !zk.has(k))).toEqual([]);
  });

  it("源码里所有字面量 t() key 都存在于词典", () => {
    const missing: string[] = [];
    for (const [key, files] of literalKeys(join(DESKTOP_ROOT, "components"))) {
      if (!isKnown(zh, key)) missing.push(`${key} (${files[0]})`);
    }
    for (const [key, files] of literalKeys(join(DESKTOP_ROOT, "lib"))) {
      if (!isKnown(zh, key)) missing.push(`${key} (${files[0]})`);
    }
    expect(missing).toEqual([]);
  });
});

function isKnown(dict: unknown, key: string): boolean {
  let node: unknown = dict;
  for (const seg of key.split(".")) {
    if (typeof node !== "object" || node === null) return false;
    node = (node as Record<string, unknown>)[seg];
  }
  return typeof node === "string";
}
