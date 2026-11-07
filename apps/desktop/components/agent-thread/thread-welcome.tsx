"use client";

import { type FC } from "react";
import { usePersonalization } from "@/lib/settings/personalization";
import { welcomeGreeting } from "@/lib/welcome-greeting";
import { AppModeSwitch } from "./app-mode-switch";

/**
 * 新会话欢迎页：一句简短的时段问候。
 *
 * 时段（早上好 / 中午好 / 下午好 / 晚上好 / 夜深了）+ 设置 →「称呼与身份」
 * 里的称呼和 AI 名称，例如「晚上好，Herther。我是扣瓦」。称呼没填就不点名，
 * AI 名称没填回落 Kova。
 */

export const ThreadWelcome: FC = () => {
  const { userName, assistantName } = usePersonalization();
  const greeting = welcomeGreeting(new Date(), userName, assistantName);

  return (
    // 左对齐，贴住输入框左沿：本容器的盒子与 ViewportFooter（composer 所在）逐字
    // 同款——mx-auto w-full max-w-(--thread-max-width)，且同处在 viewport 的 px-4
    // 之内，所以两者的左沿天然重合。这里不能再补任何水平内边距（哪怕 px-4），
    // 多一层问候语就会比 composer 外壳右移几像素，整列左沿就散了。
    <div className="aui-thread-welcome-root mx-auto mb-8 w-full max-w-(--thread-max-width)">
      {/* 问候语与档位分段器同一行：问候贴左沿、档位靠右沿——宽屏把右侧那片空白
          用起来，欢迎区少占一行、更贴输入框；窄屏放不下时 flex-wrap 折行，
          单独占一行的分段器落在主轴起点（justify-between 对单条行退化为 flex-start），
          自动退回「问候在上、档位在下」的左对齐排法。
          items-center 让两个不同高的东西（30px 字标 / 40px 分段器）居中对齐 */}
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
        <p className="aui-thread-welcome-message-inner my-2  fade-in slide-in-from-bottom-1 animate-in fill-mode-both text-3xl font-medium tracking-tight duration-200">
          {greeting}
        </p>
        {/* 会话工作模式切换（编码/工作/设计）：与问候语同排、贴着输入框上沿——
            先读到问候，再确认自己在哪个档，紧接着开聊。
            语义不变：只作用于本会话，未切过档的跟随设置→通用的全局默认 */}
        <AppModeSwitch />
      </div>
    </div>
  );
};
