/**
 * 内置插件包打包/校验共用的「计划」构建（纯逻辑，无副作用，单一事实源）：
 * 从仓库 plugins/（市场根：marketplace.json 的 plugins[] 即内置白名单）收集各
 * 插件的分发文件，产出 zip 条目表与内容聚合 hash（bundleVersion）。
 *
 * - plugins:pack（build-builtin-plugins-zip.ts）：zipSync(entries) 写
 *   src/plugins/bundle/kova-plugins.zip（构建产物，gitignore 不入库；缺失时
 *   ensure:bundle / build-sidecar.ts 编译前重打兜底，同源同字节幂等），
 *   sidecar 以 `import ... with { type: "file" }` 嵌进单文件二进制；
 * - plugins:verify（verify-builtin-plugins-zip.ts）与 pack-drift 测试：
 *   diffCommittedPluginZip 逐条目比对，源改了忘重打包即拦下。
 *   build-sidecar.ts 编译前也会重打一次兜底（同源同字节，幂等）。
 *
 * zip 布局：catalog.json（{ bundleVersion, plugins:[{name, version}] }）+
 * <pluginName>/<相对路径> 若干；物化端（src/plugins/builtin.ts）按名字前缀切组。
 * 收集口径（白名单，源目录里的其他文件一律不进包）：
 * - 清单点目录（.kova-plugin/.claude-plugin/.codex-plugin 的 plugin.json）
 * - 根级 *.html（面板入口）、panels.json、icon.svg、.mcp.json
 * - skills/ 与 mcp/ 整目录（跳过嵌套 test/node_modules/.git/dist/ui/scripts）
 * - `.mcp.json` 里 `${PLUGIN_ROOT}/<path>` 引用的文件（补漏：引用在收集范围外时并入）
 * 校验：parsePluginManifest 必须过（名字与目录一致等硬错误即打包失败）；
 * panels 声明的 entry 文件必须存在且不超面板资产上限（与 store 的 32MB 同口径）。
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, join, resolve } from "node:path";
import { unzipSync } from "fflate";
import { parsePluginManifest, isRecord, asString, containedRelPath } from "../src/plugins/manifest";

export type BuiltinPluginMeta = { name: string; version: string };

export type PluginPackPlan = {
  /** 包内容聚合 SHA256（hex）：物化端版本化重同步的比对锚点 */
  bundleVersion: string;
  plugins: BuiltinPluginMeta[];
  /** zip 内条目名（"<plugin>/<rel>" 或 "catalog.json"）→ 内容字节 */
  entries: Record<string, Uint8Array>;
};

/** 面板入口资产上限：与 src/plugins/store.ts 的 PANEL_ASSET_MAX_BYTES 同口径 */
const PANEL_ASSET_MAX_BYTES = 32 * 1024 * 1024;

/** 收集时整目录跳过（任何层级）：源件与构建残料不进包 */
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "ui", "scripts", "test"]);

const MANIFEST_DOT_DIRS = [".kova-plugin", ".claude-plugin", ".codex-plugin"];

// 函数声明式 never（箭头函数 const 不触发 if 分支不可达收窄）：fail 之后代码流即死
function fail(msg: string): never {
  throw new Error(`plugins-pack: ${msg}`);
}

/** 递归收集一个目录下应进包的文件（相对 dir 的路径，正斜杠） */
function collectFiles(dir: string, relBase: string, out: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = relBase ? `${relBase}/${entry.name}` : entry.name;
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      collectFiles(abs, rel, out);
    } else if (entry.isFile()) {
      out.push(rel);
    }
  }
}

/** 一个插件目录 → 应进包的相对路径集合 */
function pluginFiles(pluginDir: string): string[] {
  const rels: string[] = [];

  // 清单点目录（整目录收，正常只有 plugin.json 一个文件）
  for (const dot of MANIFEST_DOT_DIRS) {
    const dotDir = join(pluginDir, dot);
    if (existsSync(dotDir) && statSync(dotDir).isDirectory()) collectFiles(dotDir, dot, rels);
  }

  // 根级单文件白名单 + *.html 面板入口
  for (const entry of readdirSync(pluginDir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const name = entry.name;
    if (name === ".mcp.json" || name === "panels.json" || name === "icon.svg" || /\.html$/i.test(name)) {
      rels.push(name);
    }
  }

  // 组件目录整收
  for (const sub of ["skills", "mcp", "hooks"]) {
    const p = join(pluginDir, sub);
    if (existsSync(p) && statSync(p).isDirectory()) collectFiles(p, sub, rels);
  }

  // `${PLUGIN_ROOT}/<path>` 引用补漏（mcp server 脚本可能不在上面收集到的路径里）
  for (const rel of [...rels]) {
    if (!rel.endsWith(".mcp.json")) continue;
    const text = readFileSync(join(pluginDir, rel), "utf8");
    for (const m of text.matchAll(/\$\{PLUGIN_ROOT\}\/([A-Za-z0-9._\-/]+)/g)) {
      const refRel = m[1];
      const abs = resolve(pluginDir, refRel);
      if (!abs.startsWith(resolve(pluginDir))) continue;
      if (existsSync(abs) && statSync(abs).isFile() && !rels.includes(refRel)) rels.push(refRel);
    }
  }

  return [...new Set(rels)];
}

/** 读市场根并构建打包计划；不合法一律 throw（消息带 plugins-pack: 前缀） */
export function buildPluginPackPlan(pluginsRoot: string): PluginPackPlan {
  const root = resolve(pluginsRoot);
  const mkPath = join(root, "marketplace.json");
  if (!existsSync(mkPath)) fail(`市场清单不存在：${mkPath}`);
  let doc: unknown;
  try {
    doc = JSON.parse(readFileSync(mkPath, "utf8"));
  } catch (err) {
    fail(`marketplace.json 解析失败：${err instanceof Error ? err.message : String(err)}`);
  }
  if (!isRecord(doc) || !Array.isArray(doc.plugins)) fail("marketplace.json 顶层须为 { plugins: [] }");

  const plugins: BuiltinPluginMeta[] = [];
  const entries: Record<string, Uint8Array> = {};
  const seen = new Set<string>();

  for (const raw of doc.plugins) {
    if (!isRecord(raw)) fail("marketplace.json plugins[] 条目须为对象");
    const name = asString(raw.name);
    const source = asString(raw.source);
    if (!name) fail("marketplace.json 条目缺 name");
    if (!source || !source.startsWith("./")) fail(`插件 ${name} 的 source 须为 "./" 相对路径（"${source}"）`);
    if (seen.has(name)) fail(`插件 name 重复：${name}`);
    seen.add(name);

    const pluginDir = join(root, source.replace(/^\.\//, ""));
    if (!existsSync(pluginDir) || !statSync(pluginDir).isDirectory()) fail(`插件目录不存在：${pluginDir}`);
    if (basename(pluginDir) !== name) fail(`插件目录名（${basename(pluginDir)}）须与 name（${name}）一致`);

    // 清单硬校验（与安装/扫描同一把尺子）
    const manifest = parsePluginManifest(pluginDir);

    const files = pluginFiles(pluginDir);
    if (files.length === 0) fail(`插件 ${name} 没有任何可分发文件`);
    const fileSet = new Set(files);

    // 面板入口存在性 + 资产上限
    const panelsRel = manifest.components.panels;
    if (panelsRel) {
      if (!fileSet.has(panelsRel)) fail(`${name}: panels "${panelsRel}" 未被收集`);
      let decls: unknown;
      try {
        decls = JSON.parse(readFileSync(join(pluginDir, panelsRel), "utf8"));
      } catch (err) {
        fail(`${name}: panels 解析失败：${err instanceof Error ? err.message : String(err)}`);
      }
      if (Array.isArray(decls)) {
        for (const item of decls) {
          if (!isRecord(item)) continue;
          const entry = asString(item.entry);
          if (!entry) continue;
          const contained = containedRelPath(pluginDir, entry, `${name} panel entry`, []);
          if (!contained) fail(`${name}: panel entry 逃逸插件根（"${entry}"）`);
          const abs = join(pluginDir, contained);
          if (!existsSync(abs)) fail(`${name}: panel entry 缺失（${contained}）`);
          if (statSync(abs).size > PANEL_ASSET_MAX_BYTES) fail(`${name}: panel entry 超过资产上限（${contained}）`);
        }
      }
    }
    // 清单声明的 icon 必须进包（远程 URL 除外）
    if (manifest.icon && !fileSet.has(manifest.icon)) {
      fail(`${name}: 清单 icon "${manifest.icon}" 未被收集`);
    }

    plugins.push({ name, version: manifest.version });
    for (const rel of files) {
      entries[`${name}/${rel}`] = new Uint8Array(readFileSync(join(pluginDir, rel)));
    }
  }

  if (plugins.length === 0) fail("marketplace.json plugins[] 为空");

  // bundleVersion：条目路径+内容聚合哈希（先不含 catalog，自指排除）。
  // 收集走 readdirSync（跨平台顺序不定），故 entries 一律按键名排序后重建——
  // 同源必同字节，zip 才能提交仓库且漂移校验零误报。
  const hash = createHash("sha256");
  for (const key of Object.keys(entries).sort()) {
    hash.update(key).update(":");
    hash.update(createHash("sha256").update(entries[key]).digest("hex"));
    hash.update("\n");
  }
  const bundleVersion = hash.digest("hex");

  const sorted: Record<string, Uint8Array> = {};
  for (const key of Object.keys(entries).sort()) sorted[key] = entries[key];
  sorted["catalog.json"] = new TextEncoder().encode(
    `${JSON.stringify({ bundleVersion, source: "kova-desktop-builtin-plugins", plugins }, null, 2)}\n`,
  );
  const finalEntries: Record<string, Uint8Array> = {};
  for (const key of Object.keys(sorted).sort()) finalEntries[key] = sorted[key];

  return { bundleVersion, plugins, entries: finalEntries };
}

/** 把已产出的 zip 与计划逐条目比对（漂移返回问题列表；一致返回空） */
export function diffCommittedPluginZip(zip: Uint8Array, plan: PluginPackPlan): string[] {
  const problems: string[] = [];
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(zip);
  } catch (err) {
    return [`zip 解析失败：${err instanceof Error ? err.message : String(err)}`];
  }
  const planKeys = new Set(Object.keys(plan.entries));
  const zipKeys = new Set(Object.keys(files));
  for (const k of planKeys) if (!zipKeys.has(k)) problems.push(`缺条目：${k}`);
  for (const k of zipKeys) if (!planKeys.has(k)) problems.push(`多余条目：${k}`);
  for (const k of planKeys) {
    if (!zipKeys.has(k)) continue;
    const a = plan.entries[k];
    const b = files[k];
    if (a.length !== b.length) problems.push(`内容过期：${k}（大小不一致）`);
    else if (!a.every((v, i) => v === b[i])) problems.push(`内容过期：${k}`);
  }
  return problems;
}
