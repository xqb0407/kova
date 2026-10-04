# Debug Session: chat-text-pan-scroll

- **Status**: [OPEN]
- **Issue**: iOS 对话页：从 markdown 文字上起拖不能滚动消息列表；从空白处起拖可以滚；空白处滚过一次之后，文字上又能滚了。
- **Repro (user-reported)**: 打开有长回复的会话 → 手指按在助手消息文字上竖向拖动 → 列表不动；按在文字以外的空白处 → 正常滚；先空白处滚一下，再按文字拖 → 正常。

## 关键静态事实

- `react-native-marked` 的 `Renderer` 默认 `selectable = true`（`src/lib/Renderer.tsx:37`），本项目 `MarkdownRenderer extends Renderer` 调 `super()` 未传参 → 助手消息所有 Text 均为 selectable。
- `thread.aui.tsx` 中 `UserText`(L758)、`SpokenText`(L508) 显式 `selectable`。
- 消息列表为 `ThreadPrimitive.MessagesFlatList`（RN FlatList/UIScrollView），flex-1 已确认生效（布局正常）。
- 症状只在"文字表面"出现、空白表面正常 → 差异变量就是 selectable 文本附生的原生文本交互手势。

## Hypotheses & Verification

| ID | Hypothesis | Likelihood | Effort | Evidence |
|----|------------|------------|--------|----------|
| A | `Text selectable` 的原生文本交互手势吃掉了从文字上起步的 pan，UIScrollView 未接管；列表进入滚动后 canCancelContentTouches 才让后续手势放行 | High | Low | Pending：selectable:false 后文字上直接可滚 → Confirmed |
| B | CodeBlock 内层水平 ScrollView 拦截纵向拖动 | Medium | Low | Pending：普通段落（非代码块）上也复现 → Rejected |
| C | 链接/按钮等 onPress 组件抢占手势 | Low | Low | Pending：仅链接上复现 |
| D | `keyboardDismissMode="interactive"` 手势仲裁干扰 | Low | Medium | Pending：需单独一轮 A/B |

## 验证方式说明

RN 的 JS 层日志无法观察原生手势仲裁（谁成为 UIGestureRecognizer 的胜出不经过 JS responder 事件），故本会话的"插桩"采用受控变量实验：翻转 selectable 单一变量，由用户真机复测直接读取症状开关。

## Log Evidence

（待用户复测）

## Verification Conclusion

（待填）
