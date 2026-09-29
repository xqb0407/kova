"use client";

import { useCallback, useEffect, useRef, useState, type FC } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SettingRow } from "@/components/custom-ui/setting-row";
import { cn } from "@/lib/utils";
import {
  PERSONALIZATION_STYLE_OPTIONS,
  savePersonalization,
  usePersonalization,
  type Personalization,
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
 */

export const PersonalizationStep: FC = () => {
  const { next, back, patch } = useOnboarding();
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

  /** 合并当前镜像与草稿后整包保存（sidecar 按整包接收） */
  const persist = useCallback(
    (next: Partial<Personalization>) =>
      savePersonalization({ ...prefs, ...next }).catch(() => {}),
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
      summary: summarize(trimmed.userName, trimmed.assistantName),
    });
  }, [name, patch, persist]);

  // 卸载兜底：还没失焦就翻页也要把最后敲的内容存下来
  useEffect(() => () => flushNames(), [flushNames]);

  const editName = (key: "userName" | "assistantName", value: string) => {
    dirty.current = true;
    setName((prev) => ({ ...prev, [key]: value }));
  };

  const chooseStyle = (style: PersonalizationStyle) => {
    void persist({ style });
    patch("personalization", {
      done: true,
      summary: summarize(name.userName.trim(), name.assistantName.trim(), style),
    });
  };

  return (
    <div className="flex flex-col">
      <StepHeading
        title="让它更像你的搭档"
        desc="先定个称呼和语气。人设与自定义指令是长文本，留到「设置 → 个性化」里写更合适。"
      />
      <div className="flex flex-col gap-5">
        <div className="bg-muted/50 flex flex-col gap-1 rounded-2xl p-2">
          <SettingRow label="怎么称呼你" desc="AI 在对话中如何称呼你">
            <Input
              className="bg-background w-40"
              placeholder="留空则不指定"
              value={name.userName}
              onChange={(e) => editName("userName", e.target.value)}
              onBlur={flushNames}
            />
          </SettingRow>
          <SettingRow label="AI 的名称" desc="AI 在对话中使用的名字">
            <Input
              className="bg-background w-40"
              placeholder="留空则不指定"
              value={name.assistantName}
              onChange={(e) => editName("assistantName", e.target.value)}
              onBlur={flushNames}
            />
          </SettingRow>
        </div>

        <div>
          <div className="text-muted-foreground mb-2 text-xs">回复风格</div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {PERSONALIZATION_STYLE_OPTIONS.map((opt) => {
              const active = prefs.style === opt.value;
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
                  <span className="text-sm font-medium">{opt.label}</span>
                  <span className="text-muted-foreground text-xs">
                    {opt.desc}
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
        <Button onClick={() => { flushNames(); next(); }}>下一步</Button>
      </StepFooter>
    </div>
  );
};

/** 完成清单上的一行回顾，说人话 */
function summarize(
  userName: string,
  assistantName: string,
  style?: PersonalizationStyle,
): string {
  const bits: string[] = [];
  if (assistantName) bits.push(`AI 叫 ${assistantName}`);
  if (userName) bits.push(`称呼你为 ${userName}`);
  if (style && style !== "default") {
    const label = PERSONALIZATION_STYLE_OPTIONS.find((o) => o.value === style)?.label;
    if (label) bits.push(`${label}语气`);
  }
  return bits.join(" · ") || "沿用默认称呼与语气";
}

