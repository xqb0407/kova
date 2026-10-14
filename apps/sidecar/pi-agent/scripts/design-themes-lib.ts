/**
 * 设计主题包打包/校验共用的「计划」构建（纯逻辑，无副作用）：
 * 从 design-md/ 源目录读 catalog-src.json + 每主题 DESIGN.md + LICENSE.txt，
 * 产出 zip 条目表；校验规则与 design:pack 完全一致（单一事实源）。
 *
 * - design:pack（build-design-themes-zip.ts）：zipSync(entries) 写 bundle zip；
 * - design:verify（verify-design-themes-zip.ts）：把 committed zip 解出来与
 *   这份计划逐条目比对——源改了就重新打包，防止 zip 静默过期；
 * - test/design-md/pack-drift.test.ts 用同一个 diffCommittedZip，让本地
 *   `bun test` 与 CI test job 天然拦漂移。
 */
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { unzipSync } from "fflate";

export type ThemeMeta = { id: string; name: string; desc: string; accents: string[] };

export type PackPlan = {
  version: string;
  themeCount: number;
  /** zip 内条目名 → 内容字节 */
  entries: Record<string, Uint8Array>;
};

const SLUG_RE = /^[a-z0-9][a-z0-9._-]*$/;

/** 读源目录并构建打包计划；不合法一律 throw（消息带 design-md: 前缀） */
export async function buildPackPlan(srcDir: string): Promise<PackPlan> {
  const fail = (msg: string): never => {
    throw new Error(`design-md: ${msg}`);
  };
  const catalog = JSON.parse(await Bun.file(join(srcDir, "catalog-src.json")).text()) as {
    version: string;
    source: string;
    themes: ThemeMeta[];
  };

  if (!/^\d+\.\d+\.\d+$/.test(catalog.version)) fail(`version 必须是语义化: ${catalog.version}`);

  // id 规则与用户层 slug 一致：小写字母数字开头，后接 .-_，防路径注入
  const seen = new Set<string>();
  for (const t of catalog.themes) {
    if (!SLUG_RE.test(t.id)) fail(`主题 id 非法: ${t.id}`);
    if (seen.has(t.id)) fail(`主题 id 重复: ${t.id}`);
    seen.add(t.id);
    if (!t.name || !t.desc) fail(`主题 ${t.id} 缺 name/desc`);
    if (!Array.isArray(t.accents) || t.accents.length === 0 || t.accents.length > 4) {
      fail(`主题 ${t.id} accents 需 1-4 个色值`);
    }
    for (const a of t.accents) {
      if (!/^#[0-9a-fA-F]{6}$/.test(a)) fail(`主题 ${t.id} accent 非法: ${a}`);
    }
    const md = join(srcDir, t.id, "DESIGN.md");
    if (!existsSync(md)) fail(`主题 ${t.id} 缺 DESIGN.md（${md}）`);
  }

  // 磁盘上有目录但清单没登记 → 报错，防止新主题静默漏发
  const license = join(srcDir, "LICENSE.txt");
  const dirsOnDisk = readdirSync(srcDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
  for (const d of dirsOnDisk) {
    if (!seen.has(d)) fail(`目录 design-md/${d}/ 未在 catalog-src.json 登记`);
  }
  if (!existsSync(license)) fail("缺 design-md/LICENSE.txt（来源 MIT 文本）");

  const entries: Record<string, Uint8Array> = {
    "catalog.json": strU8(
      JSON.stringify({ version: catalog.version, source: catalog.source, themes: catalog.themes }, null, 2) + "\n",
    ),
    "LICENSE.txt": strU8(await Bun.file(license).text()),
  };
  for (const t of catalog.themes) {
    entries[`${t.id}/DESIGN.md`] = strU8(await Bun.file(join(srcDir, t.id, "DESIGN.md")).text());
  }
  return { version: catalog.version, themeCount: catalog.themes.length, entries };
}

const strU8 = (s: string): Uint8Array => new TextEncoder().encode(s);

/** committed zip 字节 vs 计划：返回差异描述（空数组 = 一致） */
export function diffCommittedZip(zipBytes: Uint8Array, plan: PackPlan): string[] {
  let unzipped: Record<string, Uint8Array>;
  try {
    unzipped = unzipSync(zipBytes);
  } catch (err) {
    return [`zip 无法解压: ${err instanceof Error ? err.message : String(err)}`];
  }
  const problems: string[] = [];
  const want = plan.entries;
  for (const [name, bytes] of Object.entries(want)) {
    const got = unzipped[name];
    if (!got) {
      problems.push(`缺条目 ${name}`);
      continue;
    }
    if (sameBytes(got, bytes)) continue;
    // 内容变了：给可读提示（文本类显示新旧首行差异计数）
    problems.push(`内容过期 ${name}`);
  }
  for (const name of Object.keys(unzipped)) {
    if (!(name in want)) problems.push(`多余条目 ${name}`);
  }
  return problems;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
