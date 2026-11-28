# 事件触发 + Headless（L1）设计

状态：L1a/L1b/L1c 已实现（Headless 不含登录自启动）。  
前置：M1/M2 已完成（Connector 远程 MCP、Inbox、任务台账）。

## 1. 目标与边界

**目标**：自动化从"时间触发"扩展为"事件触发"——webhook / 文件变更 / git 提交 / IM 消息都能驱动一次 automation 运行；桌面关闭窗口后任务继续跑（托盘常驻）。

**明确不做（本版）**：
- **登录自启动**：用户明确否决。Kova 像 VS Code——用户开才运行，运行期间才常驻。自启动若做，将来是设置页默认关闭的显式开关，不进本版。
- 独立 `kova-daemon`（v2 再议）：本版 Headless = 托盘常驻，依赖 Electron main 存活。
- Linux 无窗口运行：保持现有"window-all-closed 即退出"。
- 跨机器事件总线：触发器只在本机 Electron main 内。

## 2. 架构总览

```
触发源                          Electron main                    sidecar / 调度器
────────                       ─────────────                    ───────────────
Webhook POST ──┐            ┌→ HMAC/时间窗/幂等/限流
文件 watcher ──┤            │
git HEAD 轮询 ──┼─→ trigger-rpc ──→ hostAutomationRpc("run_with_trigger")
IM 旁路 ───────┘            └→ dev 进程内：协议 automation_trigger_fire
                                     └→ automation-core: runWithContext()
```

**关键决策**：调度仍是 automation-core 的 `PersistentTaskScheduler`（独立 kova-automation 进程）。触发器不另起执行通路——它们只是"另一种到点的方式"。复用并发闸（2）、runHistory、补跑、锁，全部免费获得。

**宿主触发网关**（`apps/electron/main/trigger-rpc.ts`）：生产走
`hostAutomationRpc("run_with_trigger")` 直连调度进程；dev 的
`KOVA_AUTOMATION_INPROC=1` 模式调度器在 sidecar 进程内，改走协议
`automation_trigger_fire`。两条路径都是 `runWithContext`，触发器清单同理
（host RPC / 协议 `list_triggers`）。

## 3. Trigger 抽象

### 3.1 存储

`<sessionsDir>/automation/triggers.json`（原子写 + 与 tasks.json 同目录纪律）：

```jsonc
{
  "version": 1,
  "triggers": [
    {
      "id": "trg-<uuid8>",
      "type": "webhook",            // webhook | file | git | im | connector
      "taskId": "<automation task id>",   // 触发哪个任务
      "enabled": true,
      "createdAt": "...",
      // type 专属配置，见各节
      "config": { ... }
    }
  ]
}
```

**不塞 vendored `ScheduledTask`**：触发器是 Electron main + sidecar 两侧共享的独立资产，与任务一对多（一个任务可被多个触发器驱动）。写路径只经 sidecar（single writer）；Electron main 只读（清单/验签 secret）+ 触发。

**跨进程可见性**：sidecar（写）与 automation 调度进程（读）各有一份内存缓存，
`load()` 以 `mtimeMs+size` 作戳，文件一变即重读——否则新建触发器要等进程重启
才可见。webhook 验签 secret 每次请求现查，不落 main 侧缓存。

### 3.2 运行上下文注入

vendored `ScheduledTaskRunContext` 加一个可选字段（本地扩展，NOTICE.md 记档）：

```ts
export type ScheduledTaskRunContext = {
  historyEntryId: string;
  sessionId: string;
  startedAt: string;
  /** 本地扩展（L1）：触发来源。cron/interval/once 触发不带（undefined）。 */
  trigger?: {
    type: "webhook" | "file" | "git" | "im" | "connector" | "manual";
    /** 触发器 id（manual 无） */
    id?: string;
    /** 触发摘要（进 Inbox 与会话标题，截 200 字） */
    summary?: string;
  };
};
```

- automation-core 新增公开 API `runWithContext(taskId, trigger)`：与 `runNow` 同路径但把 trigger 携进 `execute()` 创建的 run context。`runNow` 保持原签名（内部调 `runWithContext(id, {type:"manual"})`... 不，manual 语义留给现有入口，`runNow` 不带 trigger）。
- runner 侧：`automationPromptText` 支持 `{{trigger.summary}}` 模板替换（prompt 里写了才替换，没写不动原文——模板不注入用户没要求的上下文）。
- Inbox：`buildAutomationItem` 的 meta 加 `trigger` 字段；会话标题 `automationRunTitle` 在 trigger.summary 存在时附 `[webhook]` 等前缀。

### 3.3 触发器路由

`automation/triggers.ts`（sidecar）：触发器事实源 + 校验 + 启停/删级联。
触发执行不由本模块发起——Electron main 的 webhook/watcher 经
`trigger-rpc.ts` 调 `runWithContext`（生产 host RPC，dev 协议），
sidecar 内部入口（`test_trigger`）同样落到 `scheduler.runWithContext`。
三方共用同一条 execute 通路，权限/并发/记录一致。

## 4. 各触发源

### 4.1 Webhook

**端点**：复用远程网关思路但不混入——独立 loopback server `127.0.0.1:<port>`（默认 8788，冲突递增，实际端口写 kv 供 UI 展示）。只绑 127.0.0.1：webhook 是"第三方服务打进来"，公网暴露由用户的隧道/反代决定（与远程访问同哲学），Kova 自己绝不开公网口。

**路径与鉴权**：`POST /hook/<triggerId>`，要求 header `X-Kova-Signature: sha256=<HMAC(secret, "<timestamp>.<body>")>`（时间戳进 MAC，改时间戳重放旧签名无效）。secret 每 trigger 一个，创建时生成、UI 可重置（落 triggers.json，0600 目录纪律已有）。

**校验链（顺序固定）**：
1. 路径 triggerId 存在且 enabled、type=webhook
2. 时间窗：`X-Kova-Timestamp` 偏移 ≤5 分钟（防重放）
3. HMAC 验签（`sha256=HMAC(secret, timestamp + "." + body)`；timingSafeEqual；失败即 401，不泄露原因细节）
4. 幂等：`X-Kova-Delivery` id LRU 1024 去重（同 delivery 重试不重复触发；未真正入队时撤销标记）
5. 限流：每 trigger 10 次/分钟（超出 429）
6. body：≤64KB；JSON 时存进触发摘要（截 200 字）

**响应**：202 Accepted（触发已受理，run 异步）；失败 4xx 带 `{error}`。投递结果只写 main 日志（成功/限流/失败原因），**不落 `webhook_delivery`**——那张表是出站推送的设置页视图，混入入站记录会把用户自己的 webhook 历史挤出列表。入队失败/任务已删时撤销幂等标记，发送方可同 delivery 重试；查询链路故障回 503（可重试），不伪装成 404。

**payload 传递**：摘要进 `trigger.summary`（如 `webhook from GitHub: push to main`，取 headers 里可判别的字段 + body 前 160 字）。完整 body 不进上下文（模型可经 webhook 回查？不做——本版摘要即可，避免注入面）。

### 4.2 文件 watch

- Electron main 内 `fs.watch(root, { recursive: true })`（不引 chokidar；watch 根取 glob 静态前缀，`src/**/*.ts` → `<ws>/src`）
- config：`{ paths: ["src/**/*.ts"], events: ["change","add","unlink"], debounceMs: 2000 }`
- 相对路径限定在当前 workspace 内；glob 只支持 `*` / `**` / `?`（`trigger-glob.ts` 手写，四种模式够用且缩小语义面）
- 忽略段：`node_modules` / `.git` / `.kova` / `dist` / `out` / `build`（任一路径段命中即忽略）
- **防抖聚合**：窗口内多事件合并成一次触发，summary 列变更文件（≤5 个 + "…N more"）
- **防自触**：同任务运行期间跳过文件触发（`isAutomationTaskRunning`，main 从调度器 run 请求得知）；另加触发后 5s 冷却。dev 进程内模式 main 看不到 run 请求，只剩冷却兜底
- watcher 生命周期：main 进程内 map<triggerId, watcher>，UI 变更后立即重同步（`triggers_sync`），另有 30s 周期兜底；main before-quit 全停

### 4.3 Git

- **不做真实 watcher**（libgit2/fs.watch 对 .git 都不可靠）：main 进程 30s 轮询 `<repo>/.git/HEAD` → 分支 ref 的 commit hash（不 spawn git 进程）
- config：`{ branch?: "main", cwd: "<repo 或 workspace 相对路径>" }`（cwd 留空由 UI 填当前工作区）
- 首次读到只记基线；之后 hash 变化 → summary = `git commit <short-hash>`
- push 触发不做：交给 CI 的 webhook（GitHub/GitLab 的 push webhook 打进来），本机轮询远端是伪需求

### 4.4 IM

- 复用 `apps/electron/main/im/router.ts`：访问控制通过后、命令/绑定/agent 链路之前
  旁路（`trigger-im.ts`）——消息照常处理，命中的触发器各 fire 一次
- config：`{ platform: "feishu", chatId?: "<specific>", pattern?: "^/run" }`
  （platform 必填：wechat/feishu/dingtalk/wecom；pattern 缺省 = 该聊天每条消息，
  非法正则整条跳过）
- summary = `im <platform> <senderId>: <消息前 80 字>`
- 同触发器 5s 冷却；群聊 @mention：适配器已归一化文本，pattern 直接匹配即可

### 4.5 连接器事项（connector，L1d）

Jira / GitLab / GitHub / Linear 的新事项触发（复用收件箱连接器，无需公网）：

- config：`{ provider: "jira", connectorId?, sourceName?, itemType? }`
  （provider 必填：jira/gitlab/github/linear；connectorId 缺省 = 该平台任意
  已配置连接器；sourceName 限定 repo/项目 key，大小写不敏感；itemType 过滤
  issue ↔ issue/ticket、pr ↔ pull_request/merge_request，其余类型只在
  不设 itemType 时命中）
- 没有独立 watcher/timer：轮询由 inbox-connectors 管理器承担（凭证/代理/
  限流退避都是它的），每轮 `commitSnapshot` 后把「新事项」批量转给
  `trigger-connector.ts` 匹配（匹配逻辑在纯函数 `trigger-connector-match.ts`）
- 语义纪律：仅在快照成功推给 sidecar 后 fire（seenKeys 只在 push 成功后前进，
  提前 fire 会在重试轮重复）；首次成功同步只记已见不触发（primed 语义，
  与收件箱通知一致，避免启动时对存量事项爆发触发）
- 聚合：同触发器每批次至多 fire 一次，summary = `<平台>: <key> <标题>; …`
  （≤5 条 + "…N more"，对齐 file watch 的防抖聚合，避免打爆并发闸）
- 依赖说明：触发器不绑定连接器也能创建（平台后配连接器自动生效）；事件
  面即连接器拉取面——Jira = 指派给我且未解决，GitLab/GitHub = assigned /
  reviewRequested / mention 等，「新事项」指这些集合里首次出现的条目
- 已知边界：绑定了 connectorId 的连接器被删除/停用后，触发器静默失效
  （无独立 watcher 去校验绑定关系；与 file 触发器 watch 根消失同类，但
  那边每 30s 重试时会打 setup 警告，这里连日志都没有——先接受，UI 的
  连接器下拉只列启用中的连接器以降低误绑概率）
- UI 现状：桌面端创建入口暂不开放 connector（`inbox_connector_sources`
  与各 adapter 的 listSources 保留，供重设计后的选择式表单复用）；已有
  connector 触发器照常显示与触发

## 5. Headless v1（托盘常驻）

已实现：

1. **托盘状态**：`tray-status.ts` 从 `inbox_changed.counts.needsAction` 与
   `automation_fired / automation_run_done` 折出两个数；`tray.ts` 菜单显示
   「N 个自动化运行中 / N 条待处理」，macOS 菜单栏图标旁显示待处理数，
   Dock/任务栏 badge 同步 `needsAction`。窗口关闭后这是唯一状态可见面。
   进程换代（sidecar close / 调度器重启）清零「运行中」，避免角标卡死。
2. **关窗统一**：Windows 与 macOS 都是 close → hide（`__quitting` 时放行），
   macOS 保留 Dock 图标，点 Dock 经 `activate → focusMainWindow` 唤回。
   Linux 保持"关最后一个窗即退出"。
3. **进程存活**：sidecar / 调度器是 main 子进程，窗口 hide 不影响；
   `window-all-closed` 仍只在 Linux 退出。
4. **通知兜底**：自动化完成/失败走既有 `agent-events → notify popup` 链路
   （窗口失焦才弹，点击通知跳回对应会话）；Inbox 待处理数进托盘角标。
5. **退出**：沿用既有两条路径——键盘 ⌘Q 进场后需按住 1.5s，进度层列出运行中
   会话/服务并优雅停止；托盘/菜单 Quit 走 immediate 收尾（不弹二次确认，也不
   强行把隐藏窗口拽回前台）。两条路径都会 `stopWebhookServer + stopTriggerWatchers`。

**不做的**：登录自启动（已否决）；独立 daemon（v2）；Linux 常驻。

## 6. 协议面

sidecar 新命令（remote.ts REMOTE_DENIED_TYPES 同步加）：
- `list_triggers` → `{ type: "triggers", triggers }`
- `save_trigger` / `delete_trigger` / `set_trigger_enabled` → 全量 triggers 应答（save 回 `saved`）
- `test_trigger`（手动 fire 一次，带 `{type:"manual"}` 上下文）→ 同上
- `regenerate_trigger_secret`（webhook 专用）→ `{ type: "trigger_secret", secret, triggers }`
- `automation_trigger_fire`（宿主事件触发；dev 进程内模式用）→ `{ type: "automation_trigger_fired", task }`

desktop：任务卡片 ⋯ 菜单 →「触发器」弹窗（列表/新建/开关/删除/重置 secret/测试；
webhook 展示 URL+secret 可复制，file/git/im 表单）。不做触发器独立页面。

## 7. 安全清单

- webhook 只绑 127.0.0.1；HMAC timingSafeEqual；时间窗防重放；幂等 LRU；限流；body 上限
- secret 存 triggers.json（sessionsDir 0700 纪律已有）；不进日志/审计
- 文件 watch 的 paths 校验在 workspace 内（防 watch /etc）
- 触发器执行走 automation 既有无人值守策略（read-only/workspace-write/full 审批档）——事件触发**不放宽**任何权限
- prompt 模板只替换 `{{trigger.summary}}`，摘要统一在 trigger-rpc 出口走
  main 的 `redactSecrets`（sk-*/Bearer 打码）后再进 runHistory/Inbox

## 8. 分期

| 期 | 内容 | 状态 |
|---|---|---|
| L1a | Trigger 抽象 + runWithContext + webhook（endpoint/HMAC/幂等/限流）+ 协议/UI 最小面 | ✅ 已实现 |
| L1b | 文件 watch + git 轮询 + 触发器 UI（任务 ⋯ 菜单弹窗） | ✅ 已实现 |
| L1c | IM 旁路触发 + Headless（托盘状态/关窗统一/通知沿用/退出沿用） | ✅ 已实现 |

验收口径：
- L1b：UI 建 file 触发器 → touch 命中文件触发一次 run（Inbox 带 trigger 来源）；
  git commit 后 30s 内触发；同任务运行期间写文件不自我触发；新建/开关/删除后立即生效。
- L1c：IM 消息命中 pattern → 对应任务跑一次（消息本身仍进原会话/命令链路）；
  macOS 关窗后 webhook/file/git 仍触发，托盘角标显示待处理数；完成通知失焦可达。

## 9. 测试策略

- webhook 校验链：`automation-core/webhook-guard.ts` 纯函数，Bun test 直接覆盖
  （好/坏签名、时间窗、幂等 LRU、限流、摘要）——不引 Electron，主进程只做 IO 壳
- 触发器存储：`test/automation/triggers.test.ts`（生成/校验/更新保 secret/级联删/
  跨进程 mtime 失效/新建自动 id）
- glob 与 watch 根：`apps/electron/test/trigger-glob.test.ts`（纯函数，不拉 Electron）
- IM 条件匹配与摘要：`apps/electron/test/trigger-im-match.test.ts`（纯函数）
- connector 条件匹配与聚合摘要：`apps/electron/test/trigger-connector-match.test.ts`（纯函数）
- runWithContext：`run-with-context.test.ts`（慢 store 下 trigger 不丢、并发触发不双跑）；
  `trigger-template.test.ts`（占位替换/缺失摘要/$& 字面量）
- Inbox/meta 断言沿用既有自动化测试
- 真 watcher / webhook server 的端到端留给手工验收（Bun 无法可靠 mock
  Electron 命名导出）

## 10. 风险

| 风险 | 处理 |
|---|---|
| webhook 端口被占 | 8788 起递增探测；实际端口 kv + UI 展示 |
| 文件 watcher 泄漏句柄 | trigger 增删/任务删除/开关时同步 close；main before-quit 全停 |
| agent 自触循环 | .kova 默认忽略 + 运行期间暂停 + 防抖；文档警示 prompt 别写自指任务 |
| IM 触发重复（消息也进绑定会话） | 触发器是旁路加法不拦截；用户用 pattern 排除普通聊天 |
| 独立 scheduler 进程读不到新触发器 | 双层：triggers.json 读路径按 mtime+size 失效缓存；webhook secret 每请求现查 |
| dev 进程内模式触发链路 | main 无 host automation RPC：`trigger-rpc.ts` 退到 sidecar 协议；运行态防自触只剩 5s 冷却 |
| 托盘「运行中」计数漂移 | fired/done 帧投影；sidecar close 与调度器重启时清零，最多显示到下次换代 |
| macOS 关窗 hide 后 Dock 点击无响应 | `activate` 分支：隐藏窗口走 `focusMainWindow`（show+focus），窗口被销毁则重建 |
