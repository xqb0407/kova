/**
 * 内联图片落盘（内存优化）：工具产出的图片在转录行里是 base64，投影还要再拼一份
 * data URL——同一个会话里几十张图就是常驻几十 MB 的 JS 字符串（2026-10-04 实测：
 * 某会话 31 张 ≈ 20MB base64，全库 16 个含图会话共 ≈62MB）。
 *
 * 这里把内联图交给 expo-image-manipulator（iOS 侧 loadImage 显式支持 `data:` 输入，
 * 见 expo-image-manipulator/ios/ImageManipulatorUtils.swift）：
 *   - 输出 file:// 落在缓存目录（系统可随时回收，不进备份）；
 *   - 长边超过 MAX_EDGE 先降采样——解码位图的内存按像素走，手机上一张
 *     2000×1500 的截图解码约 12MB，压到 1600 长边后 ≈7MB，是最实在的一刀。
 *
 * 去重：内容 SHA-256 做内存表（本会话内同一张图只处理一次；离线缓存文件由系统管）。
 * 不做的事：动图（GIF/WebP）不重编码（会丢帧，保持原 data URL）；web 与失败一律
 * 返回 null（调用方保留 data URL，渲染行为不变）。
 */
import { Image as RNImage, Platform } from "react-native";
import * as Crypto from "expo-crypto";
import {
  clearRowImageUri,
  collectFailedImageParts,
} from "./image-materialize-pure";
import { ImageManipulator, SaveFormat } from "expo-image-manipulator";
import {
  fitWithinMaxEdge,
  shouldMaterializeImage,
  type MaterializedImage,
} from "./image-materialize-pure";

export {
  fitWithinMaxEdge,
  shouldMaterializeImage,
  collectInlineToolImages,
  patchRowImage,
  clearRowImageUri,
  collectFailedImageParts,
  rowImagePartIsMaterialized,
} from "./image-materialize-pure";
export type { MaterializedImage, InlineImageTarget } from "./image-materialize-pure";

const done = new Map<string, MaterializedImage>();
const inflight = new Map<string, Promise<MaterializedImage | null>>();
/** 渲染层报过"这张已落盘的图加载不出来"的 uri（缓存被系统清了/写坏了）。
 *  命中后绝不再复用该 uri，也绝不再把它写回行里——避免"坏图"被反复贴回。 */
const failedUris = new Set<string>();
/** uri → 内容摘要的反查（失败时据此驱逐去重表，让下次落盘重新生成文件） */
const digestByUri = new Map<string, string>();
/** 每张图的落盘尝试次数：两次都不成（写出来读不了）就放弃，别再反复烧 CPU/堆文件 */
const attempts = new Map<string, number>();
const MAX_MATERIALIZE_ATTEMPTS = 2;

/** 本端能否落盘（web 的 expo-file-system 面不可用，直接不做） */
export const canMaterializeImages = (): boolean => Platform.OS !== "web";

/** 内容哈希（决定去重键；同图不同会话共用一份结果） */
export async function imageDigest(dataBase64: string): Promise<string> {
  return Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, dataBase64);
}

/**
 * base64 → 缓存文件（降采样）。幂等且并发去重：同一张图的并发调用共享一次处理。
 * 失败/不支持返回 null，调用方回退 data URL。
 */
export async function materializeInlineImage(
  dataBase64: string,
  mimeType: string,
): Promise<MaterializedImage | null> {
  if (!shouldMaterializeImage(dataBase64, mimeType, canMaterializeImages())) return null;
  let digest: string;
  try {
    digest = await imageDigest(dataBase64);
  } catch {
    return null;
  }
  if ((attempts.get(digest) ?? 0) >= MAX_MATERIALIZE_ATTEMPTS) return null;
  const hit = done.get(digest);
  // 失败过的 uri 不再复用：直接跳过缓存，重新生成一份（文件是新的，行里也就换成好图）
  if (hit && !failedUris.has(hit.uri)) return hit;
  const running = inflight.get(digest);
  if (running) return running;

  const task = (async (): Promise<MaterializedImage | null> => {
    try {
      const format = mimeType === "image/png" ? SaveFormat.PNG : SaveFormat.JPEG;
      const context = ImageManipulator.manipulate(
        `data:${mimeType};base64,${dataBase64}`,
      );
      const source = await context.renderAsync();
      const target = fitWithinMaxEdge(source.width, source.height);
      const ref = target
        ? await ImageManipulator.manipulate(source)
            .resize({ width: target.width, height: target.height })
            .renderAsync()
        : source;
      const saved = await ref.saveAsync({ compress: 0.85, format });
      // 落盘自检：文件真能被图像层读出来才算成功。读不出来就当没落盘（调用方保留
      // base64）——宁可多占点内存，也不给行里贴一个打不开的 file://（这就是
      // 「pop 里截图不显示」那条：写出来的文件读不了，界面只有个空占位）。
      if (!(await verifyImageReadable(saved.uri))) {
        attempts.set(digest, (attempts.get(digest) ?? 0) + 1);
        return null;
      }
      const result: MaterializedImage = {
        uri: saved.uri,
        mimeType: format === SaveFormat.PNG ? "image/png" : "image/jpeg",
        width: saved.width,
        height: saved.height,
      };
      done.set(digest, result);
      digestByUri.set(result.uri, digest);
      failedUris.delete(result.uri);
      return result;
    } catch {
      attempts.set(digest, (attempts.get(digest) ?? 0) + 1);
      return null;
    } finally {
      inflight.delete(digest);
    }
  })();
  inflight.set(digest, task);
  return task;
}

/**
 * 渲染层反馈：某张已落盘的图加载失败了（file:// 读不出来）。只记两件事：
 *  - 记下这个 uri，去重表里驱逐它 —— 下次落盘（新快照带来 base64 时）会生成
 *    **新文件新 uri**，行里随之换成好图，不需要上层做任何补偿；
 *  - 保证它不会被再次贴回行里（否则会"坏图"循环）。
 * 为什么会有这一步：缓存目录归系统管（可被清），而图是"照需重建"的——真正的
 * 事实源在桌面端转录里，重拉一次快照就能自愈。
 */
/** 图像层读不读得出来（RN Image.getSize 对 file:// 有效）：等于替我们验一次路径 */
const verifyImageReadable = (uri: string): Promise<boolean> =>
  new Promise((resolve) => {
    let settled = false;
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };
    try {
      RNImage.getSize(uri, (w, h) => done(w > 0 && h > 0), () => done(false));
    } catch {
      done(false);
    }
    setTimeout(() => done(false), 4000);
  });

/* ---------- 渲染层反馈：加载失败 → 自愈（去重驱逐 + 请求上层重拉） ---------- */

let rematerializeHandler: (() => void) | null = null;

/** 运行时注册的"重落盘"入口（revert 掉坏 uri + 后台拉一次快照拿回 base64） */
export function setImageRematerializeHandler(handler: (() => void) | null): void {
  rematerializeHandler = handler;
}

/** 渲染层发现 file:// 读不出来时调用（幂等；没有上层监听时只记失败） */
export function requestImageRematerialize(): void {
  rematerializeHandler?.();
}

export function markMaterializedImageFailed(uri: string): void {
  if (!uri) return;
  failedUris.add(uri);
  const digest = digestByUri.get(uri);
  if (digest) {
    done.delete(digest);
    digestByUri.delete(uri);
  }
}

export const isMaterializedImageFailed = (uri: string): boolean => failedUris.has(uri);

/** 仅供测试：清空去重表与失败台账 */
export function __resetImageMaterializeCacheForTests(): void {
  done.clear();
  inflight.clear();
  failedUris.clear();
  digestByUri.clear();
  attempts.clear();
}

