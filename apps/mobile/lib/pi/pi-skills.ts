"use client";

/**
 * 技能清单镜像（移动端版，迁移自桌面 apps/desktop/lib/skills/skills.ts 的读取路径）：
 * 事实源在 sidecar（托管层 .md + 生态兼容层 + kv 开关），这里只做「/ 菜单与
 * ＋ 菜单要用的那一份清单」——设置页的增删改在移动端不做，故不搬 CRUD。
 * 变更动作（save/delete/开关）在桌面端改完，这里的下一次拉取自然见到。
 *
 * 订阅走 useSyncExternalStore + 模块内快照（不用「版本号 + useState」那种自造
 * 订阅：编译期 memo 会把 skillsList() 这类无参调用连结果一起缓存，清单到了也
 * 不重算，菜单永远空着）。快照只在数据真变时换引用。
 */
import { useEffect, useSyncExternalStore } from "react";
import {
  piRequest,
  type PiSkillEntry,
  type PiSkillsResponse,
} from "@/lib/pi/pi-bridge";

const CACHE_MS = 30_000;

type SkillsState = {
  skills: PiSkillEntry[];
  pluginSkills: PiSkillEntry[];
  loadedAt: number;
};

let cache: SkillsState = { skills: [], pluginSkills: [], loadedAt: 0 };
/** 可用技能快照（引用稳定：数据没变就不换引用） */
let snapshot: PiSkillEntry[] = [];
let inflight: Promise<void> | null = null;
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const getSnapshot = () => snapshot;

/** 可用技能（过滤被遮蔽/停用项；插件技能与常规技能同场，芯片凭名定位） */
function computeAvailable(): PiSkillEntry[] {
  return [...cache.skills, ...cache.pluginSkills].filter(
    (s) => s.enabled && !s.shadowed,
  );
}

/** 拉取技能清单（30s 内复用；在途去重）。cwd = 当前会话工作目录（sidecar 按它
 *  发现 workspace 层技能；不传则只回系统/插件层）。失败静默：菜单少一栏不影响输入 */
export async function refreshSkills(cwd?: string, force = false): Promise<void> {
  if (!force && Date.now() - cache.loadedAt < CACHE_MS) return;
  if (inflight) return inflight;
  inflight = piRequest<PiSkillsResponse>({ type: "list_skills", ...(cwd ? { cwd } : {}) })
    .then((res) => {
      cache = {
        skills: res.skills ?? [],
        pluginSkills: res.pluginSkills ?? [],
        loadedAt: Date.now(),
      };
      const next = computeAvailable();
      if (
        next.length !== snapshot.length ||
        next.some((s, i) => s !== snapshot[i])
      ) {
        snapshot = next;
        for (const listener of listeners) listener();
      }
    })
    .catch(() => {
      /* 静默：清单类数据失败不打扰输入 */
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

/** 组件侧订阅（首次挂载触发一次拉取；cwd 变了重新拉）。
 *  订阅走 useSyncExternalStore + 模块内快照：自造「版本号 + useState」时，
 *  编译期 memo 会把无参的 skillsList() 调用连结果一起缓存，清单到了也不重算，
 *  菜单永远空着——快照引用是 store 的输出，memo 不再挡得住。 */
export function useSkills(cwd?: string): PiSkillEntry[] {
  const list = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  useEffect(() => {
    void refreshSkills(cwd);
  }, [cwd]);
  return list;
}
