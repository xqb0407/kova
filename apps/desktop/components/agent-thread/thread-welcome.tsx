"use client";

import { useMemo, type FC } from "react";
import { usePiModels } from "@/lib/pi/pi-models";
import { useModelGate } from "@/lib/pi/pi-model-gate";

/**
 * 新会话欢迎页：一句把当前模型织进去的问候语。
 *
 * 问候语每个时段备了几句、按当日日期轮换（同一天内打开都稳定，隔天换一批），
 * 句中的 {model} 占位替换为当前会话选中的模型显示名（目录未命中退回
 * modelId，还没有模型选择时用「AI」兜底），例如「今晚要在 GLM 完成点什么？」。
 */

const GREETINGS: { from: number; to: number; lines: string[] }[] = [
  {
    from: 5,
    to: 11,
    lines: [
      "早安呀，今天要在 {model} 创造点什么？",
      "早上好，趁脑子清醒，让 {model} 来搭把手？",
      "早安呀，{model} 已就位，想先干哪件正事？",
    ],
  },
  {
    from: 11,
    to: 13,
    lines: [
      "中午好呀，上午告一段落，{model} 接着上？",
      "午安，边吃饭边和 {model} 聊点技术？",
    ],
  },
  {
    from: 13,
    to: 18,
    lines: [
      "下午好呀，接着开工，{model} 随时待命。",
      "下午好，有什么需要 {model} 搭把手的？",
      "午后时光，和 {model} 来点进展？",
    ],
  },
  {
    from: 18,
    to: 22,
    lines: [
      "晚上好呀，今晚要在 {model} 完成点什么？",
      "晚上好，白天没收的尾，让 {model} 陪你收一收？",
    ],
  },
  {
    from: 22,
    to: 5,
    lines: [
      "夜深了，注意休息——{model} 值夜班，有事我顶上",
      "深夜模式：{model} 在线，速战速决，早点睡",
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
    <div className="aui-thread-welcome-root mx-auto mb-6 flex w-full max-w-(--thread-max-width) flex-col items-center gap-2 px-4 text-center">
      <p className="aui-thread-welcome-message-inner fade-in slide-in-from-bottom-1 animate-in fill-mode-both text-2xl font-medium tracking-tight duration-200">
        {greeting}
      </p>
    </div>
  );
};
