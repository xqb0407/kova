# Agent Harness 加固计划（P0/P1/P2）

> 状态：待执行。本计划来自一轮"对照通用 harness 能力"的排查。
> 每条都标注了**确定性**：`已确认` = 本会话读过源码并对齐证据；`待核实` = 只有迹象，动手前先核源码。
> 明确不做：不确定的地方不猜、不顺手重构无关模块。

---

## 0. 基线：本会话已完成（避免重复做）

| 项 | 改动 | 落点 |
|---|---|---|
| 大写入超时 | `read/write/edit` 的宿主 RPC 超时 15s → 120s（原注释误判为"本地文件操作"） | `apps/sidecar/pi-agent/src/storage/hostdb/transport.ts` |
| 错误保真 | `abortAsError` 不再吞掉原因，保留 `signal.reason` | 同上 |
| 超大调用自愈 | 判定从"只认输出截断"扩到"截断 **或** 宿主 RPC 超时/中止" | `apps/sidecar/pi-agent/src/protocol/prompt-pipeline.ts` |
| 常驻拆分指引 | 阈值（200 行 / 16KB）与做法写进 `write` 工具描述 | `apps/sidecar/pi-agent/src/tools/tools.ts` |
| 分段写入能力 | `write` 增 `mode: overwrite \| append`（Rust `handle_write` + sidecar schema） | `apps/desktop/src-tauri/src/tool_exec.rs`、`tools.ts` |
| 子代理活动持久化 | 活动流落盘 + 重启回读 + `interrupted` 终态 | `apps/sidecar/pi-agent/src/subagent/activity-store.ts` 等 |

---

## P0 — 止血（数据安全 / 失控风险）

### P0-1 写入前的 stale 校验　`已确认`

**问题**：`edit` / `write` 不校验"文件是否在模型读取之后被外部改动"。

**证据**：
- `handle_edit`（`tool_exec.rs`）：读文件 → 查二进制 → 数 `old_string` 次数 → 替换，**无一致性校验**；
- `handle_write`（同文件）：`std::fs::write` 直接覆盖，连"文件已存在且从未读过"都不拦。

**后果**：模型按记忆里的旧内容盲写，**stale 覆盖静默发生**，用户/其它 agent 的改动被无声抹掉。

**方案**（Rust 侧约 40 行）：
```
静态表：READ_HASHES: Mutex<HashMap<绝对路径, u64>>   // 内容哈希
handle_read           → 记录哈希
handle_write(覆盖)    → 文件存在时：当前哈希须等于记录（无记录=从未读过 → 拒绝）；写后记录新哈希
handle_write(append)  → 同样要求有记录；文件不存在则放行（新建）
handle_edit           → 读到的内容哈希须等于记录；改后记录新哈希
```
拒绝时给**可自愈**文案：`refusing to overwrite <path>: it changed since you last read it. Read it again and retry.`

**改动面**：`src-tauri/src/tool_exec.rs`（新增表 + 三处接线）。sidecar schema 不变。

**验证**：`cargo check`；补 Rust 单测：读 → 外部改文件 → 写被拒、重读后可写。

**风险**：老会话/新进程内"模型没读过就直接覆盖"的既有行为会被拒——这是**刻意**的收紧；若实测误伤（如自动化任务首写既有文件），再加"显式 force"开关。

### P0-2 重复调用硬闸　`待核实`

**问题**：同一 `(tool, 参数)` 连续失败 N 次时，没有硬拦截；模型原地重发。

**迹象**：实测中同一大 `write` 连发 3 次，全靠自愈文案拉回。

**待核实**：sidecar / pi-agent-core 是否已有去重或循环检测（本会话 grep 未见）。
**方案**：连续失败 ≥3 次同一签名 → 工具层直接返回"停止重试，换策略"的终止性错误（或注入系统提示）。
**改动面**：sidecar 工具执行包装层。

### P0-3 工具输出上限　`待核实`

**问题**：`bash` / `read` 的大输出可能整份进上下文与 host RPC。

**迹象**：sidecar 侧只见 hook 文本与 `git status` 有截断；工具结果未见。
**待核实**：截断是否在 pi-agent-core / Rust 侧已存在。
**方案**：若无 → 工具结果按上限截断 + 附"用 read 的分页参数/重跑更精确命令"的指引。
**改动面**：Rust `handle_*` 出口 或 sidecar 结果收口。

---

## P1 — 能力缺口（体验）

### P1-4 批量编辑 `multi_edit`　`待核实`
一次调用多处替换，减少往返。常见 harness 标配。
**方案**：新增工具或给 `edit` 加 `edits: [{old_string,new_string}]`；逐个唯一匹配、任一失败则整体不落盘（原子）。
**改动面**：Rust + sidecar schema + 桌面 `AGENT_TOOL_UI` 文案。

### P1-5 读文件分页　`待核实`
长文件 `read` 整份返回。改为按行区间 + 上限返回，并给续读指引（`offset/limit`）。
**改动面**：Rust `handle_read` + sidecar schema。

---

## P2 — 治理（策略，需先定阈值）

### P2-6 主代理轮次 / 工具调用预算　`待核实`
子代理有 `maxTurns`；主代理侧未见硬上限。失控循环会一直烧。
**需你定**：每轮最大工具调用数、单会话最大轮数、超限后的行为（中止 / 仅告警）。

### P2-7 危险操作工具层闸　`已确认（部分）`
现状靠提示词 + 权限档；工具层缺"拒绝清单"。
**候选**：force push、`rm -rf` 递归、覆写未读文件（与 P0-1 合流）、越出工作区写。
**需你定**：哪些是**硬拒**、哪些只**提示**。

### P2-8 压缩后一致性核对　`待核实`
压缩、检查点、转录三者对齐未验证。**方案**：加一条一致性自检（压缩后代数、锚点、转录 seq 是否自洽）。

---

## 执行顺序与提交切分

1. **commit A（P0-1）**：stale 校验（Rust + 单测）——数据安全，优先。
2. **commit B（P0-2）**：重复调用硬闸（先核实现状）。
3. **commit C（P0-3）**：工具输出上限（先核实现状）。
4. **commit D（P1-4/P1-5）**：批量编辑 + 读分页。
5. **commit E（P2-6/P2-7/P2-8）**：治理项，等阈值定稿。

每个 commit 独立可回归；P0 三条互相独立，可并行推进。

---

## 纪律

- **先核源码再改**：所有 `待核实` 的条目，动手前先给出结论（有/无 + 证据行号）。
- **不做未验证的半成品**：一次做完一处（改 + 编译 + 测试），不留中间态。
- **不顺手重构**：只动与本条直接相关的代码。
- **Rust 改动必须 `cargo check`**；sidecar 改动必须跑 `bun test`。
