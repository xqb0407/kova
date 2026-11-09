"use client";

import { useEffect, useState, type FC } from "react";
import { SettingRow } from "@/components/custom-ui/setting-row";
import { Input } from "@/components/ui/input";
import { toast } from "@/components/ui/toast";
import { useT } from "@/lib/i18n";
import { normalizeSubagentConcurrencyInput } from "@/lib/pi/subagent-concurrency-input";
import {
  SUBAGENT_MAX_CONCURRENCY_DEFAULT,
  SUBAGENT_MAX_CONCURRENCY_MAX,
  SUBAGENT_MAX_CONCURRENCY_MIN,
  refreshSubagentSettings,
  saveSubagentSettings,
  useSubagentSettings,
} from "@/lib/pi/subagent-settings";

/**
 * 子智能体并发区块（设置 → 智能体 → 智能体配置）。
 *
 * 事实源在 sidecar kv pi.subagentMaxConcurrency；这里只做镜像与输入体验，
 * 保存后 Task/resume 的下一次检查实时读新值，不需要重开会话。
 */
export const SubagentConcurrencySettings: FC = () => {
  const t = useT();
  const settings = useSubagentSettings();
  const [text, setText] = useState(String(settings.maxConcurrency));

  // 设置页挂载时补一次水合：启动早期 sidecar 未就绪时，模块级 init 可能停在默认值
  useEffect(() => {
    void refreshSubagentSettings();
  }, []);

  useEffect(() => {
    setText(String(settings.maxConcurrency));
  }, [settings.maxConcurrency]);

  const commit = () => {
    const next = normalizeSubagentConcurrencyInput(text, settings.maxConcurrency);
    setText(String(next));
    if (next === settings.maxConcurrency) return;
    saveSubagentSettings({ maxConcurrency: next }).catch(() => {
      toast.error(t("settings.agentConfig.saveFailed"));
    });
  };

  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-base font-semibold">{t("settings.subagentConcurrency.title")}</h2>
      <p className="text-muted-foreground text-sm leading-relaxed">
        {t("settings.subagentConcurrency.desc")}
      </p>

      <div className="bg-muted/50 divide-border/40 mt-1 flex flex-col divide-y rounded-2xl p-2">
        <SettingRow
          label={t("settings.subagentConcurrency.max")}
          desc={t("settings.subagentConcurrency.maxDesc", {
            default: SUBAGENT_MAX_CONCURRENCY_DEFAULT,
            min: SUBAGENT_MAX_CONCURRENCY_MIN,
            max: SUBAGENT_MAX_CONCURRENCY_MAX,
          })}
        >
          <div className="bg-background flex h-8 items-center gap-1 rounded-md px-2">
            <Input
              value={text}
              inputMode="numeric"
              onChange={(e) => setText(e.target.value)}
              onBlur={commit}
              onKeyDown={(e) => {
                if (e.key === "Enter") (e.target as HTMLInputElement).blur();
              }}
              className="h-auto w-12 border-none bg-transparent p-0 text-right text-sm rounded-none shadow-none focus-visible:ring-0"
            />
            <span className="text-muted-foreground text-[13px] leading-5">{t("settings.subagentConcurrency.unit")}</span>
          </div>
        </SettingRow>
      </div>

      <p className="text-muted-foreground border-border/50 mt-1  px-1 pt-2 text-[13px] leading-relaxed">
        {t("settings.subagentConcurrency.footer")}
      </p>
    </section>
  );
};
