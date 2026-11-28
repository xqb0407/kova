"use client";

/**
 * 项目外观选择器：「新建/编辑工作区」名称行左侧的头像按钮 + 弹出面板。
 *
 * 触发按钮显示项目当前身份（上传图/内置头像/着色吉祥物；都没有时回退
 * 文件夹图标），点击弹出参考创建类弹窗的面板：单排小页签（图标 / 预设 /
 * 趣味 / 机器人 / 涂鸦 / 像素，与笔记图标选择器同款，溢出横向滚动）→
 * 色板行（默认 + 9 预设，仅图标档）→ 图标网格（8 列）。
 *
 * 图标目录与资料库笔记图标同源（lib/ui/dicebear-icons）：图标档 =
 * 12 矢量吉祥物 + 146 个 Bootstrap 线条图标（着色跟随主色，可滚动）；
 * 头像档 = 「经典（Gaze）/ 趣味 / 机器人 / 涂鸦 / 像素」五档，全部走
 * 同一条 DiceBear 风格管线（dicebear:<style>:<bg>:<seed>，见
 * project-avatars）：按 seed 生成 32 张、「换一批」翻 roll 换 seed（与
 * 笔记图标选择器 dicebear-icon-picker 同一套模式）。右上的随机按钮按
 * 档位统一自适应：图标档随机图标+主色，头像档「换一批」（选中值不动）。
 * 早期 24 张固定 Gaze 预设（gaze-01…）仍可渲染（旧数据兼容），只是不再
 * 出现在选择面板里。
 *
 * 组件是受控的：调用方只拿 next appearance，存哪、怎么归一由调用方决定
 * （创建弹窗先存草稿、点创建才落库）。
 */
import { useEffect, useMemo, useState, type FC } from "react";
import { DicesIcon, RefreshCwIcon, RotateCcwIcon } from "lucide-react";
import { ProjectFolderClosedIcon } from "@/components/icons/project-folder-icons";
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
  dicebearStyleAvatarValue,
  projectAvatarSrc,
} from "@/lib/projects/project-avatars";
import {
  DICEBEAR_ICON_NAMES,
  dicebearIconSvg,
  dicebearIconValue,
} from "@/lib/ui/dicebear-icons";
import {
  PROJECT_GLYPH_ICONS,
  projectColorTokens,
  ProjectBadge,
} from "@/components/ui/project-badge";
import { hasProjectAppearance } from "@/lib/projects/project-appearance";
import { useT } from "@/lib/i18n";

/** 头像档：Gaze（应用沿用多年的预设风格）+ 4 个 DiceBear 风格档，
 *  全部走同一条 dicebear:<style>:<bg>:<seed> 管线 */
const AVATAR_STYLE_TABS = [
  { styleId: "gaze", labelKey: "chat.workspaceDialog.avatarTabGaze" },
  { styleId: "fun-emoji", labelKey: "chat.workspaceDialog.avatarTabFun" },
  { styleId: "bottts-neutral", labelKey: "chat.workspaceDialog.avatarTabBots" },
  { styleId: "croodles-neutral", labelKey: "chat.workspaceDialog.avatarTabDoodle" },
  { styleId: "pixel-art-neutral", labelKey: "chat.workspaceDialog.avatarTabPixel" },
] as const;

/** 面板页签：吉祥物/线条图标一档 + 头像各风格档 */
type Pane = "glyph" | (typeof AVATAR_STYLE_TABS)[number]["styleId"];

/** 每档几张风格头像；「换一批」翻 roll 换 seed（与笔记图标选择器同参） */
const AVATAR_CELLS = 32;

/** seed 白名单 [a-z0-9]{4,16}：roll 0 用基础串，之后前缀 roll 号 */
const avatarSeed = (roll: number, index: number): string =>
  roll === 0 ? `icon${index}` : `${roll}icon${index}`;

/** 吉祥物页可选的 glyph 值全集：12 吉祥物 id + dicebear 线条图标值 */
const GLYPH_CHOICES: readonly string[] = [
  ...PROJECT_MASCOT_GLYPHS.map((glyph) => glyph.id),
  ...DICEBEAR_ICON_NAMES.map(dicebearIconValue),
];

/** 数组随机取一（randomize 专用；调用方不要求密码学随机） */
function pickOne<T>(list: readonly T[]): T {
  return list[Math.floor(Math.random() * list.length)]!;
}

/** 图标格：32px 圆角方块 + 升一级的 hover 底。图标本身统一跟项目主色走，
 *  选中只加底色/描边——不再把未选项压灰，"展开"与"收起"是同一套颜色。
 *  选中环画在格子内侧（::after 覆层 + inset ring）：网格容器 overflow 滚动
 *  会裁掉一切超出格子的描边，外扩 ring 在顶部/滚动中途必然缺一条边 */
const CELL_BASE =
  "relative grid size-8 shrink-0 place-items-center rounded-lg transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";
const CELL_IDLE = "hover:bg-muted";
const CELL_ON =
  "bg-foreground/[0.06] after:pointer-events-none after:absolute after:inset-0 after:rounded-[inherit] after:ring-2 after:ring-inset after:ring-foreground/40 after:content-['']";

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
  // 单排页签（无胶囊分段）：当前身份是风格头像停在对应风格档，其他头像
  // （旧 Gaze 预设/早期随机 id）归入经典档，否则看图标档
  const [pane, setPane] = useState<Pane>(() => {
    const matched = AVATAR_STYLE_TABS.find((tab) =>
      appearance?.avatar?.startsWith(`dicebear:${tab.styleId}:`),
    );
    if (matched) return matched.styleId;
    return appearance?.avatar ? "gaze" : "glyph";
  });
  /** 风格档的「换一批」翻页号：换 seed 换一批，选中的值不受影响 */
  const [roll, setRoll] = useState(0);

  // 懒生成：面板刚挂载/切页签/换一批时先出骨架占位，空闲档再真正生成
  // 图标（158 个 glyph SVG / 32 张头像 data URI 的首次构建不算便宜）。
  // 生成结果在 lib 层缓存，之后重开/切回都是即时的。
  const [gridReady, setGridReady] = useState(false);
  useEffect(() => {
    setGridReady(false);
    let cancelled = false;
    const w = window as Window & {
      requestIdleCallback?: (cb: () => void) => number;
    };
    const schedule = () => {
      if (typeof w.requestIdleCallback === "function") {
        w.requestIdleCallback(() => {
          if (!cancelled) setGridReady(true);
        });
      } else {
        window.setTimeout(() => {
          if (!cancelled) setGridReady(true);
        }, 32);
      }
    };
    schedule();
    return () => {
      cancelled = true;
    };
  }, [pane, roll]);

  /** 风格档的头像 id 列表（纯字符串拼装，便宜）；data URI 到渲染时才算 */
  const avatarIds = useMemo(() => {
    const style = AVATAR_STYLE_TABS.find((tab) => tab.styleId === pane);
    if (!style) return [];
    const ids: string[] = [];
    for (let index = 0; index < AVATAR_CELLS; index += 1) {
      const id = dicebearStyleAvatarValue(style.styleId, avatarSeed(roll, index));
      if (id) ids.push(id);
    }
    return ids;
  }, [pane, roll]);

  /** 网格单元数：骨架占位按它出，就绪时高度不跳 */
  const gridCount =
    pane === "glyph"
      ? PROJECT_MASCOT_GLYPHS.length + DICEBEAR_ICON_NAMES.length
      : avatarIds.length;

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

  /** 图标档的随机：随机吉祥物/线条图标 + 随机预设色（连点连换）。onChange
   *  是受控回调（非 setState updater），必须一次组装完再传。 */
  const randomizeGlyph = () => {
    onChange({
      ...withIdentity(appearance, { glyph: pickOne(GLYPH_CHOICES) }),
      color: pickOne(PROJECT_MASCOT_COLORS),
    });
  };

  /** 面板页签按钮（样式对齐笔记图标选择器的小页签） */
  const paneTabButton = (paneId: Pane, label: string) => (
    <button
      key={paneId}
      type="button"
      onClick={() => setPane(paneId)}
      aria-pressed={pane === paneId}
      className={cn(
        "text-muted-foreground hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring inline-flex h-6 shrink-0 items-center whitespace-nowrap rounded-md px-1.5 text-2xs transition-colors",
        pane === paneId && "bg-selected text-foreground",
      )}
    >
      {label}
    </button>
  );

  // 上传图片显示时「恢复默认」没有意义（清掉 glyph/avatar 也看不见），
  // 只在真正有内置身份、且图片没盖住时才提供
  const hasBuiltinIdentity = Boolean(
    (appearance?.glyph || appearance?.avatar) && !appearance?.image,
  );
  /** 头像档：右上按钮统一作「换一批」 */
  const isStylePane = pane !== "glyph";
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
                className="size-4 rounded-md [&>svg]:size-5"
              />
            ) : (
              <ProjectFolderClosedIcon className="text-muted-foreground size-4" />
            )}
          </button>
        }
      />
      <PopoverContent
        align="start"
        /* 弹窗里锚点行的高低随表单内容变化，默认碰撞避让会"一下翻上、一下朝下"。
           钉死在下方（面板走 Portal，超出弹窗/视口也不会被裁），水平方向 shift
           进视口；高度用 --available-height 兜底，空间紧时内部网格自己滚动 */
        collisionAvoidance={{ side: "none", align: "shift", fallbackAxisSide: "none" }}
        className="max-h-(--available-height) w-[23rem] gap-0 p-3 ring-0 border border-border/50"
      >
        {/* 单排页签：图标 + 头像各档并排；放不下时页签区横向滚动（滑块形式，
            滚动条隐藏），恢复默认/随机始终贴右 */}
        <div className="flex items-center gap-1">
          <div className="scrollbar-none flex min-w-0 items-center gap-1 overflow-x-auto">
            {paneTabButton("glyph", t("chat.workspaceDialog.iconTabGlyph"))}
            {AVATAR_STYLE_TABS.map((tab) =>
              paneTabButton(tab.styleId, t(tab.labelKey)),
            )}
          </div>
          <div className="ml-auto flex shrink-0 items-center gap-1">
            {/* 恢复默认只在真正有内置身份时出现；随机固定贴右 */}
            {hasBuiltinIdentity ? (
              <button
                type="button"
                onClick={resetBuiltinIdentity}
                title={t("chat.workspaceDialog.resetIdentity")}
                aria-label={t("chat.workspaceDialog.resetIdentity")}
                className="text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring inline-flex size-6 shrink-0 items-center justify-center rounded-md transition-colors"
              >
                <RotateCcwIcon className="size-3.5" />
              </button>
            ) : null}
            {/* 档位自适应的统一随机入口：图标档=随机图标+主色，预设档=随机
                选一张预设，风格档=「换一批」（翻 seed 重出整批，选中值不动） */}
            <button
              type="button"
              title={
                isStylePane
                  ? t("chat.workspaceDialog.iconShuffle")
                  : t("chat.workspaceDialog.random")
              }
              aria-label={
                isStylePane
                  ? t("chat.workspaceDialog.iconShuffle")
                  : t("chat.workspaceDialog.random")
              }
              onClick={() => {
                if (pane === "glyph") randomizeGlyph();
                else setRoll((n) => n + 1);
              }}
              className="text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring inline-flex h-6 shrink-0 items-center gap-1 rounded-full px-1.5 text-2xs transition-colors"
            >
              {isStylePane ? (
                <RefreshCwIcon className="size-3.5" />
              ) : (
                <DicesIcon className="size-3.5" />
              )}
              {isStylePane
                ? t("chat.workspaceDialog.iconShuffle")
                : t("chat.workspaceDialog.random")}
            </button>
          </div>
        </div>

        {/* 第二行：图标档放色板，其余档不占行（换一批并进右上按钮） */}
        {pane === "glyph" ? (
          /* 色板只服务吉祥物/线条图标：头像自带配色，头像页不渲染色板，
              避免"切到头像还能看到颜色"的误解 */
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

        {/* 图标网格：面板被 --available-height 压矮时滚动的是这里，图标档
            158 格平时靠自身的滚动条翻页 */}
        <div
          role="group"
          aria-label={
            pane === "glyph" ? "内置吉祥物与线条图标" : "风格头像"
          }
          className="mt-2 grid min-h-0 content-start grid-cols-8 justify-items-center gap-1.5 overflow-y-auto p-1"
        >
          {!gridReady
            ? // 骨架：数量与真实网格一致，避免就绪时高度跳动
              Array.from({ length: gridCount }, (_, i) => (
                <span
                  key={`skeleton-${i}`}
                  className="bg-muted/50 size-8 animate-pulse rounded-lg"
                />
              ))
            : pane === "glyph"
            ? [
                ...PROJECT_MASCOT_GLYPHS.map((glyph) => {
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
                }),
                ...DICEBEAR_ICON_NAMES.map((name) => {
                  const value = dicebearIconValue(name);
                  const active = appearance?.glyph === value;
                  return (
                    <button
                      // key 用完整值：bootstrap 集里也有 `bug` 等与吉祥物 id 重名的图标
                      key={value}
                      type="button"
                      title={name}
                      aria-label={name}
                      aria-pressed={active}
                      onClick={() => pickGlyph(value)}
                      className={cn(CELL_BASE, active ? CELL_ON : CELL_IDLE)}
                    >
                      <span
                        aria-hidden
                        className="size-[18px] [&>svg]:size-full [&>svg]:shrink-0"
                        style={iconTint}
                        // eslint-disable-next-line react/no-danger -- SVG 由本地打包的静态数据集生成（见 lib/ui/dicebear-icons），非用户输入
                        dangerouslySetInnerHTML={{ __html: dicebearIconSvg(name) }}
                      />
                    </button>
                  );
                }),
              ]
            : avatarIds.map((id) => {
                const active = appearance?.avatar === id;
                const src = projectAvatarSrc(id);
                return (
                  <button
                    key={id}
                    type="button"
                    aria-label={id}
                    aria-pressed={active}
                    onClick={() => pickAvatar(id)}
                    className={cn(
                      "relative focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring size-9 shrink-0 overflow-hidden rounded-lg transition-transform hover:scale-105 enabled:active:scale-[0.96]",
                      active && CELL_ON,
                    )}
                  >
                    {src ? (
                      // eslint-disable-next-line @next/next/no-img-element -- src 来自本仓库静态数据集确定性生成，非用户输入
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
