## 目标

agent 的 browser use 拆成两路，职责不重叠，由设置开关控制：

```
webview（面板内，你实时看着）—— agent 的工作面
  导航 / 点击 / 输入 / 读 DOM，URL 是唯一事实源
        │  「这个 URL 长什么样？」
        ↓
无头 Chrome（不可见，一次性）—— 相机，不是第二个浏览器
  load 同一个 URL → captureScreenshot → 退出
```

**为什么这样划**：若两者各自持有页面，你在面板看到的和 agent 推理依据的就不是一个东西。URL 只有一个事实源，webview 持有；无头 Chrome 永远是被叫去拍一张，不会跑偏。

**优雅降级**：没装 Chrome 或关掉子开关时，系统完整可用，只是 canvas/WebGL 页面 agent 看不见画面——而这正是今天土楼那次的痛点。

## 借鉴 ZCode 的两处

ZCode（Electron/Chromium）证明了目标形态是可实现的。两处可以直接搬：

1. **Playwright 的 `injectedScriptSource.js`**——他们把这脚本注入 guest webview 拿到 Playwright 同款 ARIA 快照（带元素 ref，点击可精确定位），代码在 `playwrightInjectedScriptSource.ts`。**不需要 CDP，就是一段 JS**，WKWebView 里同样能注入。Kova 现在的 `SNAPSHOT_JS` 是手写 400 行纯文本，这是同一件事的工业级替代。
2. **固定版本 + 完整性校验的提取法**——那段脚本不是 Playwright 的 public export，他们 pin 死版本、从 `playwright-core` 里只读那个字符串字面量、校验必须包含 `incrementalAriaSnapshot` 才肯用。照抄这个纪律。

## 第 1 步：webview 路升级为 ARIA 快照

- `browser_scripts.rs` 的 `SNAPSHOT_JS` 换成注入 Playwright `injectedScriptSource`，调用 `incrementalAriaSnapshot`
- 新增 `playwright_script.rs`：构建期从 pin 死的 `playwright-core` 提取该字符串字面量，`include_str!` 进二进制，附完整性校验（ZCode 同款）
- 保留现有全部注入能力：导航/点击/输入/滚动/视口/前进后退
- 恢复被 `tools.ts:354` 暂停的 6 个工具（去掉那个 filter）

## 第 2 步：无头 Chrome 拍照

新增 `src-tauri/src/browser_shot/`：

- **一次性**语义，不持长会话：load URL → 等 load → `captureScreenshot` → 杀进程组 → 返回 base64
- 独立 `--user-data-dir`（临时目录，进程退出即删）——土楼那次 SingletonLock 事故的解药
- Chrome 路径按平台探测；**探测不到就返回明确错误，不静默失败**，且不影响 webview 路的任何功能
- 复用 `browser-use-rs`（`/Users/herther/Downloads/browser-use-rs-main`，MIT）的 CDP 客户端，不手写
- `handle_tool` 加一个 match 分支，返回值 JSON 形状与现有一致
- 截图走现成 `image-parts.ts` 投影链路上屏（`screenshot` 工具已是同款）

**依赖**：`browser-use = { version = "0.2.3", default-features = false }`（关掉用不上的 `mcp-handler`）。需抬 `rust-version` 到 1.85+（该库 edition 2024，现声明 1.77.2）。

## 第 3 步：z 序（webview 保留，这问题必须真解决）

现有 `browser:occluded` 是人工白名单，44 个用 Dialog/Popover 的文件里漏一个就盖住内容（新手引导那个洞本轮已修，但那是第 45 个漏项）。

改成结构化机制：任何全屏浮层通过统一的 overlay context 注册/注销，浮层挂载即广播遮挡、卸载即恢复。不再依赖"谁记得补一次广播"。已知的设置页/向导/面板动画三处迁到同一入口。

## 第 4 步：设置

复用现有「电脑控制」页（`computer-control-settings.tsx` + `browser-config.ts` + `get/set_browser` 协议整套已在）：

- **浏览器驱动**（已有，语义微调）：agent 有没有浏览器
- **像素截图**（新增，默认关）：用无头 Chrome 拍 canvas。关掉/无 Chrome 时系统降级但完整可用
- **屏幕截图**（新增，默认关）：现有 `screencapture -x`（`tool_exec.rs:706`）在读你的真实屏幕。「不要动我的电脑」这条现在只被它违反，该页注释本就写着"后续系统级能力（截图、桌面自动化等）的开关也归这里"

## 风险

1. **需系统装 Chrome**（仅像素截图功能需要）。不打包 Chromium，缺失时给明确错误且不影响其他能力
2. **Playwright 内部产物有版本脆弱性**——那是 non-public export。用 pin 死版本 + 完整性校验缓解；提取失败时降级回现有文本快照，不让 agent 失去 DOM 能力
3. **MSRV 抬到 1.85+**，需确认 CI 工具链
4. **一次性截图有延迟**（启动 Chrome ~0.5–1s）。agent 在循环里频繁截图会明显变慢——需要的话后续加常驻实例复用
5. **真桌面软件自动化不在此方案内**。操作原生应用需独立虚拟显示，macOS 无 Xvfb 对等物

## 验证

- `cargo test --lib`：Chrome 探测、user-data-dir 隔离与清理、连接失败错误文案、**进程组清理（复用已验证的 pid 存活断言，非只看耗时）**、Playwright 脚本提取的完整性校验（故意破坏输入必须失败）
- `bun test`（sidecar）：恢复的 6 个工具注册与参数 schema
- `tsc --noEmit`（desktop）
- 手动核心验收：① agent 打开本地生成的 WebGL html → ARIA 快照正确表达「无交互元素」→ 转而截图 → **聊天里能看到 canvas**；② 面板展开/收起、切设置页、开任意弹窗**不再盖内容**；③ 关掉像素截图后系统仍完整可用，只是 canvas 看不见；④ agent 全程你的鼠标/焦点/窗口不动

## 不做

- 不删 webview（webview 是工作面，无头 Chrome 只是相机）
- 不做点击回传（你要的是看，不是操作）
- 不做真桌面软件自动化
- 不打包 Chromium
- 不在无头 Chrome 里做常驻长会话（先一次性，验证后再优化）