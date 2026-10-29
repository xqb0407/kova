"use client";

/**
 * 模型属性编辑表单（「模型属性」二级弹窗的内容）及其草稿类型。
 *
 * 从 model-settings.tsx 原样抽出来：旧的「添加 AI 服务」弹窗和新的「添加模型」
 * 弹窗（model-add-dialog.tsx）共用同一份表单，样式与字段语义都不动。
 * 末尾的 emptyAttrDraft / attrDraftToSpec 是给新弹窗用的纯函数，口径照
 * model-settings 里 openAttrEditor / confirmAttrEditor 的内联逻辑。
 */

import type { FC, ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { PiCustomModelSpec } from "@/lib/pi/pi-bridge";
import { cn } from "@/lib/utils";

/** 弹窗表单字段：小标签 + 控件 */
export const Field: FC<{
  label: ReactNode;
  className?: string;
  children: ReactNode;
}> = ({ label, className, children }) => (
  <Label className={cn("flex flex-col items-start gap-1.5", className)}>
    <span className="text-muted-foreground text-xs">{label}</span>
    {children}
  </Label>
);

/** 属性值的来源（决定字段旁的标注）：
 *  - stored：行里显式存过（用户填的 / 导入时带的），无需标注
 *  - catalog：完整 id 精确命中目录同名模型，无需标注
 *  - normalized：剥掉一层命名空间前缀后命中目录（如 cn:deepseek-v4.1-flash），
 *    标"目录推测"提示核对
 *  - guess：仍是 sidecar 缺省猜测值，标"未确认" */
export type AttrOrigin = "stored" | "catalog" | "normalized" | "guess";

export type AttrFieldOrigins = {
  contextWindow?: AttrOrigin;
  maxTokens?: AttrOrigin;
  input?: AttrOrigin;
  /** normalized 来源命中的目录 id（标注文案里点名） */
  matchedId?: string;
};

const AttrSourceLabel: FC<{
  text: string;
  origin?: AttrOrigin;
  matchedId?: string;
}> = ({ text, origin, matchedId }) => {
  if (origin === "guess" || origin === "normalized") {
    return (
      <span className="flex items-center gap-1.5">
        {text}
        <Badge
          variant="outline"
          className="h-4 shrink-0 px-1.5 text-[10px] font-normal"
          title={
            origin === "guess"
              ? "该值仍是 sidecar 缺省猜测（网关未提供此元数据），对照网关文档核实后填入即可确认"
              : `按目录同名模型推导${matchedId ? `（${matchedId}）` : ""}：modelId 带命名空间前缀，已按尾段反查。核对网关文档后填入即可确认`
          }
        >
          {origin === "guess" ? "未确认" : "目录推测"}
        </Badge>
      </span>
    );
  }
  return <>{text}</>;
};

/** 模型属性编辑表单的草稿（字符串态，提交时解析）；t* 字段是思考参数映射编辑 */
export type AttrDraft = {
  name: string;
  ctx: string;
  max: string;
  text: boolean;
  image: boolean;
  reasoning: boolean;
  /** 可生成图片标记（存 imagegen 配置覆盖层，非 models 表列）：文生图下拉过滤依据 */
  t2i: boolean;
  tOff: string;
  tMin: boolean;
  tLow: boolean;
  tMed: boolean;
  tHigh: boolean;
  tXhigh: boolean;
  tMax: boolean;
  cIn: string;
  cOut: string;
  cRead: string;
  cWrite: string;
  /** prompt cache TTL（秒）：cache warmer 只对声明过的模型工作；空 = 未声明 */
  pcShort: string;
  pcLong: string;
};

/** 档位复选框的渲染表：level = thinkingLevelMap 键（勾选时透传同名下发值） */
export const THINK_LEVELS: {
  level: string;
  field: "tMin" | "tLow" | "tMed" | "tHigh" | "tXhigh" | "tMax";
  label: string;
}[] = [
  { level: "minimal", field: "tMin", label: "最小" },
  { level: "low", field: "tLow", label: "轻度" },
  { level: "medium", field: "tMed", label: "中" },
  { level: "high", field: "tHigh", label: "高" },
  { level: "xhigh", field: "tXhigh", label: "很高" },
  { level: "max", field: "tMax", label: "最高" },
];

/**
 * 容量快捷档：点一下直接填入。上下文走十进制口径（128K=128000，与各家
 * OpenAI 兼容端点的声明一致）；最大输出走二进制口径（8K=8192，OpenAI/网关
 * 的 max_tokens 常见档）。精确值仍可手填。
 */
const CTX_PRESETS: { label: string; value: number }[] = [
  { label: "32K", value: 32_000 },
  { label: "128K", value: 128_000 },
  { label: "200K", value: 200_000 },
  { label: "256K", value: 256_000 },
  { label: "400K", value: 400_000 },
  { label: "1M", value: 1_000_000 },
];
const OUT_PRESETS: { label: string; value: number }[] = [
  { label: "4K", value: 4_096 },
  { label: "8K", value: 8_192 },
  { label: "16K", value: 16_384 },
  { label: "32K", value: 32_768 },
  { label: "64K", value: 65_536 },
];

/** 输入框下的一排快捷档；当前值命中的档位高亮 */
const PresetChips: FC<{
  presets: { label: string; value: number }[];
  current: string;
  onPick: (value: number) => void;
}> = ({ presets, current, onPick }) => (
  <div className="flex flex-wrap items-center gap-0.5">
    {presets.map((p) => {
      const active = current.trim() === String(p.value);
      return (
        <button
          key={p.label}
          type="button"
          onClick={() => onPick(p.value)}
          className={cn(
            "rounded-md px-1.5 py-0.5 text-xs transition-colors",
            active
              ? "bg-muted text-foreground"
              : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
          )}
        >
          {p.label}
        </button>
      );
    })}
  </div>
);

/** 模型属性编辑表单（"支持深度思考"等能力标记也在这里）：渲染于二级弹窗内 */
export const AttrEditor: FC<{
  draft: AttrDraft;
  busy: boolean;
  /** 是否显示思考映射编辑（模型已有确定的 provider 归属时可编辑） */
  showThinking: boolean;
  /** 目录已覆盖该模型档位且无前端覆盖 → 折叠为"自动"只读态 */
  thinkingAuto: boolean;
  /** 本次打开内用户点了"手动覆盖"：自动态展开为编辑态 */
  thinkingOverride: boolean;
  /** 目录生效档位的一句话摘要（自动态展示） */
  thinkingAutoSummary: string;
  /** 仍为 sidecar 缺省猜测值的属性字段（无来源信息时的兜底标注） */
  defaultedAttrs: string[];
  /** 逐字段来源（自定义端点/目录外模型带；缺席时回落到 defaultedAttrs） */
  attrOrigins?: AttrFieldOrigins;
  onRequestThinkingOverride: () => void;
  onRestoreAutoThinking: () => void;
  /** 容量/输出/模态/单价一键清空回"继承"（行里不再留显式值） */
  onRestoreAutoAttrs: () => void;
  onChange: (patch: Partial<AttrDraft>) => void;
  onConfirm: () => void;
  onCancel: () => void;
}> = ({
  draft,
  busy,
  showThinking,
  thinkingAuto,
  thinkingOverride,
  thinkingAutoSummary,
  defaultedAttrs,
  attrOrigins,
  onRequestThinkingOverride,
  onRestoreAutoThinking,
  onRestoreAutoAttrs,
  onChange,
  onConfirm,
  onCancel,
}) => (
  <div className="flex flex-col gap-3">
    <div className="grid grid-cols-4 gap-2">
      <Field label="名称" className="col-span-4">
        <Input
          value={draft.name}
          onChange={(e) => onChange({ name: e.target.value })}
          className="h-8 text-[13px]"
        />
      </Field>
      <Field
        label={
          <AttrSourceLabel
            text="上下文窗口"
            origin={
              attrOrigins?.contextWindow ??
              (defaultedAttrs.includes("contextWindow") ? "guess" : undefined)
            }
            matchedId={attrOrigins?.matchedId}
          />
        }
        className="col-span-2"
      >
        <Input
          type="number"
          min={0}
          value={draft.ctx}
          onChange={(e) => onChange({ ctx: e.target.value })}
          className="h-8 text-[13px] tabular-nums"
        />
        <PresetChips
          presets={CTX_PRESETS}
          current={draft.ctx}
          onPick={(value) => onChange({ ctx: String(value) })}
        />
      </Field>
      <Field
        label={
          <AttrSourceLabel
            text="最大输出"
            origin={
              attrOrigins?.maxTokens ??
              (defaultedAttrs.includes("maxTokens") ? "guess" : undefined)
            }
            matchedId={attrOrigins?.matchedId}
          />
        }
        className="col-span-2"
      >
        <Input
          type="number"
          min={0}
          value={draft.max}
          onChange={(e) => onChange({ max: e.target.value })}
          className="h-8 text-[13px] tabular-nums"
        />
        <PresetChips
          presets={OUT_PRESETS}
          current={draft.max}
          onPick={(value) => onChange({ max: String(value) })}
        />
      </Field>
      <div className="col-span-4 flex items-center gap-4 text-sm">
        <span className="text-muted-foreground shrink-0">
          <AttrSourceLabel
            text="输入模态"
            origin={
              attrOrigins?.input ??
              (defaultedAttrs.includes("input") ? "guess" : undefined)
            }
            matchedId={attrOrigins?.matchedId}
          />
        </span>
        <Label className="flex items-center gap-1.5 text-sm">
          <Checkbox
            checked={draft.text}
            onCheckedChange={(checked) => onChange({ text: checked })}
            className="size-4"
          />
          文本
        </Label>
        <Label className="flex items-center gap-1.5 text-sm">
          <Checkbox
            checked={draft.image}
            onCheckedChange={(checked) => onChange({ image: checked })}
            className="size-4"
          />
          图像
        </Label>
        {/* 能力标记：非推理模型勾上后对话页的深度思考开关才会真正下发 reasoning 参数 */}
        <Label className="ml-auto flex items-center gap-1.5 text-sm">
          <Checkbox
            checked={draft.reasoning}
            onCheckedChange={(checked) => onChange({ reasoning: checked })}
            className="size-4"
          />
          支持深度思考
        </Label>
        {/* 输出能力标记（存 imagegen 配置覆盖层）：勾上才会出现在文生图默认模型下拉 */}
        <Label
          className="flex items-center gap-1.5 text-sm"
          title="标记为可生成图片的模型（如 gpt-image-1 / dall-e-3 / seedream）：勾选后才会出现在「文生图 → 默认文生图模型」下拉里；供 generate_image 工具按 OpenAI images 协议调用"
        >
          <Checkbox
            checked={draft.t2i}
            onCheckedChange={(checked) => onChange({ t2i: checked })}
            className="size-4"
          />
          可生成图片
        </Label>
      </div>
      <Field label="输入单价">
        <Input
          type="number"
          step="any"
          min={0}
          value={draft.cIn}
          onChange={(e) => onChange({ cIn: e.target.value })}
          className="h-8 text-[13px] tabular-nums"
        />
      </Field>
      <Field label="输出单价">
        <Input
          type="number"
          step="any"
          min={0}
          value={draft.cOut}
          onChange={(e) => onChange({ cOut: e.target.value })}
          className="h-8 text-[13px] tabular-nums"
        />
      </Field>
      <Field label="缓存读">
        <Input
          type="number"
          step="any"
          min={0}
          value={draft.cRead}
          onChange={(e) => onChange({ cRead: e.target.value })}
          className="h-8 text-[13px] tabular-nums"
        />
      </Field>
      <Field label="缓存写">
        <Input
          type="number"
          step="any"
          min={0}
          value={draft.cWrite}
          onChange={(e) => onChange({ cWrite: e.target.value })}
          className="h-8 text-[13px] tabular-nums"
        />
      </Field>
      <Field label="缓存 TTL·短">
        <Input
          type="number"
          step="any"
          min={0}
          placeholder="未声明"
          title="prompt cache 短档 TTL（秒），如 Anthropic 300 / OpenAI 300：填写后该模型才会参与缓存保活（cache warmer）"
          value={draft.pcShort}
          onChange={(e) => onChange({ pcShort: e.target.value })}
          className="h-8 text-[13px] tabular-nums"
        />
      </Field>
      <Field label="缓存 TTL·长">
        <Input
          type="number"
          step="any"
          min={0}
          placeholder="未声明"
          title="prompt cache 长档 TTL（秒），如 Anthropic 3600 / OpenAI 86400：仅当端点支持长保留时填写"
          value={draft.pcLong}
          onChange={(e) => onChange({ pcLong: e.target.value })}
          className="h-8 text-[13px] tabular-nums"
        />
      </Field>
    </div>
    {/* 容量/输出/模态/单价一键回"继承"：清空后按目录种子（或缺省）重新推导，
        行里不再留显式值——目录更新/归一化命中的真值才能继续生效 */}
    <div className="flex items-center gap-2 border-t pt-2.5 text-sm">
      <span className="min-w-0 truncate text-muted-foreground text-xs">
        填写即作为该模型的覆盖保存；清空可回到目录/缺省推导
      </span>
      <Button
        size="sm"
        variant="ghost"
        className="ml-auto h-7 shrink-0 text-sm"
        onClick={onRestoreAutoAttrs}
      >
        恢复自动
      </Button>
    </div>
    {showThinking &&
      (thinkingAuto && !thinkingOverride ? (
        <div className="flex items-center gap-2 border-t pt-2.5 text-sm">
          <span className="text-muted-foreground shrink-0">思考档位</span>
          <Badge variant="outline" className="shrink-0" title={thinkingAutoSummary}>
            自动
          </Badge>
          <span
            className="min-w-0 truncate text-muted-foreground"
            title={thinkingAutoSummary}
          >
            {thinkingAutoSummary}
          </span>
          <Button
            size="sm"
            variant="ghost"
            className="ml-auto h-7 shrink-0 text-sm"
            onClick={onRequestThinkingOverride}
          >
            手动覆盖
          </Button>
        </div>
      ) : (
        <div className="flex flex-col gap-2 border-t pt-2.5">
          {thinkingAuto && (
            <div className="flex items-center gap-2 text-sm">
              <span className="min-w-0 truncate text-muted-foreground">
                基于目录值编辑；改动将作为该模型的覆盖保存
              </span>
              <Button
                size="sm"
                variant="ghost"
                className="ml-auto h-7 shrink-0 text-sm"
                onClick={onRestoreAutoThinking}
              >
                恢复自动
              </Button>
            </div>
          )}
          <div className="flex items-center gap-2 text-sm">
            <span
              className="text-muted-foreground shrink-0 cursor-help"
              title="关闭思考时显式下发的参数值。默认开思考的网关必须填它才关得掉（OpenAI 兼容常见值：none）；留空 = 不发关闭参数。"
            >
              关闭时下发
            </span>
            <Input
              value={draft.tOff}
              onChange={(e) => onChange({ tOff: e.target.value })}
              placeholder="如 none，留空不发送"
              className="h-8 w-full max-w-48 text-[13px]"
            />
          </div>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-sm">
            <span className="text-muted-foreground shrink-0">可用档位</span>
            {THINK_LEVELS.map((t) => (
              <Label key={t.level} className="flex items-center gap-1.5 text-sm">
                <Checkbox
                  checked={draft[t.field]}
                  onCheckedChange={(checked) =>
                    onChange({ [t.field]: checked } as Partial<AttrDraft>)
                  }
                  className="size-4"
                />
                {t.label}
              </Label>
            ))}
          </div>
        </div>
      ))}
    <div className="flex justify-end gap-1.5">
      <Button size="sm" variant="ghost" className="h-8 text-sm" onClick={onCancel}>
        取消
      </Button>
      <Button size="sm" className="h-8 text-sm" disabled={busy} onClick={onConfirm}>
        确定
      </Button>
    </div>
  </div>
);

/**
 * 全新模型（目录里查不到、行里没存过）的草稿初值：口径同 model-settings 的
 * openAttrEditor 在 src 只有 id 时的取值——容量留空、文本模态、单价 "0"，
 * 档位按 openai 兼容网关的保守缺省（minimal/low/medium/high 开，xhigh/max 关）。
 * 名称留空不落 id：保存时 mergeModelSpecForSave 按"没改过"处理、不发 name，
 * 目录种子以后给出的显示名才不会被 id 冻住（行展示自行回落 id）。
 */
export function emptyAttrDraft(id: string): AttrDraft {
  return {
    name: "",
    ctx: "",
    max: "",
    text: true,
    image: false,
    reasoning: false,
    t2i: false,
    tOff: "",
    tMin: true,
    tLow: true,
    tMed: true,
    tHigh: true,
    tXhigh: false,
    tMax: false,
    cIn: "0",
    cOut: "0",
    cRead: "0",
    cWrite: "0",
    pcShort: "",
    pcLong: "",
  };
}

/** 草稿 → 提交用的模型属性（口径同 model-settings 的 confirmAttrEditor；t2i / 档位不在这里） */
export function attrDraftToSpec(id: string, draft: AttrDraft): PiCustomModelSpec {
  const num = (v: string): number | undefined => {
    const n = Number(v);
    return v.trim() !== "" && Number.isFinite(n) ? n : undefined;
  };
  return {
    id,
    name: draft.name.trim() || undefined,
    reasoning: draft.reasoning,
    contextWindow: num(draft.ctx),
    maxTokens: num(draft.max),
    input: [draft.text && "text", draft.image && "image"].filter(
      (s): s is string => !!s,
    ),
    cost: {
      input: num(draft.cIn) ?? 0,
      output: num(draft.cOut) ?? 0,
      cacheRead: num(draft.cRead) ?? 0,
      cacheWrite: num(draft.cWrite) ?? 0,
    },
    // 两端都空 = 未声明（undefined）；任一非空才带上
    ...(draft.pcShort.trim() !== "" || draft.pcLong.trim() !== ""
      ? {
          promptCache: {
            ...(num(draft.pcShort) !== undefined ? { short: num(draft.pcShort) } : {}),
            ...(num(draft.pcLong) !== undefined ? { long: num(draft.pcLong) } : {}),
          },
        }
      : {}),
  };
}

/** 草稿里勾选的思考档位（thinkingLevelMap 键） */
export function attrDraftThinkingLevels(draft: AttrDraft): string[] {
  return THINK_LEVELS.filter((t) => draft[t.field]).map((t) => t.level);
}

/**
 * 生效值 spec → 编辑草稿（编辑弹窗预填的反向映射，口径同 model-settings 的
 * openAttrEditor）。思考档位/生图标记不在 spec 里，由调用方通过 thinking 传入；
 * 不传时档位给 openai 兼容网关的保守缺省、t2i 关。
 */
export function specToAttrDraft(
  id: string,
  spec: PiCustomModelSpec,
  thinking?: { levels: readonly string[]; off: string; t2i?: boolean },
): AttrDraft {
  const has = (m: string) => (spec.input ?? ["text"]).includes(m);
  const levels = thinking?.levels;
  return {
    name: spec.name ?? id,
    ctx: spec.contextWindow != null ? String(spec.contextWindow) : "",
    max: spec.maxTokens != null ? String(spec.maxTokens) : "",
    text: has("text"),
    image: has("image"),
    reasoning: spec.reasoning ?? false,
    t2i: thinking?.t2i ?? false,
    tOff: thinking?.off ?? "",
    tMin: levels ? levels.includes("minimal") : true,
    tLow: levels ? levels.includes("low") : true,
    tMed: levels ? levels.includes("medium") : true,
    tHigh: levels ? levels.includes("high") : true,
    tXhigh: levels ? levels.includes("xhigh") : false,
    tMax: levels ? levels.includes("max") : false,
    cIn: String(spec.cost?.input ?? 0),
    cOut: String(spec.cost?.output ?? 0),
    cRead: String(spec.cost?.cacheRead ?? 0),
    cWrite: String(spec.cost?.cacheWrite ?? 0),
    pcShort: spec.promptCache?.short != null ? String(spec.promptCache.short) : "",
    pcLong: spec.promptCache?.long != null ? String(spec.promptCache.long) : "",
  };
}
