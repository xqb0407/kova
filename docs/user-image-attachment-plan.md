# 用户图片附件发送实施计划（多模态输入）

> 目标：用户在 composer 粘贴/拖拽/按钮添加的图片，经协议到达 sidecar，进入模型上下文（image part），
> 历史刷新后可回看；按模型多模态能力动态开关。文字输入与既有工具结果图片链路
> （docs/image-part-design.md，工具→模型/UI）不动，本计划补 **用户 → 模型** 方向。

## 0. 现状（已勘察）

| 环节 | 状态 |
| --- | --- |
| Composer UI（按钮/拖拽/粘贴 → addAttachment） | ✅ 已有（composer.tsx、cm-composer-input.tsx:252，受 `thread.capabilities.attachments` 控制） |
| transport 发送 | ❌ `pi-transport.ts sendMessages` 只取 text parts，附件被 filter 丢弃 |
| 协议 | ❌ `{type:"prompt", id, text, threadId, sessionId, cwd}` 无附件字段 |
| sidecar 消费 | ❌ 全库无 attachment 引用；`run.agent.prompt(text)` 只传文字 |
| 模型调用 | ✅ **pi-agent-core 原生支持** `agent.prompt(input: string, images?: ImageContent[])`，`ImageContent = { type:"image", data: base64, mimeType }` |
| 模型能力元数据 | ✅ model-catalog `input: ("text"|"image")[]`（list_models 已下发到前端） |
| 转录持久化 | ✅ 预计自动：user Message 的 image content 随 agent 消息本体落盘（PR1 验证） |
| 历史重建 | ❌ transcript.toUiMessage 用户消息只投影 text |
| 排队 | ✅ prompt-queue 存整条原始 msg，附件天然随行（仅 queue_update 改 text） |

## 1. 设计决策

- **传输形状：inline base64**。prompt 消息新增 `attachments: [{ name, mimeType, data }]`（data = 裸 base64，不带 data: 前缀）。与 `ImageContent` 同构，sidecar 零转换直传 `agent.prompt`。不做先落盘传路径——多一层临时文件生命周期与清理，收益只有省 ~33% base64 体积，不划算。
- **闸门复用 image-parts 的哲学，闸门前置**：
  - 单图 ≤2MiB（`IMAGE_INLINE_MAX_BYTES` 同值，base64 后 ~2.7MiB）、每条 prompt ≤4 张、MIME 白名单 png/jpeg/gif/webp、SVG 仍然整体挡掉。
  - 最坏 4×2.7 ≈ 10.7MiB/帧，低于 Rust 重放缓冲 16MiB/run（pi_agent.rs）；stdin JSON 行同理。
  - 前端在 addAttachment 时即校验（超限 toast 拒收），sidecar 硬闸门兜底（越界图丢弃 + 在 text 尾部追加降级占位行，绝不静默吞，与工具图投影同哲学）。
- **能力 gating 两层**：
  - 软门（前端）：`capabilities.attachments` 按当前模型 `input` 含 `"image"` 动态声明；纯文本模型下附件按钮禁用、粘贴不收（现有 paste handler 已查能力位，零改动）。
    > 实施修订：软门已撤——自定义端点模型的 input 是缺省猜测值，误拦（按钮消失/粘贴被拒）频发且不可靠；UI 恒可用，由选择时校验 + sidecar 闸门兜底。
  - 硬门（sidecar）：模型不支持 image 但收到附件 → 丢弃图 + text 尾追加「[图片 N 已省略：当前模型不支持图像输入]」（模型可读，用户刷新后可见），不报错不打断。
    > 实施修订：硬门已整体移除——目录真值与自定义端点默认值都可能把支持图像的模型标成 text-only（实测连续误拦多模态模型），input 元数据不可靠。图片过物理闸门后一律放行；端点真不支持时 API 报错且错误可见，好过静默吞图。sidecar 在收到附件时打 event 日志（`prompt attachments: N image(s)`）便于诊断。
- **非目标**：PDF/任意文件（后续另立）、图片压缩/缩放（超限直接拒收，提示截屏后粘贴）、远程网关限帧调优（仅验证不改动）。

## 2. 分阶段实施

### PR1 协议 + sidecar 接收（核心链路，模型可见）

1. `protocol.ts` prompt 消息约定加 `attachments?: [{ name: string; mimeType: string; data: string }]`，文档头补一行；两处 `run.agent.prompt(text)` 改为组装 `ImageContent[]` 透传（过滤非法项：MIME 白名单、`Buffer.byteLength(data, "base64")` ≤2MiB、≤4 张；越界不抛错，text 尾追加降级行）。
2. 硬门：`run.agent.state.model` 的 input 不含 `"image"` 时全部丢弃并追加占位行（model-catalog 提供 input）。
3. 验证转录落盘：发带图 prompt 后读 transcript 文件确认 user 消息含 image content；若有独立的 user-content 序列化层则补持久化。
4. 测试：dispatch 层 mock transport 断言 `agent.prompt` 收到 `(text, images)`；闸门矩阵（超尺寸/超数量/坏 MIME/不支持模型）；占位行文案快照。

### PR2 历史重建 + 前端回显（刷新后 = 直播）

1. `transcript.ts toUiMessage`：user 消息 image content → UIMessage file part `{ type:"file", mediaType, filename, url: data:image/...;base64,... }`；纯图无文字不再返回 null。
2. 前端 user-message 渲染 file part（attachment.aui 的 user message attachments 区已按 file part 布局，缺的只是历史数据源）。
3. 测试：toUiMessage 往返快照（live parts 与 history parts 同构）。

### PR3 前端发送（打通 transport）

1. `pi-transport.ts sendMessages`：提取最后一条 user 消息的 file parts（data URL → `{name, mimeType, data}`），随 `promptStream` 下发；`PromptStreamArgs` 加 attachments，Tauri 通道（invoke pi_prompt）与 WS 通道（pi-ws-channel promptStream）同改。
2. addAttachment 校验：composer 层拦超限图（toast 说明原因），不让垃圾进草稿。
3. 排队条/queue_update 只改 text，附件不展示（快照已有 text，UI 不动）。

### PR4 能力 gating（软门）

1. `capabilities.attachments` 按当前模型动态声明：模型元数据（list_models 的 input）进前端 store，模型切换即重算；无 image 能力时 `ComposerAddAttachment` 禁用 + paste 自然拒收。
2. 远程端同源（模型清单同一协议数据）。

## 3. 验收清单

- [ ] 粘贴 / 拖拽 / 按钮三路径添加图片并发送，多模态模型能描述图片内容
- [ ] >2MiB 图、>4 张、svg：添加时被前端拦下并说明
- [ ] 纯文本模型发图：正常回复，内容含「图片已省略」占位（不报错）
- [ ] 发图后刷新：历史消息仍显示图片缩略（file part 回显）
- [ ] 带图 prompt 排队：上一轮结束后正常执行，图片随行
- [ ] 远程 WS 路径：带图 prompt 经网关可达 sidecar（验证网关无帧上限问题）
- [ ] 上下文成本提示：带图轮次的 usage 里 input tokens 明显上涨（确认图片真进了模型而非仅 UI）

## 4. 风险与注意点

- **网关帧上限**：远程路径 10.7MiB JSON 帧需实测；超限则把单 prompt 图片总量降到 ~8MiB（3×2.7）或后续改分块上传。
- **上下文成本**：图片进模型后每轮都占 token（直到 compaction）；文档里向用户说明，不做自动压缩。
- **compaction**：压缩把用户消息摘要成文字，图片语义可能丢失——与现工具图同预算，先接受。
- **转录体积**：user 图 base64 直接落 transcript 文件，单会话体积增长；2MiB×4 闸门天然限幅，先接受。
