# 事件触发 + Headless（L1）设计

状态：L1a/L1b 已实现；L1c 待开工（Headless 不含登录自启动）。  
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
触发源                          Electron main                    sidecar
────────                       ─────────────                    ───────
Webhook POST ──┐
文件 watcher ──┤
git HEAD 轮询 ──┼─→ trigger-router ──→ hostAutomationRpc("run_with_trigger")
IM @mention ───┘      │                ├→ sidecar automation RPC
                      │                │    └→ automation-core: runWithContext()
                      └→ HMAC/限流/     └→ RemoteTaskScheduler 透传
                         幂等/防抖
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
      "type": "webhook",            // webhook | file | git | im
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
    type: "webhook" | "file" | "git" | "im" | "manual";
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

**路径与鉴权**：`POST /hook/<triggerId>`，要求 header `X-Kova-Signature: sha256=<HMAC(body, secret)>`。secret 每 trigger 一个，创建时生成、UI 可重置（落 triggers.json，0600 目录纪律已有）。

**校验链（顺序固定）**：
1. 路径 triggerId 存在且 enabled、type=webhook
2. HMAC 验签（timingSafeEqual；失败即 401，不泄露原因细节）
3. 时间窗：`X-Kova-Timestamp` 偏移 ≤5 分钟（防重放）
4. 幂等：`X-Kova-Delivery` id LRU 1024 去重（同 delivery 重试不重复触发）
5. 限流：每 trigger 10 次/分钟（超出 429）
6. body：≤64KB；JSON 时存进触发摘要（截 200 字）

**响应**：202 Accepted（触发已受理，run 异步）；失败 4xx 带 `{error}`。投递日志复用现有 `webhook_delivery` 表（endpoint=triggerId, event="webhook_trigger"）——出站推送记录表顺手承接入站记录，建表已存在。

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

- 复用 `apps/electron/main/im/router.ts`：绑定会话已有；触发器是**旁路**——消息照常进绑定会话，同时若匹配触发器条件则 fire
- config：`{ platform: "wechat", chatId?: "<specific>", pattern?: "^/run" }`（私聊命令 + 正则）
- summary = 发送者 + 消息前 80 字
- 群聊 @mention：现有 IM 适配器仅私聊（微信），飞书群聊在 adapter 层——触发器条件写 platform+chatId 即可，不重复实现群解析

## 5. Headless v1（托盘常驻）

现状：Windows 关窗进托盘已有（window.ts close→hide）；macOS 关窗不退出（红色按钮隐藏到 Dock，窗口销毁才退）；Linux 退出。**缺的是**：

1. **macOS 托盘**：tray.ts 已建但只有"打开/桌宠/退出"。补：菜单显示运行中任务数（automation running + Inbox needsAction）、" quit"保持现状
2. **macOS 关窗进托盘语义统一**：close → hide（与 Windows 一致），Dock 图标保留（点击唤回）。不模仿"关闭=退出"的传统 mac 行为——常驻是本版目标
3. **窗口全关时 automation/inbox 存活**：现有架构 sidecar/scheduler 是 main 的子进程，窗口 hide 不影响（进程不退）。要防的是 macOS `window-all-closed` 误退出——现行为只在 Linux quit，正确，保持
4. **通知兜底**：任务完成/失败时系统通知（Electron Notification，设置页已有开关）+ Inbox 徽标（托盘 title 或 badge）
5. **退出确认**：托盘菜单 quit 时若有运行中 automation，先弹确认（复用现有退出确认流的 hint 位置）——避免"点了退出任务死了"的无感事故

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
- prompt 模板只替换 `{{trigger.summary}}`，摘要侧脱敏（复用 inbox safePreview 的密钥正则）

## 8. 分期

| 期 | 内容 | 状态 |
|---|---|---|
| L1a | Trigger 抽象 + runWithContext + webhook（endpoint/HMAC/幂等/限流）+ 协议/UI 最小面 | ✅ 已实现 |
| L1b | 文件 watch + git 轮询 + 触发器 UI（任务 ⋯ 菜单弹窗） | ✅ 已实现 |
| L1c | IM 旁路触发 + Headless（macOS 托盘增强 + 关窗统一 + 通知/徽标 + 退出确认） | 待开工 |

L1b 验收口径：UI 建 file 触发器 → touch 命中文件触发一次 run（Inbox 带 trigger 来源）；
git commit 后 30s 内触发；同任务运行期间写文件不自我触发；新建/开关/删除后立即生效。

## 9. 测试策略

- webhook 校验链：`automation-core/webhook-guard.ts` 纯函数，Bun test 直接覆盖
  （好/坏签名、时间窗、幂等 LRU、限流、摘要）——不引 Electron，主进程只做 IO 壳
- 触发器存储：`test/automation/triggers.test.ts`（生成/校验/更新保 secret/级联删/
  跨进程 mtime 失效/新建自动 id）
- glob 与 watch 根：`apps/electron/test/trigger-glob.test.ts`（纯函数，不拉 Electron）
- runWithContext：fake runner 断言 run.trigger 透传；Inbox meta 断言
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
