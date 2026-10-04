# 对话内图片渲染设计（image part 端到端贯通）

> 目标：让工具（AI 文生图、截图、fetch 抓到的图片等）产出的图片沿现有消息通道端到端流到
> 前端对话流内渲染，直播与刷新/重进会话后表现一致；并为“用户上传附件图片”的同族缺口预留演进位。
>
> 本设计不改模型上下文的语义（agent 消息内容保持现状），只补“UI 投影”这一段。

## 1. 背景与现状

图片块在数据源头其实已经存在，缺的是每一环的 UI 投影与渲染。当前四个卡点：

| 层 | 位置 | 现状 |
|---|---|---|
| sidecar 直播流 | `stream.ts:196-208` `tool_execution_end` | 工具结果转 chunk 只取 `type === "text"` 块，image 块映射成空串 |
| sidecar 历史投影 | `transcript.ts:141-145` `toolResultOutput` / `:177-239` `historyToUiMessages` | 同上，只取 text；注释自称“与 live 保持一致：只取 text” |
| sidecar MCP 通道 | `mcp-tools.ts:380` + `mcp-output-guard.ts:8` | MCP 返回的 image/audio/resource 块被 `formatMcpContent` 压成一行占位文本，**根本没有以 image 块形态进入 pi-ai 消息**（注释明示“P0 不做落盘渲染”） |
| 前端渲染 | `assistant-message.tsx:210-267` | `GroupedParts` 分支无 image；但 `case "data": return part.dataRendererUI` 已存在，数据型 part 有现成通道 |

链路上已经具备的东西（本设计的立足点）：

1. **数据源**：pi-ai 的 image 内容块形状为 `{ type: "image", data: <base64>, mimeType }`
   （`@earendil-works/pi-ai/dist/types.d.ts:251-255`）。内置 fetch 工具已在返回它
   （`http-tools.ts:181-186`，图片响应回传给模型），且随 agent 行原样落进 JSONL
   （`transcript.ts:350-356` persist 落的是完整 agent 消息）——**图片字节的存储成本已经发生，
   本设计不新增持久化，只是把它投到 UI**。
2. **传输**：sidecar 与前端两端都直接用 AI SDK 类型（`types.ts:7-8` 别名 `ai.UIMessage /
   UIMessageChunk`；`ai@7` 的 `UIMessageChunk` 原生支持泛型数据块
   `{ type: \`data-${NAME}\`, id?, data }`，`ai/dist/index.d.ts:2009/2316`）。
   NDJSON → Tauri 事件 → `pi-chunk-batch` → `WsPiChannel` 全程按不透明 JSON 行转发，
   新 chunk 类型零通道改造；远程网关（`remote.rs try_route`）同样按 id 原样透传。
3. **先例（本设计的模板）**：`data-compaction` 走的就是“chunk 发 `data-*` + 历史投影重建 +
   `makeAssistantDataUI` 注册渲染器”的三面一致机制——
   直播 `protocol.ts:741 sendChunk({type:"data-compaction",id,data})`、
   历史 `transcript.ts:148-164 compactionDividerPart`、
   渲染 `compaction-banner.tsx`（`makeAssistantDataUI`）+ `thread.tsx:97` 挂载注册。
   AI SDK 按 part `id` upsert，直播/刷新渲染同一组件。
4. **CSP**：`tauri.conf.json:39` 的 `img-src` 已含 `data:`，内联 data URL 上屏无需配置变更。
5. 历史消息的唯一事实源是 `get_history → historyToUiMessages`（`protocol.ts:1114-1120`，
   从 agent 行重建），JSONL 里的 `ui` 快照列不参与前端历史——**只需要改
   `historyToUiMessages` 一条路径**，`toUiMessage` 不动。

同族缺口（本设计不解决，见 §9 P1-2）：用户 composer 附件图片实际从未上行——
`pi-transport.ts:74-79` 只抽取 text parts，`protocol.ts:5` 的 prompt 帧只有 `text` 字段；
刷新后附件气泡也消失（`UserMessageAttachments` 只在 live 态渲染）。

## 2. 关键约束

1. **Rust 重放缓冲预算**：`pi_agent.rs:84-86` 单 run 缓冲上限
   `RUN_BUFFER_MAX_LINES=30000 / RUN_BUFFER_MAX_BYTES=4MB`，到顶 `truncated` 即清空整 run
   重放（刷新续流降级为纯历史加载）。一条图片 chunk 的 base64 行可达数百 KB～2MB，
   4MB 预算一张图就吃掉一半——不处理的话图片会轻易摧毁续流重放能力。
2. **直播/历史一致契约**（`transcript.ts:166-175` 文件头注释的原则）：同一轮的工具结果，
   刷新前后 parts 必须同构（含 id）。→ image 投影必须写成 stream/transcript **共用**的
   纯函数，id 用稳定规则推导，不允许各自造格式。
3. **get_history 响应体积**：历史从 agent 行重建时内联图片会随会话轮数放大响应
   （刷新一次拉全量）。P0 接受（受 §3.3 单图上限约束），P1 改引用式按需取（§9 P1-3）。
4. **模型上下文成本不变**：投影只加 chunk/part，不改 agent 消息。fetch 图片进模型上下文
   是既有行为（多模态读图），本设计不扩大也不缩小；MCP 图片进上下文需 vision 门控，
   归 P1。
5. **工具输出文本通道不动**：`tool part 的 output 仍是字符串`（各 tool-row/面板/搜索按
   string 消费），图片走独立 part，不塞进 output 对象——否则破坏 `ToolFallback`、
   工具面板、`read-result` 等全部 output 消费方。
6. **远程慢客户端**：`remote.rs:107` 注明写队列满会踢连接；超大单行（一张大图的 data URL）
   在弱网远程是风险源，单图上限（§3.3）同样护住这里。

## 3. 方案选型

### 3.1 投影格式：`data-image` part（采用）

| 方案 | 说明 | 结论 |
|---|---|---|
| A. `data-image` chunk/part + `makeAssistantDataUI` 注册 | 复用 data-compaction 已验证的三面一致机制；`assistant-message.tsx` 的 `case "data"` 原样转 `dataRendererUI`，**渲染主开关零改动** | **采用** |
| B. 标准 image part（`{type:"image"}`） | AI SDK 7 的 `UIMessage` 没有这个 part 类型（图片附件规范形态是 `file` part），adapter 会丢；还得改 `GroupedParts` switch | 否决 |
| C. 图片塞进 tool part 的 `output` | output 从 string 变异成对象，所有 output 消费方（工具行、面板、历史 diff）连锁改 | 否决（工具行内的“查看原图”入口可作为 A 的补充，§5.2） |

### 3.2 字节传输：P0 内联 data URL（采用）

| 方案 | 说明 | 结论 |
|---|---|---|
| A. 内联 data URL（`src: "data:image/png;base64,..."`） | 桌面/远程 web 两端同构可渲染；CSP 已允许；零新协议命令、零新文件目录、零鉴权面 | **P0 采用** |
| B. 引用式：sidecar 落盘 `<sessionsDir>/<sessionId>.assets/img-<n>.<ext>`，chunk 只带 `assetRef`；桌面经新 RPC `get_session_asset` 取字节，远程经网关 HTTP 静态路由 | 流与 get_history 不膨胀，重放缓冲免疫；但需新协议命令 + 网关路由 + 前端 blob 加载器 + 生命周期清扫 | **P1 演进**（触发条件见 §9） |

P0 选 A 的理由：图片字节反正已随 agent 行落盘（§1-1），内联只是“读现成的”；B 的全部复杂度
都是为绕开体积问题，而体积问题先用 §3.3 的上限策略兜住，等真疼了再上。

### 3.3 体积策略（P0）

- **单图上限 2 MiB**（原始字节，base64 后约 2.7 MiB）：超限的图片块**不发** `data-image`，
  仅保留 text 通道的占位行（沿用 `describeBlock` 的提示文案风格，注明字节数与“过大未展示”），
  `logAt("warn")` 留痕。文生图/截图类工具应自行产出该量级的图（1080p PNG 通常 0.5–2 MiB；
  更高分辨率请工具侧出 JPEG 或缩放缩略图）。
- **MIME 白名单**：`image/png | image/jpeg | image/gif | image/webp` 才进投影。
  `image/svg+xml` 挡在外（SVG 可含外链/钓鱼绘制的 UI，虽然 `<img>` 上下文不执行脚本，
  仍不值得这个面）；未列入的按超限同样降级占位。
- **Rust 预算上调**：`RUN_BUFFER_MAX_BYTES` 4MB → **16MB**（`pi_agent.rs:86`），
  并把“图片单行体量 × 预算”的关系写进注释。不采纳“data-image 行不计入缓冲”——
  不计入则刷新续流重放丢图，违反约束 2 的直播/历史一致契约；上调预算保留契约且改动最小。
  超预算仍按既有语义整 run 降级（本轮刷新后靠历史加载兜底，图片不丢，只是续流回放没有中途态）。

## 4. 数据模型

```ts
// 新增共享类型（放 sidecar types.ts，desktop 侧在 lib/pi-bridge.ts 镜像一份，协议注释同步）
export const IMAGE_PART_NAME = "image"; // → chunk type: "data-image"；part type: "data", name: "image"

export type PiImagePartData = {
  /** 内联 data URL：`data:<mimeType>;base64,<b64>` */
  src: string;
  mimeType: string;
  /** 解码后原始字节数（渲染角标“1.2 MB”用） */
  bytes: number;
  /** 产出该图的工具调用 id；纯模型直出图（未来多模态回复带图）为 null */
  toolCallId: string | null;
  /** 产生图的工具名，占位/降级文案与“在工具行定位”用 */
  toolName?: string;
  /** 可访问名：取工具 text 头的 headline，缺省 "image" */
  alt?: string;
};
```

**id 稳定规则（直播/历史同构的关键）**：`img-<toolCallId>-<块序号>`；一条 tool result 的多个
image 块各一枚。历史侧 toolCallId 在 agent 行里原样存在，两侧从同一输入函数（§5.1-1 的
`projectImageParts`）产出，天然一致。`toolCallId` 为 null（模型直出）时用
`img-<jsonlSeq>-<块序号>` / live 用 `img-<runSeq>-<contentIndex>`——P0 不产这种，先占位。

## 5. 逐层改动

### 5.1 sidecar

1. **新文件 `image-parts.ts`（投影共用纯函数）**：
   ```ts
   /** 工具结果 image 块 → PiImagePartData[]（上限/白名单过滤在此单点实现） */
   export function projectImageBlocks(
     content: { type: string; data?: string; mimeType?: string; text?: string }[],
     ctx: { toolCallId: string | null; toolName?: string; headline?: string },
   ): { parts: { id: string; data: PiImagePartData }[]; skipped: number[] };
   ```
   stream 与 transcript 只许从这里出 data-image（约束 2 的落实手段）；单测直接测这个函数。
2. **`stream.ts` `tool_execution_end`**：
   - text 块照旧拼 `output` 字符串（现状不动）；
   - 其后对 `event.result.content` 调 `projectImageBlocks`，每个 part 发一条
     `sendChunk(reqId, { type: "data-image", id, data })`（顺序：tool-output-available →
     data-image×n，图片 part 落在该 assistant 消息里 tool part 之后）；
   - 被过滤的块往 output 文本尾部追加一行 `[图片未展示：超过 2 MiB / 不支持的类型 <mime>]`，
     与 MCP 占位哲学一致（降级可见，不静默）。
3. **`transcript.ts` `historyToUiMessages`**：`toolResult` 分支回填 `part.output` 之后，
   调同一个 `projectImageBlocks`，把 parts **插到宿主消息里对应 tool part 的紧邻之后**
   （与 live 的 chunk 顺序对齐）；被过滤块的占位行追加进 output 文本（规则与 live 完全一致，
   共用函数保证）。compaction 分隔线在头部 unshift，不受此插入影响。
4. **`mcp-tools.ts` / `mcp-output-guard.ts`（P1，§9）**：P0 不动——MCP 图片今天到不了
   pi-ai 的 image 块，投影拿不到；先跑通内置工具与自定义 sidecar 工具。
5. **`protocol.ts` 协议注释**：prompt 流 chunk 清单（`:149` 附近）补一行
   `data-image` 说明；`types.ts` 导出 `PiImagePartData`。

**新工具封装约定（你封装文生图/截图要遵守的形状）**——与 fetch 工具同款返回：

```ts
return {
  content: [
    { type: "text", text: "已生成图片：xxx.png（1024×1024）" },   // 进模型上下文 + 工具行
    { type: "image", data: "<base64>", mimeType: "image/png" },    // ≤2 MiB，进 UI 投影
  ],
  details: { /* 可选元数据 */ },
};
```

注意：这种返回下模型也会“看到”图（回放进上下文，消耗 vision token）。如果只想要 UI 展示、
不让模型看（省 token），P1 会加 `uiOnly: true` 标记通道；P0 先按上表形状即可。

### 5.2 desktop

1. **新组件 `components/assistant-ui/elements/image-data.tsx`**：
   仿 `compaction-banner.tsx` 用 `makeAssistantDataUI({ name: "image", render })` 注册；
   渲染 `ImagePartCard`：
   - 缩略图卡：`max-h-64 w-auto object-contain`、圆角边框、角标显示 `alt + bytes`
     （`fmtBytes` 复用 `lib/model-format.ts` 风格）；
   - 点击 → `ui/dialog`（shadcn 已有）大图查看（`max-h-[85vh]`，深色遮罩）；
   - Dialog 内“另存为”：`<a download>` 直接存 data URL（零协议改动；P1 引用化后升级为
     系统打开/定位文件）；
   - 未知 `mimeType` / 非 `data:` src → 降级占位行（图标 + “图片无法显示”），**永不抛错**：
     渲染器崩一条消息整个 thread 挂掉，护栏放组件内。
2. **挂载注册**：`thread.tsx` 与 `<CompactionDataUI />` 并排加 `<ImageDataUI />`
   （模块级注册副作用，与先例同法）。
3. **`assistant-message.tsx` 零改动**（`case "data"` 已转发 `dataRendererUI`）。
4. **`pi-transport.ts` 零改动**：data-image 属“直接进 parts”通道（postTransform 只拦截
   旁路 store 类 chunk），不拦即通。
5. **`lib/pi-bridge.ts`**：镜像 `PiImagePartData` 类型 + 注释（该文件是协议类型的前端事实源）。
6. 工具行体验（小增强，可并入）：带图的 `toolCallId` 在 `ToolRow` 展开面板里加“查看图片”
   锚点滚动到对应 `ImagePartCard`；P0 可不做，图已按序出现在工具行下方，归属直观。

### 5.3 src-tauri

`pi_agent.rs`：`RUN_BUFFER_MAX_BYTES` 4MB → 16MB + 注释补图片行体量说明。无其他改动
（行转发对 payload 无尺寸假设）。

## 6. 时序

```
工具执行完成（result.content = [text, image]）
  ├─ live：sendChunk(tool-output-available)          → parts: tool-x（output=文本+占位）
  │        sendChunk(data-image × n)                 → parts: + data(name=image) × n
  │        ……Rust 转发时计入重放缓冲（16MB 预算）
  ├─ 落盘：persist 写 agent 行（含 image 块，现状已如此）
  └─ 刷新：get_history → historyToUiMessages 插同 id data-image parts
           → GroupedParts case "data" → dataRendererUI → ImagePartCard（与 live 同位同貌）
```

## 7. 测试要点

- **sidecar 单测**
  - `image-parts.test.ts`：上限过滤（2 MiB±1）、白名单（png/jpeg/webp/gif 过，svg/未知挡）、
    多块序号、headline 进 alt、bytes 计算。
  - `stream.test.ts`：mixed content → chunk 序列 `[tool-output-available, data-image…]`，
    被过滤块在 output 尾部有占位行。
  - `transcript.test.ts`：**同构快照**——构造含图 toolResult 的 agent 行，断言
    `historyToUiMessages` 产出的 data-image parts 与 stream 单测产出的 chunk 逐字段一致
    （含 id）；多图插入位置紧跟对应 tool part、compaction 分隔线不受扰。
- **desktop**：`ImagePartCard` 渲染（src 透传、超限降级卡不崩）、Dialog 开合。
- **手工端到端**：临时内置 `echo_image` 工具（返回内置 1×1 PNG base64 与一张 >2MiB 图）→
  live 见图/见占位 → 刷新后不变 → 轮中刷新续流重放见图 → 远程 web 端同判。

## 8. 风险与缓解

| 风险 | 缓解 |
|---|---|
| 多图长会话 get_history 响应膨胀（刷新变慢） | 单图 2 MiB 上限；P1 引用化（§9-3）；监控 `history` 应答字节数 |
| 16MB 预算仍被极端 run 打爆 → 该 run 续流重放清空 | 既有语义即“降级为历史加载”，图片终态不丢（persist 落盘）；`truncated` 置位时 log 一行便于观测 |
| data URL 撑爆 WebView 内存（大量长图） | 缩略渲染 + Dialog 延迟挂大图 src（只挂当前打开的）；上限同 §3.3 |
| 非视觉模型收到图片块报错（fetch 既有问题） | 与本设计正交、不扩大：投影不碰 agent 消息；P1 若做 MCP/上传通道再统一加 vision 门控 |
| 工具滥用大图为渲染侧制造压力 | 投影是**最后闸门**（上限/白名单单点在 `projectImageBlocks`），任何工具越界只会得到占位文本，不能打穿前端 |

## 9. P1 路线（本设计预留，不在 P0 实施）

1. **MCP 图片贯通**：`mcp-tools.ts` 结果转换保留 image 块进 pi-ai content（投影侧零改动，
   `projectImageBlocks` 自动接手）+ 模型侧 vision 门控（当前模型 `input` 含 `image` 才进
   上下文，否则只投影 UI——需要“投影但 content 不带”的双轨，届时用 `details.images` 承载）；
   `mcp-output-guard.ts` 注释“P0 不做落盘渲染”兑现。
2. **用户附件图片上行**：prompt 帧 `text` → `parts: [{type:"text"}|{type:"image"}]`
   （`pi-transport.ts` 不再只抽 text）；`toUiMessage`/`historyToUiMessages` user 分支投影
   image parts；`user-message.tsx` 渲染历史附件气泡。
3. **引用式大图（方案 B 兑现）**：>阈值落 `<sessionsDir>/<sessionId>.assets/`，chunk 带
   `assetRef`；桌面 `get_session_asset` RPC；远程网关加鉴权静态路由；
   `ImagePartCard` 按 src 前缀（`data:` / `pi-asset:`）选加载器。重放缓冲与 get_history
   对图片彻底免疫。
4. **产物卡集成**：`MessageArtifacts`（write 工具交付文件）里图片扩展名走 `ImagePartCard`
   同款缩略（本地路径经引用式通道）。
5. 工具行“查看图片”锚点、复制图片到剪贴板、在系统预览器打开（依赖 3）。

## 10. 实施拆分

| PR | 内容 | 依赖 |
|---|---|---|
| 1 | sidecar：`image-parts.ts` + `stream.ts` + `transcript.ts` + 协议注释/类型 + 单测 | — |
| 2 | desktop：`image-data.tsx` + thread.tsx 注册 + 组件测试 | PR1（类型与 id 规则） |
| 3 | src-tauri：缓冲预算 16MB + 注释 | —（可与 1 并行） |
| 4 | 手工验收（echo_image 工具临时 seed，验收后可删） | 1+2+3 |
