"use client";

import { notify } from "@/lib/host-effects";
import { piRequest } from "@/lib/pi/pi-bridge";
import type { PiModelSummary, PiVisionToolSettings } from "@/lib/pi/pi-bridge";
import type { SelectedModel } from "@/lib/model/model-settings";
import { getPiModelsSnapshot } from "@/lib/pi/pi-models";
import { getThreadModelSnapshot } from "@/lib/pi/pi-session-model";

/**
 * 「发送含图片但当前模型是纯文本输入」的发送时提示（只提示、不拦截）。
 *
 * 背景：目录元数据标为纯文本输入的模型，请求侧会按元数据把图片替换成占位
 * 文本（pi-ai downgradeUnsupportedImages，sidecar 侧行为，移动端同一 sidecar
 * 自动生效）——模型看不到图片但仍可应答。视觉辅助开关打开时（桌面 设置→模型，
 * sidecar kv 全局生效），请求侧会先把图片换成带 imageId 的占位（sidecar
 * image-refs.ts），模型可主动调 see_image 查看，本提示随之让位：开关开且
 * 目录里有可用视觉模型时不再提示。本提示在发送时提前告知，免得用户等一轮
 * 「没收到图片」的回复才明白。元数据可在 设置→模型 修正该模型的输入能力；
 * 误标但端点真拒图的残余由 sidecar 拒图修复兜底（provider-retry 剥图重试）。
 * 移动端 composer 暂无桌面端那道附件入口硬闸，留作后续。
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

/**
 * 目录里是否存在「可用的视觉模型」（see_image 自动选型在 sidecar 用同口径）：
 * 已配凭据、未被过滤隐藏、声明图像输入、非文生图标记。空目录返回 false。
 */
export function hasUsableVisionModel(models: PiModelSummary[]): boolean {
  return models.some(
    (m) =>
      m.authed &&
      m.enabled !== false &&
      m.t2i !== true &&
      Array.isArray(m.input) &&
      m.input.includes("image"),
  );
}

/** 视觉辅助开关镜像（事实源 sidecar kv pi.visionTool，全局设置）：懒加载一次，
 *  失败下次发送重试；默认关——与「开关关闭时零提示词污染」的语义一致。
 *  连续失败达到上限后停止重试（旧 sidecar 没有该命令时会每次发送空打一次
 *  RPC）；重置只能靠重启 app，属可接受的降级。 */
let visionToolEnabled = false;
let visionToolStateLoading = false;
let visionToolFailures = 0;
const VISION_TOOL_MAX_FAILURES = 3;

function ensureVisionToolState(): void {
  if (visionToolStateLoading || visionToolEnabled) return;
  if (visionToolFailures >= VISION_TOOL_MAX_FAILURES) return;
  visionToolStateLoading = true;
  void piRequest<{ type: "vision_tool"; settings: PiVisionToolSettings }>({
    type: "get_vision_tool",
  })
    .then((res) => {
      visionToolEnabled = res.settings?.enabled === true;
      visionToolFailures = 0;
    })
    .catch(() => {
      // sidecar 不可用（启动早期/断连）：保持默认关，下次发送时重试
      visionToolStateLoading = false;
      visionToolFailures += 1;
    });
}

/** 该不该提示：本次发送含图、选中模型能按 gate 同口径在目录里找到、元数据明确
 *  排除图像、且视觉辅助未就绪。enabled 可显式传入（测试与调用方覆写开关状态）。 */
export function shouldWarnUnsupportedImages(
  hasImages: boolean,
  selected: SelectedModel | null,
  models: PiModelSummary[],
  enabled: boolean = visionToolEnabled,
): boolean {
  if (!hasImages || !selected || models.length === 0) return false;
  if (enabled && hasUsableVisionModel(models)) return false;
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
  ensureVisionToolState();
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
    "当前模型不支持图片输入，它看不到所发图片——可切换到支持视觉的模型，或在桌面 设置→模型 开启「视觉辅助」让模型调 see_image 查看",
  );
}
