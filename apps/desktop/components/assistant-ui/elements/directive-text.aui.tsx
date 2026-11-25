"use client";

import { memo } from "react";
import type { TextMessagePartComponent } from "@assistant-ui/react";
import type { Unstable_DirectiveFormatter } from "@assistant-ui/react";
import { unstable_defaultDirectiveFormatter } from "@assistant-ui/react";
import {
  FileCodeIcon,
  InboxIcon,
  LibraryIcon,
  MessageSquareTextIcon,
  ZapIcon,
} from "lucide-react";
import {
  createDirectiveText as createDirectiveTextBase,
  type CreateDirectiveTextOptions,
} from "./directive-text";

export type {
  CreateDirectiveTextOptions,
  DirectiveTextFormatter,
  DirectiveTextSegment,
} from "./directive-text";

/**
 * 芯片配色的 Tailwind 任意变体集合，加在包含芯片文本的容器元素上。
 * Badge 默认 variant=secondary 的 bg-secondary 与气泡 bg-muted / composer 底色
 * 几乎同色、视觉隐身——chip 样式必须显式挂容器，composer 输入与消息气泡共用这份。
 * align-middle：药丸比正文多 2px 上下内边距，按基线排会整体下沉 2–3px（实测
 * 芯片标签比相邻文字低），改成中线对齐让药丸与文字处在同一视觉中线。
 */
export const directiveChipVariants =
  "[&_.aui-directive-chip]:mx-1.5 [&_.aui-directive-chip]:inline-flex [&_.aui-directive-chip]:align-middle [&_.aui-directive-chip]:items-baseline [&_.aui-directive-chip]:gap-1 [&_.aui-directive-chip]:rounded-[4px] [&_.aui-directive-chip]:bg-blue-100 [&_.aui-directive-chip]:pl-1.5 [&_.aui-directive-chip]:pr-2.5 [&_.aui-directive-chip]:py-0.5 [&_.aui-directive-chip]:text-[13px] [&_.aui-directive-chip]:leading-none [&_.aui-directive-chip]:font-medium [&_.aui-directive-chip]:text-blue-700 dark:[&_.aui-directive-chip]:bg-blue-900/50 dark:[&_.aui-directive-chip]:text-blue-300 [&_.aui-directive-chip-icon]:self-center";

/** Creates a `Text` message part component that parses directive syntax and renders inline chips. */
export function createDirectiveText(
  formatter: Unstable_DirectiveFormatter,
  options?: CreateDirectiveTextOptions,
): TextMessagePartComponent {
  return createDirectiveTextBase(formatter, options);
}

/** `Text` message part component that renders directive syntax as inline chips.
 *  资料库/代码引用芯片在消息里也带图标（与输入框内的芯片一致）；其余指令
 *  沿用无图标样式，与历史行为一致。 */
export const DirectiveText: TextMessagePartComponent = memo(
  createDirectiveTextBase(unstable_defaultDirectiveFormatter, {
    iconMap: {
      library: LibraryIcon,
      command: ZapIcon,
      inbox: InboxIcon,
      code: FileCodeIcon,
      comment: MessageSquareTextIcon,
    },
  }),
);
