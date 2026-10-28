"use client";

import { notify } from "@/lib/host-effects";
import type { PiModelSummary } from "@/lib/pi/pi-bridge";
import type { SelectedModel } from "@/lib/model/model-settings";
import { getPiModelsSnapshot } from "@/lib/pi/pi-models";
import { getThreadModelSnapshot } from "@/lib/pi/pi-session-model";

/**
 * 「发送含图片但当前模型是纯文本输入」的发送时提示（只提示、不拦截）。
 *
 * 背景：目录元数据标为纯文本输入的模型，请求侧会按元数据把图片替换成占位
 * 文本（pi-ai downgradeUnsupportedImages，sidecar 侧行为，移动端同一 sidecar
 * 自动生效）——模型看不到图片但仍可应答。本提示在发送时提前告知，免得用户
 * 等一轮「没收到图片」的回复才明白。元数据可在 设置→模型 修正该模型的输入
 * 能力；误标但端点真拒图的残余由 sidecar 拒图修复兜底（provider-retry 剥图
 * 重试）。移动端 composer 暂无桌面端那道附件入口硬闸，留作后续。
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
  // 改动：桌面端在这里动态 import `@/components/ui/toast`（framer-motion +
  // react-dom 的 UI 栈，浏览器侧首弹时按需加载）。RN 上没有那套组件，
  // 改走 host-effects 的 notify 端口——提示的呈现由根视图订阅后自绘横幅，
  // 本模块依旧不静态依赖任何 UI。
  notify(
    "warning",
    "当前模型不支持图片输入，它看不到所发图片——可切换到支持视觉的模型",
  );
}
