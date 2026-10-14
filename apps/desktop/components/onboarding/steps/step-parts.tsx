"use client";

import type { FC, ReactNode } from "react";
import { Button } from "@/components/ui/button";

/** 步骤标题：小标题 + 一句说明，所有步骤共用（标题可带行内元素，如服务 mark） */
export const StepHeading: FC<{ title: ReactNode; desc?: string }> = ({ title, desc }) => (
  <div className="mb-6">
    <h2 className="text-xl font-semibold tracking-tight">{title}</h2>
    {desc && (
      <p className="text-muted-foreground mt-1.5 text-sm leading-relaxed">{desc}</p>
    )}
  </div>
);

/** 空态 / 不可用提示块 */
export const Notice: FC<{ children: ReactNode }> = ({ children }) => (
  <div className="bg-muted/50 text-muted-foreground rounded-2xl px-4 py-6 text-center text-sm leading-relaxed">
    {children}
  </div>
);

/** 步骤底部导航：左「上一步」，右「下一步」。中间可塞提示或自定义按钮。
 *  onSkip 是「跳过这一节」，与顶栏那个「跳过」（结束整个引导）是两回事：
 *  必填项不传它，可选项都该传——否则没配 Key 的用户会被卡在第一步走不下去。 */
export const StepFooter: FC<{
  onBack?: () => void;
  onSkip?: () => void;
  hint?: string;
  children?: ReactNode;
}> = ({ onBack, onSkip, hint, children }) => (
  <div className="mt-6 flex items-center gap-2">
    {onBack && (
      <Button variant="ghost" onClick={onBack}>
        上一步
      </Button>
    )}
    <div className="flex-1" />
    {hint && <span className="text-muted-foreground text-xs">{hint}</span>}
    {onSkip && (
      <Button variant="ghost" onClick={onSkip}>
        跳过这一步
      </Button>
    )}
    {children}
  </div>
);
