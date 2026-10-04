import * as ImagePicker from "expo-image-picker";
import { compressImage } from "./image-compress";
import type { CreateAttachment } from "@assistant-ui/react-native";
import { validatePromptFile } from "@/lib/attachments/prompt-attachments";
import { newRequestId } from "@/lib/mobile/request-id";

/**
 * 移动端图片附件。
 *
 * 桌面端走 AttachmentAdapter 的 File 路径（<input type=file> + Rust dialog），
 * 移动端整条都不成立：RN 没有 <input>，附件来源是相册/相机，返回的是本地
 * file:// URI 而非 File 对象。所以这里改走 composer 的 **CreateAttachment 对象
 * 路径** —— core 的 addAttachment 见到非 File 入参直接落成 complete 附件、
 * 跳过 adapter.add（见 base-composer-runtime-core 的 isCreateAttachment 分支），
 * 于是 AttachmentAdapter 在移动端整个不需要注册。
 *
 * 产出的 content part 是 `{type:"image", image: dataUrl}`，与桌面端图片附件
 * 同形；buildPiSendInput 的 toImageContent 解出裸 base64 内联进 prompt 附件，
 * 下游（协议形状、大小闸门、sidecar 白名单）与桌面端完全一致。
 *
 * 移动端只做图片：文档的中转是 Rust attachment_stage（远程网关禁用），手机端
 * 没有可写的中转目录，内联 base64 又受 8MiB 请求体约束——v1 明确不做。
 */

/** 相册 / 相机选一张图 → complete 附件描述符；用户取消返回 null。 */
export async function pickImageAttachment(
  source: "library" | "camera",
): Promise<CreateAttachment | null> {
  const perm =
    source === "camera"
      ? await ImagePicker.requestCameraPermissionsAsync()
      : await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (!perm.granted) {
    throw new Error(
      source === "camera" ? "需要相机权限才能拍照" : "需要相册权限才能选图",
    );
  }

  const result =
    source === "camera"
      ? await ImagePicker.launchCameraAsync({ mediaTypes: ["images"], quality: 0.9 })
      : await ImagePicker.launchImageLibraryAsync({ mediaTypes: ["images"], quality: 0.9 });

  if (result.canceled) return null;
  const asset = result.assets[0];
  if (!asset) return null;

  const name = `${(asset.fileName ?? `image-${Date.now()}`).replace(/\.[^.]+$/, "")}.jpg`;
  // 统一压缩（相机原图动辄好几 MiB，直传必撞 2MiB 单图闸门）：
  // 长边 ≤1600、JPEG q0.8，超预算逐档退到 ≤1.5MiB
  const compressed = await compressImage(asset);
  const error = validatePromptFile({
    name,
    type: "image/jpeg",
    size: compressed.bytes,
  });
  if (error) throw new Error(error);

  return {
    id: newRequestId(),
    type: "image",
    name,
    contentType: "image/jpeg",
    content: [
      {
        type: "image",
        image: `data:image/jpeg;base64,${compressed.base64}`,
      },
    ],
  };
}
