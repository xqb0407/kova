/**
 * leafer/assets.ts — 图片资产的 base64 → data URL 缓存。
 *
 * 图片节点 src 是 workspace 相对路径，渲染前要经桥 requestAsset 取回 base64。
 * scene.ts 是命令式 patch（非 React 组件级订阅），所以这里用「全局版本号 + hook」
 * 通知 DesignStage 重跑一次 patch；单帧视图（导出、Home 缩略图）可用
 * assetDataUrl 的 Promise 口径等待就绪。
 */
import { useEffect, useState } from "react";
import { bridge } from "../bridge";
import { walkDoc, type DesignDoc } from "../doc";

type AssetState = { status: "loading" | "ready"; url: string | null };

const assetCache = new Map<string, AssetState>();
const assetListeners = new Set<() => void>();

function subscribeAssets(cb: () => void): () => void {
  assetListeners.add(cb);
  return () => assetListeners.delete(cb);
}

/** 发起加载（幂等；已缓存直接返回）。standalone 下桥超时 → url:null 占位不阻塞 */
export function ensureAsset(path: string): void {
  if (!path || assetCache.has(path)) return;
  assetCache.set(path, { status: "loading", url: null });
  void bridge.requestAsset(path).then((b64) => {
    const url = b64 ? toDataUrl(path, b64) : null;
    assetCache.set(path, { status: "ready", url });
    for (const l of assetListeners) l();
  });
}

const MIME: [RegExp, string][] = [
  [/\.png$/i, "image/png"],
  [/\.jpe?g$/i, "image/jpeg"],
  [/\.webp$/i, "image/webp"],
  [/\.gif$/i, "image/gif"],
  [/\.svg$/i, "image/svg+xml"],
];

function toDataUrl(path: string, b64: string): string {
  const mime = MIME.find(([re]) => re.test(path))?.[1] ?? "application/octet-stream";
  return `data:${mime};base64,${b64}`;
}

export function getAssetState(path: string): AssetState | undefined {
  return assetCache.get(path);
}

/** 异步等待资产就绪（导出/缩略图用）；失败返回 null */
export function assetDataUrl(path: string): Promise<string | null> {
  ensureAsset(path);
  const cur = assetCache.get(path);
  if (cur && cur.status === "ready") return Promise.resolve(cur.url);
  return new Promise((res) => {
    const unsub = subscribeAssets(() => {
      const s = assetCache.get(path);
      if (s && s.status === "ready") {
        unsub();
        res(s.url);
      }
    });
  });
}

/** 文档内全部 image 节点预取（applyDoc / commit 后调用，渲染时大概率已就绪） */
export function preloadDocAssets(doc: DesignDoc): void {
  for (const { node } of walkDoc(doc)) {
    if (node.type === "image" && node.src) ensureAsset(node.src);
  }
}

/** 订阅资产版本变化：DesignStage 依赖它重跑 patch，把 loading 占位换成真图 */
export function useAssetsVersion(): number {
  const [v, setV] = useState(0);
  useEffect(() => subscribeAssets(() => setV((n) => n + 1)), []);
  return v;
}
