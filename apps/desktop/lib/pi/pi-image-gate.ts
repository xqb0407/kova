"use client";

import { useEffect } from "react";
import { useAuiState } from "@assistant-ui/react";
import type { PiModelSummary } from "@/lib/pi/pi-bridge";
import type { SelectedModel } from "@/lib/model/model-settings";
import { getPiModelsSnapshot, usePiModels } from "@/lib/pi/pi-models";
import { getThreadModelSnapshot, useThreadModel } from "@/lib/pi/pi-session-model";
import {
  hasUsableVisionModel,
  imageSupportFromMetadata,
} from "@/lib/pi/pi-vision-warning";
import {
  isVisionToolEnabled,
  useVisionToolSettings,
} from "@/lib/settings/vision-tool-config";

/**
 * 「当前模型是纯文本输入」的 composer 图片附件硬闸（多模态降级闭环第③道防线）。
 *
 * 请求侧降级（pi-ai downgradeUnsupportedImages）与 sidecar 拒图修复只保证
 * 「带图会话不报废」；本闸按同一份目录元数据把图片挡在入口——纯文本模型
 * 干脆加不了图片，省掉注定被剥掉的上传与一轮「看不到图」的问答。与
 * pi-model-gate 同口径：目录为空（未加载/远程模式/web 预览）不判定，
 * input 字段缺失的模型不判定，模型不在目录（已删/停用）不判定——
 * 宁可漏放（请求侧会兜底）也不误禁。
 *
 * 视觉辅助（设置→模型）打开且目录里有可用视觉模型时本闸让位：请求侧会把
 * 图片换成带 imageId 的占位（sidecar image-refs.ts），模型可主动调
 * see_image 查看，附件照常放行。开关关闭（默认）或目录里凑不出可用视觉模型
 * 时维持拦截——「提示词零污染」优先，默认行为与未引入该能力前一致。
 *
 * 元数据标错的模型在此表现为「加不了图片」；自救入口在 设置→模型 的
 * 输入能力勾选，或开启视觉辅助。两个消费面：
 * - 响应式（useImageSupportGate）：加号菜单图片项禁用、composer dropzone
 *   disabled；
 * - 同步（imageAttachmentBlockedReason）：validatePromptFile 内部调用——
 *   粘贴/文件选择/data URI 三类入口共用这一道，拒收文案即本提示。
 */

export const IMAGE_GATE_HINT =
  "当前模型不支持图片输入，已禁止添加图片附件（可在 设置→模型 修正该模型的输入能力，或开启「视觉辅助」让模型通过 see_image 查看图片）";

/** 目录里找当前选择（与 pi-model-gate / pi-vision-warning 同一过滤口径） */
function findCatalogModel(
  models: PiModelSummary[],
  selected: SelectedModel,
): PiModelSummary | null {
  return (
    models.find(
      (m) =>
        m.provider === selected.provider &&
        m.id === selected.modelId &&
        m.authed &&
        m.enabled !== false,
    ) ?? null
  );
}

/**
 * 纯判定：元数据明确排除图像输入、且视觉辅助未就绪才 true；其余情形一律放行。
 * 就绪 = 视觉辅助开关打开（enabled 可显式传入供测试与调用方覆写，缺省读镜像）
 * **且** 目录里存在可用视觉模型（hasUsableVisionModel 现算）——二者缺一不可。
 */
export function imageGateBlocked(
  models: PiModelSummary[],
  selected: SelectedModel | null,
  enabled: boolean = isVisionToolEnabled(),
): boolean {
  if (!selected || models.length === 0) return false;
  if (enabled && hasUsableVisionModel(models)) return false;
  return imageSupportFromMetadata(findCatalogModel(models, selected)) === false;
}

/* ---------------- 同步入口的线程登记（兜底） ----------------
 * 主路径由调用方把线程 id 传进 validatePromptFile（composer 自己知道所在
 * 会话）。这里的模块级登记只给「确实拿不到线程上下文」的旧/外部调用点兜底：
 * 由 useImageSupportGate 的 effect 随线程切换刷新。不做 unmount 清理：
 * composer 恒挂载（多消费者卸载时序不定）；注意单例只能代表最后一次挂载的
 * 那个会话，主对话 + 副屏并存时不能依赖它（见 imageAttachmentBlockedReason）。 */
let gateThreadId: string | undefined;

export function setImageGateThreadId(threadId: string | undefined): void {
  gateThreadId = threadId;
}

/** 同步判定（validatePromptFile 用）：命中返回拒收文案，否则 null。
 *  空目录/无选择时不判定，恒 null。
 *
 *  threadId 必须由调用方传入：主对话与副屏（划词会话）各挂一个 composer，
 *  模块级登记只有一份，后挂载的会把前一个覆盖掉——粘贴图片时按另一个会话
 *  的模型判定，正是「视觉模型被误报不支持」的跨 composer 版本。缺省回落到
 *  useImageSupportGate 的登记（旧调用点兜底）。 */
export function imageAttachmentBlockedReason(threadId?: string): string | null {
  const selected = getThreadModelSnapshot(threadId ?? gateThreadId ?? "");
  if (!selected) return null;
  return imageGateBlocked(getPiModelsSnapshot(), selected) ? IMAGE_GATE_HINT : null;
}

/** 响应式判定：加号菜单/dropzone 的禁用态与 tooltip 共用一份取值。
 *  开关状态经 useVisionToolSettings 订阅——设置页翻转后本闸即时重渲染，
 *  不能用 isVisionToolEnabled() 裸读（非响应式，composer 会停在旧禁用态）。
 *  副作用：随线程切换刷新同步入口的线程登记（见上）。 */
export function useImageSupportGate(): {
  canAttachImages: boolean;
  hint: string | null;
} {
  const threadId = useAuiState((s) => s.threads.mainThreadId);
  const selected = useThreadModel(threadId);
  const models = usePiModels();
  const visionEnabled = useVisionToolSettings().enabled;
  const blocked = imageGateBlocked(models, selected, visionEnabled);
  useEffect(() => {
    setImageGateThreadId(threadId);
  }, [threadId]);
  return { canAttachImages: !blocked, hint: blocked ? IMAGE_GATE_HINT : null };
}
