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
 * - mcp 运行时闭包：入口脚本的传递相对 import 全部进包（ui/ 等被跳目录按需带入），
 *   闭包裸导入的 npm 依赖 vendor 进包内 node_modules（递归 dependencies；pnpm 布局
 *   经 realpath 收真身）——打包时缺依赖即失败，不带病出包
 * 校验：parsePluginManifest 必须过（名字与目录一致等硬错误即打包失败）；
 * panels 声明的 entry 文件必须存在且不超面板资产上限（与 store 的 32MB 同口径）。
 */
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, join, relative, resolve, sep } from "node:path";
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

/** vendoring（mcp 运行时 npm 依赖整包入包）时的跳过集：包内 dist 是运行时本体，必须带上 */
const VENDOR_SKIP_DIRS = new Set(["node_modules", ".git"]);

const MANIFEST_DOT_DIRS = [".kova-plugin", ".claude-plugin", ".codex-plugin"];

// 函数声明式 never（箭头函数 const 不触发 if 分支不可达收窄）：fail 之后代码流即死
function fail(msg: string): never {
  throw new Error(`plugins-pack: ${msg}`);
}

/** 递归收集一个目录下应进包的文件（相对 dir 的路径，正斜杠；符号链接按目标类型跟进） */
function collectFiles(
  dir: string,
  relBase: string,
  out: string[],
  skipDirs: ReadonlySet<string> = SKIP_DIRS,
): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = relBase ? `${relBase}/${entry.name}` : entry.name;
    const abs = join(dir, entry.name);
    const isDir = entry.isDirectory() || (entry.isSymbolicLink() && statSync(abs).isDirectory());
    const isFile = entry.isFile() || (entry.isSymbolicLink() && statSync(abs).isFile());
    if (isDir) {
      if (skipDirs.has(entry.name)) continue;
      collectFiles(abs, rel, out, skipDirs);
    } else if (isFile) {
      out.push(rel);
    }
  }
}

/** 一个分发文件：zip 内相对路径 + 读取源（vendored 依赖的源在 .pnpm 存储里，两者不同） */
type DistFile = { zipRel: string; srcAbs: string };

/** 一个插件目录 → 应进包的分发文件（zip 键与读取源解耦，vendor 依赖平铺进 node_modules） */
function pluginFiles(pluginDir: string): DistFile[] {
  const files = new Map<string, DistFile>();
  const addRel = (rel: string): void => {
    if (!files.has(rel)) files.set(rel, { zipRel: rel, srcAbs: join(pluginDir, rel) });
  };
  const addCollected = (dir: string, relBase: string, skipDirs?: ReadonlySet<string>): void => {
    const rels: string[] = [];
    collectFiles(dir, relBase, rels, skipDirs);
    for (const rel of rels) addRel(rel);
  };

  // 清单点目录（整目录收，正常只有 plugin.json 一个文件）
  for (const dot of MANIFEST_DOT_DIRS) {
    const dotDir = join(pluginDir, dot);
    if (existsSync(dotDir) && statSync(dotDir).isDirectory()) addCollected(dotDir, dot);
  }

  // 根级单文件白名单 + *.html 面板入口
  for (const entry of readdirSync(pluginDir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const name = entry.name;
    if (name === ".mcp.json" || name === "panels.json" || name === "icon.svg" || /\.html$/i.test(name)) {
      addRel(name);
    }
  }

  // 组件目录整收
  for (const sub of ["skills", "mcp", "hooks"]) {
    const p = join(pluginDir, sub);
    if (existsSync(p) && statSync(p).isDirectory()) addCollected(p, sub);
  }

  // `.mcp.json` 里 `${PLUGIN_ROOT}/<path>` 引用补漏（引用在收集范围外时并入），
  // 再对入口脚本做传递 import 闭包 + 裸导入 npm 包 vendor（见 mcpRuntimeClosure）
  const pluginRootRefs: string[] = [];
  for (const rel of files.keys()) {
    if (!rel.endsWith(".mcp.json")) continue;
    const text = readFileSync(join(pluginDir, rel), "utf8");
    for (const m of text.matchAll(/\$\{PLUGIN_ROOT\}\/([A-Za-z0-9._\-/]+)/g)) {
      const refRel = m[1];
      const abs = resolve(pluginDir, refRel);
      if (!abs.startsWith(resolve(pluginDir))) continue;
      if (existsSync(abs) && statSync(abs).isFile()) pluginRootRefs.push(refRel);
    }
  }
  for (const refRel of pluginRootRefs) addRel(refRel);

  // mcp 运行时闭包：入口脚本的传递相对 import 全部进包（SKIP_DIRS 跳过的目录如
  // ui/ 由此按需带入——mcp server 与面板共享源码时不用改目录布局）；闭包里裸导入
  // 的 npm 依赖（含递归依赖）vendor 进包内 node_modules，物化后无需用户侧装依赖。
  // 打包时缺依赖 = 明确失败（物化端无法补救），不带病出包。
  const entryScripts = pluginRootRefs.filter((r) => /\.(m|c)?[jt]sx?$/i.test(r));
  if (entryScripts.length > 0) {
    const closure = mcpRuntimeClosure(pluginDir, [...new Set(entryScripts)]);
    for (const f of closure.files) addRel(f);
    const seenPkgs = new Set<string>();
    const vendor = (pkg: string, parentReal?: string, parentPkg?: string): void =>
      vendorPackage(pluginDir, pkg, files, seenPkgs, parentReal, parentPkg);
    for (const pkg of closure.packages) vendor(pkg);
  }

  return [...files.values()];
}

// ---------------------------------------------------------------------------
// mcp 运行时闭包（入口脚本的传递 import）与 npm 依赖 vendoring
// ---------------------------------------------------------------------------

/** 从 TS/JS 源码提取 import 来源说明符：from "x" / import("x") / import "x" / require("x") */
function importSpecifiers(src: string): string[] {
  // 剥注释再匹配，避免把文档示例当 import；行注释前排除 ":"（不误伤 "https://"）。
  // 按行匹配且 from 前缀须为 import/export/收括号——否则 `required: ["path", "from"]`
  // 这类 schema 字符串里的 "from" 会被当成导入源（真实事故）。
  const stripped = src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'])\/\/[^\n]*/g, "$1");
  const out: string[] = [];
  for (const line of stripped.split("\n")) {
    for (const m of line.matchAll(/\bfrom\s*["']([^"']+)["']/g)) {
      const prefix = line.slice(0, m.index);
      if (/\b(?:import|export)\b/.test(prefix) || /\}\s*$/.test(prefix)) out.push(m[1]);
    }
    for (const m of line.matchAll(/\b(?:import|require)\s*\(\s*["']([^"']+)["']/g)) out.push(m[1]);
    for (const m of line.matchAll(/\bimport\s+["']([^"']+)["']/g)) out.push(m[1]);
  }
  return out;
}

const IMPORT_FILE_CANDIDATES = [
  "",
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  "/index.ts",
  "/index.tsx",
  "/index.js",
];

/** 相对说明符 → 插件内文件相对路径（正斜杠）；逃逸插件根或无命中返回 undefined */
function resolveImportTarget(pluginDir: string, fromRel: string, spec: string): string | undefined {
  const rootPrefix = resolve(pluginDir) + sep;
  const absNoExt = resolve(pluginDir, join(fromRel, ".."), spec);
  if (!absNoExt.startsWith(rootPrefix)) return undefined;
  const relNoExt = relative(pluginDir, absNoExt).split(sep).join("/");
  for (const suffix of IMPORT_FILE_CANDIDATES) {
    const candidate = `${relNoExt}${suffix}`;
    const abs = join(pluginDir, candidate);
    if (existsSync(abs) && statSync(abs).isFile()) return candidate;
  }
  return undefined;
}

/** 裸说明符 → 包名（scope 整体归位；子路径导入 vendor 整包） */
function barePackageName(spec: string): string {
  const parts = spec.split("/");
  return spec.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

/**
 * 从入口脚本出发走传递 import 闭包（只跟插件内相对导入，node:/裸导入记包名）。
 * 无后缀/显式后缀/index 目录三种写法都解析；解析不到 = 源码与打包口径脱节，
 * fail 快速暴露（物化端无法补救缺文件）。
 */
function mcpRuntimeClosure(
  pluginDir: string,
  entries: string[],
): { files: string[]; packages: string[] } {
  const files = new Set<string>();
  const packages = new Set<string>();
  const queue = [...entries];
  while (queue.length > 0) {
    const rel = queue.pop()!;
    if (files.has(rel)) continue;
    files.add(rel);
    for (const spec of importSpecifiers(readFileSync(join(pluginDir, rel), "utf8"))) {
      if (spec.startsWith("node:") || spec.startsWith("#")) continue;
      if (spec.startsWith("./") || spec.startsWith("../")) {
        const target = resolveImportTarget(pluginDir, rel, spec);
        if (!target) fail(`${rel}: import "${spec}" 解析不到插件内文件（mcp 运行时闭包收不全）`);
        queue.push(target);
      } else {
        packages.add(barePackageName(spec));
      }
    }
  }
  return { files: [...files], packages: [...packages] };
}

/**
 * 一个 npm 包（含递归依赖）vendor 进包内 node_modules 的相对路径集合。
 * 依赖先找包同级（pnpm 虚拟存储/嵌套布局）再退顶层（npm/yarn hoisted）；zip 里
 * 统一平铺到 node_modules/<pkg>/，bun 从包内向上一跳即命中。缺依赖打包即失败。
 */
function vendorPackage(
  pluginDir: string,
  pkg: string,
  files: Map<string, DistFile>,
  seenPkgs: Set<string>,
  parentReal?: string,
  parentPkg?: string,
): void {
  if (seenPkgs.has(pkg)) return;
  seenPkgs.add(pkg);
  const candidates = parentReal
    ? [join(parentReal, "..", pkg), join(pluginDir, "node_modules", pkg)]
    : [join(pluginDir, "node_modules", pkg)];
  const found = candidates.find((c) => existsSync(c));
  if (!found) {
    const from = parentPkg ? `（${parentPkg} 的依赖）` : "";
    fail(`mcp 运行时依赖未安装：node_modules/${pkg}${from}（先在插件目录装依赖再打包）`);
  }
  const real = realpathSync(found);
  const rels: string[] = [];
  collectFiles(real, "", rels, VENDOR_SKIP_DIRS);
  for (const r of rels) {
    const zipRel = `node_modules/${pkg}/${r}`;
    if (!files.has(zipRel)) files.set(zipRel, { zipRel, srcAbs: join(real, r) });
  }
  const doc = JSON.parse(readFileSync(join(real, "package.json"), "utf8"));
  if (isRecord(doc) && isRecord(doc.dependencies)) {
    for (const dep of Object.keys(doc.dependencies)) {
      vendorPackage(pluginDir, dep, files, seenPkgs, real, pkg);
    }
  }
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
    const fileSet = new Set(files.map((f) => f.zipRel));

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
    for (const f of files) {
      entries[`${name}/${f.zipRel}`] = new Uint8Array(readFileSync(f.srcAbs));
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
