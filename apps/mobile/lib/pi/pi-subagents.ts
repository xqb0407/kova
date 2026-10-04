"use client";

/**
 * 子智能体清单镜像（移动端版，迁移自桌面 apps/desktop/lib/subagent/subagents.ts
 * 的读取路径）：@ 提及菜单要用的启用项清单；设置在桌面端改完，这里下次拉取即见。
 */
import { useEffect, useSyncExternalStore } from "react";
import {
  piRequest,
  type PiSubagentEntry,
  type PiSubagentsResponse,
} from "@/lib/pi/pi-bridge";

const CACHE_MS = 30_000;

type SubagentsState = {
  agents: PiSubagentEntry[];
  pluginAgents: PiSubagentEntry[];
  loadedAt: number;
};

let cache: SubagentsState = { agents: [], pluginAgents: [], loadedAt: 0 };
/** 可用子智能体快照（引用稳定） */
let snapshot: SubagentEntry[] = [];
let inflight: Promise<void> | null = null;
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const getSnapshot = () => snapshot;

/** 可用子智能体（未显式关闭的；插件子智能体同场） */
function computeAvailable(): SubagentEntry[] {
  return [...cache.agents, ...cache.pluginAgents].filter(
    (a) => (a as SubagentEntry).enabled !== false,
  );
}

export async function refreshSubagents(cwd?: string, force = false): Promise<void> {
  if (!force && Date.now() - cache.loadedAt < CACHE_MS) return;
  if (inflight) return inflight;
  inflight = piRequest<PiSubagentsResponse>({ type: "list_subagents", ...(cwd ? { cwd } : {}) })
    .then((res) => {
      cache = {
        agents: res.agents ?? [],
        pluginAgents: res.pluginAgents ?? [],
        loadedAt: Date.now(),
      };
      const next = computeAvailable();
      if (
        next.length !== snapshot.length ||
        next.some((a, i) => a !== snapshot[i])
      ) {
        snapshot = next;
        for (const listener of listeners) listener();
      }
    })
    .catch(() => {
      /* 静默同上 */
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

type SubagentEntry = PiSubagentEntry & { enabled?: boolean };

/** 组件侧订阅（同 pi-skills：useSyncExternalStore + 快照，避免 memo 把
 *  无参调用连结果缓存住，清单到了不重算） */
export function useSubagents(cwd?: string): SubagentEntry[] {
  const list = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  useEffect(() => {
    void refreshSubagents(cwd);
  }, [cwd]);
  return list;
}
