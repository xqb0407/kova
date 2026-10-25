# 每轮装配层（Turn Assembly）

sidecar 的横切能力（工具输出预算、卡死检测，后续的权限/压缩/记忆等）通过一个统一的
装配层接入，而不是在主流程里各自调用。设计目标：**可开关、可诊断、默认零行为变化**。

## 两级装配

| 级别 | 时机 | 产物 | 依赖的事实 |
|---|---|---|---|
| 会话级 `assembleSession` | 会话物化、换目录、换 threadId、拨开关 | 工具表 + 系统提示词后缀 | sessionId/threadId/cwd/mode/appMode/model |
| 回合级 `assembleTurn` | 每个用户 prompt 开头 | 用户提示词前缀 + 提醒 + 钩子快照 | 上一级 + turnId/messages/userText/approvalLevel |

工具表只在"拨开关 / 切模式 / 换目录"时重建；装配层不按轮增删工具，避免破坏
工具 schema 缓存。系统提示词后缀只允许随设置变化的稳定内容；每轮变化的事实
（计数、进度、提醒）走回合级、注入在用户消息尾部。

## 目录

```
src/agent/assembly/
  contracts.ts        契约（Capability / CapabilityHost / Snapshot / Plan）
  registry.ts         生命周期、安装窗口、开关、两级装配
  settings.ts         kv pi.capabilities 的规整/恢复/应用
  assemble.ts         提醒渲染、tool:before/after 钩子链、turn:end 钩子
  capabilities/
    tool-budget.ts    超限工具输出外置
    loop-guard.ts     同一失败调用反复出现时注入一次提醒
  index.ts            内置能力注册与启动初始化
src/sessions/artifact-store.ts   工具输出落盘（<sessionsDir>/artifacts/）
src/protocol/handlers/capabilities.ts   get_capabilities / set_capabilities
```

## 契约要点

- 能力只能在 `install(host)` 执行期间注册贡献；安装结束后再调用 host 的注册方法
  直接抛错，防止"把 host 存起来后补注册"。
- 注册表生命周期 `new → installing → ready | failed`；安装失败清空全部贡献，
  装配退化为"无能力"，不阻断主流程。
- 装配前先快照所有开关，再 await 贡献；同一轮不会混用新旧开关。
- 能力抛错的处理：`tool:before` / `tool:after` / `turn:end` 都是 fail open（记日志
  后继续），装配失败退化为空计划。

## 与 pi-agent-core 钩子的对应

| 装配层 | pi 侧接缝 | 约束 |
|---|---|---|
| `tool:before` | `AgentOptions.beforeToolCall` | 只能 `{ block, reason, terminate }`，**不能改写参数**；参数改写留在工具实现内 |
| `tool:after` | `AgentOptions.afterToolCall` | 支持部分覆盖 `content/details/isError`，按 order 依次 reduce |
| `turn:end` | `agent.subscribe` 的 `turn_end` | 只观察、至多排入一条提醒；提醒经 `prepareNextTurnWithContext` 在下一 step 注入，最终轮随轮末丢弃 |
| 系统提示词后缀 | `composeModeSystemPrompt` 的固定槽位 | 在外部目录段之后、git/环境事实段之前 |
| 用户提示词前缀/提醒 | `runPromptTurn` 的 `promptText` 尾部 | 默认空串，拼接结果与改造前逐字节相同 |

## 配置与协议

kv 键 `pi.capabilities`：

```json
{
  "enabled": { "tool-budget": true, "loop-guard": true },
  "params": {
    "tool-budget": { "maxInlineBytes": 32768, "perTool": { "grep": 16384 } },
    "loop-guard": { "mode": "steer", "threshold": 3 }
  }
}
```

- 未出现在 `enabled` 里的能力跟随 `defaultEnabled`：**tool-budget 默认开启**（超限
  输出外置对长会话是净收益，关闭入口在设置页「上下文预算」或协议层），
  loop-guard 默认关闭（实验性，UI 开启时联动 `mode:"steer"`）。显式存的值永远
  压过默认。
- `loop-guard.mode`：`shadow`（默认，只记录）或 `steer`（排入一条提醒，经
  `prepareNextTurnWithContext` 在循环继续时注入；最终轮不会泄漏到下一次用户 prompt）。
- `tool-budget` 默认阈值 32KB，超限文本外置到 `<sessionsDir>/artifacts/`；写失败
  降级为头尾预览。
- 协议：`get_capabilities` 返回 `{ lifecycle, settings, items, failures }`（failures
  是安装期被隔离的能力及原因）；`set_capabilities` 全量覆盖 `settings`、全局生效
  （不接受 sessionId），个别驻留 run 重建失败时响应额外带 `reloadFailures`，失败的
  run 保留旧工具表、下次 resolve 自愈。

## 新增一个能力

1. 新建 `capabilities/<id>.ts`，实现 `Capability`，在 `install(host)` 里注册贡献。
2. 在 `assembly/index.ts` 的 `initCapabilities()` 里注册。
3. 默认 `defaultEnabled: false`，先在 shadow 模式验证，再单独调整默认值。
4. 单测至少覆盖：默认关闭、开启后的贡献、失败降级、会话开关清理。

## 已知取舍

- 回合级 `TurnPlan.reminders` 追加在用户消息尾部（用户可见、随转录保存）；能力
  收尾提醒经 `prepareNextTurnWithContext` 注入为带 `[[capability-reminder]]` 哨兵
  的 user 消息，sidecar 投影/thread_snapshot/搜索与桌面、移动投影层按前缀隐藏，
  不渲染成用户气泡（与 auto-continue/goal-continue 同一套机制）。
- 会话级开关只存在于内存，随 `dropRun` 清理；不持久化。
- `prepareNextTurnWithContext` 仍由压缩独占；能力提醒通过同一个组合函数追加
  `messages`，不覆盖压缩返回的 `context`。
- `set_capabilities` 是全量覆盖：新设置里删掉的 key 会回落到能力的 `defaultEnabled`。
- 协议层提醒：`capabilities` / `reloadFailures` 的帧类型目前只在 sidecar handler 与
  桌面 `pi-bridge.ts` 本地类型里定义（照 `PiBrowserConfig` 先例）；pi-protocol 包级
  schema 仍未补，移动端也未接。将来移动端接入或统一协议时记得补进 pi-protocol
  （本文件记录，防丢）。桌面设置页入口：智能体 → 智能体配置 →「上下文预算」。
- 单个能力安装失败只隔离该能力（`get_capabilities.failures` 可见），不再拖垮全部能力。
- 能力贡献的工具仍受 `toolsForMode` 白名单过滤：ask/plan 等只读模式默认看不到，
  新增能力工具时需要同步维护模式白名单。
- artifact 保留：每会话 200 文件 / 200MB 淘汰最旧；删除会话清整目录。
- 分叉（fork）会把被复制消息里引用的 artifact **硬链**到新会话目录，并把回执
  路径改写为新会话（父会话删除/淘汰后分叉仍可读）；文件在 fork 时已被淘汰的
  那条保留原路径，属尽力而为。`truncate_session` 不产生悬空引用，只留孤儿文件，
  随保留策略或删会话回收。
