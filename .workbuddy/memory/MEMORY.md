# 项目长期笔记

## 样式体系约定

- **Tailwind v4 + shadcn `base-vega`**（`components.json`），入口 `app/styles/globals.css`，无 `tailwind.config`，
  全部 token 走 CSS 变量 + `@theme inline`。
- **shadow**：使用 Tailwind 默认 scale，**不要**在 `@theme inline` 里覆盖 `--shadow-*`。
  shadcn 官方不定义 `--shadow-*`——已知来源出处：
  - `https://ui.shadcn.com/r/styles/base-vega/index.json` → `cssVars: {}`
  - `https://ui.shadcn.com/r/colors/neutral.json`（项目 oklch 配色来源）→ 仅颜色 + `--radius: 0.625rem`
- **`--app-*` 间接层惯例**：凡是要在浅/深模式间切换的 token，在 `@theme inline` 里必须写成引用
  （如 `--shadow-md: var(--app-shadow-md)`、`--font-sans: var(--app-font-sans)`），
  因为 inline 会内联值本身，直接写字面量会导致 `.dark` 覆盖失效。
- **主题驱动**：`.dark` 类挂在 html 上（`@custom-variant dark (&:where(.dark, .dark *))`），
  另有 `data-accent` / `data-font` / `data-chat-width` / `data-window-effect` 等属性档位，由 `lib/ui-prefs.ts` 落标。

## 已知待办

- `globals.css` 有两个大面积重复的 `@theme inline` 块（约 25-124 行、126-181 行），
  radius 定义互相冲突，后者生效。建议合并清理。

## 调试手法

- 项目没装 `@tailwindcss/cli`，验证 CSS 改动用临时脚本 + `postcss` + `@tailwindcss/postcss`
  把 `globals.css` 编出来直接看产物（`@source inline("...")` 指定候选类避免全量扫描）。
