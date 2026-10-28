"use client";

/**
 * 桌宠偏好：开关 + 素材地址。localStorage 持久化（键 `kova.pet.prefs.v1`），
 * 主窗口与悬浮窗同源共享同一份——悬浮窗改不了设置，只读。
 *
 * 刻意不并入 ui-prefs：那边的字段迁移/预绘制脚本/主题派生都是外观专用链路，
 * 桌宠两个字段背不动这些；独立小 store 按同样的 useSyncExternalStore 模式走。
 */

import { useSyncExternalStore } from "react";

/** 桌宠显示模式（二选一）：应用内角标 / 独立悬浮窗；off = 关闭。 */
export type PetMode = "inline" | "floating" | "off";

/**
 * 显示尺寸档位：图集格子 192×208 是位图，显示宽越接近 192 的整数倍越锐利
 * （对齐 Codex：设置里用 slider 连续调节）。范围 96–288，超出会明显发糊。
 */
export const PET_SIZE_MIN = 96;
export const PET_SIZE_MAX = 288;
/** 旧版离散档位 → px 的迁移映射 */
const LEGACY_SIZE: Record<string, number> = { sm: 96, md: 144, lg: 192, xl: 288 };

export interface PetPrefs {
  /** 显示模式：应用内与悬浮窗互斥，切换时悬浮窗随模式自动开关 */
  mode: PetMode;
  /** 上一次非关闭形态：托盘"显示/隐藏"在 off ↔ 该形态间切换 */
  lastNonOffMode: Exclude<PetMode, "off">;
  /** pet.json 地址（对象清单不走这里；相对地址按页面基址解析） */
  configUrl: string;
  /** 显示宽度 px（slider 连续调节，96–288） */
  size: number;
  /** 内嵌角标在主窗口里的停靠位（右/下边距 px）；null = 默认右下角 */
  dock: { right: number; bottom: number } | null;
  /** 用户自行添加的自定义宠物（应用自定义地址时自动入库，出现在预览卡片里） */
  customPets: { configUrl: string; name: string }[];
}

/**
 * 宠物不再内置：素材只来自宠物目录（pets/ 扫描）或用户添加的远程地址。
 * 空串 = 尚未选择宠物（宿主渲染空，不报错）。
 */

const STORAGE_KEY = "kova.pet.prefs.v1";
const DEFAULTS: PetPrefs = {
  mode: "inline",
  lastNonOffMode: "inline",
  configUrl: "",
  size: 144,
  dock: null,
  customPets: [],
};

let prefs: PetPrefs = readStorage();
const listeners = new Set<() => void>();

// 跨窗口同步（三层兜底）：
// 1. patchPetPrefs 显式经主进程广播，**载荷携带完整偏好 JSON**——接收方直接
//    采用，不回读 localStorage（跨进程回读有竞态：可能拿到写之前的旧值）；
// 2. localStorage storage 事件作为备份（同样优先用 event.newValue）；
// 3. 窗口重新聚焦时重读一次——即使前两条全丢，点一下主窗口就能自愈。
if (typeof window !== "undefined") {
  const resync = () => {
    prefs = readStorage();
    emit();
  };
  window.addEventListener("storage", (event) => {
    if (event.key !== STORAGE_KEY && event.key !== null) return;
    // 优先用事件携带的新值，跨进程回读 localStorage 可能拿到写之前的旧值
    if (typeof event.newValue === "string") {
      try {
        prefs = normalizeParsed(JSON.parse(event.newValue));
        emit();
        return;
      } catch {
        // 落回重读
      }
    }
    resync();
  });
  window.addEventListener("focus", resync);
  void import("@/desktop-bridge/event").then(({ listen }) =>
    listen("pet-prefs-changed", (e) => {
      const raw = e.payload;
      if (typeof raw === "string") {
        try {
          prefs = normalizeParsed(JSON.parse(raw));
          emit();
          return;
        } catch {
          // 落回重读
        }
      }
      resync();
    }),
  );
  // 原生右键菜单的动作回传（主进程 Menu.click → 广播）：单字段合并即可
  void import("@/desktop-bridge/event").then(({ listen }) =>
    listen<{ mode: PetMode }>("pet-set-mode", (e) => {
      const mode = e.payload?.mode;
      if (mode === "inline" || mode === "floating" || mode === "off") {
        patchPetPrefs({ mode });
      }
    }),
  );
}

function readSize(v: unknown): number {
  // 旧版离散档位名（sm/md/lg/xl）迁移成 px
  if (typeof v === "string" && LEGACY_SIZE[v] !== undefined) return LEGACY_SIZE[v];
  if (typeof v === "number" && Number.isFinite(v)) {
    return Math.min(Math.max(Math.round(v), PET_SIZE_MIN), PET_SIZE_MAX);
  }
  return 144;
}

function readCustomPets(v: unknown): { configUrl: string; name: string }[] {
  if (!Array.isArray(v)) return [];
  const seen = new Set<string>();
  const out: { configUrl: string; name: string }[] = [];
  for (const item of v) {
    const configUrl = typeof item?.configUrl === "string" ? item.configUrl : "";
    if (configUrl === "" || seen.has(configUrl)) continue;
    seen.add(configUrl);
    out.push({ configUrl, name: typeof item?.name === "string" && item.name ? item.name : configUrl });
  }
  return out;
}

function normalizeParsed(parsed: Partial<PetPrefs> & { enabled?: boolean }): PetPrefs {
  // 旧版只有 enabled 布尔：false → off，true → inline（悬浮窗当时由开关单独管，无法恢复）
  const mode: PetMode =
    parsed.mode === "floating" || parsed.mode === "inline" || parsed.mode === "off"
      ? parsed.mode
      : parsed.enabled === false
        ? "off"
        : "inline";
  const lastNonOffMode: PetPrefs["lastNonOffMode"] =
    parsed.lastNonOffMode === "floating" ? "floating" : "inline";
  const dock =
    parsed.dock && typeof parsed.dock.right === "number" && typeof parsed.dock.bottom === "number"
      ? { right: parsed.dock.right, bottom: parsed.dock.bottom }
      : null;
  const rawConfigUrl = typeof parsed.configUrl === "string" ? parsed.configUrl : "";
  // 旧版内置演示素材（public/pet-fixtures/*）已移除：迁移成"未选择"
  const configUrl = rawConfigUrl.startsWith("/pet-fixtures/") ? "" : rawConfigUrl;
  return {
    mode,
    lastNonOffMode,
    configUrl,
    size: readSize(parsed.size),
    dock,
    customPets: readCustomPets(parsed.customPets),
  };
}

function readStorage(): PetPrefs {
  if (typeof window === "undefined") return DEFAULTS;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULTS;
    return normalizeParsed(JSON.parse(raw));
  } catch {
    return DEFAULTS;
  }
}

function emit(): void {
  for (const listener of listeners) listener();
}

export function getPetPrefs(): PetPrefs {
  return prefs;
}

export function patchPetPrefs(patch: Partial<PetPrefs>): void {
  prefs = { ...prefs, ...patch };
  // 非关闭模式永远刷新"上次形态"：托盘 off ↔ 上次形态 的切换语义靠它
  if (prefs.mode !== "off") prefs.lastNonOffMode = prefs.mode;
  const serialized = JSON.stringify(prefs);
  try {
    window.localStorage.setItem(STORAGE_KEY, serialized);
  } catch {
    // 存储失败不影响本次会话
  }
  emit();
  // 其他窗口（悬浮窗/主窗口）大概率收不到 storage 事件：显式让主进程广播，
  // **载荷直接带完整偏好**——接收方不回读 localStorage（跨进程回读有竞态）。
  // 动态 import 避免与桥模块形成加载环；非桌面（无桥）静默，本窗口已生效。
  void import("@/desktop-bridge/pet")
    .then((m) => m.notifyPetPrefsChanged(serialized))
    .catch(() => {});
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function usePetPrefs(): PetPrefs {
  return useSyncExternalStore(subscribe, getPetPrefs, () => DEFAULTS);
}
