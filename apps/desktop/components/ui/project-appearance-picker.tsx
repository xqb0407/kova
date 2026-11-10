"use client";

/**
 * 项目外观选择器：侧栏项目「⋯」弹层与「新建工作区」对话框共用。
 *
 * 之前两处各写一套，新建弹窗多了一个「默认文件夹」格、也少了头像页签和
 * 自定义取色，看起来像两种图标体系。这里把颜色行与图标页签原样抽出：
 * - ProjectColorPicker：默认色 + 预设色 + 自定义取色（头像/图片时锁住）；
 * - ProjectIconPicker：吉祥物 / 头像两页签 + 恢复默认。
 *
 * 组件是受控的：调用方只拿 next appearance，存哪、怎么归一由调用方决定
 * （侧栏写 localStorage，创建弹窗先存草稿、点创建才落库）。
 */
import { useEffect, useState, type FC } from "react";
import dynamic from "next/dynamic";
import { cn } from "@/lib/utils";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  PROJECT_MASCOT_COLORS,
  PROJECT_MASCOT_GLYPHS,
  type ProjectAppearance,
} from "@/lib/projects/project-appearance";
import {
  BUILTIN_PROJECT_AVATARS,
  projectAvatarSrc,
} from "@/lib/projects/project-avatars";
import {
  PROJECT_GLYPH_ICONS,
  projectColorTokens,
} from "@/components/ui/project-badge";

/** 取色器只在「自定义颜色」展开时才需要：懒加载，别把设置页的
 *  color-picker（1244 行 + motion）带进主聊天 chunk */
const LazyColorField = dynamic(
  () =>
    import("@/components/settings/components/theme/color-field").then(
      (m) => m.ColorField,
    ),
  {
    ssr: false,
    loading: () => (
      <div className="bg-muted h-8 animate-pulse rounded-md" aria-hidden />
    ),
  },
);

export type ProjectIconTab = "glyph" | "avatar";

/** 图标格：32px 圆角方块 + 升一级的 hover 底。图标本身统一跟项目主色走，
 *  选中只加底色/描边——不再把未选项压灰，"展开"与"收起"是同一套颜色 */
const CELL_BASE =
  "grid size-8 shrink-0 place-items-center rounded-lg transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";
const CELL_IDLE = "hover:bg-muted";
const CELL_ON = "bg-foreground/[0.06] ring-1 ring-foreground/15";

/** 色点：18px 圆点，单行放完（默认 + 9 预设 + 自定义）。选中用外描边，不占布局；
 *  环色取前景色，强调色恰好等于色点颜色时也分得开 */
const SWATCH_BASE =
  "size-[18px] shrink-0 rounded-full border border-black/10 transition-transform hover:scale-110 enabled:active:scale-[0.96] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring dark:border-white/10";
const SWATCH_ON = "outline-2 outline-offset-2 outline-foreground";

/** 清掉某个字段；清完为空则整条移除（回退文件夹图标） */
function clearField(
  appearance: ProjectAppearance | null,
  field: keyof ProjectAppearance,
): ProjectAppearance | null {
  const rest: ProjectAppearance = { ...(appearance ?? {}) };
  delete rest[field];
  return Object.keys(rest).length > 0 ? rest : null;
}

export const ProjectColorPicker: FC<{
  appearance: ProjectAppearance | null;
  onChange: (next: ProjectAppearance | null) => void;
}> = ({ appearance, onChange }) => {
  // 上传图片与内置头像使用自己的配色，此时整组压暗锁住，避免"点了没反应"
  const colorLocked = Boolean(appearance?.image || appearance?.avatar);
  // 当前用的是自定义 hex（不在预设盘里）→ 彩虹/自定义色点显示选中环
  const customColor = Boolean(
    appearance?.color && !PROJECT_MASCOT_COLORS.includes(appearance.color),
  );

  return (
    <div
      className="px-0.5"
      title={
        colorLocked
          ? "上传图片与内置头像使用自己的配色，颜色只作用于吉祥物"
          : undefined
      }
    >
      <div
        role="group"
        aria-label="图标颜色"
        aria-disabled={colorLocked}
        className={cn(
          // 色点铺满整行，避免在宽弹窗里只挤在左侧、和整宽的图标网格失衡
          "flex flex-wrap items-center justify-between gap-2",
          colorLocked && "pointer-events-none opacity-40",
        )}
      >
        {/* 默认（主题色）：对角分割表示"没有指定颜色"，与设置页强调色同款 */}
        <button
          type="button"
          title="默认（跟随主题）"
          aria-label="默认（跟随主题）"
          aria-pressed={!appearance?.color}
          disabled={colorLocked}
          onClick={() => onChange(clearField(appearance, "color"))}
          className={cn(SWATCH_BASE, !appearance?.color && SWATCH_ON)}
          style={{
            background:
              "linear-gradient(135deg, var(--color-foreground) 50%, var(--color-muted-foreground) 50%)",
          }}
        />
        {PROJECT_MASCOT_COLORS.map((color) => (
          <button
            key={color}
            type="button"
            title={color}
            aria-label={color}
            aria-pressed={appearance?.color === color}
            disabled={colorLocked}
            onClick={() => onChange({ ...(appearance ?? {}), color })}
            className={cn(
              SWATCH_BASE,
              appearance?.color === color && SWATCH_ON,
            )}
            style={{ backgroundColor: color }}
          />
        ))}
        {/* 自定义颜色：与主题设置的强调色选择器同款——彩虹入口 + 取色面板 */}
        <Popover>
          <PopoverTrigger
            render={
              <button
                type="button"
                title="自定义颜色"
                aria-label="自定义颜色"
                aria-pressed={customColor}
                disabled={colorLocked}
                className={cn(SWATCH_BASE, customColor && SWATCH_ON)}
                style={{
                  // 与主题设置的强调色选择器一致：有自定义色就显示它，
                  // 没有才显示彩虹入口——收起/展开看到的是同一个颜色
                  background:
                    customColor && appearance?.color
                      ? appearance.color
                      : "conic-gradient(from 210deg, #f87171, #fbbf24, #4ade80, #38bdf8, #a78bfa, #f472b6, #f87171)",
                }}
              />
            }
          />
          <PopoverContent align="end" className="min-w-64 p-3">
            <div className="text-sm font-medium">自定义颜色</div>
            <p className="text-muted-foreground mt-1 text-xs">
              任意 hex 颜色，图标线条会按深浅主题自动适配。
            </p>
            <LazyColorField
              value={appearance?.color ?? "#3b82f6"}
              overridden={customColor}
              onChange={(hex) =>
                onChange({ ...(appearance ?? {}), color: hex })
              }
              onReset={() => onChange(clearField(appearance, "color"))}
            />
          </PopoverContent>
        </Popover>
      </div>
    </div>
  );
};

export const ProjectIconPicker: FC<{
  appearance: ProjectAppearance | null;
  onChange: (next: ProjectAppearance | null) => void;
  /** 页签变化回调：头像页签下颜色行没有意义，父级据此隐藏颜色选择器 */
  onTabChange?: (tab: ProjectIconTab) => void;
  /** 弹层打开时把页签对齐到当前身份（侧栏传 popover open，创建弹窗传 dialog open） */
  resetKey?: unknown;
}> = ({ appearance, onChange, onTabChange, resetKey }) => {
  // 默认看哪一组：当前用的是内置头像就停在头像页，否则看吉祥物页
  const [iconTab, setIconTab] = useState<ProjectIconTab>(
    appearance?.avatar ? "avatar" : "glyph",
  );

  // 打开时把分段对齐到当前图标：组件被换项目复用时也不会停在上一家的页签
  useEffect(() => {
    if (!resetKey) return;
    const next: ProjectIconTab = appearance?.avatar ? "avatar" : "glyph";
    setIconTab(next);
    onTabChange?.(next);
    // onTabChange 由调用方用稳定 setter 传入；放进依赖会让内联回调每次重排页签
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetKey, appearance?.glyph, appearance?.avatar]);

  /** 选择内置图标即替换当前身份：同时清掉头像组与上传图片，点了立刻可见 */
  const pickGlyph = (id: string) => {
    const rest: ProjectAppearance = { ...(appearance ?? {}) };
    delete rest.avatar;
    delete rest.image;
    onChange({ ...rest, glyph: id });
  };
  const pickAvatar = (id: string) => {
    const rest: ProjectAppearance = { ...(appearance ?? {}) };
    delete rest.glyph;
    delete rest.image;
    onChange({ ...rest, avatar: id });
  };
  /** 两组身份互斥：恢复默认可同时清掉两组（保留颜色/图片） */
  const resetBuiltinIdentity = () => {
    const rest: ProjectAppearance = { ...(appearance ?? {}) };
    delete rest.glyph;
    delete rest.avatar;
    onChange(Object.keys(rest).length > 0 ? rest : null);
  };

  // 上传图片显示时「恢复默认」没有意义（清掉 glyph/avatar 也看不见），
  // 只在真正有内置身份、且图片没盖住时才提供
  const hasBuiltinIdentity = Boolean(
    (appearance?.glyph || appearance?.avatar) && !appearance?.image,
  );
  /** 图标着色：主色按主题明暗做一次混合（见 projectColorTokens），
   *  自定义深色 hex 在暗色主题下也不会糊进背景 */
  const colorTokens = appearance?.color
    ? projectColorTokens(appearance.color)
    : null;
  const iconTint = colorTokens ? { color: colorTokens.ink } : undefined;

  return (
    <div className="flex flex-col gap-2 px-0.5">
      <div className="border-border/60 flex items-center gap-4 border-b">
        {(["glyph", "avatar"] as const).map((tab) => {
          const active = iconTab === tab;
          return (
            <button
              key={tab}
              type="button"
              aria-pressed={active}
              onClick={() => {
                setIconTab(tab);
                onTabChange?.(tab);
              }}
              className={cn(
                "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring relative flex h-7 items-center text-xs font-medium transition-colors",
                active
                  ? "text-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {tab === "glyph" ? "吉祥物" : "头像"}
              <span
                aria-hidden
                className={cn(
                  "absolute inset-x-0 -bottom-px h-[1.5px] rounded-full transition-colors",
                  active ? "bg-foreground" : "bg-transparent",
                )}
              />
            </button>
          );
        })}
        <button
          type="button"
          onClick={resetBuiltinIdentity}
          disabled={!hasBuiltinIdentity}
          className={cn(
            "text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring ms-auto shrink-0 rounded px-1 pb-0.5 text-2xs transition-colors",
            !hasBuiltinIdentity && "invisible",
          )}
        >
          恢复默认
        </button>
      </div>
      <div
        role="group"
        aria-label={iconTab === "glyph" ? "内置吉祥物" : "内置头像"}
        className={cn(
          "grid grid-cols-6 justify-items-center",
          iconTab === "glyph"
            ? "gap-1"
            : cn(
                "gap-2",
                // 当前 24 个正好 6×4 完整铺开：不套滚动容器，避免选中描边被裁、
                // 也不出现多余的滚动条。以后超过 4 行才限高滚动（滚动条隐藏，
                // 仍可用滚轮/触控板），并留出内边距防止描边贴边。
                BUILTIN_PROJECT_AVATARS.length > 24 &&
                  "max-h-56 overflow-y-auto overscroll-contain p-1 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
              ),
        )}
      >
        {iconTab === "glyph"
          ? PROJECT_MASCOT_GLYPHS.map((glyph) => {
              const Icon = PROJECT_GLYPH_ICONS[glyph.id];
              const active = appearance?.glyph === glyph.id;
              return (
                <button
                  key={glyph.id}
                  type="button"
                  title={glyph.label}
                  aria-label={glyph.label}
                  aria-pressed={active}
                  onClick={() => pickGlyph(glyph.id)}
                  className={cn(CELL_BASE, active ? CELL_ON : CELL_IDLE)}
                >
                  {Icon ? (
                    <Icon className="size-[18px]" style={iconTint} />
                  ) : null}
                </button>
              );
            })
          : BUILTIN_PROJECT_AVATARS.map((avatar) => {
              const active = appearance?.avatar === avatar.id;
              const src = projectAvatarSrc(avatar.id);
              return (
                <button
                  key={avatar.id}
                  type="button"
                  title={avatar.label}
                  aria-label={avatar.label}
                  aria-pressed={active}
                  onClick={() => pickAvatar(avatar.id)}
                  className={cn(
                    "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring size-10 shrink-0 overflow-hidden rounded-lg transition-transform hover:scale-105 enabled:active:scale-[0.96]",
                    active && "outline-2 outline-offset-2 outline-foreground",
                  )}
                >
                  {src ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={src}
                      alt=""
                      draggable={false}
                      className="size-full object-cover"
                    />
                  ) : null}
                </button>
              );
            })}
      </div>
    </div>
  );
};
