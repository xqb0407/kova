"use client";

import { useMemo, type FC } from "react";
import { usePiModels } from "@/lib/pi/pi-models";
import { useModelGate } from "@/lib/pi/pi-model-gate";
import { AppModeSwitch } from "./app-mode-switch";

/**
 * 新会话欢迎页：一句把当前模型织进去的问候语。
 *
 * 问候语每个时段备了几句、按当日日期轮换（同一天内打开都稳定，隔天换一批），
 * 句中的 {model} 占位替换为当前会话选中的模型显示名（目录未命中退回
 * modelId，还没有模型选择时用「AI」兜底），例如「下午好，GLM 随时待命。」。
 * 措辞保持克制：一句时段问候 + 模型在位，不玩梗、不替用户安排作息。
 */

const GREETINGS: { from: number; to: number; lines: string[] }[] = [
  {
    from: 5,
    to: 11,
    lines: [
      "早上好，今天想在 {model} 上做点什么？",
      "早上好，{model} 已就绪。",
      "新的一天，{model} 在线待命。",
    ],
  },
  {
    from: 11,
    to: 13,
    lines: [
      "中午好，{model} 在线，随时继续。",
      "午安，有什么想让 {model} 处理的？",
    ],
  },
  {
    from: 13,
    to: 18,
    lines: [
      "下午好，{model} 随时待命。",
      "下午好，有什么需要 {model} 协助的？",
      "继续工作，{model} 在线。",
    ],
  },
  {
    from: 18,
    to: 22,
    lines: [
      "晚上好，今晚想在 {model} 上完成什么？",
      "晚上好，{model} 在线待命。",
    ],
  },
  {
    from: 22,
    to: 5,
    lines: [
      "夜深了，注意休息，{model} 仍在待命。",
      "深夜了，{model} 在线，尽快收工。",
    ],
  },
];

/** 当年第几天（1 起），作为问候语轮换的种子 */
const dayOfYear = (now: Date) => {
  const start = new Date(now.getFullYear(), 0, 0);
  return Math.floor((now.getTime() - start.getTime()) / 86400000);
};

const pickGreeting = (now: Date, model: string) => {
  const hour = now.getHours();
  const slot = GREETINGS.find(
    (s) =>
      s.from < s.to ? hour >= s.from && hour < s.to : hour >= s.from || hour < s.to,
  );
  const lines = slot?.lines ?? GREETINGS[0].lines;
  return lines[dayOfYear(now) % lines.length].replaceAll("{model}", model);
};

export const ThreadWelcome: FC = () => {
  const models = usePiModels();
  // 走闸门那份选择：provider 被删/停用后会话记忆仍指着那个模型，直接展示会是一串
  // 目录里已经不存在的裸 modelId
  const gate = useModelGate();

  // 句子里用的模型名：目录显示名优先（目录异步加载，命中后会从 id 换成显示名）
  const modelName = useMemo(() => {
    const live = gate.selected;
    if (!live) return "AI";
    const hit = models.find(
      (m) => m.provider === live.provider && m.id === live.modelId,
    );
    return hit ? (hit.name || hit.id) : live.modelId;
  }, [models, gate.selected]);

  const greeting = useMemo(() => pickGreeting(new Date(), modelName), [modelName]);

  return (
    // gap-3（12px）：问候语与分段器是两块独立的东西，原来 gap-2（8px）在大一号
    // 的控件下面显得贴在一起，像问候语的一行标签
    <div className="aui-thread-welcome-root mx-auto mb-8 flex w-full max-w-(--thread-max-width) flex-col items-center gap-3 px-4 text-center">
      <p className="aui-thread-welcome-message-inner my-2  fade-in slide-in-from-bottom-1 animate-in fill-mode-both text-3xl font-medium tracking-tight duration-200">
        {greeting}
      </p>
      {/* 会话工作模式切换（编码/工作/设计）：问候语之下、输入框之上——先读到
          问候，再确认自己在哪个档，紧接着开聊。
          语义不变：只作用于本会话，未切过档的跟随设置→通用的全局默认 */}
      <AppModeSwitch />
    </div>
  );
};
