"use client";

import { memo } from "react";
import type { TextMessagePartComponent } from "@assistant-ui/react";
import type { Unstable_DirectiveFormatter } from "@assistant-ui/react";
import { unstable_defaultDirectiveFormatter } from "@assistant-ui/react";
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
 */
export const directiveChipVariants =
  "[&_.aui-directive-chip]:inline-flex [&_.aui-directive-chip]:items-baseline [&_.aui-directive-chip]:gap-1 [&_.aui-directive-chip]:rounded-md [&_.aui-directive-chip]:bg-blue-100 [&_.aui-directive-chip]:px-1.5 [&_.aui-directive-chip]:py-0.5 [&_.aui-directive-chip]:text-[13px] [&_.aui-directive-chip]:leading-none [&_.aui-directive-chip]:font-medium [&_.aui-directive-chip]:text-blue-700 dark:[&_.aui-directive-chip]:bg-blue-900/50 dark:[&_.aui-directive-chip]:text-blue-300 [&_.aui-directive-chip-icon]:self-center";

/** Creates a `Text` message part component that parses directive syntax and renders inline chips. */
export function createDirectiveText(
  formatter: Unstable_DirectiveFormatter,
  options?: CreateDirectiveTextOptions,
): TextMessagePartComponent {
  return createDirectiveTextBase(formatter, options);
}

/** `Text` message part component that renders directive syntax as inline chips. */
export const DirectiveText: TextMessagePartComponent = memo(
  createDirectiveTextBase(unstable_defaultDirectiveFormatter),
);
