"use client";

/**
 * 笔记页面图标渲染（编辑器 40px 槽 / 查看器顶栏 / 文件树行共用）。
 *
 * 三种形态（见 lib/ui/dicebear-icons 的 parseNoteIcon）：
 * - emoji 旧值：按文本渲染；
 * - `dicebear:icons:<名字>`：内联 SVG，fill=currentColor 跟随文字色；
 * - `dicebear:<风格>:<背景>:<seed>`：随机风格头像（与项目头像同一格式），
 *   彩色自带底盘，走 projectAvatarSrc 的 data URI（<img>）。
 * 尺寸由 className 给：默认编辑器槽 40px；小尺寸传 `size-4 text-sm`——emoji
 * 用字号撑、svg/img 用盒子尺寸，各分支都要覆盖。
 */

import { cn } from "@/lib/utils";
import {
  dicebearIconSvg,
  parseNoteIcon,
} from "@/lib/ui/dicebear-icons";
import { projectAvatarSrc } from "@/lib/projects/project-avatars";

export function NoteIconGlyph({
  icon,
  className,
}: {
  icon: string;
  className?: string;
}) {
  const parsed = parseNoteIcon(icon);
  if (!parsed) {
    return (
      <span
        className={cn(
          "inline-block size-10 text-[40px] leading-none",
          className,
        )}
      >
        {icon}
      </span>
    );
  }
  if (parsed.kind === "avatar") {
    const src = projectAvatarSrc(parsed.id);
    if (src) {
      return (
        // eslint-disable-next-line @next/next/no-img-element -- src 来自本仓库静态数据集确定性生成，非用户输入
        <img
          src={src}
          alt=""
          aria-hidden
          draggable={false}
          className={cn("inline-block size-10", className)}
        />
      );
    }
    return null;
  }
  return (
    <span
      aria-hidden
      className={cn(
        "text-foreground inline-block size-10 [&>svg]:size-full",
        className,
      )}
      // eslint-disable-next-line react/no-danger -- SVG 由本地打包的静态数据集生成（见 lib/ui/dicebear-icons），非用户输入
      dangerouslySetInnerHTML={{ __html: dicebearIconSvg(parsed.name) }}
    />
  );
}
