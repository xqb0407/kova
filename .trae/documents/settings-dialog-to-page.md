# 设置从弹窗改为页面形式（二级侧边栏）

## Context

当前设置是 `SettingsModal`（Dialog 弹窗，左侧 4 个 tab + 右侧内容），由主侧边栏底部的"设置"按钮触发。用户希望改成截图（Cherry Studio 风格）的页面形式：点击底部"设置"后，聊天内容区切换为设置页面，页面自带**二级侧边栏**（含"‹ 返回应用"按钮 + 分组菜单），点击"返回应用"回到聊天。

用户已确认的范围：
- **仅替换主内容区**：主侧边栏保持可见，设置页只替换右侧聊天区域（Header 保留，因其承载窗口拖拽区 / Windows WindowControls）。
- **仅现有 4 项分组**：偏好 → 通用/外观；AI → 模型；系统 → 远程访问。不做占位菜单项。
- **内容原样迁移**：ModelSettings / RemoteSettings / AppearanceSettings 组件不动，只改导航容器。

## 改动文件（共 3 个）

### 1. `components/settings/settings-modal.tsx` → `settings-page.tsx`（git mv + 重写）

- `git mv` 保留历史，然后重写内容：
  - 删除 Dialog 相关导入与渲染，组件改名 `SettingsPage`，新增 prop `onBack: () => void`。
  - 默认选中 section 保持 `"models"`。
  - 布局：`flex h-full w-full bg-background`
    - **二级侧边栏** `<nav>`：`w-56 shrink-0 border-r bg-muted/40 p-3 flex flex-col gap-1`
      - 顶部"‹ 返回应用"按钮（`ChevronLeftIcon`，`h-8 rounded-md px-2.5 text-sm text-muted-foreground hover:bg-muted`），点击调 `onBack`。
      - 分组菜单，复用现有按钮样式（`data-active` 高亮，见原文件 L52-66）：
        - 偏好：通用 `SlidersHorizontalIcon`、外观 `PaintbrushIcon`
        - AI：模型 `BoxesIcon`（默认选中）
        - 系统：远程访问 `GlobeIcon`
      - 分组标题样式：`text-muted-foreground px-2 text-xs font-medium`（参考原 L49-51）。
      - 不做搜索框（仅 4 项，无意义）。
    - **内容区**：`min-w-0 flex-1 overflow-y-auto`，按 section 原样渲染 `<ModelSettings />`、`<RemoteSettings />`、`<AppearanceSettings />`、通用占位。

### 2. `components/agent-thread/clone-thread-shell.tsx`

- 删除：`settingsOpen` state（L92）、`SettingsModal` 导入（L42）与渲染（L574）。
- `CloneThreadShellProps` 新增 `onOpenSettings?: () => void`。
- 桌面侧边栏底部设置按钮（L430）：`onClick={() => onOpenSettings?.()}`。
- 移动端 Sheet 内设置按钮（L526）：先 `setMobileOpen(false)` 再调 `onOpenSettings?.()`。
- `isRemoteMode()` 隐藏逻辑保持不变。

### 3. `components/agent-thread/base.tsx`

- 新增视图状态：`const [view, setView] = useState<"chat" | "settings">("chat")`。
- 传 `onOpenSettings={() => setView("settings")}` 给 `CloneThreadShell`。
- `<main>` 内切换（Header 保持挂载，窗口 chrome 不受影响）：

```tsx
<main className="flex-1 overflow-hidden">
  {view === "settings" ? (
    <SettingsPage onBack={() => setView("chat")} />
  ) : (
    <Thread />
  )}
</main>
```

## 不改的内容

- `model-settings.tsx` / `remote-settings.tsx` / `appearance-settings.tsx` 内容与样式（后续按截图重排另起任务）。
- 主侧边栏结构、折叠逻辑、移动端 Sheet 结构。
- 无路由变化（静态导出，纯视图状态切换）。

## 验证

1. `npx tsc --noEmit` 通过。
2. `bun run dev`（浏览器）/ `bun run tauri:dev`（桌面）手动验证：
   - 点击侧边栏底部"设置"→ 内容区切换为设置页，二级侧边栏显示"‹ 返回应用"与 3 组菜单，默认进入"模型"。
   - 切换 通用/外观/远程访问 内容正常渲染。
   - 点击"返回应用"回到聊天，会话与侧边栏状态保留。
   - 移动端窄屏：Sheet 内点"设置"→ Sheet 关闭并进入设置页。
