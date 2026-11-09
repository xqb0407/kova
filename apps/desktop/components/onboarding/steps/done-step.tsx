"use client";

import type { FC, ReactNode } from "react";
import Image from "next/image";
import { Button } from "@/components/ui/button";
import { useT } from "@/lib/i18n";
import logo from "@/public/favicon/icon.png";
import { ONBOARDING_SECTIONS } from "../onboarding-sections";
import { useOnboarding } from "../onboarding-flow";
import { CheckIcon, CircleIcon, SparklesIcon } from "lucide-react";

/**
 * 完成页：按 ONBOARDING_SECTIONS 逐条回顾这次配了什么，并给一条「接下来干什么」
 * 的具体建议——跳过的项照实显示为未配置，而不是当作已完成。
 *
 * 条目不写死：清单加一节，这里自动多一行。文案走词典 key（语言切换即时生效）。
 */
export const DoneStep: FC = () => {
  const { results, finish, back } = useOnboarding();
  const t = useT();

  return (
    <div className="flex flex-col items-center text-center">
      <Image
        src={logo}
        alt="Kova"
        width={64}
        height={64}
        className="size-14 dark:hue-rotate-180 dark:invert"
      />
      <h1 className="mt-4 text-2xl font-semibold tracking-tight">
        {t("onboarding.done.title")}
      </h1>
      <p className="text-muted-foreground mt-1.5 text-sm">
        {t("onboarding.done.subtitle")}
      </p>

      <div className="mt-7 w-full">
        <ul className="flex flex-col gap-1.5">
          {ONBOARDING_SECTIONS.map((section) => {
            const result = results[section.id];
            const done = !!result?.done;
            const title = t(section.titleKey);
            return (
              <Row key={section.id} done={done}>
                {done
                  ? t("onboarding.done.rowDone", {
                      title,
                      summary: result?.summary ?? t("common.state.configured"),
                    })
                  : t("onboarding.done.rowMissing", {
                      title,
                      missing: t(section.missingKey),
                    })}
              </Row>
            );
          })}
        </ul>
      </div>

      <div className="bg-muted/50 mt-6 flex w-full items-start gap-2.5 rounded-2xl p-4 text-left">
        <SparklesIcon className="text-muted-foreground mt-0.5 size-4 shrink-0" />
        <p className="text-muted-foreground text-xs leading-relaxed">
          {t("onboarding.done.tipLead")}
          <Kbd>/</Kbd>
          {t("onboarding.done.tipTrail")}
        </p>
      </div>

      <div className="mt-7 flex items-center gap-2">
        <Button size="lg" onClick={finish}>
          {t("onboarding.done.start")}
        </Button>
        <Button size="lg" variant="ghost" onClick={back}>
          {t("onboarding.done.back")}
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
  <kbd className="bg-background text-foreground rounded border px-1 py-0.5 font-mono text-3xs">
    {children}
  </kbd>
);
