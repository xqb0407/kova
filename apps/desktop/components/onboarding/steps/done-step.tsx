"use client";

import type { FC, ReactNode } from "react";
import Image from "next/image";
import { Button } from "@/components/ui/button";
import logo from "@/public/favicon/icon.png";
import { ONBOARDING_SECTIONS } from "../onboarding-sections";
import { useOnboarding } from "../onboarding-flow";
import { CheckIcon, CircleIcon, SparklesIcon } from "lucide-react";

/**
 * 完成页：按 ONBOARDING_SECTIONS 逐条回顾这次配了什么，并给一条「接下来干什么」
 * 的具体建议——跳过的项照实显示为未配置，而不是当作已完成。
 *
 * 条目不写死：清单加一节，这里自动多一行。
 */
export const DoneStep: FC = () => {
  const { results, finish, back } = useOnboarding();

  return (
    <div className="flex flex-col items-center text-center">
      <Image
        src={logo}
        alt="Kova"
        width={64}
        height={64}
        className="size-14 dark:hue-rotate-180 dark:invert"
      />
      <h1 className="mt-4 text-2xl font-semibold tracking-tight">配置好了</h1>
      <p className="text-muted-foreground mt-1.5 text-sm">
        随时可以在设置里改，接下来就交给你了。
      </p>

      <div className="mt-7 w-full">
        <ul className="flex flex-col gap-1.5">
          {ONBOARDING_SECTIONS.map((section) => {
            const result = results[section.id];
            const done = !!result?.done;
            return (
              <Row key={section.id} done={done}>
                {done
                  ? `${section.title} · ${result?.summary ?? "已配置"}`
                  : `${section.title}未配置 —— ${section.missing}`}
              </Row>
            );
          })}
        </ul>
      </div>

      <div className="bg-muted/50 mt-6 flex w-full items-start gap-2.5 rounded-2xl p-4 text-left">
        <SparklesIcon className="text-muted-foreground mt-0.5 size-4 shrink-0" />
        <p className="text-muted-foreground text-xs leading-relaxed">
          {"试试直接在输入框里说「帮我看看这个项目怎么跑起来」，或者按 "}
          <Kbd>/</Kbd>
          {" 用斜杠命令。想知道还有哪些能力，侧边栏的插件市场和技能管理值得逛逛。"}
        </p>
      </div>

      <div className="mt-7 flex items-center gap-2">
        <Button size="lg" onClick={finish}>
          开始使用
        </Button>
        <Button size="lg" variant="ghost" onClick={back}>
          回去改改
        </Button>
      </div>
    </div>
  );
};

/** 完成清单的一行：配好了打勾，没配显示空心圈（不粉饰） */
const Row: FC<{ done: boolean; children: ReactNode }> = ({ done, children }) => (
  <li className="flex items-center gap-2.5 rounded-xl px-3 py-2 text-left text-sm">
    {done ? (
      <CheckIcon className="text-primary size-4 shrink-0" />
    ) : (
      <CircleIcon className="text-muted-foreground/50 size-4 shrink-0" />
    )}
    <span className={done ? "" : "text-muted-foreground"}>{children}</span>
  </li>
);

/** 行内按键提示 */
const Kbd: FC<{ children: ReactNode }> = ({ children }) => (
  <kbd className="bg-background text-foreground rounded border px-1 py-0.5 font-mono text-[10px]">
    {children}
  </kbd>
);
