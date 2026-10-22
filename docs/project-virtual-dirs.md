# 项目虚拟目录（多代码工程合并）：设计、细节与审查记录

状态：实现完成；类型检查、单元测试、sidecar 构建与 renderer 构建均通过。

## 1. 目标与范围

把一个「项目」从单一工作目录扩展为**一个主目录 + 若干附加代码工程根目录**，
类似 Pi 的虚拟工作区：前后端两个仓库、共享库、脚手架可以合并在同一张项目卡下，
项目内所有对话共享同一套附加上下文。

本次范围：

- sidecar：项目目录配置、归属解析、提示词/技能/检索/写权限接入。
- 桌面端：项目「⋯」弹层里的目录管理、侧栏按项目归并分组。
- `pi-protocol`：`project_dirs` 契约与会话摘要的 `projectCwd`。
- 明确不做：会话级添加入口、composer 状态条、斜杠命令、移动端 UI。

## 2. 术语

| 术语 | 含义 |
| --- | --- |
| 主目录（main） | 项目的身份目录；通常就是会话 cwd，也是侧栏项目卡的 key |
| 附加根（root） | 主目录之外、合并进同一项目的代码工程目录 |
| 项目归属（projectCwd） | 会话实际挂在哪个主目录下；附加根里的会话也回主目录 |
| 生效目录（effective dirs） | 当前会话真正拿到的附加根列表（会排除 cwd 自身） |

## 3. 存储与安全

配置存 sidecar 的本机 SQLite kv：`pi.projectDirs`，形状：

```json
{ "/abs/frontend": [{ "path": "/abs/backend", "label": "backend" }] }
```

为什么不用仓库内文件（如 `<cwd>/.kova/project-dirs.json`）：

- 项目配置会注入 `AGENTS.md`、技能与文件检索路径；跟随 git 意味着 clone 别人的仓库
  就能给 agent 注入指令，这是不可接受的默认值。
- 本机 kv 同时被桌面端、远程端和 sidecar 共享，不需要新增数据库列或迁移。
- 代价：团队成员不能自动共享同一套虚拟目录；如需共享要单独做带信任确认的机制。

启动时 `initProjectDirs()` 在模型目录闸门内装载；损坏/不可读按空配置启动并记日志，
不阻断会话。写盘失败会回滚内存态（见 §10）。

## 4. 归属与合并规则

### 4.1 归属

- `projectCwdFor(cwd)`：cwd 等于某项目主目录，或等于某项目的附加根 → 返回主目录；
  否则 `undefined`。
- 普通任务（cwd 为空）永远没有项目归属，也就没有附加目录。
- **精确路径匹配**：会话开在附加根的子目录时，不会自动并入该项目（与 kova 现有
  「按 cwd 精确分组」一致）。需要合并就把那个子目录本身添加为根。
- 未配置的普通 cwd 可以被吸收：把 `backend` 加为 `frontend` 的根后，原来在
  `backend` 里的会话会归到 `frontend` 项目卡下。已配置项目之间则互斥。

### 4.2 生效目录

`effectiveProjectDirs(cwd)`：

- cwd = 主目录 → 全部附加根；
- cwd = 某附加根 → 主目录 + 其余附加根（排除自己，因为自己就是工作区）；
- 其它 → 空。

### 4.3 准入校验

`addProjectDir` 依次检查：

1. 主目录存在且是目录；
2. 新根存在、是目录、路径不含控制字符；
3. 不与主目录、已有根重叠（任一方向包含都算）；
4. 每项目最多 `MAX_EXTERNAL_DIRS = 8` 个附加根；
5. 不被其它**已配置**项目的任何根占用，也不包含它们。

手工编辑 kv 造成的脏数据在装载时归一：主目录重叠的根、跨项目重复的根、
项目内互相嵌套的根都按「先见者胜」剔除。

## 5. 生效链路

### 5.1 系统提示词

- 注入位置：`composeModeSystemPrompt` 的 instructions 段之后、git 段之前。
- 段标题：`## Project Folders (additional code repositories)`。
- 每个根取**第一个非空**指令文件：`AGENTS.md` → `CLAUDE.md` → `.claude/CLAUDE.md`
  （与工作区指令层同款，避免同一份规则重复注入）。
- 单文件 16k 字符截断；全部根合计 32k 字符预算，超出按顺序截断并附标记。
- 目录不存在时保留一段 `[unavailable: directory does not exist]`，让模型不要反复尝试。
- 无附加根时整段为空串，默认提示词字节级不变。

### 5.2 技能

- 每个根扫描 `.kova/skills`、`.agents/skills`、`.claude/skills`。
- 新 scope `external`，stateKey 带根目录路径；`editable=false`。
- 合并顺序：工作区 > 外部根（按添加顺序）> 系统 > 生态·用户 > 插件。
- 设置页的技能清单不传外部根，因此不会被某个项目的临时目录污染；
  模型侧通过系统提示词目录与 `use_skill` 使用外部技能。
- 外部目录的技能缓存按目录签名缓存，进程内不主动修剪（见 §10）。

### 5.3 文件检索

工具 `search_external_files(pattern, maxResults?)`：

- 只读；跨所有生效附加根搜索，按目录分组返回绝对路径。
- 默认 50 条、上限 1000；达到上限即停并标记 `truncated`。
- 跳过 `.git`、`node_modules`、所有隐藏目录、符号链接。
- 额外有 50,000 条遍历安全阀（只防失控，不体现在结果里）。
- 工具在 agent / goal 档工具集里；plan / ask 只读档不含它，但可以用 `glob`/`grep`
  的绝对路径参数检索附加根。
- 模型**不能**增删项目目录。

### 5.4 写权限

- `workspace-write` / `review` 档把生效附加根按「工作区内」对待：
  `write` / `edit` 免确认（review 档也免审查）。
- `ask` 档不变，仍逐次询问。
- `bash` 不受影响：参数里看不出写目标，仍按原审批链处理。

### 5.5 侧栏分组

- 会话摘要新增 `projectCwd`（sidecar 在 `sessionSummaryOf` 里算好）。
- 桌面 `piSessionProjectMap` 存 remoteId → projectCwd；`useThreadListGroups` 优先用它
  分组，因此附加根里的会话回到同一张项目卡下。
- 在项目卡里「新建对话」仍把工作目录设为主目录。
- 项目目录变更后，sidecar 广播 `sessions_changed`，各端重新拉清单并按新归属分组。

### 5.6 编辑检查点（多根）

- sidecar 条目所有权层升级为 **manifest v2**：每条记录带 `root + rel`，
  清单键 = `root + NUL + rel`，跨根同名文件不会串。
- 主根（会话 cwd）沿用 v1 blob 布局，旧检查点可无损查询/撤销；附加根按
  `rootHash` 分子目录存 blob。读取 v1 清单时在内存里升级，下一次写盘落 v2。
- `write`/`edit` 的 prepare/capture 现在会收到项目的生效附加根；落在任何根内
  的路径都会记录边界。根外路径仍跳过。
- `checkpoint_status` 返回 `{ root, rel, primary, ... }`；检查点卡把主根文件
  与影子仓库 diff 按 `rel` 合并，附加根文件单独一组展示（带根目录徽标）。
- `checkpoint_diff` / `checkpoint_undo` 接受可选 `root`；省略时按主根解析
  （兼容旧桌面端）。回滚资格仍按记录查找，非记录根无法借 undo 写任意路径。
- **边界**：整轮影子仓库 diff/撤销（Electron 侧）仍只覆盖会话 cwd；附加根
  只提供逐文件回滚，不进入整轮 patch。整轮撤销后若仍有逐文件记录（附加根、
  gitignored 文件、非 git 主目录），卡片会保留并提示逐文件回滚，不会把入口
  一起清掉。
- **影子仓库没收录的主根文件**：gitignored 文件、主目录不是 git 仓库时，
  检查点卡会从条目所有权层单独列出「主目录（未进入整轮快照）」组，同样支持
  逐文件回滚；这类轮即使影子 diff 为空也会出卡。
- **折叠态聚合数字**：同一轮同时改了 cwd 与附加根时，折叠态的文件数/增删行
  仍以影子仓库（cwd）为准；附加根/快照外主根文件的数字在展开后按行展示。
  只有所有权层记录、没有影子 diff 的轮会单独出卡，聚合数字来自所有权层。

### 5.7 文件树

- 主进程 `fs-cmds.resolveRoot` 增加项目虚拟目录的可信根：只认**当前存在**的
  主目录/附加根（realpath），文件不存在/无权限不授权。
- 文件标签顶部出现根切换器（主目录 + 附加根），默认当前会话 cwd；切换后
  `FileExplorer` 以该根为 `rootCwd`，展开状态按根重置。
- 打开文件、浏览器预览、右键新建/重命名/删除都使用当前选中根；
  文件标签的 `(cwd, path)` 身份因此能区分同名文件。
- 只做“按根切换”，不把多个根虚拟合并成一棵树（避免相对路径冲突）。

### 5.8 不随项目目录扩展的能力

为了避免过度承诺，以下能力仍然只认当前会话 cwd：

- **git 环境段**：只显示 cwd 仓库的分支/状态；附加根的 git 状态用 bash 自行查询。
- **记忆 / 子代理定义 / MCP 工作区配置**：只读取 cwd 下的 `.kova/*`，不合并附加根。
- **bash 自动审批**：不变——参数里看不出写目标，仍走原审批链。
- **整轮撤销**：影子仓库快照/`git_checkpoint_restore` 仍只覆盖 cwd；
  附加根用检查点卡里的逐文件回滚。

### 5.9 热生效

`recomputeRunsForProject(projectCwd, previousRoots)`：

- 遍历驻留 run，命中「当前归属该项目」或「变更前属于该项目」的：
  重算 `run.externalDirs` → 预热技能缓存 → 重排系统提示词
  （`agent.state.messages` 与 `loopContext.messages` 同改，轮中下一次模型请求即生效）。
- 未驻留会话不物化，下次 `resolveSession` 时自然按新配置装配。

## 6. 协议

| 命令/字段 | 说明 |
| --- | --- |
| `get_project_dirs { cwd? }` | 返回 `project_dirs`：`main`、`roots`（主目录在前）、`dirs`（请求 cwd 的生效附加目录）、`missing`；无 cwd 时返回全部项目 `projects` |
| `add_project_dir { cwd, path }` | 校验并持久化，返回同款 `project_dirs` |
| `remove_project_dir { cwd, path }` | 同上；主目录不可移除 |
| `SessionSummary.projectCwd` | 会话所属虚拟项目主目录；缺省 = 按 cwd 分组 |

`thread_snapshot` 不携带附加目录；UI 打开项目弹层时现拉 `get_project_dirs`。

## 7. UI

- 入口只有一处：侧边栏项目行的「⋯」弹层 →「项目目录（多个代码工程）」。
- 主目录只读并带「主目录」徽标；附加根可添加/移除；移除有确认（影响项目内所有对话）。
- 不存在的根显示琥珀色警告「目录不存在（配置保留，已跳过）」。
- 添加/移除按钮仅在桌面壳、非远程模式显示（需要原生目录选择器）；远程端只读展示。
  远程网关同时把 `add_project_dir` / `remove_project_dir` 列入拒绝名单，作为第二道闸。
- 文件标签顶部有根切换器（主目录 + 附加根），默认当前会话 cwd，可切换浏览/打开文件。
- 检查点卡展开后：主根文件与影子仓库 diff 合并展示；附加根文件单独一组，
  可逐文件回滚或打开。
- 没有 composer 状态条、没有 `/dir-add`、`/dirs`，也没有会话级添加对话框。

## 8. 边界与细节问题

1. **为什么只做项目级**：会话级目录会让同一项目里的不同对话看到不同上下文，
   与「虚拟工作区」的心智模型冲突；用户明确要求普通任务不挂目录。
2. **普通任务**：cwd 为空 → 归属为空 → 不注入、不检索、不扩写权限。
   只有选了工作目录（成为项目会话）后才继承项目目录。
3. **fork 会话**：fork 复制 cwd，因此天然继承同一项目与同一套附加目录；
   不需要在转录里复制任何目录状态。
4. **切换 cwd**：`rebindRunCwd` 重新求值归属与附加目录，重建工具/技能/提示词。
5. **目录被删**：配置保留，提示词标注不可用，技能/检索跳过；恢复目录后自动重新生效。
6. **缓存增长**：外部技能缓存按根目录保留，不随会话结束修剪；条目数受「每项目 8 个根 +
   项目数」约束。多会话各自不同目录时不会互相删缓存。
7. **搜索截断**：`truncated = 命中数 >= 上限`，达到上限后再无匹配也报 `truncated`；
   这是保守提示，不是精确的「还有更多」判定。
8. **写权限**：附加根内的 `write/edit` 在 workspace-write/review 档免确认；
   这是用户显式配置的项目边界，不是仓库自我授权。
9. **跨端同步**：本窗口的增删走命令应答；其它窗口靠 `sessions_changed` 重拉清单，
   弹层每次打开都会重新拉取配置。
10. **持久化失败**：add/remove 先改内存再写盘，失败会回滚，避免「本进程看到加了、
    重启后消失」。
11. **项目归档/删除**：配置仍以主目录为 key 保留；重新打开同 cwd 的会话会恢复。
12. **子目录会话**：不自动归并，需要显式把该子目录加为根（精确匹配原则）。

## 9. 测试

自动化：

- `test/agent/project-dirs.test.ts`：归属、生效清单、重叠/占用/上限校验、
  持久化回放、脏配置归一、移除最后一个根后的归属消失。
- `test/agent/external-dirs.test.ts`：指令文件优先级与截断、缺失目录占位、
  搜索跳过规则、上限与跨目录预算。
- `test/agent/external-dir-tools.test.ts`：无目录报错、命中分组、空结果说明。
- `test/agent/modes.test.ts`：附加根写权限（workspace-write / ask / 目录缺失不授权）
  与提示词段顺序。
- `test/sessions/project-dirs-resolve.test.ts`：真实 `resolveSession` 装配——提示词、
  工具表、附加根视角、普通任务为空、项目目录热更新与只读投影。
- `apps/desktop/lib/pi/pi-thread-adapter.test.ts`：会话摘要的 `projectCwd` 落到侧栏
  分组镜像，移出项目时旧映射被删除。
- `test/agent/workspace-boundary.test.ts`：extraRoots 放行边界与 bash 不受影响。
- `test/skills/skills.test.ts`：外部技能层合并与遮蔽顺序。
- `test/checkpoint/store.test.ts`：检查点多根——同轮双根、root/primary、跨根
  同名文件回滚隔离、越界拒绝、v1 清单无损升级。
- `apps/desktop/lib/pi/pi-runtime/turn-checkpoints.test.ts`：只有附加根改动的轮
  仍落检查点卡（聚合来自所有权层）；零改动不出空卡。
- `apps/electron/main/project-roots.test.ts`：文件树可信根解析（只认存在的目录、
  脏 JSON/重复根/文件节点）。
- `packages/pi-protocol/test/contract.test.ts`：`project_dirs` 契约与
  `SessionSummary.projectCwd`。

已执行：

```bash
cd apps/sidecar/pi-agent && bun test          # 1811 通过
cd apps/desktop && bun test lib               # 885 通过
cd apps/electron && bun test                  # 29 通过
cd packages/pi-protocol && bun test           # 30 通过
cd apps/sidecar/pi-agent && tsc --noEmit
cd apps/desktop && tsc --noEmit
cd apps/electron && tsc --noEmit
bun run build                                 # sidecar smoke + renderer + main
```

手工验收建议：

1. 项目 A 添加仓库 B 为附加根；重启应用，配置仍在。
2. 在 A 新建对话：系统提示词出现 `## Project Folders`，包含 B 的 `AGENTS.md`。
3. 在 B 里新建对话：侧栏归到 A 的项目卡下；工作区胶囊仍显示 B。
4. 文件标签顶部切换到 B：能浏览、打开、预览 B 下文件。
5. 让模型调用 `search_external_files "*.ts"`：结果包含 B 下文件。
6. workspace-write 档让模型写 B 下文件：不弹审批；写项目外仍弹。
7. 写 B 下文件后展开检查点卡：出现「项目附加根」行，可逐文件回滚；
   整轮撤销仍只处理 A 的仓库。
8. 移除 B：A/B 的对话恢复各自分组，提示词里的 B 段消失，文件树切换器消失。
9. 手工改名 B：弹层/文件树显示不可用，提示词标注 unavailable，检索跳过。

## 10. 审查记录

本轮审查发现并修正：

- **跨会话缓存修剪**：早期实现按单次 `externalDirs` 清单修剪技能缓存，多个会话
  各自不同目录时会误删别人的缓存；改为只增不删（按目录去重）。
- **TDZ**：`resolveSession` 在 `run` 声明前把 run 传给工具参数构造器会踩 TDZ；
  改为 getter 延迟解引用。
- **持久化失败分叉**：添加/删除先改内存再写 kv，失败时内存已变；已改为失败回滚。
- **脏配置**：手工编辑 kv 可能产生跨项目重复/嵌套根；装载时按「先见者胜」归一。
- **热路径 realpath**：`list_sessions` 每个会话都 realpath；对主目录命中加了原字符串短路。
- **假 run 防御**：审批与工具闭包对 `externalDirs` 缺失做了防御，避免测试桩/旧对象崩溃。
- **缺失目录提示**：`project_dirs` 增加 `missing`，弹层显示警告。
- **缺失根不授权写入**：目录被删/路径写错时配置保留，但不再计入
  workspace-write/review 的免确认范围（防止顺着不存在路径写到任意位置）。
- **分组重算信号**：`projectCwd` 不在 thread item 元数据里，清单逐字段相同时
  不会触发重算；`useThreadListGroups` 补订阅摘要版本号（每次 list 落库自增）。
- **项目变更后的后处理失败**：配置已落盘时，热更新/广播失败只记日志、不把
  命令回成 error（否则前端会以为没加成功并重试）。
- **远程写入口**：网关拒绝远程 `add_project_dir` / `remove_project_dir`，
  UI 在远程模式隐藏写控件，只保留只读展示。
- **端到端装配测试**：新增真实 `resolveSession` 测试，覆盖依赖环、run 初始字段、
  提示词/工具表、附加根视角、普通任务为空、热更新与只读投影。
- **检查点多根**：manifest v2（root+rel 键、主根沿用旧 blob 布局、v1 内存升级）；
  `write/edit` 把项目附加根传给 prepare/capture；状态/差异/回滚按 root 定位，
  非记录根无法借 undo 写任意路径；卡片把附加根文件单列并支持逐文件回滚。
- **文件树多根**：主进程 `fs-cmds.resolveRoot` 只信任**存在的**项目主目录/附加根；
  文件标签顶部提供根切换器，打开文件/预览/写操作都使用当前根。
- **会话级残留**：移除了遗留的会话级 store/状态条/命令与协议，避免两套语义并存。

已知限制：

- 搜索遍历安全阀触发时不会标记 `truncated`（只防失控，不承诺完整）。
- 子目录不会自动并入项目（精确匹配）。
- 配置是本机私有的，暂不支持团队共享。
- 项目弹层打开时现拉配置，多窗口并发修改以最后写者为准（命令串行 + 全量覆盖）。
- 移动端未消费 `projectCwd`：仍按会话自己的 cwd 分组（协议字段可选，不影响旧端）。
- 整轮撤销仍只覆盖会话 cwd；附加根、gitignored 主根文件、非 git 主目录只有
  逐文件回滚（见 §5.6）。
- 同一轮同时改 cwd 与附加根时，检查点卡折叠态的聚合数字只含 cwd；展开后
  才看到附加根/快照外主根文件的逐文件统计。
- git 环境段/记忆/子代理/MCP 工作区配置仍只认当前 cwd（见 §5.8）。
- **提示词读数的既有差异**：热重排走 `composeRunPrompt`，沿用「不写 Model 行」的
  既有语义；只读投影仍带 Model 行，因此变更项目目录后两侧 `systemPromptTokens`
  允许相差一行模型描述（约 6–10 tokens）。初始 resolve 的两侧读数仍逐字段一致。
