"use client";

import type { FC } from "react";

const getGreeting = () => {
  const hour = new Date().getHours();
  if (hour >= 5 && hour < 11) return "早安呀，新的一天开始了，接下去让我来发挥";
  if (hour >= 11 && hour < 13) return "中午好呀，接下去让我来发挥";
  if (hour >= 13 && hour < 18) return "下午好呀，接下去让我来发挥";
  if (hour >= 18 && hour < 22) return "晚上好呀，接下去让我来发挥";
  return "夜深了，注意休息，接下去让我来发挥";
};

export const ThreadWelcome: FC = () => {
  const greeting = getGreeting();
  return (
    <div className="aui-thread-welcome-root mx-auto mb-6 flex w-full max-w-(--thread-max-width) flex-col items-center px-4 text-center">
      <p className="aui-thread-welcome-message-inner fade-in slide-in-from-bottom-1 animate-in fill-mode-both text-2xl font-medium tracking-tight duration-200">
        {greeting}
      </p>
    </div>
  );
};