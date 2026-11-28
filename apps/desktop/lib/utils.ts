/**
 * 全局 className 合并器。
 *
 * 在 cn 包默认配置上补两个字号档（13px / 15px）：界面正文大量使用 13px，
 * 若继续写任意值 `text-[13px]`，口径散落在 500 多处；用 `text-ui` 表达后，
 * 改字号只动 globals.css 一处。
 *
 * 必须在这里注册：tailwind-merge 默认只认内建号型，未知的 `text-xxx`
 * 会被当成文字颜色，与 `text-muted-foreground` 合并时会把字号整个丢掉。
 * 因此组件不要直接 `import { cn } from "cn"`，一律走 `@/lib/utils`。
 */
import { createCn } from "cn/config";

export const cn = createCn({
  extend: {
    classGroups: {
      "font-size": [{ text: ["ui", "ui-lg"] }],
    },
  },
});