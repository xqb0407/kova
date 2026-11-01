/**
 * 图表属性区（自 Inspector 拆出）：14 种类型、排布变体、图例、数据标签、轴、平滑与主题。
 * 数据编辑走画布双击（数据面板支持从 Excel/CSV 粘贴）；配色走默认色板。
 * 样式只写 ChartEl 的显式字段，缺省语义统一由 chart/spec.ts 归一。
 */
import { type FC, type ReactNode } from "react";
import { Input } from "@/components/ui/input";
import { CHART_KINDS, CHART_LEGEND_POS, type ChartEl, type ChartKind, type ChartLabelPos, type ChartLegendPos, type ChartVariant } from "@/doc";
import { CHART_META, categoryAxisOf, chartKindPatch, chartLegendDefault, usesCartesian } from "@/chart/spec";
import { GroupCard, NumField, SectionTitle } from "../fields";
import { SegGroup } from "../swatches";

const TextRow: FC<{ label: string; value: string; placeholder?: string; onChange: (v: string) => void }> = ({ label, value, placeholder, onChange }) => (
  <label className="flex min-w-0 items-center gap-1.5">
    <span className="text-muted-foreground w-14 shrink-0 text-xs font-medium">{label}</span>
    <Input
      className="h-7 w-full min-w-0 px-2 text-xs"
      value={value}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => e.stopPropagation()}
    />
  </label>
);

/** 14 种类型的小字网格（图标信息量不足，中文名更直接） */
const TypeGrid: FC<{ value: ChartKind; onChange: (k: ChartKind) => void }> = ({ value, onChange }) => (
  <div className="grid grid-cols-4 gap-1" role="group" aria-label="图表类型">
    {CHART_KINDS.map((k) => (
      <button
        key={k}
        type="button"
        title={CHART_META[k].label}
        aria-label={`图表类型 ${CHART_META[k].label}`}
        aria-pressed={value === k}
        onClick={() => onChange(k)}
        className={
          "h-6 truncate rounded-sm px-1 text-[11px] transition-colors " +
          (value === k ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground")
        }
        style={{ background: value === k ? "var(--background)" : undefined }}
      >
        {CHART_META[k].label}
      </button>
    ))}
  </div>
);

const Row: FC<{ label: string; children: ReactNode }> = ({ label, children }) => (
  <div className="flex min-w-0 items-center gap-1.5">
    <span className="text-muted-foreground w-14 shrink-0 text-xs font-medium">{label}</span>
    <div className="min-w-0 flex-1">{children}</div>
  </div>
);

const OnOff: FC<{ value: boolean; onChange: (v: boolean) => void; onText?: string; offText?: string; aria: string }> = ({
  value,
  onChange,
  onText = "显示",
  offText = "隐藏",
  aria,
}) => (
  <SegGroup
    value={value ? "on" : "off"}
    ariaLabel={aria}
    onChange={(v) => onChange(v === "on")}
    options={[
      { v: "on", node: <span className="text-xs font-semibold">{onText}</span>, title: onText },
      { v: "off", node: <span className="text-xs">{offText}</span>, title: offText },
    ]}
  />
);

export const ChartSection: FC<{ el: ChartEl; patch: (p: Partial<ChartEl>, coalesce?: boolean) => void }> = ({ el, patch }) => {
  const kind = el.chart ?? "bar";
  const cart = usesCartesian(kind);
  const catAxis = categoryAxisOf(kind);
  const hasVariant = kind === "bar" || kind === "barH" || kind === "area";
  const smoothable = kind === "line" || kind === "area" || kind === "combo";
  const variant: ChartVariant = el.variant ?? "clustered";
  const legendPos: ChartLegendPos = el.legend?.position ?? "bottom";
  const legendShown = el.legend?.show ?? el.showLegend ?? chartLegendDefault(kind, el.series.length);
  /** 数值轴：barH 类目在 y；散点/气泡双数值轴；其余类别在 x、数值在 y */
  const valueAxes: Array<"x" | "y"> =
    kind === "barH" ? ["x"] : kind === "scatter" || kind === "bubble" ? ["x", "y"] : ["y"];
  const labelsShown = el.dataLabels?.show ?? (kind === "pie" || kind === "doughnut" || kind === "funnel");
  const labelPos: ChartLabelPos = el.dataLabels?.position ?? "outside";

  const setChart = (k: ChartKind) => patch({ ...chartKindPatch(el, k), chart: k } as Partial<ChartEl>, true);
  const setAxis = (which: "x" | "y", p: Partial<NonNullable<ChartEl["axes"]>["x"]>) =>
    patch({ axes: { ...el.axes, [which]: { ...el.axes?.[which], ...p } } } as Partial<ChartEl>, true);

  return (
    <>
      <SectionTitle>图表</SectionTitle>
      <GroupCard className="flex flex-col gap-2.5">
        <div className="bg-secondary/60 flex flex-col gap-0.5 rounded-lg p-0.5">
          <TypeGrid value={kind} onChange={setChart} />
        </div>

        {hasVariant && (
          <Row label="排布">
            <SegGroup
              value={variant}
              ariaLabel="排布方式"
              onChange={(v) => patch({ variant: v } as Partial<ChartEl>, true)}
              options={[
                { v: "clustered", node: <span className="text-xs">簇状</span>, title: "簇状（并排）" },
                { v: "stacked", node: <span className="text-xs">堆叠</span>, title: "堆叠" },
                { v: "percent", node: <span className="text-xs">百分比</span>, title: "百分比堆叠" },
              ]}
            />
          </Row>
        )}

        {smoothable && <Row label="平滑"><OnOff value={el.smooth === true} onChange={(v) => patch({ smooth: v } as Partial<ChartEl>, true)} aria="折线平滑" /></Row>}

        <Row label="图例">
          <div className="flex items-center gap-1.5">
            <OnOff value={legendShown} onChange={(v) => patch({ legend: { ...el.legend, show: v } } as Partial<ChartEl>, true)} aria="图例显示" />
            <SegGroup
              value={legendPos}
              className="flex-1"
              ariaLabel="图例方位"
              onChange={(v) => patch({ legend: { ...el.legend, show: true, position: v } } as Partial<ChartEl>, true)}
              options={CHART_LEGEND_POS.map((p) => ({
                v: p,
                node: <span className="text-[11px]">{p === "top" ? "顶" : p === "bottom" ? "底" : p === "left" ? "左" : "右"}</span>,
                title: `图例在${p === "top" ? "顶部" : p === "bottom" ? "底部" : p === "left" ? "左侧" : "右侧"}`,
              }))}
            />
          </div>
        </Row>

        <Row label="数值">
          <div className="flex items-center gap-1.5">
            <OnOff value={labelsShown} onChange={(v) => patch({ dataLabels: { ...el.dataLabels, show: v } } as Partial<ChartEl>, true)} aria="数据标签" />
            <SegGroup
              value={labelPos}
              className="flex-1"
              ariaLabel="标签位置"
              onChange={(v) => patch({ dataLabels: { ...el.dataLabels, show: true, position: v } } as Partial<ChartEl>, true)}
              options={(["outside", "inside", "center", "top"] as const).map((p) => ({
                v: p,
                node: <span className="text-[11px]">{p === "outside" ? "外" : p === "inside" ? "内" : p === "center" ? "中" : "顶"}</span>,
                title: { outside: "标签在外", inside: "标签在内", center: "标签居中", top: "标签在上" }[p],
              }))}
            />
          </div>
        </Row>

        {labelsShown && (
          <TextRow
            label="标签格式"
            value={el.dataLabels?.format ?? ""}
            placeholder="{c} 或 {b} {d}%"
            onChange={(v) => patch({ dataLabels: { ...el.dataLabels, show: true, format: v || undefined } } as Partial<ChartEl>, true)}
          />
        )}

        <NumField label="字号" min={6} max={48} value={el.size ?? 12} onChange={(v) => patch({ size: v } as Partial<ChartEl>, true)} />
      </GroupCard>

      {cart && (
        <>
          <SectionTitle>坐标轴</SectionTitle>
          <GroupCard className="flex flex-col gap-2.5">
            <TextRow label="X 轴" value={el.axes?.x?.title ?? ""} placeholder="横轴标题" onChange={(v) => setAxis("x", { title: v })} />
            <TextRow label="Y 轴" value={el.axes?.y?.title ?? ""} placeholder="纵轴标题" onChange={(v) => setAxis("y", { title: v })} />
            {catAxis && <NumField label="旋转" min={-90} max={90} value={el.axes?.[catAxis]?.rotate ?? 0} onChange={(v) => setAxis(catAxis, { rotate: v })} />}
            {valueAxes.map((ax) => {
              const name = ax.toUpperCase();
              return (
                <div key={ax} className="flex flex-col gap-1">
                  <div className="flex items-center gap-2">
                    <NumField
                      label={valueAxes.length > 1 ? `${name} 最小` : "最小"}
                      value={el.axes?.[ax]?.min ?? 0}
                      onChange={(v) => setAxis(ax, { min: v })}
                    />
                    <NumField
                      label={valueAxes.length > 1 ? `${name} 最大` : "最大"}
                      value={el.axes?.[ax]?.max ?? 0}
                      onChange={(v) => setAxis(ax, { max: v })}
                    />
                  </div>
                  <Row label={valueAxes.length > 1 ? `${name} 网格` : "网格"}>
                    <OnOff value={el.axes?.[ax]?.grid ?? true} onChange={(v) => setAxis(ax, { grid: v })} aria={`${name} 数值轴网格线`} />
                  </Row>
                </div>
              );
            })}
          </GroupCard>
        </>
      )}

      <SectionTitle>配色主题</SectionTitle>
      <GroupCard>
        <SegGroup
          value={el.theme ?? "auto"}
          ariaLabel="图表主题"
          onChange={(v) => patch({ theme: v === "auto" ? undefined : v } as Partial<ChartEl>, true)}
          options={[
            { v: "auto", node: <span className="text-xs">跟随页面</span>, title: "跟随页面底色" },
            { v: "light", node: <span className="text-xs">浅色</span>, title: "浅色（深字）" },
            { v: "dark", node: <span className="text-xs">深色</span>, title: "深色（浅字）" },
          ]}
        />
      </GroupCard>

      <p className="text-muted-foreground mt-3 leading-relaxed">
        双击图表打开数据面板：类目×系列、散点或甘特任务，可直接从 Excel/CSV 粘贴。饼/环只取第一个系列。
      </p>
    </>
  );
};
