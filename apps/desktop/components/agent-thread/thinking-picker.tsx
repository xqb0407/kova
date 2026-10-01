"use client";

import { useEffect, useState, type FC } from "react";
import { BrainIcon, CheckIcon } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useAuiState } from "@assistant-ui/react";
import { usePiModels } from "@/lib/pi/pi-models";
import { useThreadModel } from "@/lib/pi/pi-session-model";
import {
  hydrateThreadThinking,
  setThreadThinking,
  useThreadThinking,
} from "@/lib/pi/pi-session-thinking";
import { setThinkingLevel, type ThinkingLevel } from "@/lib/settings/thinking-settings";
import { useSendLock } from "@/lib/pi/pi-send-lock";
import { cn } from "@/lib/utils";

/**
 * 深度思考档位选择器（composer 区，模型选择器右侧）：点开下拉选档，
 * 档位名对齐 pi-kova 中文文案。当前模型的可用档位由目录的
 * supportedThinkingLevels（pi-ai 按 reasoning + thinkingLevelMap 推导）
 * 决定，不支持的档位直接不渲染（不是置灰）；完全不支持推理的模型菜单里
 * 只剩「关闭」，触发器 title 提示去 设置→模型 配置。
 * 会话级记忆：选择经定靶 set_thinking 只落当前会话（转录行 + 偏好列），
 * 切回会话时恢复该会话上次档位；无记忆的会话回落默认档位（设置页配置）。
 * 未发送草稿只记内存，首条发送建会话后由 flush 落库（见 pi-session-thinking）。
 * 发送锁（useSendLock）：消息发送完成前（在跑/排队待派发）禁止改档位，
 * 见 pi-send-lock 头注。
 */
const LEVEL_OPTIONS: { value: ThinkingLevel; label: string }[] = [
  { value: "off", label: "关闭" },
  { value: "minimal", label: "最小" },
  { value: "low", label: "轻度" },
  { value: "medium", label: "中" },
  { value: "high", label: "高" },
  { value: "xhigh", label: "很高" },
  { value: "max", label: "最高" },
];

export const ThinkingPicker: FC = () => {
  const threadId = useAuiState((s) => s.threads.mainThreadId);
  const level = useThreadThinking(threadId);
  const sendLocked = useSendLock();
  const models = usePiModels();
  const selected = useThreadModel(threadId);
  const [open, setOpen] = useState(false);

  // 切线程时水合该会话记住的档位（无记忆则回落默认档位）
  useEffect(() => {
    if (!threadId) return;
    hydrateThreadThinking(threadId);
  }, [threadId]);

  const info = selected
    ? models.find(
        (m) => m.provider === selected.provider && m.id === selected.modelId,
      )
    : undefined;
  // undefined = 目录未加载/模型未知 → 全档可点；数组 = 支持档位（不含 off，空 = 明确不支持）
  const supported = info?.supportedThinkingLevels;
  const selectable = (v: ThinkingLevel) =>
    v === "off" || (supported ? supported.includes(v) : true);

  const on = level !== "off";
  const currentLabel = on
    ? (LEVEL_OPTIONS.find((o) => o.value === level)?.label ?? level)
    : null;
  const title = sendLocked
    ? "消息发送完成前禁止调整思考档位"
    : supported && supported.length === 0
      ? "深度思考：当前模型未标记支持推理（可在 设置→模型 勾选）"
      : `深度思考：${currentLabel ?? "关闭"}`;

  const pick = (v: ThinkingLevel) => {
    setOpen(false);
    if (sendLocked || v === level) return;
    if (threadId) {
      void setThreadThinking(threadId, v);
    } else {
      // 无主线程上下文（理论不可达）：退化为纯默认档位变更
      void setThinkingLevel(v);
    }
  };

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger
        render={
          <button
            type="button"
            data-slot="aui-composer-thinking"
            aria-label="Select thinking effort"
            title={title}
            disabled={sendLocked}
            className={cn(
              "inline-flex h-7 items-center gap-1 rounded-full px-2.5 text-sm transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50",
              on
                ? "bg-primary/10 text-primary hover:bg-primary/15"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            <BrainIcon className="size-3.5 shrink-0" />
            {currentLabel && <span>{currentLabel}</span>}
          </button>
        }
      />
      <DropdownMenuContent align="end" className="w-40 p-1">
        <DropdownMenuGroup>
          <DropdownMenuLabel>思考强度</DropdownMenuLabel>
          {/* 不支持的档位不置灰、直接不渲染；模型未知（目录未加载）时全档保留 */}
          {LEVEL_OPTIONS.filter((o) => selectable(o.value)).map((o) => (
            <DropdownMenuItem
              key={o.value}
              onClick={() => pick(o.value)}
              className="gap-2 py-1.5"
            >
              <span className="min-w-0 flex-1">{o.label}</span>
              {o.value === level && (
                <CheckIcon className="size-4 shrink-0" />
              )}
            </DropdownMenuItem>
          ))}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
};
