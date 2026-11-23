"use client";

import { useCallback, useEffect, useRef, useState, type FC } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SettingRow } from "@/components/custom-ui/setting-row";
import { cn } from "@/lib/utils";
import { useT, type TFunc } from "@/lib/i18n";
import {
  PERSONALIZATION_STYLE_OPTIONS,
  savePersonalization,
  usePersonalization,
  type Personalization,
  type PersonalizationBuiltinStyle,
  type PersonalizationStyle,
} from "@/lib/settings/personalization";
import { useOnboarding } from "../onboarding-flow";
import { StepFooter, StepHeading } from "./step-parts";

/**
 * 个性化：称呼与身份 + 回复风格。写的是「设置 → 个性化」同一份数据
 * （savePersonalization → sidecar kv），改完立刻生效，不用重启。
 *
 * 人设（soul.md）与自定义指令（rules.md）是长 Markdown，铺在引导里会把这一页
 * 撑成表单墙，也不适合一句话回答——只在页脚点一句它们在哪里，其余留给设置页。
 *
 * 风格选项只列内置档位：自定义风格要开弹窗编辑器，在引导这种线性流程里太重。
 * 档位名/描述的词典 key 在 settings.style.<value>.*（引导与设置页共用一份）。
 */

/** 内置档 → 词典 key（渲染点经 t 解析，语言切换即时生效） */
const STYLE_LABEL_KEYS: Record<PersonalizationBuiltinStyle, { label: string; desc: string }> = {
  default: { label: "settings.style.default.label", desc: "settings.style.default.desc" },
  professional: { label: "settings.style.professional.label", desc: "settings.style.professional.desc" },
  friendly: { label: "settings.style.friendly.label", desc: "settings.style.friendly.desc" },
  imaginative: { label: "settings.style.imaginative.label", desc: "settings.style.imaginative.desc" },
  blunt: { label: "settings.style.blunt.label", desc: "settings.style.blunt.desc" },
  guiding: { label: "settings.style.guiding.label", desc: "settings.style.guiding.desc" },
};

/** 完成清单上的一行回顾，说人话（t 由调用方传入，保证用当前语言拼装） */
function summarize(
  t: TFunc,
  userName: string,
  assistantName: string,
  style?: PersonalizationStyle,
): string {
  const bits: string[] = [];
  if (assistantName) bits.push(t("onboarding.personalization.summaryAiName", { name: assistantName }));
  if (userName) bits.push(t("onboarding.personalization.summaryYourName", { name: userName }));
  if (style && style !== "default") {
    const label = STYLE_LABEL_KEYS[style as PersonalizationBuiltinStyle]?.label;
    if (label) bits.push(t("onboarding.personalization.summaryStyleSuffix", { style: t(label) }));
  }
  return bits.join(" · ") || t("onboarding.personalization.summaryFallback");
}

export const PersonalizationStep: FC = () => {
  const { next, back, patch } = useOnboarding();
  const t = useT();
  const prefs = usePersonalization();

  // 草稿：输入框失焦才落盘，避免每敲一个字就发一次 set_personalization
  const [name, setName] = useState({
    userName: prefs.userName,
    assistantName: prefs.assistantName,
  });
  const dirty = useRef(false);
  useEffect(() => {
    if (!dirty.current) {
      setName({ userName: prefs.userName, assistantName: prefs.assistantName });
    }
  }, [prefs]);

  /** 合并当前镜像与草稿；changed 只含本次草稿字段，未改动的身份文件
   *  （让 AI 写入的 rules.md 等）由 sidecar 保留磁盘现值 */
  const persist = useCallback(
    (draft: Partial<Personalization>) =>
      savePersonalization(
        { ...prefs, ...draft },
        Object.keys(draft) as (keyof Personalization)[],
      ).catch(() => {}),
    [prefs],
  );

  const flushNames = useCallback(() => {
    if (!dirty.current) return;
    dirty.current = false;
    const trimmed = {
      userName: name.userName.trim(),
      assistantName: name.assistantName.trim(),
    };
    void persist(trimmed);
    patch("personalization", {
      done: !!trimmed.userName || !!trimmed.assistantName,
      summary: summarize(t, trimmed.userName, trimmed.assistantName),
    });
  }, [name, patch, persist, t]);

  // 卸载兜底：还没失焦就翻页也要把最后敲的内容存下来。
  // 依赖必须放空——flushNames 每次输入都会换身份，直接进依赖会让 React 在依赖
  // 变化时先跑上一版 cleanup，等于每敲一个字符就落盘一次（且写的是旧闭包的值）。
  // 用 ref 始终指向最新实现，只在真正卸载时调用一次。
  const flushRef = useRef(flushNames);
  useEffect(() => {
    flushRef.current = flushNames;
  }, [flushNames]);
  useEffect(() => () => flushRef.current(), []);

  const editName = (key: "userName" | "assistantName", value: string) => {
    dirty.current = true;
    setName((prev) => ({ ...prev, [key]: value }));
  };

  const chooseStyle = (style: PersonalizationStyle) => {
    void persist({ style });
    patch("personalization", {
      done: true,
      summary: summarize(t, name.userName.trim(), name.assistantName.trim(), style),
    });
  };

  return (
    <div className="flex flex-col">
      <StepHeading
        title={t("onboarding.personalization.title")}
        desc={t("onboarding.personalization.desc")}
      />
      <div className="flex flex-col gap-5">
        <div className="bg-muted/50 flex flex-col gap-1 rounded-2xl p-2">
          <SettingRow label={t("onboarding.personalization.yourName")} desc={t("onboarding.personalization.yourNameDesc")}>
            <Input
              className="bg-background w-40"
              placeholder={t("onboarding.personalization.placeholder")}
              value={name.userName}
              onChange={(e) => editName("userName", e.target.value)}
              onBlur={flushNames}
            />
          </SettingRow>
          <SettingRow label={t("onboarding.personalization.aiName")} desc={t("onboarding.personalization.aiNameDesc")}>
            <Input
              className="bg-background w-40"
              placeholder={t("onboarding.personalization.placeholder")}
              value={name.assistantName}
              onChange={(e) => editName("assistantName", e.target.value)}
              onBlur={flushNames}
            />
          </SettingRow>
        </div>

        <div>
          <div className="text-muted-foreground mb-2 text-xs">{t("onboarding.personalization.styleLabel")}</div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {PERSONALIZATION_STYLE_OPTIONS.map((opt) => {
              const active = prefs.style === opt.value;
              const keys = STYLE_LABEL_KEYS[opt.value];
              return (
                <button
                  key={opt.value}
                  type="button"
                  aria-pressed={active}
                  onClick={() => chooseStyle(opt.value)}
                  className={cn(
                    "hover:bg-muted/70 flex flex-col items-start rounded-2xl border px-3 py-2.5 text-left transition-colors",
                    active
                      ? "border-primary/40 bg-muted/60"
                      : "border-transparent",
                  )}
                >
                  <span className="text-sm font-medium">{t(keys.label)}</span>
                  <span className="text-muted-foreground text-xs">
                    {t(keys.desc)}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      </div>

      <StepFooter
        onBack={back}
        onSkip={() => {
          flushNames();
          next();
        }}
      >
        <Button onClick={() => { flushNames(); next(); }}>{t("common.action.next")}</Button>
      </StepFooter>
    </div>
  );
};

