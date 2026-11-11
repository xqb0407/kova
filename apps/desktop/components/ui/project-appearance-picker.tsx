"use client";

/**
 * 项目外观选择器：「新建/编辑工作区」名称行左侧的头像按钮 + 弹出面板。
 *
 * 触发按钮显示项目当前身份（上传图/内置头像/着色吉祥物；都没有时回退
 * 文件夹图标），点击弹出参考创建类弹窗的面板：页签（pill 分段：吉祥物/
 * 头像）→ 色板行（默认 + 9 预设 + 随机，仅吉祥物页）→ 图标网格（8 列）。
 * 图标目录沿用既有两组：12 矢量吉祥物（着色跟随主色）与 24 张内置
 * DiceBear 头像（自带配色，不参与色板）。头像页的「随机」从 DiceBear
 * 全部 61 种风格里抽一种生成新头像，id 只存 style/seed/背景色，
 * 刷新/重开后仍是同一张。
 *
 * 组件是受控的：调用方只拿 next appearance，存哪、怎么归一由调用方决定
 * （创建弹窗先存草稿、点创建才落库）。
 */
import { useState, type FC } from "react";
import { DicesIcon, FolderClosedIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Segmented } from "@/components/custom-ui/segmented";
import {
  PROJECT_MASCOT_COLORS,
  PROJECT_MASCOT_GLYPHS,
  type ProjectAppearance,
} from "@/lib/projects/project-appearance";
import {
  BUILTIN_PROJECT_AVATARS,
  projectAvatarSrc,
  randomProjectAvatar,
} from "@/lib/projects/project-avatars";
import {
  PROJECT_GLYPH_ICONS,
  projectColorTokens,
  ProjectBadge,
} from "@/components/ui/project-badge";
import { hasProjectAppearance } from "@/lib/projects/project-appearance";
import { useT } from "@/lib/i18n";

export type ProjectIconTab = "glyph" | "avatar";

/** 数组随机取一（randomize 专用；调用方不要求密码学随机） */
function pickOne<T>(list: readonly T[]): T {
  return list[Math.floor(Math.random() * list.length)]!;
}

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

/** 替换身份字段并清掉互斥组（吉祥物/头像/上传图三者只留一个） */
function withIdentity(
  appearance: ProjectAppearance | null,
  identity: { glyph: string } | { avatar: string },
): ProjectAppearance {
  const rest: ProjectAppearance = { ...(appearance ?? {}) };
  delete rest.glyph;
  delete rest.avatar;
  delete rest.image;
  return { ...rest, ...identity };
}

/**
 * 头像按钮 + 弹出面板（页签 + 色板 + 网格一体）。受控：appearance/onChange
 * 由父级持有；面板里选完即时生效（父级草稿态），点外部收起。
 */
export const ProjectAppearancePicker: FC<{
  appearance: ProjectAppearance | null;
  onChange: (next: ProjectAppearance | null) => void;
  /** 触发按钮禁用（提交中等） */
  disabled?: boolean;
  /** 嵌进 InputGroup 用：去掉自带边框/底色，由外层容器统一画边框和焦点环 */
  embedded?: boolean;
}> = ({ appearance, onChange, disabled, embedded }) => {
  const t = useT();
  // 默认看哪一组：当前用的是内置头像就停在头像页，否则看吉祥物页
  const [iconTab, setIconTab] = useState<ProjectIconTab>(
    appearance?.avatar ? "avatar" : "glyph",
  );

  /** 选择内置图标即替换当前身份：同时清掉头像组与上传图片，点了立刻可见 */
  const pickGlyph = (id: string) => {
    onChange(withIdentity(appearance, { glyph: id }));
  };
  const pickAvatar = (id: string) => {
    onChange(withIdentity(appearance, { avatar: id }));
  };
  /** 两组身份互斥：恢复默认可同时清掉两组（保留颜色/图片） */
  const resetBuiltinIdentity = () => {
    const rest: ProjectAppearance = { ...(appearance ?? {}) };
    delete rest.glyph;
    delete rest.avatar;
    onChange(Object.keys(rest).length > 0 ? rest : null);
  };

  /** 吉祥物页的随机：随机吉祥物 + 随机预设色（连点连换）。onChange 是受控
   *  回调（非 setState updater），必须一次组装完再传。 */
  const randomizeGlyph = () => {
    onChange({
      ...withIdentity(appearance, { glyph: pickOne(PROJECT_MASCOT_GLYPHS).id }),
      color: pickOne(PROJECT_MASCOT_COLORS),
    });
  };

  /** 头像页的随机：从 DiceBear 全部风格里抽一种，再用新 seed 生成一张新头像。
   *  id 只存 style/seed/背景色，刷新或重开面板后仍是同一张。 */
  const randomizeAvatar = () => {
    onChange(withIdentity(appearance, { avatar: randomProjectAvatar() }));
  };

  // 上传图片显示时「恢复默认」没有意义（清掉 glyph/avatar 也看不见），
  // 只在真正有内置身份、且图片没盖住时才提供
  const hasBuiltinIdentity = Boolean(
    (appearance?.glyph || appearance?.avatar) && !appearance?.image,
  );
  // 上传图片与内置头像使用自己的配色，此时整组压暗锁住，避免"点了没反应"
  const colorLocked = Boolean(appearance?.image || appearance?.avatar);
  /** 图标着色：主色按主题明暗做一次混合（见 projectColorTokens），
   *  自定义深色 hex 在暗色主题下也不会糊进背景 */
  const colorTokens = appearance?.color
    ? projectColorTokens(appearance.color)
    : null;
  const iconTint = colorTokens ? { color: colorTokens.ink } : undefined;

  return (
    <Popover>
      <PopoverTrigger
        render={
          <button
            type="button"
            disabled={disabled}
            title={t("chat.workspaceDialog.icon")}
            aria-label={t("chat.workspaceDialog.icon")}
            className={cn(
              "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring grid size-9 shrink-0 cursor-pointer place-items-center transition-colors disabled:cursor-not-allowed disabled:opacity-60",
              embedded
                ? // 嵌在 InputGroup 里：外层已是 bg-muted/60，hover 用实色才看得见
                  "h-full rounded-l-lg rounded-r-none border-0 bg-transparent hover:bg-muted"
                : "rounded-lg border border-border/80 bg-muted/30 hover:bg-muted/60",
            )}
          >
            {hasProjectAppearance(appearance) ? (
              <ProjectBadge
                appearance={appearance}
                className="size-6 rounded-md [&>svg]:size-5"
              />
            ) : (
              <FolderClosedIcon className="text-muted-foreground size-4" />
            )}
          </button>
        }
      />
      <PopoverContent align="start" className="w-[21rem] gap-0 p-3">
        <div className="flex items-center justify-between gap-2">
          <Segmented<ProjectIconTab>
            value={iconTab}
            onChange={setIconTab}
            options={[
              { value: "glyph", label: "吉祥物" },
              { value: "avatar", label: "头像" },
            ]}
          />
          <div className="flex items-center gap-1">
            {/* 恢复默认只在真正有内置身份时出现；随机固定在组尾，永远贴右 */}
            {hasBuiltinIdentity ? (
              <button
                type="button"
                onClick={resetBuiltinIdentity}
                className="text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring shrink-0 rounded px-1 text-2xs transition-colors"
              >
                恢复默认
              </button>
            ) : null}
            <button
              type="button"
              title={
                iconTab === "avatar"
                  ? "随机一张 DiceBear 头像（全部风格）"
                  : t("chat.workspaceDialog.random")
              }
              aria-label={
                iconTab === "avatar"
                  ? "随机一张 DiceBear 头像（全部风格）"
                  : t("chat.workspaceDialog.random")
              }
              onClick={iconTab === "avatar" ? randomizeAvatar : randomizeGlyph}
              className="text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring inline-flex h-7 shrink-0 items-center gap-1 rounded-full px-2 text-2xs transition-colors"
            >
              <DicesIcon className="size-3.5" />
              随机
            </button>
          </div>
        </div>

        {/* 色板只服务吉祥物/文件夹图标：头像自带配色，头像页不渲染色板，
            避免"切到头像还能看到颜色"的误解 */}
        {iconTab === "glyph" ? (
          <div
            role="group"
            aria-label="图标颜色"
            aria-disabled={colorLocked}
            className={cn(
              "mt-2.5 flex flex-wrap items-center gap-2",
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
          </div>
        ) : null}

        <div
          role="group"
          aria-label={iconTab === "glyph" ? "内置吉祥物" : "内置头像"}
          className="mt-3 grid grid-cols-8 justify-items-center gap-1.5"
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
                      "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring size-9 shrink-0 overflow-hidden rounded-lg transition-transform hover:scale-105 enabled:active:scale-[0.96]",
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
      </PopoverContent>
    </Popover>
  );
};
