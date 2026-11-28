"use client";

/**
 * DiceBear 图标选择网格（资料库笔记「页面图标」等场景通用）。
 *
 * 两组风格源：
 * - 图标：Bootstrap Icons 集（MIT，146 个），值 `dicebear:icons:<名字>`，
 *   线条字形跟随文字色；
 * - 随机风格头像：fun-emoji / bottts-neutral / croodles-neutral /
 *   pixel-art-neutral，值 `dicebear:<风格>:<背景>:<seed>`，与项目头像同一
 *   格式同一渲染管线（projectAvatarSrc）；「换一批」换 seed，选中的值不变。
 *
 * 只渲染弹层内容（页签 + 网格 + 移除入口），触发按钮与浮层壳由宿主持有
 * （如 NoteIcon 的 40px 图标槽），不同入口可复用同一份选择器。
 */

import { useEffect, useMemo, useState } from "react";
import { RefreshCwIcon } from "lucide-react";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import {
  DICEBEAR_ICON_NAMES,
  dicebearIconSvg,
  dicebearIconValue,
} from "@/lib/ui/dicebear-icons";
import { dicebearStyleAvatarValue, projectAvatarSrc } from "@/lib/projects/project-avatars";

/** 头像风格页签：挑在 20–40px 下读得清、气质适合当笔记图标的几款 */
const AVATAR_TABS = [
  { styleId: "fun-emoji", labelKey: "library.editor.iconTabFun" },
  { styleId: "bottts-neutral", labelKey: "library.editor.iconTabBots" },
  { styleId: "croodles-neutral", labelKey: "library.editor.iconTabDoodle" },
  { styleId: "pixel-art-neutral", labelKey: "library.editor.iconTabPixel" },
] as const;

type TabId = "glyphs" | (typeof AVATAR_TABS)[number]["styleId"];

/** 每页几张头像；「换一批」翻 roll 换 seed */
const AVATAR_CELLS = 32;
const AVATAR_COLS = 8;

/** seed 白名单 [a-z0-9]{4,16}：roll 0 用基础串，之后前缀 roll 号 */
const avatarSeed = (roll: number, index: number): string =>
  roll === 0 ? `icon${index}` : `${roll}icon${index}`;

export function DicebearIconPicker({
  value,
  onChange,
  className,
}: {
  /** 当前值（dicebear 图标/头像或 emoji）；null/未设置 = 无图标 */
  value?: string | null;
  onChange: (next: string | null) => void;
  className?: string;
}) {
  const t = useT();
  const [tab, setTab] = useState<TabId>("glyphs");
  const [roll, setRoll] = useState(0);
  // 懒生成：弹层刚挂载/切页签/换一批时先出骨架占位，空闲档再真正生成
  // 图标（146 个 glyph SVG / 32 张头像 data URI 的首次构建不算便宜）。
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
  }, [tab, roll]);

  /** 头像格子的 id 列表（纯字符串拼装，便宜）；data URI 到渲染时才算 */
  const avatarIds = useMemo(() => {
    const style = AVATAR_TABS.find((t2) => t2.styleId === tab);
    if (!style) return [];
    const ids: string[] = [];
    for (let index = 0; index < AVATAR_CELLS; index += 1) {
      const id = dicebearStyleAvatarValue(style.styleId, avatarSeed(roll, index));
      if (id) ids.push(id);
    }
    return ids;
  }, [tab, roll]);

  const gridCount = tab === "glyphs" ? DICEBEAR_ICON_NAMES.length : avatarIds.length;

  const tabButton = (tabId: TabId, label: string) => (
    <button
      key={tabId}
      type="button"
      onClick={() => setTab(tabId)}
      aria-pressed={tab === tabId}
      className={cn(
        "hover:bg-hover text-muted-foreground inline-flex h-7 shrink-0 items-center whitespace-nowrap rounded-md px-2 text-sm transition-colors",
        tab === tabId && "bg-selected text-foreground",
      )}
    >
      {label}
    </button>
  );

  return (
    <div className={cn("w-80", className)}>
      <div className="mb-1.5 flex items-center gap-1">
        {tabButton("glyphs", t("library.editor.iconTabGlyphs"))}
        {AVATAR_TABS.map((t2) => tabButton(t2.styleId, t(t2.labelKey)))}
        {tab !== "glyphs" ? (
          <button
            type="button"
            onClick={() => setRoll((n) => n + 1)}
            title={t("library.editor.iconShuffle")}
            aria-label={t("library.editor.iconShuffle")}
            className="text-muted-foreground hover:bg-hover hover:text-foreground ml-auto inline-flex size-6 items-center justify-center rounded-md transition-colors"
          >
            <RefreshCwIcon className="size-3.5" />
          </button>
        ) : null}
      </div>
      <div className="grid max-h-72 grid-cols-8 gap-0.5 overflow-y-auto">
        {!gridReady
          ? // 骨架：数量与真实网格一致，避免就绪时高度跳动
            Array.from({ length: gridCount }, (_, i) => (
              <span
                key={`skeleton-${i}`}
                className="bg-muted/50 size-8 animate-pulse rounded"
              />
            ))
          : tab === "glyphs"
          ? DICEBEAR_ICON_NAMES.map((name) => {
              const selected = value === dicebearIconValue(name);
              return (
                <button
                  key={name}
                  type="button"
                  title={name}
                  aria-label={name}
                  aria-pressed={selected}
                  onClick={() => onChange(dicebearIconValue(name))}
                  className={cn(
                    "text-foreground hover:bg-hover grid size-8 place-items-center rounded transition-colors",
                    selected && "bg-selected",
                  )}
                >
                  <span
                    aria-hidden
                    className="[&>svg]:size-5.5 [&>svg]:shrink-0"
                    // eslint-disable-next-line react/no-danger -- SVG 由本地打包的静态数据集生成（见 dicebear-icons），非用户输入
                    dangerouslySetInnerHTML={{ __html: dicebearIconSvg(name) }}
                  />
                </button>
              );
            })
          : avatarIds.map((id) => {
              const selected = value === id;
              const src = projectAvatarSrc(id);
              return (
                <button
                  key={id}
                  type="button"
                  aria-label={id}
                  aria-pressed={selected}
                  onClick={() => onChange(id)}
                  className={cn(
                    "hover:bg-hover grid size-8 place-items-center rounded transition-colors",
                    selected && "bg-selected",
                  )}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element -- src 来自本仓库静态数据集确定性生成，非用户输入 */}
                  {src ? (
                    <img
                      src={src}
                      alt=""
                      aria-hidden
                      draggable={false}
                      className="size-7"
                    />
                  ) : null}
                </button>
              );
            })}
      </div>
      {value ? (
        <button
          type="button"
          onClick={() => onChange(null)}
          className="hover:bg-hover text-muted-foreground mt-1.5 w-full rounded-md px-2 py-1.5 text-left text-sm transition-colors"
        >
          {t("library.editor.removeIcon")}
        </button>
      ) : null}
    </div>
  );
}
