# IM 双向通道（微信首发）

让微信用户直接与本机的 Kova 助手对话：消息进绑定会话，回复经通道发回。
管理入口在**侧边栏「远程」→「接入 IM」**页签（创建 Bot / 扫码绑定 / 工作目录 / 删除）。

## 架构

```
微信 ⇄ iLink CGI（HTTP 长轮询）⇄ 主进程 im/ 模块 ⇄ sidecar（NDJSON）

apps/electron/main/im/
├── types.ts          ImChannelAdapter 契约（新平台实现此接口）
├── registry.ts       (platform, channelId) 双键注册表，多 Bot 实例无跨实例兜底
├── access.ts         入站门控：去重(msgId LRU 1000/5min) → 仅私聊 → owner 门
├── router.ts         绑定表 / IM 命令 / prompt 下发 / 回程聚合回复
├── manager.ts        通道启停编排：启动恢复、reconcile、before-quit 收尾
├── im-commands.ts    im_* 命令（清单/CRUD/扫码/owner）
└── adapters/wechat/  ilink-protocol（wire 类型）→ ilink-client（纯 fetch）
                      → wechat-adapter（长轮询 monitor 循环）
```

接线点：

- 命令注册：`main/registry.ts` → `setupImCommands(register)`；回程 tap
  `setImRouterTap(handleAgentFrame)` 把 sidecar 无 id 帧旁路给 router。
- 生命周期：`main/index.ts` ready 后 `startImSubsystem()`（恢复 enabled 通道，
  cursor 从 kv 续传）；`before-quit` 里 `stopImSubsystem()`。
- 回程原理：`pi-agent.ts` 的无 id 自发帧经 `setImRouterTap` 旁路；router 按
  sessionId 把 `thread_event.message_update` 的 `assistantMessageEvent.delta`
  累积到该会话的**聚合队列队首**（sidecar 串行执行 turn、IM 消息可连发，故
  必须 FIFO 排队）；`agent_end` 事件（带 stopReason/errorMessage）结算队首：
  aborted 不回、error 回摘要、正常走 `get_history(tail)` 取最终文本（>4000 字
  截断）。注意 chunk 流是 `{id, chunk:{...}}` 包装、顶层无 sessionId，不能用来
  按会话聚合（遗留并行流，内容与 thread_event 重复）。

## 绑定模型

`im_binding(platform, channel_id, chat_id, sender_id, session_id, strategy, pinned, updated_at)`
以 `(platform, channel_id, chat_id)` 为主键——**一个微信聊天持久映射到一个桌面会话**：
（`pinned`/`strategy` 是已下线的「钉住会话」历史列，路由不再读取，保留只为兼容旧库。）

- 首条消息自动 `new_session`（cwd 取 Bot 配置的工作目录）并落绑定，同时**下发一次
  引导消息**（告知可直接对话，并列出 `/new` 开启新对话、`/clear` 压缩上下文、
  `/stop` 停止任务——首次接入的用户否则不知道命令存在）；
- 此后该聊天每条消息路由到同一会话（连续对话），app 重启绑定保持；
- 微信内 `/new` 解绑重建（下条消息进新会话）、`/clear` 压缩上下文、`/stop` 中止；
- **每个聊天各自新建会话**，不再支持把 Bot 钉到某个桌面会话；
- 修改 Bot 的**工作目录**会清空该通道的全部绑定：下一条消息在新目录里建新会话，
  旧会话保留（不再接收该聊天的新消息）。前端切换目录前会弹确认，明确提示
  「历史上下文不会延续」。
- IM 会话在索引表里打 `kind='im'` 来源标（`list_sessions` 投影为 `origin:"im"`）：
  侧栏对**没有项目归属**的 IM 会话按 cwd 兜底分组。Bot 的工作目录可能是普通
  目录（不是注册项目），没有来源标时会被「无项目归属会话不展示」的规则隐藏，
  用户在侧栏完全看不到聊天记录。升级时主进程启动会对既有绑定补一次来源标。
- 桌面端删除某个会话时，sidecar 广播 `sessions_changed(deleted)`，router 据此
  清掉指向它的 `im_binding`——否则绑定会继续指向不存在的会话，后续消息既
  进不了列表也拿不到正常回复。

owner 门：每通道首个私聊者自动成为 owner（`im_owner` 表），陌生人消息一律拒绝并回
固定提示——不会凭空建会话。详情页「访问控制」可查看 owner（脱敏）并重置
（`im_owner_get/reset`），重置后下一条私聊重新成为 owner。

### 回复颗粒度（详情页下拉，四档）

- **标准回复**：助手正文逐条即时回传（assistant 消息完结即发，不等整轮收尾）；
- **完整回复**：正文 + 该轮工具调用摘要（工具名 + 参数提示 + 失败标记）；
- **摘要回复**：整轮压成一行速览（首行截 80 字 + 工具调用次数）；
- **实时进度**：额外推送**每回合一条**完整思考片段（工具轮的思考并入下一轮，
  只在最终消息/错误时冲刷；截取尾部 300 字）与工具执行进度（4s 节流），
  处理期间维持「对方正在输入」状态（typing，5s keepalive，10min 自过期）。

### 思考深度（详情页下拉）

侧车默认思考档位是 `off`（不产生思考事件），IM 会话从主进程创建、不继承桌面端
的选择，所以默认也不思考。通道配置新增 `thinkingLevel`（关闭/低/中/高）：

- 新建绑定时对该会话下发 `set_thinking`；
- 改配置时应用到该通道全部已绑定会话（`applyThinkingToChannel`）；
- 选「实时进度」而思考仍关闭时，前端自动把思考深度切到「低」——否则没有
  思考内容可推。档位越高回复越慢、费用越高，按需调整。

### 通道管理闭环

详情页包含：启用/停用开关（只停长轮询，不解绑）、绑定/解绑（reauth 时提示
「登录凭证已失效」并引导重新绑定）、回复颗粒度、工作目录、
访问控制（owner 展示/重置 + **发送测试消息**）、删除 Bot。
测试消息复用该通道**最近一次入站目标**（含平台回复凭据：钉钉 sessionWebhook、
企微回调帧、飞书 message_id、微信 context_token）；无入站记录时提示先在对应
平台发一条——owner 是 senderId，与平台回复锚点并不等价，不能直接拼接发送。
该目标是**进程内存态**：重启后需先收到一条消息；解绑/换绑/重置 owner/切平台/
删除通道时会被丢弃，避免把测试消息发给旧账号或前任 owner。通道停用时测试消息
直接拒绝（适配器已下线）。钉钉 sessionWebhook 约 1.5 小时过期，过期后需在钉钉
里重新发一条消息获取新凭据。

### 自愈与错误反馈

- **按 requestId 精确结算**：chunk 流的 `finish`/`error` 帧带本轮 requestId，聚合据此
  结算——thread_event 的 `agent_end` 无 id，只能按队首猜归属，同会话排队两条消息时
  会错结下一条（曾导致回复丢失）。聚合在 `message_end` 只发正文、不摘除，统一等
  `finish` 结算；
- **线程隔离**：IM prompt 统一带 `threadId = im:<sessionId>`。不传会被侧车归入
  `"default"` 线程——所有聊天共用一条串行链（互相排队、`/stop` 失效）；
- sidecar 的错误帧立刻回错误到 IM 并清聚合（`message_end` 与 error 帧同一错误
  只发一次）；
- 错误若指向「会话不存在/失效」（桌面端把 IM 会话删了），自动解绑——下一条消息
  重建会话，通道不会永久卡死；
- 聚合登记在 prompt 写入成功之后：登记顺序与 sidecar 实际执行顺序一致，
  并发投递时队首归属不会错位。

### 审批与提问（IM 无人值守面）

IM 会话由手机/聊天窗口驱动，没有桌面交互面，因此：

- **Question 工具不注入**（`isImThread(threadId)`，见 `sessions/im-thread.ts`）；
  工具表里不存在，模型看不见就不会问。execute 里还有一道兜底：旧工具表/恢复
  会话仍调用时立即返回「按最合理假设继续」，绝不挂起；
- **逐工具审批转文本**：sidecar 的 `data-toolApproval` 帧带 requestId，router
  按 requestId 找到所属聊天，把工具名、命令/路径/MCP 调用转成一条 IM 消息，
  用户回复「允许」「允许并记住」「拒绝」后经 `tool_confirm` 结算（拒绝可带
  反馈文本，作为 reason 回给模型）。同一聊天多个审批按队列逐项提示，10 分钟
  未确认自动拒绝；`/new`、`/stop`、本轮收尾都会清掉待确认项；
- MCP elicitation（表单式追问）在 IM 会话里直接 decline（无人可填表单），
  不让 MCP execute 永久挂起；
- 桌面端打开同一个会话时 threadId 就是 sessionId，卡片与审批交互照常可用。

## 微信 iLink 协议事实（已对照腾讯官方 npm 包源码 + 可用接入实现核对）

- 基址：`https://ilinkai.weixin.qq.com`（登录成功后可用 `confirmed` 下发的
  `baseurl`）。请求头：`iLink-App-ClientVersion`（扫码 GET 用 `"1"`）、
  `iLink-App-Id: bot`；带 token 请求另加 `AuthorizationType: ilink_bot_token`、
  `Authorization: Bearer <token>`、`X-WECHAT-UIN`。
- 扫码：`GET ilink/bot/get_bot_qrcode?bot_type=3` → 返回 `qrcode`（票据）与
  `qrcode_img_content`（**二维码内容串/URL**，前端本地渲染，不是图片字节）；
  失败时回落 POST（官方 SDK 路径）。状态轮询
  `GET ilink/bot/get_qrcode_status?qrcode=…` 为 30s 长轮询，超时按 `wait` 继续；
  状态可能是字符串或数字（0/1/2/3/4）；响应可能包在 `data` 下。
- 状态机：`wait` → `scaned` → `confirmed`（下发 `bot_token`/`ilink_bot_id`/
  `baseurl`）；`scaned_but_redirect` 换 `https://{redirect_host}` 继续；
  `need_verifycode` 需用户在桌面端输入手机微信显示的数字（`im_wechat_qrcode_verify`，
  下一轮轮询以 `verify_code` 提交）；`verify_code_blocked`/`binded_redirect` 为终止态。
- 收消息：`POST ilink/bot/getupdates`（90s 长轮询，客户端超时按空响应续拉），
  游标 `get_updates_buf` 持久化（kv `im.wechat.cursor.<channelId>`）。消息可能
  嵌套 `msg`/`message` 且字段有别名（`msgs|messages|updates|items|list`、
  `from_user_id|user_id|…`），客户端统一归一；只滤 BOT 自身消息，不按
  `message_state` 卡门（用户消息发送即完整）。
- 发消息：`POST ilink/bot/sendmessage`，`msg.item_list[0].text_item.text`；
  `message_type=2`、`message_state=2`，回传入站 `context_token`；
  正文换行统一 CRLF（平台客户端对 LF 处理不一致）。
- 会话过期：`reauth` 状态，UI 提示重新扫码。
- **仅私聊**，无群聊能力。

## 前端

- `lib/im/channels.ts`：镜像 store（useSyncExternalStore），事实源在主进程；
  命令缺失（旧主进程）时面板自动降级提示。
- `components/agent-thread/remote-view.tsx`：侧边栏「远程」主区视图，
  Segmented 双页签 = 远程控制（复用 RemoteSettings）｜接入 IM。
- `components/agent-thread/im-channels-panel.tsx`：Bot 清单 + 详情
  （二维码 / 工作目录 / 删除）。

## 命令清单

`im_channels_list` `im_channels_platforms` `im_channels_save` `im_channels_delete`
`im_channels_toggle` `im_channels_status` `im_channels_test`
`im_wechat_qrcode_start` `im_wechat_qrcode_poll` `im_wechat_qrcode_verify` `im_wechat_unbind`
`im_owner_get` `im_owner_reset`
`im_binding_get` `im_binding_delete`

表结构在命令注册时集中创建（`ensureImTables`，`im_binding` / `im_owner`），
避免任意命令路径撞 "no such table"。

## 飞书（Feishu / Lark）

- **连接**：官方 SDK（`@larksuiteoapi/node-sdk`）WebSocket 长连接，`WSClient` +
  `EventDispatcher` 订阅 `im.message.receive_v1`。免公网回调/验签；SDK 自带重连。
- **绑定**（详情页「绑定机器人」）：
  - **扫码一键创建**：走飞书 accounts 设备码流程（init → begin → poll），扫码授权后
    自动获得 App ID / App Secret 并启动长连接，二维码下方显示配对码（扫码不可用
    时可在飞书里手输）；
  - **手动填写**：App ID / App Secret / 数据域（飞书或 Lark 国际版）。凭据先经
    `tenant_access_token/internal` 校验，成功后用 `secret.ts` 加密落库
    （kv `im.feishu.credential.<channelId>`）。
- **消息**：仅私聊（`chat_type=p2p`），文本与富文本（post）解析并剥离 mention；
  机器人自身消息（`sender_type=app`）与群聊消息丢弃；`message_id` 作幂等键。
- **发送**：`/open-apis/im/v1/messages`（有入站 `message_id` 时走 reply 锚定线程）；
  长文本按 3800 字符分段；租户 token 按 appId 缓存、过期前 60s 刷新。
- **typing**：对入站消息加/删 `OnIt` reaction（尽力而为），对应「实时进度」档的
  处理中提示。
- **权限要求**（手动路径）：开放平台为应用开启「机器人」能力，事件订阅选择
  「长连接」并订阅 `im.message.receive_v1`；发布版本后生效。
- **命令**：`im_feishu_qrcode_start/poll`（一键创建）、`im_feishu_app_save`（手动）、
  `im_feishu_unbind`。通用命令（清单/启停/状态/测试/owner）对两个平台一致。

## 钉钉（DingTalk）

- **连接**：官方 `dingtalk-stream` SDK（构建期打包进主进程）的 Stream 模式长连接（免公网回调），
  `DWClient({clientId, clientSecret})` + `registerCallbackListener(TOPIC_ROBOT)`；
  收到消息后立即 `socketCallBackResponse(messageId, {})` ACK（否则 60s 内重推）。
- **绑定**：详情页「绑定机器人」填写 Client ID（AppKey）+ Client Secret；
  主进程先用 `oapi.dingtalk.com/gettoken` 校验凭据，成功后加密落库
  （kv `im.dingtalk.credential.<channelId>`）并连接。
  开放平台需为企业内部应用开启「机器人」能力，并选择 **Stream 模式** 发布。
- **消息**：仅单聊（`conversationType === "1"`），仅文本；机器人回环过滤；
  `msgId` 作幂等键。
- **发送**：用入站 `sessionWebhook` 回复（约 1.5h 有效），请求头带
  `x-acs-dingtalk-access-token`（SDK `getAccessToken`）；长文本 2000 字符分段。
- **命令**：`im_dingtalk_app_save`（手动绑定）、`im_dingtalk_unbind`。

## 企业微信（WeCom）

- **连接**：官方 `@wecom/aibot-node-sdk`（构建期打包进主进程）的**智能机器人长连接**
  （`wss://openws.work.weixin.qq.com`），SDK 内置认证帧、心跳与指数退避重连。
- **绑定**：企业微信后台 → 智能机器人 → 开启 **API 模式并选择「长连接」**，
  把 BotID 与长连接 Secret 填进详情页；加密落库（kv `im.wecom.credential.<channelId>`），
  保存后立即连接，认证结果由状态点反馈。
- **消息**：仅单聊（`chattype === "single"`），仅文本；`msgid` 作幂等键；
  单聊没有 chatid 时用发送者 userid 作为会话锚点。
- **发送**：透传入站回调帧、走 **stream 协议**回复（`msgtype:"stream"` +
  `finish:true`，SDK `replyStream`；长连接普通回复不接受纯 text 消息体）；
  最近一帧按聊天缓存，供测试消息等无帧场景兜底；单条 stream 回复
  （router 已限 4000 字符，远低于平台 20480 字节上限）。
- **限制**：每个机器人同一时刻仅允许一条长连接（新连接会踢掉旧连接）；
  无 typing 状态（「实时进度」档的思考/工具消息仍正常推送）。
- **命令**：`im_wecom_app_save`（手动绑定）、`im_wecom_unbind`。

## 新平台接入步骤（公众号）



1. `im/adapters/<platform>.ts` 实现 `ImChannelAdapter`
   （长连接型：start 建连+事件→InboundMessage；回调型：经 http-bridge 挂 remote 网关）；
2. `manager.ts` 工厂注册 + `im-commands.ts` 平台清单放开 `available: true`；
3. 凭据存储沿用 secret 加密 kv（`im.<platform>.<channelId>.*`）；
4. 群聊平台在 `access.ts` 的群门处接白名单策略（当前宁拒）。

参考传输模式（官方渠道已核实）：飞书 WSClient 长连接（`@larksuiteoapi/node-sdk`，
免公网，3s 处理时限→先入队快速 ack）；钉钉 Stream（`dingtalk-stream`）；企业微信
智能机器人长连接（`@wecom/aibot-node-sdk`，单连接互踢、回复透传 req_id）；
微信公众号为唯一回调型（XML+AES，5s 应答，公网复用 remote 网关 + cloudflared 隧道）。

## 已知边界

- iLink 无官方文档与 SLA，协议字段可能随微信版本调整；token 过期需重新扫码。
- 非文本消息（图片/语音/文件）首发降级忽略。
- 审批转成 IM 文本消息（允许/拒绝），不再要求用户回桌面端点卡；Question 工具
  不在 IM 会话注入，MCP 表单式追问直接 decline。
