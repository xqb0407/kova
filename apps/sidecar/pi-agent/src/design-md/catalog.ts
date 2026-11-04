/**
 * 内置主题包的装载与解析。
 *
 * 仓库不再随产品分发内置主题包（design-themes.zip 已移除：早期内置的是来源
 * 不明的第三方设计文档，不适合随开源产品分发）。装载与解析逻辑保留：
 * - `setBuiltinBundleBytesForTest` 仍可注入内存构造的包（测试路径，unzip 解析）；
 * - 无内置包时目录为空，调用方按空清单处理；
 * - 后续若重新引入内置主题，须为自研内容并重建打包链（见 git 历史 design:pack）。
 *
 * 装载一次缓存全量（catalog 元数据 + 每套正文）；
 * catalog.version 是升级同步（builtin-sync）的比对锚点，无包时恒为 "0"。
 */
import { unzipSync, strFromU8 } from "fflate";

export type BuiltinThemeMeta = {
  id: string;
  name: string;
  desc: string;
  accents: string[];
};

type Bundle = {
  version: string;
  source: string;
  themes: BuiltinThemeMeta[];
  /** slug → DESIGN.md 正文 */
  docs: Map<string, string>;
};

let bundle: Bundle | null = null;
let loadError: string | null = null;

/** 测试注入的包字节（优先级高于内嵌 zip；传 null 清除） */
let bundleBytesOverride: Uint8Array | null = null;

/** 测试钩子：用内存构造的主题包替代内嵌 zip（配合 PI_DESIGN_MD_DIR 钉住目录） */
export function setBuiltinBundleBytesForTest(bytes: Uint8Array | null): void {
  bundleBytesOverride = bytes;
  bundle = null;
  loadError = null;
}

/** 无内置包时的恒定空目录（version "0" 即「从未内置」的同步锚点） */
const EMPTY_BUNDLE: Bundle = { version: "0", source: "", themes: [], docs: new Map() };

async function parseBundle(bytes: Uint8Array): Promise<Bundle> {
  const files = unzipSync(bytes);
  const catalogRaw = files["catalog.json"];
  if (!catalogRaw) throw new Error("主题包缺 catalog.json");
  const parsed = JSON.parse(strFromU8(catalogRaw)) as {
    version?: unknown;
    source?: unknown;
    themes?: unknown;
  };
  if (typeof parsed.version !== "string" || !Array.isArray(parsed.themes)) {
    throw new Error("主题包 catalog.json 结构非法");
  }
  const docs = new Map<string, string>();
  const themes: BuiltinThemeMeta[] = [];
  for (const t of parsed.themes) {
    if (!t || typeof t.id !== "string") continue;
    const doc = files[`${t.id}/DESIGN.md`];
    if (!doc) continue; // 包内缺正文的主题不进清单
    docs.set(t.id, strFromU8(doc));
    themes.push({
      id: t.id,
      name: typeof t.name === "string" ? t.name : t.id,
      desc: typeof t.desc === "string" ? t.desc : "",
      accents: Array.isArray(t.accents)
        ? (t.accents as unknown[]).filter((a: unknown) => typeof a === "string") as string[]
        : [],
    });
  }
  return {
    version: parsed.version,
    source: typeof parsed.source === "string" ? parsed.source : "",
    themes,
    docs,
  };
}

async function loadBundle(): Promise<Bundle> {
  if (bundle) return bundle;
  if (loadError) throw new Error(loadError);
  if (!bundleBytesOverride) return EMPTY_BUNDLE;
  try {
    bundle = await parseBundle(bundleBytesOverride);
    return bundle;
  } catch (err) {
    loadError = err instanceof Error ? err.message : String(err);
    throw new Error(loadError);
  }
}

/** 主题包元数据（清单与解压同步共用；装载失败抛错，调用方按非致命处理） */
export async function builtinCatalog(): Promise<Bundle> {
  return loadBundle();
}

/** 内置主题正文（zip 内存副本 = 磁盘 builtin/ 副本同源）；未收录返回 null */
export async function readBuiltinDoc(id: string): Promise<string | null> {
  const b = await loadBundle();
  return b.docs.get(id) ?? null;
}

/** 测试钩子：清装载缓存（换 env 重定向 zip 后需重读） */
export function resetBundleCacheForTest(): void {
  bundle = null;
  loadError = null;
}
