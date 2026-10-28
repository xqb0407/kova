"use client";

/**
 * 宠物库（目录扫描）：对齐 Codex 的 ~/.codex/pets 模型——把宠物文件夹放进
 * Kova 的 pets 目录（appData/pets）就会被扫描出来，没有"添加"动作。
 *
 * 扫描只读元数据；素材走 `kova://pet/<目录>/<文件>` 直出（主进程协议分支，
 * 路径钳在库目录内），所以清单里的 configUrl 是普通 URL——宿主零改动。
 */

import { useEffect, useState } from "react";
import { scanPetLibrary } from "@/desktop-bridge/pet";
import { isDesktop } from "@/lib/desktop-env";

export interface LibraryPet {
  /** 目录名（即 pet id） */
  id: string;
  name: string;
  /** 可直接喂给 <Pet manifest> 的 pet.json 地址 */
  configUrl: string;
  dir: string;
}

interface ScanResult {
  dir: string;
  pets: { dir: string; rel: string; name: string; configUrl: string }[];
}

let cache: { dir: string; pets: LibraryPet[] } | null = null;
let inflight: Promise<{ dir: string; pets: LibraryPet[] }> | null = null;

/** 扫描宠物库。非桌面环境返回空库（内置 fixtures 由设置页自行拼装）。 */
export async function scanPetLibraryPets(force = false): Promise<{ dir: string; pets: LibraryPet[] }> {
  if (!isDesktop()) return { dir: "", pets: [] };
  if (cache !== null && !force) return cache;
  if (inflight !== null) return inflight;

  inflight = (async () => {
    const scan = await scanPetLibrary();
    const pets: LibraryPet[] = scan.pets.map((entry) => ({
      id: entry.dir.split(/[\\/]/).pop() ?? entry.name,
      name: entry.name,
      configUrl: entry.configUrl,
      dir: entry.dir,
    }));
    const result = { dir: scan.dir, pets };
    cache = result;
    return result;
  })();

  try {
    return await inflight;
  } finally {
    inflight = null;
  }
}

/** 扫描结果失效（下次 force 重扫）。 */
export function invalidatePetLibrary(): void {
  cache = null;
}

/** 设置页用的扫描 hook：seq 递增触发强制重扫。 */
export function usePetLibrary(refreshSeq: number): { dir: string; pets: LibraryPet[] } {
  const [state, setState] = useState<{ dir: string; pets: LibraryPet[] }>({ dir: "", pets: [] });
  useEffect(() => {
    let cancelled = false;
    void scanPetLibraryPets(refreshSeq > 0).then((result) => {
      if (!cancelled) setState(result);
    });
    return () => {
      cancelled = true;
    };
  }, [refreshSeq]);
  return state;
}
