"use client";

/**
 * 宠物清单与素材的网络加载：fetch 优先，`kova://pet/` 库地址在 dev http 页面
 * 被 Chromium 拦截时回落 `pet_asset_read` 桥（生产 kova://app 同源走不到兜底）。
 *
 * 原逻辑内联在 Pet 组件（pet.tsx）里；提取出来给预览条带加载器
 * （preview-atlas.ts）复用——条带加载器同样要拿清单与图集字节。
 */

import { readPetAsset } from "@/desktop-bridge/pet";

/** `kova://pet/<相对路径>` → 相对路径；非库地址返回 null。 */
function kovaPetRel(url: string): string | null {
  const match = /^kova:\/\/pet\/(.+)$/i.exec(url);
  if (!match?.[1]) return null;
  return decodeURIComponent(match[1]);
}

function base64ToBytes(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      const dataUrl = String(reader.result);
      const comma = dataUrl.indexOf(",");
      resolve(comma >= 0 ? dataUrl.slice(comma + 1) : "");
    });
    reader.addEventListener("error", () => reject(new Error("资源 base64 编码失败")));
    reader.readAsDataURL(blob);
  });
}

/**
 * 拉 pet.json。返回 `viaBridge`：true = fetch 被拦走了桥兜底——此时该清单下的
 * 其它 `kova://` 资源地址同样加载不了，调用方需要走桥逐个取（见 Pet 的内嵌
 * data URL 路径）。
 */
export async function fetchPetJson(
  source: string,
): Promise<{ json: unknown; viaBridge: boolean }> {
  try {
    const res = await fetch(source);
    if (!res.ok) throw new Error(`pet.json 拉取失败：HTTP ${res.status}`);
    return { json: await res.json(), viaBridge: false };
  } catch (err) {
    const rel = kovaPetRel(source);
    if (rel === null) throw err;
    const { bytes } = await readKovaBytes(rel);
    return { json: JSON.parse(new TextDecoder().decode(bytes)) as unknown, viaBridge: true };
  }
}

/**
 * 桥读路径的素材 base64 直出（不经过 bytes→base64 的重编码）：Pet 的内嵌
 * data URL 清单用。库地址直接走桥；其余地址 fetch 后转 base64。
 */
export async function fetchPetBase64(
  url: string,
): Promise<{ base64: string; mime: string }> {
  const rel = kovaPetRel(url);
  if (rel !== null) return readPetAsset(rel);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`资源拉取失败：HTTP ${res.status}`);
  const blob = await res.blob();
  return { base64: await blobToBase64(blob), mime: blob.type };
}

/**
 * 拉二进制素材（图集/动图），给解码侧用（createImageBitmap 吃 Blob）。
 * fetch 失败且是库地址时回落桥读；空响应也视为失败走兜底——dev 下自定义协议
 * fetch 偶发成功但 body 为空，直接拿空字节解码只会把失败推迟到解码一步。
 */
export async function fetchPetBytes(
  url: string,
): Promise<{ bytes: Uint8Array<ArrayBuffer>; mime: string }> {
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`资源拉取失败：HTTP ${res.status}`);
    const blob = await res.blob();
    if (blob.size === 0) throw new Error(`资源响应为空：${url}`);
    return { bytes: new Uint8Array(await blob.arrayBuffer()), mime: blob.type };
  } catch (err) {
    const rel = kovaPetRel(url);
    if (rel === null) throw err;
    const asset = await readPetAsset(rel);
    return { bytes: base64ToBytes(asset.base64), mime: asset.mime };
  }
}

async function readKovaBytes(rel: string): Promise<{ bytes: Uint8Array<ArrayBuffer>; mime: string }> {
  const asset = await readPetAsset(rel);
  return { bytes: base64ToBytes(asset.base64), mime: asset.mime };
}
