"use client";

import type { FC } from "react";
import Image from "next/image";
import { Button } from "@/components/ui/button";
import logo from "@/public/favicon/icon.png";
import { ONBOARDING_SECTIONS } from "../onboarding-sections";
import { useOnboarding } from "../onboarding-flow";

/**
 * 欢迎页：左侧主标与行动，右侧是即将做的几件事。
 *
 * 之前的版本是「图标方块 + 一行标题 + 一行灰字 + 两个按钮 + 三栏能力条」——
 * 这正是各种生成式界面都长成的样子，所以一眼就是 demo。真正让它像产品的是
 * 版面本身：不对称的双栏，中间一道竖细线，右侧当作目录用竖排而不是横排，
 * 因为横排三栏会把几件事压成同一优先级、也更像功能罗列。竖排配序号之后，
 * 它们才读作「接下来要走的几步」。
 *
 * 目录条目来自 ONBOARDING_SECTIONS，不在这里另抄一份——加分区时欢迎页自动跟着变。
 */

export const WelcomeStep: FC = () => {
  const { next, finish } = useOnboarding();

  return (
    <div className="grid gap-10 sm:grid-cols-[1.2fr_0.8fr] sm:gap-12">
      <div className="flex flex-col">
        <Image
          src={logo}
          alt="Kova"
          width={32}
          height={32}
          className="size-8 dark:hue-rotate-180 dark:invert"
          priority
        />

        <h1 className="mt-9 text-4xl font-semibold tracking-tight">
          两分钟，配好就能开工
        </h1>
        <p className="text-muted-foreground mt-4 max-w-[32ch] text-base leading-relaxed">
          Kova 跑在你本机，用你自己的模型服务。
        </p>

        <div className="mt-10 flex items-center gap-2">
          <Button size="lg" onClick={next}>
            开始配置
          </Button>
          <Button size="lg" variant="ghost" onClick={finish}>
            稍后再说
          </Button>
        </div>
      </div>

      {/* 竖细线当分隔，右栏读作目录而非并列的卖点 */}
      <ol className="border-border/60 flex flex-col gap-7 border-l pl-8 sm:pt-1">
        {ONBOARDING_SECTIONS.map((step, i) => (
          <li key={step.title} className="flex gap-4">
            <span className="text-muted-foreground/60 w-4 shrink-0 text-sm tabular-nums">
              {i + 1}
            </span>
            <div className="flex flex-col gap-1">
              <span className="text-sm font-medium">{step.title}</span>
              <span className="text-muted-foreground text-xs leading-relaxed">
                {step.desc}
              </span>
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
};
