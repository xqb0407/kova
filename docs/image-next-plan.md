# 图片链路后续实施计划（截图工具 / MCP 图片透传 / 大图引用式）

> 前置：正规路线 PR1-4 已完成（设计见 `docs/image-part-design.md`，验收工具 echo_image 在案）。
> 本文锚点全部经代码核实（2026-09-18），明天照单执行即可。

## 0. 已完成基线（不用再动）

- 工具结果 image 块 → `data-image` part 投影 + 2MiB 闸门 + MIME 白名单：`src/image-parts.ts`（sidecar 与历史共用唯一收口）
- 直播流：`stream.ts` tool_execution_end；历史：`transcript.ts`（同构）
- 前端渲染：`components/assistant-ui/elements/image-data.tsx`（缩略卡/放大/保存/占位降级），thread.tsx 已挂载
- Rust 重放缓冲 16MB：`src-tauri/src/pi_agent.rs`
- sidecar `tsc` 零错、`bun test` 604 全绿

**结论：任何工具只要在结果里返回 `{type:"image", data:<base64>, mimeType}` 块，前端零改动直接上屏。**

---

## 1. 截图工具 screenshot（优先级最高，先做这个）

### 1.1 为什么必须走 Rust 宿主命令，不能纯 sidecar

- `bash` 宿主通道的输出有截断上限（`tool_exec.rs` bash 分支），~1MB 级 base64 必被截断 → 不可用。
- macOS 截图命令（`screencapture`）与 JPEG 压缩（`sips`）是系统自带的本地执行，与 `bash` 工具同一归属层（宿主），放 Rust 侧跨平台边界也最干净。

### 1.2 改动清单

| 文件 | 改动 |
|---|---|
| `apps/desktop/src-tauri/src/tool_exec.rs` | ① 命令分发 match（`"bash" =>` 附近，当前 565 行）加 `"screenshot"` 分支；② 实现：`std::process::Command` 串三条系统命令——`screencapture -x /tmp/xxx.png`（静默全屏）→ `sips -Z <maxDim> -s format jpeg -s formatOptions <quality> ...`（缩放+压 JPEG）→ 读文件字节转 base64 返回 `{ base64, mimeType: "image/jpeg", width, height, bytes }`；临时文件用完即删（`temp_dir/` + uuid，别落用户工作区）；参数 `maxDim`(默认 1920)/`quality`(默认 70) 从 host params 读，夹到合理区间；Windows 分支：PowerShell `-command` 用 `System.Drawing` CopyFromScreen 存 JPEG（Git Bash 环境判断参照 bash 分支既有写法），拿不到屏幕缩放命令时直接用 PowerShell 内联质量参数 |
| `apps/sidecar/pi-agent/src/screenshot-tool.ts`（新建） | `buildScreenshotTool(): AgentTool`：name `screenshot`，parameters `{maxDim?, quality?}`（Type.Object），`execute` 里 `await hostToolCall("screenshot", cwd, params, signal)` → 返回 `content: [{type:"text", text:"屏幕截图（1920×1200 JPEG 约 380KB）"}, {type:"image", data, mimeType}]`；host 报错时返回 isError 文本结果（对齐 browser-tools.ts 的 textResult 兜底风格） |
| `apps/sidecar/pi-agent/src/tools.ts` | import + `buildTools` 数组注册（放在 `...buildBrowserTools` 附近，注释说明截图属宿主侧能力） |
| `src-tauri`（顺带确认） | `pi_agent.rs` 读 sidecar stdout 用 `read_line` 无行长上限，1.5MB 级 host_result 单帧没问题；host_query/host_result 通道对大 data 无额外闸门（执行时核实一次 `tool_exec.rs` 返回序列化路径即可） |

### 1.3 尺寸预算（关键约束，防退化）

- 闸门是 **解码后字节 ≤2MiB**（`image-parts.ts` `IMAGE_INLINE_MAX_BYTES`）。
- Retina 全屏 PNG 常见 3-8MB → 必超限变占位。所以**截图默认就必须压成 JPEG**：maxDim 1920 + quality 70 经验值 200-800KB，留足余量。
- 预算逻辑放 Rust 侧（压缩时兜底：若压完仍 >1.8MB，自动降 quality 再压一轮），sidecar 只做闸门守门员（已有，不动）。

### 1.4 测试

- sidecar：`screenshot-tool.test.ts`——用 hostdb 测试同款 fake transport（捕获 stdout、手动 `resolveHostResult`）验证：成功回包组装 image 块；host 失败回 isError 文本。投影层不用重测（image-parts 已覆盖）。
- Rust：`cargo check` + 手工验收（见 1.5）；`sips`/PowerShell 参数拼接抽纯函数 `fn build_capture_cmds(...)` 单测拼串。

### 1.5 手工验收脚本

对话里说「截一张当前屏幕」→ 预期：工具行收起后出现截图卡片；点开放大能看清文字；「保存」能落一张 .jpg；刷新 F5 后图片还在；对同一会话再截第二张，两张都在。

---

## 2. MCP 图片透传（Playwright/browser MCP 的截图就靠它）

### 2.1 现状卡点（已核实）

- `src/mcp-output-guard.ts` `describeBlock`（104-106 行）：非 text 块（含 image）→ 只留一行占位说明。
- `src/mcp-tools.ts:380`：`call` 动作把 `formatMcpContent(...)` 的**纯文本**塞进结果，MCP 返回的 `{type:"image", data, mimeType}`（与 pi-ai ImageContent 同形）直接丢字节。

### 2.2 改动清单

| 文件 | 改动 |
|---|---|
| `src/mcp-output-guard.ts` | 新增 `splitMcpContent(content): { text: string; images: {data,mimeType}[] }`——text 块进文本通道（继续走 guardMcpText 截断逻辑），image/audio/resource 里的 `type:"image"` 摘出来；`formatMcpContent` 保留为薄包装（只取 text），旧调用点不炸 |
| `src/mcp-tools.ts` | `call` 动作 380 行附近：改用 `splitMcpContent`，返回 `content: [text块, ...image块]`；isError 时图片块照带（错误也可能附图） |
| 其余 | 零改动——投影/闸门/渲染/历史全链路自动生效（`img-<toolCallId>-<n>` id 已带工具调用归属） |

### 2.3 测试

- `mcp-output-guard.test.ts`：text+image 混排拆分、image 无 data 字段降级进文本占位、guard 截断只作用于文本部分。
- `mcp-tools.test.ts`：fake MCP 结果含 image 块 → call 返回 content 数组含 image 项。
- 端到端：配一个 Playwright MCP（或任意返回图片的 MCP），对话里「用 mcp 打开 example.com 并截图」→ 卡片上屏 + 刷新不丢。

### 2.4 风险

- MCP 大图（PNG 全屏）同样受 2MiB 闸门 → 显示占位提示，属预期降级；解法归 §3。
- base64 进 JSONL：MCP 截图历史会明显变大（每张 ≈0.3-1.5MB ×4/3 的 base64），磁盘增长可接受但引用式（§3）才是终局。

---

## 3. 大图引用式（asset-reference，P1 收尾）

> 目标：>2MiB 的图不再降级成占位，而是**落盘 + part 里只放引用**，`<img>` 走自定义协议读文件。

- sidecar：投影收口处（`image-parts.ts` 加旁路）超限图写 `{appData}/image-assets/<sha1>.<ext>`，part data 变 `{ src: "aui-asset://<sha1>.jpg", ... }`；转录里存的也是引用（刷新/续流天然一致，JSONL 不再膨胀）。
- Rust：`lib.rs` setup 里 `register_asynchronous_uri_scheme_protocol("aui-asset", ...)` 把协议映射到该目录（严格限定目录 + 防路径穿越；对齐 CSP 需要 Tauri capability/CSP 配置加 `asset` 协议白名单——`img-src` 目前只放了 `data:`）。
- 前端：`image-data.tsx` 的 src 白名单加 `aui-asset:` 协议；保存链接改走协议下载或 host 另存命令。
- 触发条件：**先被真实需求 push 再做**（截图/MCP 占位率数据、或用户反馈大图看不到）。现在 2MiB+JPEG 兜底对交互场景够用。

## 4. 收尾杂项

- 验收通过后：删 `src/echo-image-tool.ts` + `tools.ts` 里两行注册（文件顶和注册处都有「验收后删除」标注）。
- 用户消息附件上传（composer 图 → 模型输入）仍是设计文档 §9 独立项，不在本计划内。
- 每步完成跑：`cd apps/sidecar/pi-agent && ~/.bun/bin/bun test && ~/.bun/bin/bun x tsc --noEmit`；动 Rust 加 `cargo check`（`~/.cargo/bin/cargo`，此环境 PATH 无 cargo）。

## 5. 建议排期

| 序 | 任务 | 预估 | 依赖 |
|---|---|---|---|
| 1 | screenshot 工具（§1） | 半天（大头是 Rust 双平台命令拼测） | 无 |
| 2 | MCP 图片透传（§2） | 2-3 小时 | 无 |
| 3 | echo_image 摘除（§4） | 5 分钟 | 1+2 验收完 |
| 4 | 引用式大图（§3） | 1 天，暂缓 | 需求出现再做 |
