/**
 * 5 字段 cron 的结构化编辑模型（纯函数）：表达式 ↔ 每字段的可编辑形态。
 * cron-editor 组件用它解析/回吐/校验；「这个排期真的能跑」的事实源仍在
 * sidecar 的 automation_preview，这里只保证编辑器的结构完整与往返保真
 * （认不出的高级写法落 raw 原样带回，不擅自改写用户输入）。
 */

export type CronFieldKey = "minute" | "hour" | "dom" | "month" | "dow";

/** every="*"；list="a,b,c"（单值写作 "a"）；range="a-b"；step="星号/n"；raw=其余原样保留 */
export type CronFieldMode = "every" | "list" | "range" | "step" | "raw";

export type CronField =
  | { mode: "every" }
  | { mode: "list"; values: number[] }
  | { mode: "range"; from: number; to: number }
  | { mode: "step"; step: number }
  /** 认不出的写法（1-5/2、MON 等）：不解析，只在原文上编辑 */
  | { mode: "raw"; text: string };

export type CronFields = Record<CronFieldKey, CronField>;

export type CronFieldSpec = {
  key: CronFieldKey;
  label: string;
  /** 量词：每 N「分钟」 */
  unit: string;
  min: number;
  max: number;
};

const SPEC_BY_KEY: Record<CronFieldKey, CronFieldSpec> = {
  minute: { key: "minute", label: "分钟", unit: "分钟", min: 0, max: 59 },
  hour: { key: "hour", label: "小时", unit: "小时", min: 0, max: 23 },
  dom: { key: "dom", label: "日", unit: "天", min: 1, max: 31 },
  month: { key: "month", label: "月", unit: "月", min: 1, max: 12 },
  // 星期 0-6（0=周日）；表达式里写 7 也指周日，解析时归一
  dow: { key: "dow", label: "星期", unit: "天", min: 0, max: 6 },
};

/** 表达式的字段顺序（表达式条与序列化都按它） */
export const CRON_FIELD_SEQUENCE: readonly CronFieldKey[] = [
  "minute",
  "hour",
  "dom",
  "month",
  "dow",
];

export function cronFieldSpec(key: CronFieldKey): CronFieldSpec {
  return SPEC_BY_KEY[key];
}

export const CRON_MODE_LABELS: Record<CronFieldMode, string> = {
  every: "每个",
  list: "指定",
  range: "范围",
  step: "步进",
  raw: "原始",
};

/** [from..to] 展开（含两端）；range→list 切换、chip 网格都按它生成值域 */
export function expandRange(from: number, to: number): number[] {
  if (to < from) return [];
  return Array.from({ length: to - from + 1 }, (_, i) => from + i);
}

/** 值域校验；星期 7≡0（cron 的两种周日写法） */
function normValue(v: number, spec: CronFieldSpec): number | undefined {
  if (spec.key === "dow" && v === 7) return 0;
  return v >= spec.min && v <= spec.max ? v : undefined;
}

export function parseCronField(text: string, spec: CronFieldSpec): CronField {
  const t = text.trim();
  if (t === "*") return { mode: "every" };

  const step = /^\*\/(\d+)$/.exec(t);
  if (step?.[1]) {
    const n = Number(step[1]);
    if (n >= 1) return { mode: "step", step: n };
    return { mode: "raw", text: t };
  }

  const range = /^(\d+)-(\d+)$/.exec(t);
  if (range?.[1] && range[2]) {
    const from = normValue(Number(range[1]), spec);
    const to = normValue(Number(range[2]), spec);
    // 倒序区间（5-1）不是合法 cron，交回 raw 而不是悄悄交换端点
    if (from !== undefined && to !== undefined && from <= to) return { mode: "range", from, to };
    return { mode: "raw", text: t };
  }

  const parts = t.includes(",") ? t.split(",") : [t];
  const values = parts.map((p) =>
    /^\d+$/.test(p.trim()) ? normValue(Number(p.trim()), spec) : undefined,
  );
  if (values.length > 0 && values.every((v) => v !== undefined)) {
    const sorted = [...new Set(values as number[])].sort((a, b) => a - b);
    return { mode: "list", values: sorted };
  }

  return { mode: "raw", text: t };
}

/** 空值/非法态回 null：组件据此判「表达式还不完整」，不向父级回吐半截表达式 */
export function serializeCronField(field: CronField): string | null {
  switch (field.mode) {
    case "every":
      return "*";
    case "step":
      return field.step >= 1 ? `*/${field.step}` : null;
    case "range":
      return field.from <= field.to ? `${field.from}-${field.to}` : null;
    case "list":
      return field.values.length > 0 ? field.values.join(",") : null;
    case "raw":
      return field.text.trim() || null;
  }
}

export function serializeCron(fields: CronFields): string | null {
  const parts: string[] = [];
  for (const key of CRON_FIELD_SEQUENCE) {
    const token = serializeCronField(fields[key]);
    if (token === null) return null;
    parts.push(token);
  }
  return parts.join(" ");
}

export function parseCron(expr: string): CronFields | null {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  return Object.fromEntries(
    CRON_FIELD_SEQUENCE.map((key, i) => [key, parseCronField(parts[i]!, SPEC_BY_KEY[key])]),
  ) as CronFields;
}

/** 结构完整（5 字段、无空字段）≠ 调度器认可：真实判定以 sidecar preview 为准 */
export function isCronComplete(expr: string): boolean {
  const fields = parseCron(expr);
  return fields !== null && serializeCron(fields) !== null;
}

export const DEFAULT_CRON_FIELDS: CronFields = {
  minute: { mode: "list", values: [0] },
  hour: { mode: "list", values: [9] },
  dom: { mode: "every" },
  month: { mode: "every" },
  dow: { mode: "every" },
};

/** 等差列表的步长；不满足（少于两个值/间距不齐）回 undefined */
function evenStep(values: number[]): number | undefined {
  if (values.length < 2) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const gap = sorted[1]! - sorted[0]!;
  if (gap < 1) return undefined;
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i]! - sorted[i - 1]! !== gap) return undefined;
  }
  return gap;
}

/**
 * 模式切换的状态桥接：能保值的尽量保值（0,15,30,45 → 每 15 分钟、范围 → 枚举、
 * 等差枚举 → 步进），否则落该字段的合理默认（起点为字段下界）。
 */
export function switchFieldMode(
  field: CronField,
  mode: CronFieldMode,
  spec: CronFieldSpec,
): CronField {
  if (field.mode === mode) return field;
  switch (mode) {
    case "every":
      return { mode: "every" };
    case "list": {
      if (field.mode === "range") return { mode: "list", values: expandRange(field.from, field.to) };
      if (field.mode === "step") {
        const values: number[] = [];
        for (let v = spec.min; v <= spec.max; v += field.step) values.push(v);
        return { mode: "list", values };
      }
      return { mode: "list", values: [spec.min] };
    }
    case "range": {
      if (field.mode === "list" && field.values.length > 0) {
        return {
          mode: "range",
          from: Math.min(...field.values),
          to: Math.max(...field.values),
        };
      }
      return { mode: "range", from: spec.min, to: spec.max };
    }
    case "step": {
      if (field.mode === "list") {
        const gap = evenStep(field.values);
        if (gap !== undefined) return { mode: "step", step: gap };
      }
      return { mode: "step", step: 2 };
    }
    case "raw":
      return { mode: "raw", text: serializeCronField(field) ?? "" };
  }
}
