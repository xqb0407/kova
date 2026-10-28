"use client";

/**
 * 子智能体头像：显式头像（内置 Clay 预设或上传的 data URL）→ 没设就按名称哈希
 * 落一张内置预设当默认——所以正常情况下永远是一张脸，没有"空态"。
 *
 * 只有图片加载失败（文件被清理/预设被删）才按 `fallback` 回落：
 * - "tile"（默认）：名称散列色块 + Bot 图标——设置页列表那种有底色的方块；
 * - "plain"：裸 Bot 图标——聊天侧工具行/快速查看里与其它工具图标并排。
 *
 * 尺寸与圆角都由父容器的 className 下发（与 LetterAvatar 同一约定）：
 * `className` 控制外层盒子，`iconClassName` 控制回落 Bot 图标的大小。
 */
import * as React from "react";
import type { CSSProperties, FC } from "react";
import { BotIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { hueFromName } from "@/lib/ui/name-hue";
import { resolveSubagentAvatarSrc } from "@/lib/subagent/avatar";

/**
 * mention iconMap 用的闭包图标组件工厂：每个子代理条目一个专属键
 * （`agent-avatar:<名字>`），组件闭包捕获名字与头像值——iconMap 的组件只收
 * className，拿不到条目数据，只能这样按条目造组件。本文件是 .tsx，JSX 写在这。
 */
export function subagentAvatarIconComponent(
  name: string,
  avatar: string | undefined,
): FC<{ className?: string }> {
  const Icon: FC<{ className?: string }> = ({ className }) => (
    <SubagentAvatar
      name={name}
      avatar={avatar}
      fallback="plain"
      className={cn("rounded-full", className)}
      iconClassName={className}
    />
  );
  return Icon;
}

export const SubagentAvatar: FC<{
  name: string;
  avatar?: string;
  /** 外层盒子：尺寸/圆角在这里给（如 "size-10 rounded-xl"、"size-4 rounded-md"） */
  className?: string;
  /** 回落 Bot 图标的尺寸/颜色类（tile 默认占盒子一半；plain 必须自己给尺寸） */
  iconClassName?: string;
  fallback?: "tile" | "plain";
}> = ({ name, avatar, className, iconClassName, fallback = "tile" }) => {
  const src = resolveSubagentAvatarSrc(avatar, name);
  // 记住"坏掉的 src"而不是布尔：avatar 换新值后自然重试，不用手动复位
  const [brokenSrc, setBrokenSrc] = React.useState<string | null>(null);
  const showImage = src !== null && brokenSrc !== src;

  if (!showImage && fallback === "plain") {
    return <BotIcon aria-hidden className={cn("shrink-0", iconClassName)} />;
  }

  return (
    <span
      aria-hidden
      className={cn("relative grid shrink-0 place-items-center overflow-hidden rounded-[inherit]", className)}
    >
      {showImage ? (
        <img
          src={src}
          alt=""
          draggable={false}
          onError={() => setBrokenSrc(src)}
          className="size-full object-cover"
        />
      ) : (
        <span
          style={{ "--av-h": String(hueFromName(name)) } as CSSProperties}
          className={cn(
            "grid size-full place-items-center",
            "bg-[hsl(var(--av-h)_72%_92%)] text-[hsl(var(--av-h)_58%_30%)]",
            "dark:bg-[hsl(var(--av-h)_42%_22%)] dark:text-[hsl(var(--av-h)_62%_84%)]",
          )}
        >
          <BotIcon className={iconClassName ?? "size-1/2"} />
        </span>
      )}
    </span>
  );
};
