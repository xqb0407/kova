"use client";

import type { PiModelSummary } from "@/lib/pi/pi-bridge";
import type { SelectedModel } from "@/lib/model/model-settings";
import { getPiModelsSnapshot } from "@/lib/pi/pi-models";
import { getThreadModelSnapshot } from "@/lib/pi/pi-session-model";

/**
 * 「发送含图片但当前模型是纯文本输入」的桌面提示（只提示、不拦截）。
 *
 * 背景：图片以 image_url 无条件进请求体（pi-ai openai-completions 转换器），
 * 端点若是纯文本模型会静默忽略，模型便如实回答「没收到图片」。sidecar 不做
 * 拦截：input 元数据不可靠、实测误拦过支持图像的模型，模型硬门已移除
 * （见 sidecar prompt-pipeline.ts 附件段注释）。桌面层按列表元数据仅 toast
 * 提醒——元数据错了代价也只是多一句提示，用户可切换视觉模型，或在
 * 设置→模型 里修正该模型的输入能力。
 *
 * 判定时机在发送而非添加附件（添加后还可能换模型）；汇聚点是
 * ThreadController.sendMessage（普通发送 / 排队 / steer / 重新生成重发都经它）。
 * 与 pi-model-gate 同口径：目录为空（未加载或远程模式）不判定；input 字段
 * 缺失的模型不判定，避免误报。
 */

/** 目录元数据是否明确排除图像输入；input 缺失（undefined/非数组）返回 null=不判定 */
export function imageSupportFromMetadata(
  model: PiModelSummary | null | undefined,
): boolean | null {
  if (!model || !Array.isArray(model.input)) return null;
  return model.input.includes("image");
}

/** 该不该提示：本次发送含图、选中模型能按 gate 同口径在目录里找到、且元数据明确排除图像 */
export function shouldWarnUnsupportedImages(
  hasImages: boolean,
  selected: SelectedModel | null,
  models: PiModelSummary[],
): boolean {
  if (!hasImages || !selected || models.length === 0) return false;
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
      "当前模型不支持图片输入，它看不到所发图片——可切换到支持视觉的模型",
    );
  });
}
