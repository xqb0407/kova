# 收件箱外部来源（GitHub / GitLab / Jira / Linear）

状态：v1 已实现（2026-11）
范围：主进程连接器运行时、sidecar 外部条目同步、设置页、双栏收件箱、交给 Agent、通知
非目标：外部系统写操作、OAuth 应用、团队共享收件箱、Jira 评论/@提及、Linear 通知流

> 一句话：把「有人指派任务 / 请求评审 / @我」从四个外部平台收进同一个收件箱，
> 默认只收需要动作的事项；不刷屏、不改写外部数据。

---

## 1. 数据流与事实源分工

```
本地 agent 事件 ──► sidecar journal（events.jsonl 追加 + state.json 投影）
外部平台 ◄──轮询── 主进程 connector runtime（每来源一个，默认 120s ±10% 抖动）
                    │ Token 解密 / 独立 session + 代理 / 分页 / 限流退避
                    ▼
        规范化成 ExternalNotification[]（统一形状，sidecar 不认识任何平台）
                    ▼
        inbox_external_sync {provider, connectorId, items[], complete}
                    ▼
        sidecar：稳定 ID upsert（external:<provider>:<idKey>）
                    ▼
        inbox_changed ──► 渲染层 / 侧栏徽标 / 托盘 / 系统通知
```

- sidecar 只认识统一形状，不认识 GitHub；主进程只负责把各家 API 折成这个形状；
- 渲染层是纯视图，平台信息全部数据驱动（`PROVIDER_META` / `ProviderMeta`）。

---

## 2. 认证与默认过滤

全部使用 Token/PAT，不依赖 OAuth 应用：

| 平台 | 认证 | 默认拉取 | 需要权限 |
|---|---|---|---|
| GitHub | Personal Access Token | `GET /notifications?all=false`，reason = assign / review_requested / mention / team_mention | Classic PAT：`notifications`；Fine-grained：Notifications 只读 |
| GitLab | Personal Access Token | `GET /api/v4/todos?state=pending`，action = assigned / review_requested / mentioned / directly_addressed / unmergeable | `read_api` |
| Jira | Cloud：邮箱 + API Token；Server/DC：PAT | JQL：`assignee = currentUser() AND resolution = Unresolved` | 读取 Issue 的权限 |
| Linear | Personal API Key | GraphQL：指派给我且 state 不是 completed/canceled 的 Issue | 读取 Issue 的权限 |

默认只收「需要动作」的事件；GitLab `build_failed` 默认关闭，可在设置页打开（FYI，
不占待关注动作）。

### 自托管

- GitHub Enterprise：API 地址填 `https://host/api/v3`。
- GitLab 自托管：服务器地址填实例根地址，adapter 自动拼 `/api/v4`。
- Jira Server/DC：认证方式切到 Server / DC，填站点根地址 + PAT。
- Linear 固定官方端点。

---

## 3. 收件箱条目语义

外部事项按「通知事件」建模，而不是长期 `open` 的阻塞项：

- `state: "done"`，`requiresAction` 由事件类型决定；
- 现有 `updateInboxState` 因此允许归档/删除；
- 需要动作的事项因 `requiresAction=true` 留在「待关注」，处理完（在原平台或本地
  归档）后离开；非动作事项未读时也在待关注，读后进历史。

稳定 ID：

- 条目 ID = `external:<provider>:<idKey>`；
- `idKey` 含 host/账号前缀，避免多站点/多实例碰撞；
- `key` 只用于展示（`repo#123`、`JIRA-123`、`HER-5`）；
- 同一 Issue 的新动态更新原行，不新增重复行。

---

## 4. 同步与结算

- 每次成功拉取推「全量快照」；
- `complete=true`：sidecar 把本次未出现、同 `provider+connectorId` 的旧条目结算为
  `resolved`（→ 历史）——这就是「在原平台处理完，收件箱自动消化」的机制；
- `complete=false`（分页截断）：只 upsert，不结算缺失项，避免误删；
- 内容无变化时 `upsertInboxItem` 跳过：不写 journal、不重新变未读；
- 上游有实质变化（状态/标题/摘要）才重新未读；
- 用户墓碑删除的条目不会被后续同步复活；
- 归档过的条目被新动态刷新时保持归档。

### 轮询与退避

- 默认 120 秒，可选 1/2/5/15 分钟；
- 成功：基础间隔 ±10% 抖动；
- 失败：`base × 2^n`，上限 15 分钟；
- 429：尊重 `Retry-After` / `X-RateLimit-Reset`；
- 401/403：停止自动重试，置 `needs_auth`，等用户处理；
- 系统休眠恢复：立即补一轮；
- sidecar 换代：主进程补推最近一次快照；
- 「保存/换 Token」后立即探测账号名 + 首轮同步（1.5s）。

### 异常的用户出口

收件箱在列表上方出现一条横幅（每来源一行错误）：

- `needs_auth`：显示「重新连接」→ 直达设置的收件箱来源段；
- `error` / 网络类：显示「重试同步」→ 立即 `syncInboxConnector`，不等退避；
  设置页的「检查」按钮同一语义（真同步一轮并刷新状态），不是只读探测。

### 系统通知

- 只对「新出现且 `requiresAction`」的事项弹一次；
- 主窗口已聚焦时不弹；首次成功同步只标记已见，不补弹历史事项；
- 点击通知：聚焦窗口并切到收件箱（`inbox:open`）；
- 每个来源可单独关闭。

---

## 5. 收件箱 UI（双栏）

- 左栏：待关注/历史/已归档分段 + 来源下拉 + 搜索 + 筛选；右栏阅读窗；
- 筛选按 tab 分域：任务 tab = 任务类型/时间/项目；平台 tab = 状态/时间/团队仓库；
  「全部」只留视图+时间。切来源时自动清掉只对上一来源有意义的状态/仓库/项目/类型，
  时间保留；
- 外部事项行内联来源 mark（官方品牌图标）+ 状态圈 + `类型 · key` + 相对时间；
- Token 失效/同步失败的横幅在筛选行与列表之间。

### 外部详情按需拉取

- 选中外部条目时，渲染层走 `inbox_connector_detail` IPC；
- 主进程用保存的 Token 调 provider 详情接口（GitHub issue/PR + comments；
  GitLab issue/MR + notes；Jira issue + comments（ADF 转文本）；Linear GraphQL）；
- 主进程内存缓存 60s；**正文/评论不落收件箱 journal**，事实源永远是平台；
- 404/410 的提示是「不存在或无权访问（可能已被删除）」，不是配置错误。

---

## 6. 交给 Agent（芯片 + 回链）

- 阅读窗「交给 Agent / Ask」：点击时把标题/链接/状态/负责人/正文（8k 截断）/最近
  评论（3 条、800 字截断）**快照**进 localStorage（`inbox.agentContext.v1`，最多
  24 条淘汰最旧）；
- composer 里只有一枚 `:inbox[标题]{name=inbox:<itemId>}` 原子芯片 + 一行指令
  （send=复述理解并给方案、确认前不改文件；Ask=「我的问题：」）；
- 真正发送时 `buildPiSendInput` 扫描芯片 → 展开 `[[inbox-ctx]]` 隐藏块给模型；
  气泡只显示芯片、编辑重发拿回芯片（`prompt-notices` 负责剥离隐藏块）；
- 回链：发送侧同步记 `aui.threads.getState().mainThreadId`（兜底 Base 在
  mainThreadId 变化后补记）→ `inbox.sentToAgent.v1`；条目上出现「已交给 Agent」
  标记 + ⋯「查看会话」——能换出 sessionId 就开对应会话，换不出按线程 id 切；
- **已知取舍**：回链与上下文快照是渲染层 localStorage——清应用数据/换设备会丢，
  降级为「去会话列表找」+ 芯片只剩编号/链接；核心收件箱数据（journal）不受影响。

---

## 7. 安全与隐私

- Token 用 `secret.ts` 的 AES-256-GCM 加密存 `state.db` 的 kv；
- 公开快照只返回 `hasToken` + 末四位，Token 永不回渲染层；
- HTTP 用独立 Electron session（`inbox-connectors` 分区），按「设置 → 网络代理」
  应用 system/direct/custom 代理；
- 重定向 `redirect: "manual"`：只跟随同源、非 https→http 降级、≤5 跳（GitHub 改名
  仓库会 301 到同域 `/repositories/<id>`，必须放行）；跨域一律阻断，Token 不外带；
- 响应上限 4MB；错误信息截断，不打印请求头/Token；
- 条目只存标题、编号、状态、来源名、链接，不存正文/评论内容；
- 不做任何外部写操作（不替用户标记已读/完成 todo）。

---

## 8. 代码地图

主进程：

- `apps/electron/main/inbox-connectors/manager.ts`：轮询、状态、通知、推送
- `config-store.ts`：kv 配置 + Token 加密 + 状态持久化
- `http.ts`：`net.request` + 独立 session + 代理 + 同源重定向
- `detail.ts`：外部详情按需拉取（60s 缓存）
- `providers/{github,gitlab,jira,linear}.ts`：四个 adapter
- `commands.ts`：`inbox_connectors_*` IPC + `inbox_connector_detail`
- `notify.ts`：系统通知

sidecar：

- `apps/sidecar/pi-agent/src/inbox/store.ts`：`syncExternalInboxItems`
- `apps/sidecar/pi-agent/src/inbox/items.ts`：`buildExternalInboxItem`
- `apps/sidecar/pi-agent/src/protocol/handlers/inbox.ts`：`inbox_external_sync`

渲染层：

- `apps/desktop/lib/inbox/connectors.ts`：镜像 store + `fetchInboxExternalDetail`
- `apps/desktop/lib/inbox/sent-agent.ts`：交给 Agent 的回链
- `apps/desktop/lib/composer/inbox-reference.ts`：事项芯片 + 上下文快照 + 发送展开
- `apps/desktop/components/inbox/inbox-view.tsx`：双栏主视图
- `apps/desktop/components/inbox/external-issue-detail.tsx`：外部阅读窗
- `apps/desktop/components/inbox/local-item-detail.tsx`：本地事项阅读窗
- `apps/desktop/components/custom-ui/provider-glyph.tsx`：官方品牌图标
- `apps/desktop/components/settings/components/inbox-sources-settings.tsx`

---

## 9. 扩展指南

### 9.1 新增一个平台（如 Azure DevOps）

一个 adapter 文件 + 五处注册，主流程零改动：

| 步骤 | 位置 |
|---|---|
| 1. adapter（`fetch / test / detail?` 三接口，detail 可省略→UI 显示「暂不支持详情」） | `apps/electron/main/inbox-connectors/providers/<id>.ts` |
| 2. provider 枚举 | `packages/pi-protocol/src/inbox-connectors.ts` 的 `INBOX_CONNECTOR_PROVIDERS` |
| 3. 注册表 | `apps/electron/main/inbox-connectors/providers/index.ts` 的 `adapterFor` |
| 4. 品牌信息（label/色/官方 mark） | `apps/desktop/components/custom-ui/provider-glyph.tsx` |
| 5. 设置页 meta（字段/事件勾选/Token 链接，数据驱动） | `inbox-sources-settings.tsx` 的 `PROVIDERS` 数组 |
| 6. 文案 | zh/en 的 `settings.inboxSources.*` 与 `inbox.filterMenu.sources.*` |

adapter 契约：`fetch` 返回 `{items, complete}`（拉全才 true）；条目形状见
`ExternalNotification`；idKey 必须带 host 前缀；不写外部状态。

### 9.2 其他扩展点

| 要加什么 | 位置 | 说明 |
|---|---|---|
| 新事件类型（如 @提及细化） | `InboxConnectorEvents` 加 key + adapter 的 reason 映射 + `ProviderMeta.eventKeys` | 设置页 checkbox 数据驱动 |
| 多账号/多站点 | 数据模型与运行时已按 `connectorId` 分桶（sidecar 结算、主进程 runtimes） | 只差设置 UI 列表化 |
| 新收件箱动作 | `item.actions` 数组 + `runInboxAction` 管线 | 行菜单/阅读窗按钮自动出现 |
| PR review 线程等复杂详情 | `InboxExternalDetail` schema 加可选字段 + 对应 adapter.detail | 不实现的平台自动降级 |
| 事项引用到对话（其它场景） | `lib/composer/inbox-reference.ts` 的芯片机制 | 与 `:code/:library/:agent` 同一套 |

### 9.3 扩展时要留意的边界

1. `InboxExternalDetail` 形状固定——先扩协议再加数据；
2. 系统通知只有「新事项且 requiresAction」一条规则 + 按来源开关，没有按事件类型的
   通知偏好；
3. 回链/交给 Agent 快照在渲染层 localStorage——要跨设备/多窗口时升级为主进程 kv
   或 journal 字段；
4. 「检查」按钮语义 = 真同步一轮（保持这个语义，别改回只读探测——网络抖动后它
   是用户的主要恢复入口）。

---

## 10. 后续方向（未排期）

- 多账号/多站点：见 9.2，只剩 UI；
- Jira 评论/@提及：需要额外拉 comment/mention 数据源；
- Linear 通知流：可改用 `notifications` GraphQL 查询覆盖 mention；
- GitHub/GitLab 通知已读回写：目前刻意不做，避免意外修改外部状态；
- OAuth：需要注册应用与回调，后续可作为 PAT 的更友好替代。
