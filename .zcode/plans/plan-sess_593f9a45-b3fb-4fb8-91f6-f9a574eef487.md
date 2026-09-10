## 修复：文件夹组展开时触发按钮不显示"选中"样式

### 根因
- `components/ui/button.tsx:17` 中 `ghost` variant 包含 `aria-expanded:bg-muted`。
- Base UI 的 `CollapsibleTrigger`（`@base-ui/react/collapsible`）展开时给触发元素设 `aria-expanded="true"`。
- 因此 `ProjectListItems` 里渲染成 Button 的组触发器（`components/assistant-ui/elements/thread-list.aui.tsx:322-340`）在展开状态下常驻 `bg-muted` 背景，视觉上像被选中。

### 改动（单文件、一行）
在 `components/assistant-ui/elements/thread-list.aui.tsx` 第 328 行，给该 `CollapsibleTrigger` 的 `render={<Button …>}` 的 className 追加覆盖类：

```tsx
className="h-8 justify-start gap-2 px-2.5 text-sm font-normal hover:bg-muted aria-expanded:bg-transparent"
```

- 项目的 `cn`（npm 包 `cn`，clsx + tailwind-merge 的替代实现）会在 `buttonVariants({ variant, size, className })` 合并时解析冲突，调用方传入的 `aria-expanded:bg-transparent` 会替换 variant 自带的 `aria-expanded:bg-muted`。
- 保留 `hover:bg-muted`：悬停反馈不变，只是展开后不再常驻高亮。

### 不改的部分
- 全局 `ghost` variant 不动——其他 aria-expanded 按钮（如更多菜单触发器）需要展开高亮。
- reasoning / tool-group 的 CollapsibleTrigger 是纯 div，无此问题。

### 验证
- 展开某个项目文件夹：组标题按钮背景应恢复透明（仅 hover 时变灰）；收起后行为不变。
- 检查其他 ghost 按钮（新对话、更多菜单）展开高亮不受影响。
