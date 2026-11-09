"use client";

import type { PiModelSummary } from "@/lib/pi/pi-bridge";
import type { SelectedModel } from "@/lib/model/model-settings";
import { getPiModelsSnapshot } from "@/lib/pi/pi-models";
import { getThreadModelSnapshot } from "@/lib/pi/pi-session-model";
import { isVisionToolEnabled } from "@/lib/settings/vision-tool-config";

/**
 * 「发送含图片但当前模型是纯文本输入」的桌面提示。
 *
 * 背景：目录元数据明确标为纯文本输入的模型，请求侧会按元数据把图片替换成
 * 占位文本（pi-ai downgradeUnsupportedImages，补丁已恢复 user 分支；见 sidecar
 * transform-images.test.ts 头注）——模型看不到图片但仍可应答。视觉辅助开关
 * 打开时（设置→模型），请求侧会先把图片换成带 imageId 的占位（sidecar
 * image-refs.ts），模型可主动调 see_image 查看，本提示随之让位：开关开且
 * 目录里有可用视觉模型时不再提示。本 toast 在发送时提前告知，免得用户等一轮
 * 「没收到图片」的回复才明白。元数据可在 设置→模型 修正该模型的输入能力；
 * 误标但端点真拒图的残余由 sidecar 拒图修复兜底（provider-retry 剥图重试）。
 *
 * 判定时机在发送而非添加附件（添加后还可能换模型）；汇聚点是
 * ThreadController.sendMessage（普通发送 / 排队 / steer / 重新生成重发都经它）。
 * 与 pi-model-gate 同口径：目录为空（未加载或远程模式）不判定；input 字段
 * 缺失的模型不判定，避免误报。composer 附件入口另有同口径硬闸
 * （lib/attachments/prompt-attachments.ts + useImageSupportGate）。
 */

/** 目录元数据是否明确排除图像输入；input 缺失（undefined/非数组）返回 null=不判定 */
export function imageSupportFromMetadata(
  model: PiModelSummary | null | undefined,
): boolean | null {
  if (!model || !Array.isArray(model.input)) return null;
  return model.input.includes("image");
}

/**
 * 「可用视觉模型」的单条判定（清单过滤与 hasUsableVisionModel 共用一份口径，
 * 防 UI 过滤与判定逻辑漂移）：已配凭据、未被过滤隐藏、声明图像输入、非文生图。
 */
export function isUsableVisionModel(m: PiModelSummary): boolean {
  return (
    m.authed &&
    m.enabled !== false &&
    m.t2i !== true &&
    Array.isArray(m.input) &&
    m.input.includes("image")
  );
}

/**
 * 目录里是否存在「可用的视觉模型」（see_image 自动挑选在 sidecar 用同口径）。
 * 空目录返回 false。
 */
export function hasUsableVisionModel(models: PiModelSummary[]): boolean {
  return models.some(isUsableVisionModel);
}

/** 视觉辅助是否就绪：开关打开（enabled 缺省读镜像）+ 目录里有可用视觉模型 */
export function visionHelperReady(
  models: PiModelSummary[],
  enabled: boolean = isVisionToolEnabled(),
): boolean {
  return enabled && hasUsableVisionModel(models);
}

/** 该不该提示：本次发送含图、选中模型能按 gate 同口径在目录里找到、元数据明确
 *  排除图像、且视觉辅助未就绪。enabled 可显式传入（测试与调用方覆写开关状态）。 */
export function shouldWarnUnsupportedImages(
  hasImages: boolean,
  selected: SelectedModel | null,
  models: PiModelSummary[],
  enabled: boolean = isVisionToolEnabled(),
): boolean {
  if (!hasImages || !selected || models.length === 0) return false;
  if (visionHelperReady(models, enabled)) return false;
  const model = models.find(
    (m) =>
      m.provider === selected.provider &&
      m.id === selected.modelId &&
      m.authed &&
      m.enabled !== false,
  );
  return imageSupportFromMetadata(model) === false;
}

let lastWarnKey = "";
let lastWarnAt = 0;

/** 发送汇聚点调用：命中判定时弹一次 toast；同一模型 5s 内不重复弹（连发不刷屏） */
export function maybeWarnUnsupportedImages(
  threadId: string,
  hasImages: boolean,
): void {
  if (!hasImages) return;
  const selected = getThreadModelSnapshot(threadId);
  if (!shouldWarnUnsupportedImages(true, selected, getPiModelsSnapshot())) return;
  const key = selected
    ? `${selected.provider}/${selected.modelId}`
    : "";
  const now = Date.now();
  if (key === lastWarnKey && now - lastWarnAt < 5000) return;
  lastWarnKey = key;
  lastWarnAt = now;
  // 动态引入：本模块被 ThreadController 静态依赖（含其单测），不能把
  // framer-motion/react-dom 的 UI 栈拉进测试模块图；浏览器侧首弹时按需加载。
  void import("@/components/ui/toast").then(({ toast }) => {
    toast.warning(
      "当前模型不支持图片输入，它看不到所发图片——可切换到支持视觉的模型，或在 设置→模型 开启「视觉辅助」让模型调 see_image 查看",
    );
  });
}
