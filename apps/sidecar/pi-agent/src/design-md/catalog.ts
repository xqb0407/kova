/**
 * 内置主题包（design-themes.zip）的装载与解析。
 *
 * zip 由 `bun run design:pack`（scripts/build-design-themes-zip.ts）从仓库里的
 * design-md/ 源目录生成并提交；`with { type: "file" }` 静态导入使其在
 * bun --compile 单文件二进制中内嵌（dev 走磁盘路径），解压用 fflate。
 *
 * 装载一次缓存全量（catalog 元数据 + 每套正文，~1.2MB 驻留内存可接受）：
 * - 清单/正文读取以 zip 内容为准（与解压到 <appData>/design-md/builtin/ 的磁盘
 *   副本同源同字节；磁盘副本首启解压 + 版本化重同步，见 builtin-sync.ts，供
 *   外部工具与用户直接访问）；
 * - catalog.version 是升级同步的比对锚点。
 */
import { unzipSync, strFromU8 } from "fflate";
import zipUrl from "./bundle/design-themes.zip" with { type: "file" };

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

async function loadBundle(): Promise<Bundle> {
  if (bundle) return bundle;
  if (loadError) throw new Error(loadError);
  try {
    const bytes = bundleBytesOverride
      ? bundleBytesOverride
      : new Uint8Array(await Bun.file(zipUrl).arrayBuffer());
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
      if (!doc) continue; // 包内缺正文的主题不进清单（打包脚本本会拒绝这种包）
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
    bundle = {
      version: parsed.version,
      source: typeof parsed.source === "string" ? parsed.source : "",
      themes,
      docs,
    };
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
