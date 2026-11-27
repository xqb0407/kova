"use client";

/**
 * 排期表单共享件：编辑器的初始排期（新建任务）与触发器管理里编辑
 * schedule 触发器（统一触发模型 P1）复用同一套档位/输入/预览。
 *
 * 档位不直接暴露 cron 语法：每天/每周/每月三档预设拼表达式，"自定义"档开
 * 结构化编辑器（custom-ui/cron-editor）；改动防抖拉 automation_preview
 * （sidecar 真算，本地时区），下几次触发时刻与调度器判定完全同源。
 */

import { useCallback, useEffect, useMemo, useState, type FC } from "react";
import { Loader2Icon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { CronEditor } from "@/components/custom-ui/cron-editor";
import { DateTimePicker } from "@/components/custom-ui/date-time-picker";
import { TimePicker } from "@/components/custom-ui/time-picker";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  cronToPreset,
  formatDateTime,
  parseIntervalSeconds,
  presetToCron,
} from "@/lib/automation/automation-format";
import { previewAutomationSchedule } from "@/lib/automation/automations";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n";

export type FreqMode = "daily" | "weekly" | "monthly" | "interval" | "once" | "cron";

const FREQ_LABEL_KEYS: { mode: FreqMode; labelKey: string }[] = [
  { mode: "daily", labelKey: "automation.editor.freqDaily" },
  { mode: "weekly", labelKey: "automation.editor.freqWeekly" },
  { mode: "monthly", labelKey: "automation.editor.freqMonthly" },
  { mode: "interval", labelKey: "automation.editor.freqInterval" },
  { mode: "once", labelKey: "automation.editor.freqOnce" },
  { mode: "cron", labelKey: "automation.editor.freqCron" },
];

export const WEEKDAY_SHORT_KEYS = [
  "weekdayShortSun",
  "weekdayShortMon",
  "weekdayShortTue",
  "weekdayShortWed",
  "weekdayShortThu",
  "weekdayShortFri",
  "weekdayShortSat",
] as const;
export const WEEKDAY_FULL_KEYS = [
  "weekdaySun",
  "weekdayMon",
  "weekdayTue",
  "weekdayWed",
  "weekdayThu",
  "weekdayFri",
  "weekdaySat",
] as const;

export type ScheduleFormState = {
  mode: FreqMode;
  time: string;
  days: number[];
  monthDay: number;
  intervalN: number;
  intervalUnit: "s" | "m" | "h" | "d";
  onceValue: string;
  cronExpr: string;
};

/** 排期来源：已有任务记录或预置模板（两者字段形态一致，模板无 intervalSeconds 时回退解析文本） */
export type ScheduleSource = {
  type: "cron" | "once" | "interval";
  schedule: string;
  intervalSeconds?: number;
};

/** ISO → "YYYY-MM-DDTHH:mm"（datetime-local 控件按本地时区取值） */
function toLocalInputValue(iso: string | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** once 的相对形态（模板 "+1d"）→ 此刻起算的 ISO；绝对 ISO 原样返回。
 *  （sidecar 保存时也对相对形态按当时时刻解析，这里仅为表单可视） */
function resolveOnceSchedule(schedule: string): string {
  const m = /^(\d+)(s|m|h|d)$/.exec(schedule.trim());
  if (!m || !m[1] || !m[2]) return schedule;
  const mult = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] as "s" | "m" | "h" | "d"];
  return new Date(Date.now() + Number(m[1]) * mult).toISOString();
}

/** 从排期来源反推表单初始频率态 */
export function initScheduleState(source: ScheduleSource | null): ScheduleFormState {
  const base: ScheduleFormState = {
    mode: "daily",
    time: "09:00",
    days: [1, 2, 3, 4, 5],
    monthDay: 1,
    intervalN: 60,
    intervalUnit: "m",
    onceValue: "",
    cronExpr: "0 9 * * *",
  };
  if (!source) return base;
  if (source.type === "interval") {
    const s = source.intervalSeconds ?? parseIntervalSeconds(source.schedule) ?? 60;
    const unit = s % 86400 === 0 ? "d" : s % 3600 === 0 ? "h" : s % 60 === 0 ? "m" : "s";
    const mult = { s: 1, m: 60, h: 3600, d: 86400 }[unit];
    return { ...base, mode: "interval", intervalN: Math.round(s / mult), intervalUnit: unit };
  }
  if (source.type === "once") {
    return {
      ...base,
      mode: "once",
      onceValue: toLocalInputValue(resolveOnceSchedule(source.schedule)),
    };
  }
  const p = cronToPreset(source.schedule);
  const hhmm = (h: number, m: number) =>
    `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
  switch (p.mode) {
    case "daily":
      return { ...base, mode: "daily", time: hhmm(p.hour, p.minute) };
    case "weekly":
      return { ...base, mode: "weekly", time: hhmm(p.hour, p.minute), days: p.days };
    case "monthly":
      return { ...base, mode: "monthly", time: hhmm(p.hour, p.minute), monthDay: p.day };
    default:
      return { ...base, mode: "cron", cronExpr: source.schedule };
  }
}

/** 组装排期字符串（与 sidecar 三种 schedule 形态一一对应）；表单未填完整返回 null */
export function buildSchedule(
  s: ScheduleFormState,
): { type: "cron" | "once" | "interval"; schedule: string } | null {
  const [hRaw, mRaw] = s.time.split(":");
  const h = Number(hRaw);
  const m = Number(mRaw);
  switch (s.mode) {
    case "daily":
      return { type: "cron", schedule: presetToCron({ mode: "daily", hour: h, minute: m }) };
    case "weekly":
      if (s.days.length === 0) return null;
      return {
        type: "cron",
        schedule: presetToCron({ mode: "weekly", hour: h, minute: m, days: s.days }),
      };
    case "monthly":
      return {
        type: "cron",
        schedule: presetToCron({ mode: "monthly", hour: h, minute: m, day: s.monthDay }),
      };
    case "interval": {
      const n = Math.max(1, Math.round(s.intervalN));
      return { type: "interval", schedule: `${n}${s.intervalUnit}` };
    }
    case "once":
      if (!s.onceValue) return null;
      return { type: "once", schedule: new Date(s.onceValue).toISOString() };
    case "cron":
      return { type: "cron", schedule: s.cronExpr };
  }
}

/** 排期表单状态 hook：state/built/防抖预览一处持有（编辑器与触发器管理共用） */
export function useScheduleForm(initial: ScheduleSource | null) {
  const [state, setStateRaw] = useState<ScheduleFormState>(() => initScheduleState(initial));
  // patch 合并语义（传完整对象也等价于整体重置）
  const setState = useCallback(
    (patch: Partial<ScheduleFormState>) => setStateRaw((prev) => ({ ...prev, ...patch })),
    [],
  );
  const built = useMemo(() => buildSchedule(state), [state]);
  const [preview, setPreview] = useState<{ runs: string[] } | { error: string } | null>(null);

  // 防抖排期预览：下几次触发时刻由 sidecar 计算（与调度器同源同本地时区）
  const previewKey = built ? `${built.type}:${built.schedule}` : "";
  useEffect(() => {
    if (!built) {
      setPreview(null);
      return;
    }
    let cancelled = false;
    const id = setTimeout(() => {
      void previewAutomationSchedule({ type: built.type, schedule: built.schedule, count: 3 }).then(
        (r) => {
          if (!cancelled) setPreview(r);
        },
      );
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewKey]);

  return { state, setState, built, preview };
}

/** 档位按钮 + 按档位出现的输入行（时刻/星期/几号/间隔/一次性/自定义） */
export const ScheduleFields: FC<{
  state: ScheduleFormState;
  setState: (patch: Partial<ScheduleFormState>) => void;
  /** 切进「自定义」时种当前预设表达式用（两档位各持状态，不种会看到陈旧 cronExpr） */
  built: { type: "cron" | "once" | "interval"; schedule: string } | null;
}> = ({ state, setState, built }) => {
  const t = useT();
  return (
    <>
      <div className="flex flex-wrap gap-1">
        {FREQ_LABEL_KEYS.map((f) => (
          <Button
            key={f.mode}
            type="button"
            size="sm"
            variant={state.mode === f.mode ? "secondary" : "outline"}
            className={cn("h-7 px-3 text-xs", state.mode === f.mode && "bg-selected")}
            onClick={() => {
              // 切进「自定义」时把当前预设拼出的表达式种进编辑器：两个档位
              // 各自持有状态，不种的话「每天 18:00 → 自定义」会看到陈旧的
              // cronExpr。interval/once 拼不出 cron，保持原值不动。
              if (f.mode === "cron" && built?.type === "cron") {
                setState({ cronExpr: built.schedule, mode: "cron" });
              } else {
                setState({ mode: f.mode });
              }
            }}
          >
            {t(f.labelKey)}
          </Button>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-2 pt-1">
        {(state.mode === "daily" || state.mode === "weekly" || state.mode === "monthly") && (
          <TimePicker
            value={state.time}
            onChange={(time) => setState({ time })}
            aria-label={t("automation.editor.timeAria")}
          />
        )}
        {state.mode === "weekly" && (
          <div className="flex items-center gap-1">
            {WEEKDAY_SHORT_KEYS.map((key, i) => (
              <Button
                key={key}
                type="button"
                size="icon"
                variant={state.days.includes(i) ? "secondary" : "ghost"}
                className={cn("size-7 text-xs", state.days.includes(i) && "bg-selected")}
                onClick={() =>
                  setState({
                    days: state.days.includes(i)
                      ? state.days.filter((d) => d !== i).sort()
                      : [...state.days, i].sort(),
                  })
                }
                aria-label={t("automation.editor.weekdayAria", {
                  day: t(`automation.cron.${WEEKDAY_FULL_KEYS[i]!}`),
                })}
              >
                {t(`automation.cron.${key}`)}
              </Button>
            ))}
          </div>
        )}
        {state.mode === "monthly" && (
          <Select
            value={String(state.monthDay)}
            onValueChange={(v) => v && setState({ monthDay: Number(v) })}
          >
            <SelectTrigger size="sm" className="w-28 border bg-background">
              <SelectValue>{t("automation.editor.monthlyDay", { day: state.monthDay })}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {Array.from({ length: 31 }, (_, i) => i + 1).map((d) => (
                <SelectItem key={d} value={String(d)}>
                  {t("automation.editor.monthlyDay", { day: d })}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        {state.mode === "interval" && (
          <>
            <Input
              type="number"
              min={1}
              value={String(state.intervalN)}
              onChange={(e) => setState({ intervalN: Number(e.target.value) || 1 })}
              className="w-20"
              aria-label={t("automation.editor.intervalValueAria")}
            />
            <Select
              value={state.intervalUnit}
              onValueChange={(v) => v && setState({ intervalUnit: v as "s" | "m" | "h" | "d" })}
            >
              <SelectTrigger size="sm" className="w-24 border bg-background">
                <SelectValue>
                  {t(
                    `automation.editor.unit${
                      { s: "Second", m: "Minute", h: "Hour", d: "Day" }[state.intervalUnit]
                    }`,
                  )}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="s">{t("automation.editor.unitSecond")}</SelectItem>
                <SelectItem value="m">{t("automation.editor.unitMinute")}</SelectItem>
                <SelectItem value="h">{t("automation.editor.unitHour")}</SelectItem>
                <SelectItem value="d">{t("automation.editor.unitDay")}</SelectItem>
              </SelectContent>
            </Select>
          </>
        )}
        {state.mode === "once" && (
          <>
            <DateTimePicker
              value={state.onceValue}
              onChange={(onceValue) => setState({ onceValue })}
              aria-label={t("automation.editor.onceAria")}
            />
            <div className="flex gap-1">
              {[
                { labelKey: "automation.editor.quick10m", ms: 10 * 60_000 },
                { labelKey: "automation.editor.quick1h", ms: 3_600_000 },
                { labelKey: "automation.editor.quickTomorrow", ms: 24 * 3_600_000 },
              ].map((q) => (
                <Button
                  key={q.labelKey}
                  type="button"
                  size="sm"
                  variant="outline"
                  className="h-6 px-2 text-xs"
                  onClick={() =>
                    setState({ onceValue: toLocalInputValue(new Date(Date.now() + q.ms).toISOString()) })
                  }
                >
                  {t(q.labelKey)}
                </Button>
              ))}
            </div>
          </>
        )}
        {state.mode === "cron" && (
          <CronEditor
            value={state.cronExpr}
            onChange={(cronExpr) => setState({ cronExpr })}
            className="w-full"
          />
        )}
      </div>
    </>
  );
};

/** 预览框：sidecar 真算的下三次触发（croner 本地时区），非法排期红字提示 */
export const SchedulePreviewBox: FC<{
  built: { type: "cron" | "once" | "interval"; schedule: string } | null;
  preview: { runs: string[] } | { error: string } | null;
  /** built===null（表单未填完整）时的占位文案；按档位由调用方给 */
  emptyKey?: string;
}> = ({ built, preview, emptyKey }) => {
  const t = useT();
  return (
    <div className="text-muted-foreground bg-muted/50 rounded-lg px-3 py-2 text-xs">
      {built === null ? (
        t(emptyKey ?? "automation.editor.previewNeedDay")
      ) : preview === null ? (
        <span className="flex items-center gap-1.5">
          <Loader2Icon className="size-3 animate-spin" />
          {t("automation.editor.previewCalculating")}
        </span>
      ) : "error" in preview ? (
        <span className="text-red-500">{preview.error}</span>
      ) : (
        <div className="flex flex-col gap-0.5">
          <span>{t("automation.editor.previewRuns")}</span>
          {preview.runs.map((r) => (
            <span key={r}>{formatDateTime(r)}</span>
          ))}
        </div>
      )}
    </div>
  );
};
