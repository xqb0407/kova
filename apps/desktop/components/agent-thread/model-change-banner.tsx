"use client";

import { makeAssistantDataUI } from "@assistant-ui/react";
import { ArrowLeftRightIcon } from "lucide-react";
import { Marker, MarkerContent, MarkerIcon } from "../ui/marker";

/**
 * 会话流中部的「模型已切换」分隔线。
 *
 * 只在切换之后真正发出过消息时才出现：sidecar 扫描转录时丢弃「切完还没有
 * 后续消息」的尾部分切换行（见 transcript.ts），发送下一条消息后快照重建
 * 出 modelChange 消息，投影成 data-model-change part（见 messageProjection）。
 */
type ModelChangeData = {
  provider?: string;
  modelId?: string;
  name?: string;
};

function modelLabel(data: ModelChangeData): string {
  if (data.name) return data.name;
  if (data.provider && data.modelId) return `${data.provider}/${data.modelId}`;
  return data.modelId ?? "新的模型";
}

export function ModelChangeBanner({ data }: { data: ModelChangeData }) {
  return (
    // 与上一条消息的操作栏留出呼吸感：分隔线是消息流里独立的视觉停顿
    <div className="my-3">
      <Marker variant="separator">
        <MarkerIcon>
          <ArrowLeftRightIcon className="size-3.5 shrink-0" />
        </MarkerIcon>
        <MarkerContent>已切换到 {modelLabel(data)}</MarkerContent>
      </Marker>
    </div>
  );
}

export const ModelChangeDataUI = makeAssistantDataUI<ModelChangeData>({
  name: "model-change",
  render: ModelChangeBanner,
});
