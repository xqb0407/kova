"use client";

/**
 * Cron 表达式编辑器（custom-ui）：五段表达式条 + 人话摘要 + 按字段展开的结构化面板。
 *
 * 状态模型：父级的 value 是唯一事实，内部解析成每字段的 CronField；编辑先落内部
 * 状态，能序列化出完整表达式才向父级回吐（「指定」清空这类中间态只在本地提示，
 * 父级拿不到半截表达式）。语义合法性（这个排期真能跑）以 sidecar preview 为准。
 *
 * 滑块刻意不用 framer 的 layoutId 共享布局：dialog 按内容高度垂直居中，展开面板会
 * 让内容在视口里重定位，framer 的投影会把祖先位移回放成滑块飞行（ui/tabs 与
 * custom-ui/segmented 的同款坑）。这里沿用 segmented 的常驻指示器 + 容器系坐标 +
 * CSS transition；面板展开、换字这类不涉及布局投影的动效才交给 framer。
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type FC,
  type ReactNode,
} from "react";
import { AnimatePresence, motion, useReducedMotion, type Variants } from "framer-motion";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Segmented, type SegmentedOption } from "@/components/custom-ui/segmented";
import { describeCron } from "@/lib/automation/automation-format";
import { useT, type TFunc } from "@/lib/i18n";
import {
  CRON_FIELD_SEQUENCE,
  CRON_MODE_LABEL_KEYS,
  cronFieldSpec,
  DEFAULT_CRON_FIELDS,
  expandRange,
  parseCron,
  serializeCron,
  serializeCronField,
  switchFieldMode,
  type CronField,
  type CronFieldKey,
  type CronFieldMode,
  type CronFields,
} from "@/lib/automation/cron-fields";
import { EASE_OUT } from "@/lib/motion/ease";
import { cn } from "@/lib/utils";

/** chip 网格列数：分钟 60 颗窄窗 6 列排 10 行、sm 起 12 列排 5 行，星期/月份一行一个词。
 *  列数带断点是因为弹窗窄于 ~430px 时 12 列的 chip 会被压到 20px 以下（数字放不下），
 *  而头部 Segmented 本身有 ~250px 最小宽度，窄窗必然存在 */
const FIELD_UI: Record<CronFieldKey, { pad: boolean; cols: string }> = {
  minute: { pad: true, cols: "grid-cols-6 sm:grid-cols-12" },
  hour: { pad: true, cols: "grid-cols-6 sm:grid-cols-12" },
  dom: { pad: false, cols: "grid-cols-4 sm:grid-cols-8" },
  month: { pad: false, cols: "grid-cols-6" },
  dow: { pad: false, cols: "grid-cols-7" },
};

const DOW_SHORT_KEY = [
  "weekdayShortSun",
  "weekdayShortMon",
  "weekdayShortTue",
  "weekdayShortWed",
  "weekdayShortThu",
  "weekdayShortFri",
  "weekdayShortSat",
] as const;
const DOW_FULL_KEY = [
  "weekdaySun",
  "weekdayMon",
  "weekdayTue",
  "weekdayWed",
  "weekdayThu",
  "weekdayFri",
  "weekdaySat",
] as const;

const EVERY_HINT_KEY: Record<CronFieldKey, string> = {
  minute: "automation.cron.hintEveryMinute",
  hour: "automation.cron.hintEveryHour",
  dom: "automation.cron.hintEveryDom",
  month: "automation.cron.hintEveryMonth",
  dow: "automation.cron.hintEveryDow",
};

/** chip 上的短文案（网格对齐优先） */
function chipLabel(t: TFunc, key: CronFieldKey, v: number): string {
  if (key === "dow") return t(`automation.cron.${DOW_SHORT_KEY[v % 7]!}`);
  if (key === "month") return String(v);
  return FIELD_UI[key].pad ? String(v).padStart(2, "0") : String(v);
}

/** 下拉选项与提示里的带量词文案 */
function optionLabel(t: TFunc, key: CronFieldKey, v: number): string {
  if (key === "dow") return t(`automation.cron.${DOW_FULL_KEY[v % 7]!}`);
  if (key === "month") return t("automation.cron.monthOption", { n: v });
  if (key === "dom") return t("automation.cron.dayOption", { n: v });
  return chipLabel(t, key, v);
}

/** 换字动效：旧字上浮模糊退场、新字自下带模糊落位（同 animated-badge 的字滚） */
const ROLL_VARIANTS: Variants = {
  initial: { opacity: 0.72, y: "72%", filter: "blur(5px)" },
  animate: {
    opacity: 1,
    y: "0%",
    filter: "blur(0px)",
    transition: {
      y: { type: "spring", stiffness: 340, damping: 28, mass: 0.7 },
      opacity: { duration: 0.24, ease: EASE_OUT },
      filter: { duration: 0.34, ease: EASE_OUT },
    },
  },
  exit: {
    opacity: 0.4,
    y: "-72%",
    filter: "blur(5px)",
    transition: { duration: 0.18, ease: EASE_OUT },
  },
};

const RollText: FC<{ text: string; className?: string; title?: string }> = ({
  text,
  className,
  title,
}) => {
  const reduce = useReducedMotion();
  return (
    <span title={title} className={cn("relative inline-flex min-w-0 overflow-hidden", className)}>
      <AnimatePresence mode="popLayout" initial={false}>
        <motion.span
          key={text}
          variants={ROLL_VARIANTS}
          initial={reduce ? false : "initial"}
          animate={reduce ? { opacity: 1 } : "animate"}
          exit={reduce ? undefined : "exit"}
          className="inline-block whitespace-nowrap will-change-transform"
        >
          {text}
        </motion.span>
      </AnimatePresence>
    </span>
  );
};

const Chip: FC<{ selected: boolean; onToggle: () => void; children: ReactNode }> = ({
  selected,
  onToggle,
  children,
}) => (
  <button
    type="button"
    aria-pressed={selected}
    onClick={onToggle}
    className={cn(
      "h-6 rounded-md border text-xs tabular-nums",
      "motion-safe:transition-[color,background-color,border-color,transform] motion-safe:duration-150",
      "motion-safe:enabled:active:scale-[0.96]",
      selected
        ? "border-primary/35 bg-primary/15 text-foreground font-medium"
        : "border-transparent bg-background/60 text-muted-foreground hover:bg-hover hover:text-foreground",
    )}
  >
    {children}
  </button>
);

const ValueSelect: FC<{
  fieldKey: CronFieldKey;
  value: number;
  values: number[];
  onChange: (v: number) => void;
}> = ({ fieldKey, value, values, onChange }) => {
  const t = useT();
  return (
    <Select value={String(value)} onValueChange={(v) => v && onChange(Number(v))}>
      <SelectTrigger size="sm" className="bg-background w-24 border">
        <SelectValue>{optionLabel(t, fieldKey, value)}</SelectValue>
      </SelectTrigger>
      <SelectContent>
        {values.map((v) => (
          <SelectItem key={v} value={String(v)}>
            {optionLabel(t, fieldKey, v)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
};

const FieldPanel: FC<{
  fieldKey: CronFieldKey;
  field: CronField;
  onFieldChange: (next: CronField) => void;
}> = ({ fieldKey, field, onFieldChange }) => {
  const t = useT();
  const spec = cronFieldSpec(fieldKey);
  const label = t(spec.labelKey);
  const unit = t(spec.unitKey);
  const ui = FIELD_UI[fieldKey];
  const modeOptions = useMemo<SegmentedOption<CronFieldMode>[]>(
    () =>
      (["every", "list", "range", "step", "raw"] as const).map((m) => ({
        value: m,
        label: t(CRON_MODE_LABEL_KEYS[m]),
      })),
    [t],
  );

  return (
    <div
      role="group"
      aria-label={t("automation.cron.fieldEditorAria", { label })}
      className="flex flex-col gap-2.5"
    >
      {/* 头部允许换行：Segmented 不可收缩（选项 whitespace-nowrap），窄窗里
          「标签 + 五段选择器」一行放不下，硬排会把整张表单撑出横向滚动 */}
      <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1.5">
        <span className="text-muted-foreground shrink-0 text-xs">
          {t("automation.cron.fieldHowTrigger", { label })}
        </span>
        <Segmented
          value={field.mode}
          options={modeOptions}
          onChange={(m) => onFieldChange(switchFieldMode(field, m, spec))}
        />
      </div>

      {field.mode === "every" ? (
        <p className="text-muted-foreground text-xs">{t(EVERY_HINT_KEY[fieldKey])}</p>
      ) : null}

      {field.mode === "list" ? (
        <div className={cn("grid gap-1", ui.cols)}>
          {expandRange(spec.min, spec.max).map((v) => {
            const selected = field.values.includes(v);
            return (
              <Chip
                key={v}
                selected={selected}
                onToggle={() =>
                  onFieldChange({
                    mode: "list",
                    values: selected
                      ? field.values.filter((x) => x !== v)
                      : [...field.values, v].sort((a, b) => a - b),
                  })
                }
              >
                {chipLabel(t, fieldKey, v)}
              </Chip>
            );
          })}
        </div>
      ) : null}

      {field.mode === "range" ? (
        <div className="flex flex-wrap items-center gap-2">
          <ValueSelect
            fieldKey={fieldKey}
            value={field.from}
            values={expandRange(spec.min, field.to)}
            onChange={(v) => onFieldChange({ mode: "range", from: v, to: Math.max(field.to, v) })}
          />
          <span className="text-muted-foreground text-xs">{t("automation.cron.rangeTo")}</span>
          <ValueSelect
            fieldKey={fieldKey}
            value={field.to}
            values={expandRange(field.from, spec.max)}
            onChange={(v) => onFieldChange({ mode: "range", from: field.from, to: v })}
          />
          <span className="text-muted-foreground text-xs">{t("automation.cron.rangeInclusive")}</span>
        </div>
      ) : null}

      {field.mode === "step" ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-muted-foreground text-xs">{t("automation.cron.stepEvery")}</span>
          <Input
            type="number"
            min={1}
            max={spec.max}
            value={String(field.step)}
            onChange={(e) => {
              const n = Math.floor(Number(e.target.value));
              if (Number.isFinite(n)) {
                onFieldChange({ mode: "step", step: Math.min(Math.max(1, n), spec.max) });
              }
            }}
            className="h-8 w-16 text-center"
            aria-label={t("automation.cron.stepAria", { unit })}
          />
          <span className="text-muted-foreground text-xs">
            {t("automation.cron.stepHint", {
              unit,
              min: optionLabel(t, fieldKey, spec.min),
            })}
          </span>
        </div>
      ) : null}

      {field.mode === "raw" ? (
        <div className="flex flex-col gap-1.5">
          <Input
            value={field.text}
            onChange={(e) => onFieldChange({ mode: "raw", text: e.target.value })}
            placeholder="1-5/2"
            className="h-8 font-mono"
            aria-label={t("automation.cron.rawAria", { label })}
          />
          <p className="text-muted-foreground text-xs">
            {t("automation.cron.rawHint")}
          </p>
        </div>
      ) : null}
    </div>
  );
};

export type CronEditorProps = {
  /**
   * 标准 5 字段表达式。解析不了时组件内部落默认字段（每天 09:00），
   * 但要等用户真的编辑过才回吐；归一整形（"5,1" → "1,5"）只发生在
   * 显示层与后续编辑结果里，组件不主动改写父级手上的字符串。
   */
  value: string;
  onChange: (next: string) => void;
  className?: string;
  id?: string;
};

export function CronEditor({ value, onChange, className, id }: CronEditorProps) {
  const t = useT();
  const reduce = useReducedMotion();
  const [fields, setFields] = useState<CronFields>(() => parseCron(value) ?? DEFAULT_CRON_FIELDS);
  const [active, setActive] = useState<CronFieldKey | null>(null);
  // 与父级已同步的表达式（本组件回吐的，或采纳自 prop 的外部值）：两种情况下
  // 都不该把同一串再发回去——父级原样送回时不重复解析（会冲掉编辑中的中间态
  // 如空「指定」），采纳外部值时也不回敬一次
  const synced = useRef<string | null>(null);
  // 只有用户动过手才回吐：外部值被采纳（含解析不了的初值）不构成一次编辑，
  // 否则挂载一个非法初值就会立刻把内部默认值写成父级的值
  const dirty = useRef(false);

  useEffect(() => {
    if (value === synced.current) return;
    synced.current = value;
    dirty.current = false;
    const parsed = parseCron(value);
    if (parsed) setFields(parsed);
  }, [value]);

  const expr = useMemo(() => serializeCron(fields), [fields]);
  const incomplete = useMemo(
    () =>
      expr !== null
        ? null
        : (CRON_FIELD_SEQUENCE.find((k) => serializeCronField(fields[k]) === null) ?? null),
    [fields, expr],
  );

  // 回吐派生自 state 而非编辑动作的闭包：同一 tick 里连点多个 chip 也不会
  // 用旧 state 互相覆盖；非法中间态（空「指定」）只留在本地提示，不向外发，
  // dirty 保持置位，等填回合法值再一次性回吐
  useEffect(() => {
    if (!dirty.current || expr === null || expr === synced.current) return;
    dirty.current = false;
    synced.current = expr;
    onChange(expr);
  }, [expr, onChange]);

  const commit = (key: CronFieldKey, next: CronField) => {
    dirty.current = true;
    setFields((cur) => ({ ...cur, [key]: next }));
  };

  // —— 表达式条滑块：常驻指示器 + 容器系坐标（segmented 同款，免疫祖先 reflow）——
  const barRef = useRef<HTMLDivElement>(null);
  const cellRefs = useRef(new Map<CronFieldKey, HTMLButtonElement>());
  const [pill, setPill] = useState<CSSProperties>({});
  const [pillReady, setPillReady] = useState(false);

  const measure = useCallback(() => {
    if (!active) return; // 收起时保留最后几何，仅淡出；下次展开原地滑回
    const bar = barRef.current;
    const cell = cellRefs.current.get(active);
    if (!bar || !cell) return;
    const c = bar.getBoundingClientRect();
    const b = cell.getBoundingClientRect();
    setPill({
      "--cron-pill-left": `${b.left - c.left}px`,
      "--cron-pill-top": `${b.top - c.top}px`,
      "--cron-pill-width": `${b.width}px`,
      "--cron-pill-height": `${b.height}px`,
    } as CSSProperties);
    setPillReady(true);
  }, [active]);

  // 首次测量前不渲染指示器：否则它会从 0×0 被 transition 一路"长"出来
  useLayoutEffect(measure, [measure]);

  // 条宽/字体就绪导致的格子尺寸变化同样要跟上
  useEffect(() => {
    const bar = barRef.current;
    if (!bar) return;
    const ro = new ResizeObserver(() => measure());
    ro.observe(bar);
    for (const el of cellRefs.current.values()) ro.observe(el);
    return () => ro.disconnect();
  }, [measure]);

  const summary =
    expr !== null
      ? describeCron(expr)
      : incomplete
        ? t("automation.cron.missingValue", {
            label: t(cronFieldSpec(incomplete).labelKey),
          })
        : t("automation.cron.incomplete");

  const activeSpec = active ? cronFieldSpec(active) : null;

  return (
    <div
      id={id}
      role="group"
      aria-label={t("automation.cron.editorAria")}
      className={cn("flex flex-col gap-2", className)}
    >
      <div ref={barRef} className="bg-card/40 relative flex items-stretch gap-1 rounded-xl border p-1">
        {pillReady ? (
          <span
            aria-hidden
            style={pill}
            className={cn(
              "bg-primary/10 ring-primary/25 pointer-events-none absolute left-(--cron-pill-left) top-(--cron-pill-top) h-(--cron-pill-height) w-(--cron-pill-width) rounded-lg ring-1",
              "motion-safe:transition-[left,top,width,height,opacity] motion-safe:duration-500 motion-safe:ease-[cubic-bezier(0.16,1,0.3,1)]",
              active ? "opacity-100" : "opacity-0",
            )}
          />
        ) : null}
        {CRON_FIELD_SEQUENCE.map((key) => {
          const spec = cronFieldSpec(key);
          const token = serializeCronField(fields[key]) ?? "—";
          const isActive = active === key;
          return (
            <button
              key={key}
              ref={(el) => {
                if (el) cellRefs.current.set(key, el);
                else cellRefs.current.delete(key);
              }}
              type="button"
              title={token}
              aria-expanded={isActive}
              aria-label={`${t(spec.labelKey)}：${token}`}
              onClick={() => setActive(isActive ? null : key)}
              className={cn(
                "relative z-10 flex min-w-0 flex-1 flex-col items-center gap-0.5 rounded-lg px-1.5 py-1.5 transition-colors",
                isActive
                  ? "text-foreground"
                  : "text-muted-foreground hover:bg-hover hover:text-foreground",
              )}
            >
              <RollText
                text={token}
                className={cn("font-mono max-w-full text-ui tabular-nums", isActive && "font-medium")}
              />
              <span className="text-2xs">{t(spec.labelKey)}</span>
            </button>
          );
        })}
      </div>

      {/* 人话摘要：与自动化卡片同一套 describeCron，认不出的写法回退原始表达式。
          长表达式（多选分钟后是 "Cron: 0,1,2,…"）单行放不下，title 悬浮看全文 */}
      <RollText
        text={summary}
        title={summary}
        className={cn(
          "px-1 text-xs transition-colors",
          expr === null ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground",
        )}
      />

      <AnimatePresence initial={false}>
        {active && activeSpec ? (
          <motion.div
            key="panel"
            initial={reduce ? { opacity: 0 } : { height: 0, opacity: 0 }}
            animate={reduce ? { opacity: 1 } : { height: "auto", opacity: 1 }}
            exit={reduce ? { opacity: 0 } : { height: 0, opacity: 0 }}
            transition={
              reduce
                ? { duration: 0.15 }
                : {
                    height: { type: "spring", stiffness: 380, damping: 34, mass: 0.7 },
                    opacity: { duration: 0.22, ease: EASE_OUT },
                  }
            }
            className="overflow-hidden"
          >
            <div className="bg-muted/30 rounded-xl border p-3">
              <motion.div
                key={active}
                initial={reduce ? false : { opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.22, ease: EASE_OUT }}
              >
                <FieldPanel
                  fieldKey={active}
                  field={fields[active]}
                  onFieldChange={(next) => commit(active, next)}
                />
              </motion.div>
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}
