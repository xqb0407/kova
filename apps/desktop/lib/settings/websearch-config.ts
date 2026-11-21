"use client";

import { useSyncExternalStore } from "react";
import { piRequest } from "@/lib/pi/pi-bridge";
import type {
  PiWebSearchDefaults,
  PiWebSearchKeyStatus,
  PiWebSearchPreset,
  PiWebSearchProvider,
  PiWebSearchSettings,
  PiWebSearchTestResult,
} from "@/lib/pi/pi-bridge";

/**
 * 网页搜索设置（设置 → 智能体 → 网页搜索）的配置镜像。
 * 事实源在 sidecar——SQLite kv（pi.websearch）+ 加密凭据表（websearch:<id>）。
 * 这里只做镜像：get_websearch 水合，set_websearch 保存，key 单独写（不回显明文）。
 */
export type WebSearchSnapshot = {
  settings: PiWebSearchSettings;
  keys: Record<string, PiWebSearchKeyStatus>;
  presets: PiWebSearchPreset[];
  defaults: PiWebSearchDefaults;
};

export type { PiWebSearchTestResult as WebSearchTestResult };

const DEFAULT_PROVIDER: PiWebSearchProvider = {
  id: "tavily",
  kind: "tavily",
  label: "Tavily",
  baseUrl: "",
  method: "POST",
  headers: {},
  bodyTemplate: "",
  resultsPath: "",
  titlePath: "",
  urlPath: "",
  snippetPath: "",
  sourcePath: "",
};

export const DEFAULT_WEB_SEARCH_SETTINGS: PiWebSearchSettings = {
  enabled: true,
  provider: DEFAULT_PROVIDER,
  requestTimeoutMs: 8_000,
  maxResults: 8,
};

/** 旧版 sidecar 缺 presets 时的回落（仅「添加服务」按钮用；端点仍由 sidecar 解析） */
const FALLBACK_PRESETS: PiWebSearchPreset[] = [
  { kind: "deepseek", label: "DeepSeek Search", baseUrl: "", needsKey: true },
  { kind: "tavily", label: "Tavily", baseUrl: "", needsKey: true },
  { kind: "brave", label: "Brave Search", baseUrl: "", needsKey: true },
  { kind: "exa", label: "Exa", baseUrl: "", needsKey: true },
  { kind: "searxng", label: "SearXNG", baseUrl: "", needsKey: false },
];

export const DEFAULT_WEB_SEARCH_DEFAULTS: PiWebSearchDefaults = {
  requestTimeoutMs: 8_000,
  maxResults: 8,
};

const DEFAULT_SNAPSHOT: WebSearchSnapshot = {
  settings: DEFAULT_WEB_SEARCH_SETTINGS,
  keys: {},
  presets: FALLBACK_PRESETS,
  defaults: DEFAULT_WEB_SEARCH_DEFAULTS,
};

let snapshot: WebSearchSnapshot = DEFAULT_SNAPSHOT;
const listeners = new Set<() => void>();
// 写序号：保存/刷新/存 key 并发时，只让最新一次写回的结果落地，
// 防止慢的旧响应覆盖刚做的修改（页面是即时保存，改字段很频繁）
let writeSeq = 0;

function emit(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useWebSearchSettings(): WebSearchSnapshot {
  return useSyncExternalStore(
    subscribe,
    () => snapshot,
    () => DEFAULT_SNAPSHOT,
  );
}

/** 非渲染路径（测试按钮）读最新镜像：失焦提交刚 optimistic 更新过，但点击
 *  处理器里捕获的 props 还是上一帧的值 */
export function getWebSearchSettings(): PiWebSearchSettings {
  return snapshot.settings;
}

type WebSearchResponse = {
  type: "websearch";
  settings: PiWebSearchSettings;
  keys: Record<string, PiWebSearchKeyStatus>;
  presets: PiWebSearchPreset[];
  defaults: PiWebSearchDefaults;
};

function applyResponse(res: WebSearchResponse): void {
  snapshot = {
    settings: res.settings,
    // set 只回当前服务的 key 状态：合并保留其它服务的已知状态
    keys: { ...snapshot.keys, ...(res.keys ?? {}) },
    presets: res.presets?.length ? res.presets : FALLBACK_PRESETS,
    defaults: res.defaults ?? DEFAULT_WEB_SEARCH_DEFAULTS,
  };
  emit();
}

/** 从 sidecar 拉最新配置（sidecar 不可用则保持当前镜像） */
export async function refreshWebSearchSettings(): Promise<void> {
  const seq = writeSeq;
  try {
    const res = await piRequest<WebSearchResponse>({ type: "get_websearch" });
    // 请求期间有本地写入：以本地乐观状态为准，别回滚用户刚改的值
    if (seq === writeSeq) applyResponse(res);
  } catch {
    // sidecar 不可用（启动早期/连接断开）：保持默认，保存时仍会尝试
  }
}

/** 保存配置：乐观更新；sidecar 落 kv 并返回权威快照，失败回滚并抛出 */
export async function saveWebSearchSettings(
  next: PiWebSearchSettings,
): Promise<void> {
  const seq = ++writeSeq;
  const previous = snapshot;
  snapshot = { ...snapshot, settings: next };
  emit();
  try {
    const res = await piRequest<WebSearchResponse>({
      type: "set_websearch",
      settings: next,
    });
    if (seq === writeSeq) applyResponse(res);
  } catch (err) {
    // 只有这次写仍是最新时才能回滚：更新的保存已经覆盖了乐观状态
    if (seq === writeSeq) {
      snapshot = previous;
      emit();
    }
    throw err;
  }
}

/** 保存/清除某家的 key（空 key 且不 clear = 保持原值） */
export async function saveWebSearchKey(
  providerId: string,
  apiKey: string,
  clear = false,
): Promise<void> {
  const seq = ++writeSeq;
  const res = await piRequest<{
    type: "websearch_key";
    providerId: string;
    hasKey: boolean;
    masked: string;
  }>({
    type: "set_websearch_key",
    providerId,
    ...(clear ? { clear: true } : { apiKey }),
  });
  if (seq !== writeSeq) return;
  snapshot = {
    ...snapshot,
    keys: {
      ...snapshot.keys,
      [res.providerId]: { hasKey: res.hasKey, masked: res.masked },
    },
  };
  emit();
}

/** 设置页「测试连接」：用草稿配置实时搜索一次，不落库；不返回 key */
export async function testWebSearch(input: {
  query?: string;
  apiKey?: string;
  settings?: PiWebSearchSettings;
}): Promise<PiWebSearchTestResult> {
  const timeout =
    input.settings?.requestTimeoutMs ?? snapshot.settings.requestTimeoutMs;
  const res = await piRequest<{
    type: "websearch_tested";
    result: PiWebSearchTestResult;
  }>(
    { type: "test_websearch", ...input },
    // 单次超时 + 宿主 RPC 余量（15s）+ 往返；别让通用请求超时先掐掉测试
    Math.max(30_000, timeout + 16_000),
  );
  return res.result;
}

// client bundle 加载即水合（SSR 端不请求，getServerSnapshot 返回默认值）
void refreshWebSearchSettings();
