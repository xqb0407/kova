# CodeMirror 集成 + 外观「代码块主题」设计

## 背景与决策（已确认）

- 现状：项目零 CodeMirror 依赖；右侧 Agent 面板的两处代码/diff 视图（活动页「文件变更」`files-section.tsx`、审查页真 diff `git-files.tsx`）都是手写 `<pre>` 逐行着色，无语法高亮。
- **CodeMirror 只服务右侧面板**（diff 展示 + 代码查看），聊天区 Streamdown/Shiki 渲染不动。
- 新设置「外观 → 代码块主题」**只控制 CodeMirror**，候选：**默认 GitHub / VS Code / IntelliJ IDEA**（三套均含浅深双版本）。
- 预览形态：**设置页内嵌实时预览**（仿现有字体预览模式）。

## 一、依赖选型

```
bun add @uiw/react-codemirror codemirror @codemirror/view @codemirror/state \
  @codemirror/language @codemirror/language-data @codemirror/merge \
  @uiw/codemirror-theme-github @uiw/codemirror-theme-vscode @uiw/codemirror-theme-idea
```

- `@uiw/react-codemirror`：编辑器 React 生命周期封装（查看器/预览用）。
- `@uiw/codemirror-theme-github|vscode|idea`：三套主题，各自导出 light/dark（`githubLight/githubDark`、`vscodeLight/vscodeDark`、`ideaLight/ideaDark`）。
- `@codemirror/language-data`：按扩展名懒加载语言包（bundle 友好，只有展开过的文件类型才拉取）。
- `@codemirror/merge`：`before/after` 双文本的 inline（unified）diff 视图。
- 若某包与现有 React 19 有 peer 冲突，实现时降级为直接手搭 `EditorView`（备选路径，不改变接口）。

## 二、主题配置链路（复用 ui-prefs 模式）

1. **`lib/ui-prefs.ts`**：新增 `export type CodeThemeName = "default" | "vscode" | "idea"`；`UiPrefs` 加 `codeTheme` 字段（默认 `"default"`）；`applyPrefs()` 写 `root.dataset.codeTheme`（default 时 delete，与 fontFamily 同款式）。
2. **`app/layout.tsx`**：`UI_PREFS_BOOTSTRAP` 内联脚本同步加 `data-code-theme`（该文件注释明确要求两处一致；虽然 CodeMirror 主题走 JS extension，此属性同时供预览区 CSS 微调与未来消费）。
3. **`lib/code-theme.ts`（新）**：主题注册表单一事实源：
   - `codeThemeExtension(name, dark): Extension` → 映射到对应 @uiw 主题；
   - `DIFF_COLORS[name][dark]` → 每个主题的 +/− 行底色（GitHub 绿/红、VSCode 绿/红、IDEA 蓝/橙），供 patch 装饰用；
   - `languageForPath(path): Promise<Extension[]>` → 从 `languageData` 按文件名匹配语言描述并 `load()`，未命中返回空（纯文本）。

## 三、CodeMirror 组件层（新目录 `components/code/`）

1. **`cm-editor.tsx` → `<CodeMirrorBlock>`**：只读代码块（也供预览复用）。
   - props：`value`、`path`（推断语言）、`maxHeight`、`wrap` 等；`basicSetup` 定制：关自动补全/搜索面板，保留行号（可关）。
   - 内部 `useUiPrefs().codeTheme` + **`useHtmlDark()`**（MutationObserver 监听 `<html>` 的 `.dark` 类）→ 主题即时切换，与系统深色跟随无缝一致。
   - 语言扩展异步加载，加载前纯文本渲染，不闪烁报错。
   - 对外预留 `editable/onChange`，本次不接编辑保存。
2. **`cm-diff.tsx` → `<CodeMirrorDiff>`**：
   - `oldText/newText/path` → `@codemirror/merge` inline unified 视图（`mergeControls:false`、隐藏变更条、只读），行级 +/- 背景由当前主题决定；
   - 只有 patch 文本的场景 → 走 `CodeMirrorBlock` + `patchDecorations()`（按行首 `+/-/@@` 应用 `DIFF_COLORS` 背景装饰，语法高亮用 patch 内容自身的语言由 path 提供——本期先整体着色，逐 hunk 高亮留作后续）。
3. **样式**：`app/styles/codemirror.css`（新，globals.css 引入）：`.cm-editor` 字号 11px、行高 1.6、背景透明继承 `bg-muted/20` 卡片底色、gutter 弱化、max-height 滚动条与面板现有风格统一；`font-family` 跟随 `--app-font-mono`。

## 四、面板接入（替换手写 diff 渲染）

1. **`files-section.tsx`（活动/审查派生视图）`EntryDiff`**：逐行 map 换成 `<CodeMirrorDiff oldText={…} newText={…} path={group.path}>`；保留现有头部（op 图标、±计数）、失败输出、`MAX_DIFF_LINES` 展开逻辑（折叠=限制 editor maxHeight，展开=放开）。编辑器仅在卡片展开后挂载，收起即卸载（性能）。
2. **`git-files.tsx` `GitFileCard`**：展开体换成 `<CodeMirrorBlock value={f.patch} path={f.path}>` + patch 行装饰；`⋯ 展开剩余行` 交互保留；二进制/截断提示不变。
3. 检查点卡片（`checkpoint-bar`）→ GitReview(checkpoint) 链路自动受益，无需改。

## 五、外观设置页（`appearance-settings.tsx`）

- 「界面」卡片内、字体行之后加：
  - `<SettingRow label="代码块主题" desc="仅作用于右侧面板的代码与 diff 展示">` + `Select`（默认 GitHub / VS Code / IntelliJ IDEA，受控 `prefs.codeTheme` → `setUiPref("codeTheme", v)`）。
- 该行下方加**内嵌实时预览卡** `code-theme-preview.tsx`（新）：一段 12 行左右的 TS 示例（注释/字符串/数字/装饰器/箭头函数）用 `<CodeMirrorBlock>` 渲染，另附一小段 diff 示例用 `<CodeMirrorDiff>` 渲染；切主题/深浅色即时重绘（组件自身订阅 store，无需额外机制）。

## 六、明确不做（本期边界）

- 不动聊天区 Streamdown/Shiki（`shikiTheme` 保持现状）；
- 不做代码编辑保存、不做自定义主题编辑器；
- 不做窗口标题栏级别的 diff 侧边对比视图（仅 unified）。

## 七、实施顺序与验证

1. 装依赖 → `lib/ui-prefs.ts`/`layout.tsx`/`lib/code-theme.ts`（配置链路，`bunx tsc --noEmit` 验证类型）。
2. `components/code/` 组件层 + CSS。
3. 面板两处接入（`bun run dev` 下打开活动/审查标签人工核对 diff 观感与展开性能）。
4. 设置页行 + 预览卡；验证：刷新后主题保持（localStorage）、跟随系统切深浅色、三主题切换预览即时变色。
5. 收尾：`bun run build` 通过；bundle 报告确认语言包为按需分块。

**风险与预案**：@uiw 主题包与 CM6 细节 API（merge inline 模式选项名）以实现时官方文档/类型为准微调；若 `@codemirror/merge` 在折叠 hunk 场景体验不佳，退路是 files-section 也走「patch 文本 + 装饰」统一实现（接口不变）。