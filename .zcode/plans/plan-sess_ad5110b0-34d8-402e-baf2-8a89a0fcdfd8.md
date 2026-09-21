# sidecar 大文件拆分方案（设计模式驱动的职责分解）

## 现状诊断（结构探索结论）

| 文件 | 行数 | 问题 | 扇入 |
|---|---|---|---|
| protocol/protocol.ts | 2708 | 97 个命令分支的巨型 switch + prompt 管线 + payload 构建器 + 生命周期状态全部混在一起 | 2（index/runner）|
| plugins/plugins.ts | 1228 | manifest 解析、市场 CRUD、git 操作、扫描缓存、启停状态五种职责 | 8 |
| storage/hostdb.ts | 1055 | 已是仓储形状（QueryTransport 策略 + query 单入口），但 RPC 传输/localDispatch SQLite 镜像/行类型/表 API 挤在一个文件 | **43** |
| subagent/subagent.ts | 1000 | 工具定义（330 行 AgentTool 工厂+超长 description）与 DelegationRecord/运行管理纠缠 | 4 |
| skills/skills.ts | 683 | 三层发现合并、文档解析落盘、启停状态三职责 | 11 |
| model/model-catalog.ts | 671 | 内置目录/自定义 provider/thinking 映射/当前模型状态 | 8 |
| sessions/sessions.ts | 745 | 会话注册表 Map 群 + 300 行 resolveSession 装配流程 | 4 |

**不动的文件**（内聚性已够，硬拆反而伤）：mcp-manager.ts（单类连接池）、provider-retry.ts（纯策略函数集）、todo-state.ts（纯函数状态机）、subagent-definitions.ts（数据定义）、automation/（vendored）。

## 核心策略：门面（Facade re-export）+ 职责模块

每个大文件拆成 `X/子模块.ts` 后，**原文件变成纯 re-export 门面**。43 个引用 hostdb 的调用方、11 个引用 skills 的调用方一行都不用改；模块级单例状态（缓存/Map）通过 re-export 保持同一实例；bun 单文件打包零运行时开销。这是扇入高的模块唯一低风险的拆法。

## 阶段 A（本轮实施，与 queue-v2 零冲突）

基于 `refactor/sidecar-folders` 开新分支 `refactor/sidecar-decomposition`（依赖新目录结构）。每个文件拆完立即跑 typecheck + bun test，绿了才提交，一个文件一个 commit：

**A1. hostdb.ts** → `storage/hostdb.ts`（门面：query + init + 每表薄封装 session*/credential*/customProvider*/models*/kv*/usage*，~250 行）
- `hostdb/transport.ts`：QueryTransport 策略接口、stdoutRpc、resolveHostResult、取消/超时（~250 行）
- `hostdb/local.ts`：initLocalStorage、localDispatch 巨型 switch、三个 migrate*Local、resetStorageForTest（~390 行）
- `hostdb/rows.ts`：SessionRow/CustomProviderRow/ModelRow/UsageRow/HostHttpData 等纯类型（~270 行）

**A2. plugins.ts** → `plugins/plugins.ts` 门面
- `plugins/manifest.ts`：parsePluginManifest + hooks 解析 + 路径 helpers（~460 行）
- `plugins/marketplaces.ts`：市场登记 CRUD + catalog 解析缓存 + gitRun + add/remove/refresh/install（~520 行）
- `plugins/state.ts`：enabledState + 扫描缓存 + activePlugins/resolvePluginComponent/icons（~370 行）

**A3. skills.ts** → `skills/skills.ts` 门面
- `skills/discovery.ts`（三层发现 mergeLayers/快照/prompt 块）、`skills/docs.ts`（parse/render/validate/save/delete）、`skills/state.ts`（启停）

**A4. model-catalog.ts** → `model/model-catalog.ts` 门面
- `model/catalog.ts`（内置目录+seed 查找）、`model/custom-providers.ts`（注册/覆盖/行应用）、`model/thinking.ts`（级别+映射+hooks）、`model/state.ts`（当前 key）

**A5. subagent.ts** → `subagent/subagent.ts` 门面
- `subagent/delegation.ts`（DelegationRecord 注册/活动流/等待收敛，~290 行）、`subagent/run.ts`（SubagentRun 类，~285 行）、`subagent/tools.ts`（buildSubagentTools + 工具 description，~330 行）——工具适配器与运行管理器分离

## 阶段 B（protocol.ts + sessions.ts，设计已定稿，等 queue-v2 收尾后单独一轮）

protocol.ts 是 queue-v2 活跃区（最近 5 个提交全在改它），现在拆会大面积冲突。

**B1. protocol.ts** → Command Registry（命令注册表）：
- `protocol/protocol.ts` 保留：handleLine + dispatch 路由（switch→查表）+ 生命周期状态 + mgmtQueue/initGate（~450 行）
- `protocol/prompt-pipeline.ts`：dispatchPrompt/runPromptTurn/steer/abortRun（~430 行）；`protocol/payloads.ts`：各域 payload 构建器（~230 行）
- `protocol/handlers/` 12 个域模块（lifecycle/queue/sessions/models/providers/settings/subagents/automations/plugins/skills/mcp/interactive），统一签名 `(reqId, msg) => Promise<void>`，注册表带 mgmtQueue 串行标记；97 个分支逐域迁移，每域测试绿了再迁下一个

**B2. sessions.ts** → 会话注册表（Map 群+追踪）与 `sessions/resolve.ts`（resolveSession+装配）分离

## 验证与回滚

每文件一个 commit；每步跑 `bun run typecheck` + `bun test`（732 用例）+ 收尾 `bun run build` 冒烟。测试文件与门面同目录搬移，protocol.test.ts 直调 dispatch 的 828 行用例在门面下不变。出问题按 commit 粒度回滚。