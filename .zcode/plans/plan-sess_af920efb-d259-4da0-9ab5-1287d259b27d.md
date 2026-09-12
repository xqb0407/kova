## 最终实施计划：产物卡片 + 文件变更条

### 关键修正（相对上一版）
产物从消息里已有的 `write` 工具调用**派生**，不再依赖模型调用专用 `artifact` 工具——你截图里的 `login-notion.html` 证明模型只会 write 文件 + 正文提一句，不会主动调工具。`write` 的 `args.file_path` + `args.content` 就是路径和完整内容，卡片的大小/预览/打开全部在前端从消息快照拿到。因此本版**零 sidecar 改动、零 Rust 改动**。

已与你确认的两个决定：产物判定=**扩展名白名单**；呈现=**仅消息尾部卡片**（不做正文行内 chip）。

---

### 第一部分：文件变更条（截图2「N 个文件已更改 +22 -9 / 撤销」）— 纯挂载
全链路已存在（Rust 影子仓库快照 → pi-transport 打点 → pi-checkpoints store → checkpoint-bar 组件），唯一缺口是组件从未挂载。

1. **挂载** `components/agent-thread/thread.tsx`：`import { CheckpointBar } from "./checkpoint-bar"`，在 `ViewportFooter`（约133行）内、`<Composer />`（约141行）之前插入 `<CheckpointBar />`。组件自带 `if (!cp) return null`，无检查点时不占位。
2. **删调试日志**：`checkpoint-bar.tsx:109-114`、`pi-transport.ts:71-72`、`pi-transport.ts:86-87` 三处 `[checkpoint-debug]` console.warn。
3. **文案对齐** `checkpoint-bar.tsx:192`：「本回合改动 {files} 个文件」→「{files} 个文件已更改」。保留/撤销两步式与 apply-conflict 防误伤逻辑不动。

语义维持「每回合一条」（新 prompt 时 clearRunCheckpoint 清槽），不做每条消息的历史记录（影子仓库仅 LRU 存 20 个快照）。

---

### 第二部分：产物卡片（截图1 尾部文件卡 + 预览）— 前端派生

1. **新增 `lib/artifacts.ts`**（纯函数，唯一逻辑源）：
   - `DELIVERABLE_EXT`：`html/htm/xhtml/md/markdown/txt/csv/tsv/json/jsonl/xml/yaml/yml/log` 等文本交付物扩展名（可调）。注明 pdf/png 等二进制无法经文本 write 产出，不在 v1。
   - `isDeliverable(path)`、`formatBytes(n)`（内容经 `new TextEncoder().encode(content).length` → 「27.2 KB」）。
   - `messageArtifacts(parts)`：扫本条消息 `write` part，复用现成 `fileChangePair("write", args)`（`lib/panel-activity.ts:121`）取 `{path, content}`，按 `isDeliverable` 过滤、剔除 running/failed，按 path 去重（后写覆盖），返回 `{toolCallId, path, base, size}[]`。

2. **渲染挂载** `components/agent-thread/assistant-message.tsx`：在 `<MessagePrimitive.GroupedParts>` 之后加 `<MessageArtifacts />`。用 `useAuiState` 读 `s.message.status`——**running 时返回 null**（避免流式逐 token 重扫/重编码大内容），回合结束计算一次；无产物不渲染。

3. **卡片组件**（新 `components/agent-thread/agent-panel/artifact-card.tsx` 或就近）：`FileTypeIcon`（复用 `tool-row.aui.tsx:51` 的 next/dynamic 导入）+ 文件名（复用 `splitPath` `tool-row.aui.tsx:62`）+ 大小；行尾按钮：
   - **预览** → `openPanelTab("file", { focus: toolCallId, title: base })`（复用现成「文件」标签）。
   - **在系统打开** → `openPath(join(getWorkspace(), path))`（`@tauri-apps/plugin-shell`，同 `checkpoint-bar.tsx:57`；`getWorkspace()` 为空即网页端时隐藏）。

4. **扩展「文件」标签做预览** `components/agent-thread/agent-panel/file-view.tsx`：
   - `useFilePart`（40行）新增识别 `write` part：path=`args.file_path`、text=`args.content`（与 read/plan 同一份消息快照语义，刷新后 transcript 重建的 tool part 仍可用）。
   - `FileBody`（100行）在现有 md 预览/源码切换外，加 `.html/.htm` 分支 → `<iframe srcDoc={text} sandbox="allow-scripts" />` 直接渲染页面。md/txt 等维持 Streamdown/CodeMirror。

> 无 sidecar 改动、无 modes.ts/提示词改动、无 Rust 命令、无新面板标签类型——预览寄生在已有「文件」标签上。

---

### 已知限制（v1，可接受）
- bash 生成的文件不进卡（消息无内容快照）。
- 交付物先 write 后又 edit：卡片显示 write 版本（edit 不带全文）。
- 覆盖两者需加 `workspace_read` Rust 命令读磁盘实时内容——后置，本次不做。

### 验证
- 前端 `next build`（或 `tsc --noEmit`）过类型。
- sidecar 无改动，跑 `cd sidecar/pi-agent && bun test` 确认回归。
- Rust 无改动。
- 手动：复现你的场景——agent 写 `login-notion.html` → 回合尾出现产物卡（图标+名+大小）→ 点预览在面板渲染出登录页；改代码后回合尾出现「N 个文件已更改 +− / 撤销」条。

### 后置（本轮不做，已确认）
- 消息尾聚合行「查看所有产物 (N) / 查看所有变更 (N)」。
- 正文行内文件名 chip。
- bash 产物 / 写后再编辑的实时内容（workspace_read）。

### 改动面小结
第一部分 3 文件（近乎纯挂载）；第二部分 1 新 lib + 1 新组件 + 2 处小改（assistant-message 挂载、file-view 扩展）。协议/审批/历史重建/sidecar/Rust 全部零改动。建议先做第一部分（低风险、独立可验证），再做第二部分。