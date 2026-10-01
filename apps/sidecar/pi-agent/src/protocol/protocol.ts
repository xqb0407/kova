/**
 * pi-agent sidecar 协议层：stdin NDJSON 命令分发中枢。
 * 由 Tauri(Rust) 以子进程方式拉起，本层职责只有装配：
 * 解析 stdin 行 → initGate 就绪闸门 → mgmtQueue 串行（prompt 例外）→ 注册表路由。
 *
 * ===== 线协议 =====
 *
 * 通用约定：每条请求带 id；管理命令应答帧回填同 id；prompt 走流式（见下）。
 * 业务错误以 { id, type: "error", errorText, error? } 应答（handler 抛错由
 * handleLine 收口）。error 是加性的结构化归因 { code, source, retryable,
 * statusCode? }（设计文档 §8）：出口路径（未知命令/管理 catch/prompt 准备
 * catch）经分类器换算，含糊串按本地运行时归因；errorText 永久保留兜底。
 *
 *   { "type": "prompt", "id", "threadId", "text", "sessionId"?, "cwd"?, "steer"? }
 *       cwd = workspace 目录；仅在需要新建会话时使用，缺省为用户主目录
 *       steer?: true——并入当前轮：该线程忙时消息注入活跃轮（agent.steer，下次模型
 *       调用前被消费，随活跃轮转录落盘），本请求走退化流 data-steered →
 *       start 后挂起，finish 随宿主轮收尾补发（提前结束会把框架共享 status 置回
 *       ready，宿主轮会被 UI 显示为已停止；见 steerIntoActiveRun）；不占队列上限，
 *       不中止当前回复。线程空闲 / 活跃轮正在收尾 / steer 抛错时落回普通排队
 *       prompt 结束后若有后台子代理（Task 委派）仍在运行，等待其完成并在同一条
 *       reqId 消息流内注入恢复 prompt 投递报告（多 step 收敛），再发 finish
 *   { "type": "abort", "threadId"? }   中止线程（缺省全局）的父代理与后台子代理，
 *       并取消该范围内全部排队 prompt；threadId 提供时只影响该线程
 *   { "type": "shutdown" }   宿主应用退出（kill_on_exit）发起的优雅终止：全局 abort
 *       让在飞 run 把 partial 结算落盘、取消排队、停自动化调度，等全部 run idle
 *       （5s 封顶）后经 maybeExit 冲刷 stdout 退出进程；无应答帧
 *   { "type": "queue_cancel", "id", "requestId" }           → { id, type: "queue_cancelled", requestId }
 *       删除单个排队项，其 prompt 流立即 abort + finish 收尾（不执行）
 *   { "type": "queue_promote", "id", "requestId" }          → { id, type: "queue_promoted", requestId }
 *       立即发送：该项提到所属线程队首并中止该线程当前活跃 turn（其余排队项保留）
 *   { "type": "queue_steer", "id", "requestId" }            → { id, type: "queue_steered", requestId }
 *       并入当前轮：排队项注入所属线程活跃轮（不中止不排队），其流走 steered
 *       退化收尾（finish 随宿主轮收尾补发）；无活跃轮/正在收尾则报错、项原位保留
 *   { "type": "queue_pop", "id", "threadId"?, "sessionId"? } → { id, type: "queue_popped", threadId, popped }
 *       弹出队首交由前端重发（前端接力泵用；仅线程空闲且无串行链节时弹出，
 *       否则 popped 为 null——链节仍在，泵转而在跑轮探测重挂）
 *   prompt 排队（prompt-queue.ts）：队列按线程隔离，线程内上一轮未结束时到达的
 *       prompt 进该线程 FIFO 队列（多线程并行互不阻塞）；每次变更向该线程活跃
 *       请求广播 { chunk: { type: "data-queue-state", data: 全量快照 } }（前端
 *       最后快照胜出），并落 queue_state 行进 session（重启后 get_queue_state
 *       回放恢复）；线程内顺序由该线程串行链保证
 *   { "type": "ping", "id" }                                  → { id, type: "pong" }
 *   { "type": "list_sessions", "id" }                         → { id, type: "sessions", sessions: [...] }
 *   { "type": "list_running", "id" }                          → { id, type: "running", sessionIds: [...], turns: [{sessionId,requestId}] }
 *       当前正在跑 prompt turn 的会话清单（前端刷新/启动后水合侧边栏"运行中"指示）；
 *       turns 为会话与请求 id 齐备的子集，供前端在 webview 存储丢失时重建在飞流登记
 *   { "type": "get_subagent_activity", "id", "delegationId" } → { id, type: "subagent_activity_snapshot", record, items }
 *       子代理一次委派的运行活动快照（Task 委派的全局内存索引，delegationId 接受 ≥4 位前缀）；
 *       record = { agentName, description?, status, startedAt, completedAt?, turns, toolCalls, report? }，
 *       items = SubagentActivityItem[]（见 types.ts）；记录不存在（重启/被清理）回 error
 *   { "type": "new_session", "id", "threadId", "cwd" }        → { id, type: "session", sessionId, threadId }
 *   { "type": "fork_session", "id", "sessionId" }             → { id, type: "forked", sessionId: <新会话> }
 *       分支对话：把源会话转录复制到全新 sessionId（seq 沿用、header 重写），
 *       索引行标题加「（分支）」后缀；与源会话此后再无关联
 *   { "type": "thread_snapshot", "id", "sessionId" }         → { id, type: "thread_snapshot", snapshot }
 *       PiClient 契约快照（react-pi 迁移）：JSONL 转录 → { metadata, messages, hostUiRequests?, seq?, lastError? }；
 *       messages 为 pi-ai 原生 agent 行直出（压缩检查点行重建为 compactionSummary 消息），
 *       metadata.status 以 activeTurns 为准；seq = 事件水位现读（未盖章不带）
 *   { "type": "get_history", "id", "sessionId", "tail"?, "beforeSeq"? }
 *                                       → { id, type: "history", messages, pending, firstSeq, lastSeq, hasMore }
 *       历史从 agent 消息重建，含工具部件（tool part 的 input/output 与 live 流一致）与
 *       工具图片的 data-image part（与 live 同构）；
 *       compaction 检查点行重建为 data-compaction 分隔线 part（刷新后分隔线不丢）；
 *       pending = 转录里未结算的 PendingInteraction[]（§4，刷新/重启后重建挂起卡）；
 *       tail/beforeSeq = 消息行分页窗（§6，游标 = 行 seq；缺省全量不破旧端），
 *       firstSeq/lastSeq/hasMore 为窗口元数据（空窗 first/last = null）
 *   { "type": "list_pending", "id", "sessionId" | "threadId" } → { id, type: "pending", items: PendingInteraction[] }
 *       挂起交互权威拉取（§3 回拉表 / §4）：读转录交互行配对出未结算清单，不依赖会话驻留
 *   { "type": "delete_session", "id", "sessionId" }           → { id, type: "deleted" }
 *   { "type": "rename_session", "id", "sessionId", "name" }   → { id, type: "renamed" }
 *   { "type": "archive_session", "id", "sessionId", "archived" } → { id, type: "archived" }
 *       归档 / 取消归档（archived: bool）：列表项打标，正文与索引行不动；list_sessions 会带回 archived 字段
 *   { "type": "set_session_cwd", "id", "sessionId", "cwd": string }
 *                                       → { id, type: "session_cwd_set", sessionId, cwd }
 *       中途换/清会话工作目录（""=解绑，执行目录回落任务工作区会话子目录）：
 *       驻留 run 走完整换绑（重建工具/技能/提示词 + 回写索引行与 header），
 *       不驻留只写索引行与 header（下次物化自然生效）；本轮在跑时报 busy 拒绝
 *   { "type": "list_models", "id" }                           → { id, type: "models", models: [...], providers: [...] }
 *       models 项含 enabled 与 maxTokens/input/cost 属性（enabled=false = 已被过滤隐藏，前端自行过滤）
 *   { "type": "set_model", "id", "provider", "modelId", "sessionId"? } → { id, type: "model", provider, modelId }
 *       sessionId 提供 = 会话定靶选择：转录 model_change 行与偏好列只落该会话（其余驻留会话不动）；
 *       缺省 = 全局默认变更（设置页/启动恢复）：更新「最近一次使用」，驻留会话中仅从未显式
 *       选过模型的即时刷 live run（不落行）。两种形态都写 kv pi.model。
 *   { "type": "get_model", "id" }                             → { id, type: "model", provider, modelId }
 *       未选择时 provider/modelId 为空串（前端据此校准 UI 真值）
 *   { "type": "set_thinking", "id", "level" }                 → { id, type: "thinking", level }（深度思考档位，广播到活动会话）
 *   { "type": "set_thinking_maps", "id", "maps" }             → { id, type: "thinking_maps", applied }（模型级 thinkingLevelMap 覆盖整包下发）
 *   { "type": "lookup_thinking_seed", "id", "modelId" }       → { id, type: "thinking_seed", seed }
 *       按 modelId 反查内置目录的属性种子（reasoning/thinkingLevelMap/supportedThinkingLevels
 *       + contextWindow/maxTokens/input/cost 目录真值）；
 *       自定义端点与目录外新增模型的属性弹窗预填用，未命中回 null
 *   { "type": "get_personalization", "id" }                   → { id, type: "personalization", settings, paths }（个性化设置：回复风格/自定义风格列表/内置档位覆盖/称呼/人设/自定义指令；paths = 人设/指令身份文件绝对路径）
 *   { "type": "set_personalization", "id", "settings" }       → { id, type: "personalization", settings, paths }（人设/指令落全局身份文件、结构化字段含自定义风格列表与内置覆盖落 SQLite kv + 活动会话系统提示词热替换）
 *   { "type": "get_app_mode", "id" }                          → { id, type: "app_mode", mode }（全局工作模式："work" | "code" | "design"，事实源 SQLite kv）
 *   { "type": "set_app_mode", "id", "mode" }                  → { id, type: "app_mode", mode }（落 SQLite kv + 活动会话系统提示词热替换，同 personalization；非法值回落 "code"）
 *   { "type": "get_memory", "id" }                            → { id, type: "memory", settings }（记忆设置：总开关/作用域叠加/文件检索/指定文件白名单）
 *   { "type": "set_memory", "id", "settings" }                → { id, type: "memory", settings }（落 SQLite kv + 活动会话系统提示词热替换，同 personalization）
 *   { "type": "get_browser", "id" }                           → { id, type: "browser", settings }（浏览器驱动开关：browser_* 工具是否可用）
 *   { "type": "set_browser", "id", "settings" }               → { id, type: "browser", settings }（落 SQLite kv 即生效，工具 execute 实时门控）
 *   { "type": "get_imagegen", "id" }                           → { id, type: "imagegen", settings }（文生图：总开关/默认生图模型 provider+modelId/默认尺寸）
 *   { "type": "set_imagegen", "id", "settings" }               → { id, type: "imagegen", settings }（落 SQLite kv 即生效，generate_image execute 实时门控）
 *   { "type": "list_secrets", "id" }                          → { id, type: "secrets", entries, enabled, bindings }（密钥清单**只回名字与掩码**，明文落 Rust 侧密文存储，无 RPC 出口）
 *   { "type": "save_secret", "id", "name", "scope", "value"?, "skills"?, "cwd"? } → 刷新后的密钥清单
 *       value 留空 = 只改绑定不改值（编辑弹窗不回填明文）；skills 给出即整条替换该名字的技能白名单；scope = "global"|"workspace"（workspace 需 cwd）
 *   { "type": "delete_secret", "id", "name", "scope", "cwd"? } → 刷新后的密钥清单（连带摘掉该名字的绑定）
 *   { "type": "save_secret_bindings", "id", "enabled"?, "bindings"? } → 刷新后的密钥清单（总开关 + 绑定整包覆盖，落 SQLite kv）
 *       绑定语义见 secrets/secrets.ts：技能白名单 ["*"] = 任意 bash 调用，空数组 = 不注入（默认拒绝）
 *   { "type": "get_observability", "id" }                     → { id, type: "observability", settings }（可观测性导出配置：OTLP 端点/鉴权头/采样率/脱敏）
 *   { "type": "set_observability", "id", "settings" }         → { id, type: "observability", settings }（落 SQLite kv 即生效，otlp-exporter 实时门控）
 *   { "type": "test_observability", "id", "settings"? }       → { id, type: "observability_tested", result }（探针 span 试发：settings 缺省用当前配置，10s 超时）
 *   { "type": "get_hooks", "id" }                             → { id, type: "hooks", hooks: [...] }（Claude Code 式生命周期钩子配置，见 hooks.ts）
 *   { "type": "set_hooks", "id", "hooks": [...] }             → { id, type: "hooks_saved" }（全量覆盖，落 SQLite kv；PreToolUse/PermissionRequest 在工具调用/审批路径同步生效）
 *   { "type": "list_memory_files", "id", "cwd"? }             → { id, type: "memory_files", scopes: { global, workspace } }
 *       两作用域记忆目录路径与文件清单（工作区未选时 workspace 为 null）；设置 → 记忆页渲染用
 *   { "type": "read_memory_file", "id", "scope", "cwd"?, "file" } → { id, type: "memory_file", file, content }
 *       读单个记忆文件（相对记忆目录，允许 daily/...；路径越界回 missing）；设置页点开文件预览/编辑用
 *   { "type": "write_memory_file", "id", "scope", "cwd"?, "file", "content" } → { id, type: "memory_file_saved", scope, file, bytes }
 *       保存设置页编辑的记忆文件（整体覆盖，根级 .md），成功后热替换活动会话提示词
 *   { "type": "list_subagents", "id", "cwd"? }                → { id, type: "subagents", agents, workspaceCwd, diagnostics }
 *   { "type": "save_subagent", "id", "scope", "cwd"?, ("definition"|"raw"), "name"? } → 校验后写 <app_data>/subagents 或 <cwd>/.kova/subagents 的 YAML + 热重载 → 同款 subagents 应答（name=编辑前原名，改名时清旧文件）
 *   { "type": "delete_subagent", "id", "scope", "name", "cwd"? } → 删文件 + 热重载 → 同款 subagents 应答（内置不可删）
 *   { "type": "set_subagent_enabled", "id", "scope", "name", "cwd"?, "enabled" } → 开关落 kv + 热重载 → 同款 subagents 应答
 *   { "type": "automation_list", "id" }                        → { id, type: "automation_list", tasks }
 *   { "type": "automation_save", "id", "task" }                → 无 task.id 建 / 有则全量覆盖（排期经 resolveScheduledTaskDefinition 校验）→ automation_list 应答
 *   { "type": "automation_delete", "id", "taskId" }            → 删任务 → automation_list 应答
 *   { "type": "automation_set_enabled", "id", "taskId", "enabled" } → 开关排期 → automation_list 应答
 *   { "type": "automation_run_now", "id", "taskId" }           → 立即触发一次（结果经 automation_run_done 自发帧）→ automation_list 应答
 *   { "type": "automation_history_delete", "id", "taskId", "entryIds"? | "all"? } → 删运行记录条目（entryIds 单/多条，all:true 清空；不级联会话）→ automation_list 应答
 *   { "type": "automation_preview", "id", "scheduleType", "schedule", "count"? } → { id, type: "automation_preview", runs } 或 { id, type: "automation_preview", error }（排期校验红字提示，不占调度器）
 *   { "type": "automation_templates", "id" }                   → { id, type: "automation_templates", templates }（预置模板清单，见 automation/templates.ts）
 *   { "type": "list_skills", "id", "cwd"? }                   → { id, type: "skills", skills, workspaceCwd, diagnostics }
 *       技能清单（<cwd>/.kova/skills、<app_data>/skills 可编辑 + 生态 .agents/skills 只读合并，
 *       同名遮蔽 工作区>生态·工作区>系统>生态·用户）；设置 → 技能页渲染用
 *   { "type": "save_skill", "id", "scope", "cwd"?, ("definition"|"raw"), "fallbackName"?, "name"? }
 *                                                            → 校验后写 <app_data>/skills 或 <cwd>/.kova/skills 的
 *       技能 .md 文档（frontmatter+正文）+ 热重载 → 同款 skills 应答（name=编辑前原名，改名时清旧文件）
 *   { "type": "delete_skill", "id", "scope", "name", "cwd"? } → 删文件 + 热重载 → 同款 skills 应答（生态只读不可删）
 *   { "type": "set_skill_enabled", "id", "scope", "name", "cwd"?, "enabled" } → 开关落 kv + 热重载 → 同款 skills 应答
 *   { "type": "set_skills_enabled", "id", "targets": [{ "scope", "name" }...], "cwd"?, "enabled" }
 *       批量开关（设置页「全部启用 / 全部关闭」快捷）：targets 整表置为目标状态、一次性落盘 + 热重载 → 同款 skills 应答
 *   —— 设计主题（awesome-design-md 品牌风格 DESIGN.md；内置 zip 包随版本解压同步，
 *      用户层 <app_data>/design-md/user 可编辑，同名用户主题遮蔽内置；见 design-md/）——
 *   { "type": "list_design_themes", "id", "threadId"?, "sessionId"? } → { id, type: "design_themes", entries, version, builtinCount, userCount, error, active? }
 *       主题清单（内置层来自 zip catalog + 遮蔽标记；用户层现扫目录；带 threadId 回该会话当前选中 active）；
 *       设置页与 composer 胶囊渲染用
 *   { "type": "get_design_theme", "id", "ref": { "scope", "id" } } → { id, type: "design_theme_doc", ref, entry, doc }
 *       主题全文（user = 磁盘原文含 frontmatter；builtin = 包内 DESIGN.md 原文）：编辑回填/预览/fork 另存用
 *   { "type": "save_design_theme", "id", ("definition"|"raw"), "fallbackName"?, "themeId"? }
 *       → 校验后写用户层 <slug>.md + 刷快照 + 活动会话主题句热替换 → { id, type: "design_theme_saved", ref, entries, ... }
 *       themeId = 改名编辑目标的业务 id（裸 id 被协议 reqId 占用，WS 通道会覆写，同 save_model_provider 的 providerId；改名后旧 id 引用自动重映射）
 *   { "type": "delete_design_theme", "id", "scope": "user", "themeId" } → 删文件 + 一切引用（未驻留偏好列/驻留 run/最近使用）收口为不使用 + 热替换 → 同款 design_themes 应答（内置不可删）
 *   { "type": "set_design_theme", "id", "threadId", "sessionId"?, "cwd"?, "theme": { "scope", "id" } | null }
 *       会话级选中（composer 胶囊）：null = 显式不使用主题（偏好列落 ""，不再回落最近使用）；
 *       只重排该会话提示词 + 落 sessions.design_theme 列与最近使用 kv → { id, type: "design_theme_set", sessionId, theme }
 *   —— 多窗口/远程同步（无 id 自发通知帧，Rust pi-chunk-batch 原样广播 + remote.rs 白名单）：
 *   { "type": "design_themes", entries, ... }      save/delete 后推新清单（发起方另有带 id 应答，推送幂等）
 *   { "type": "design_theme_set", "threadId", "sessionId", "theme" }
 *       set 选中后推该线程新值；save 改名/delete 收口波及的驻留线程也逐线程推此帧
 *   —— 插件系统（市场页「已装插件」；插件清单探测 .kova-plugin/.claude-plugin/.codex-plugin，
 *      四类组件 skills/mcpServers/hooks/subagents 垫底合并，见 plugins.ts）——
 *   { "type": "list_plugins", "id", "cwd"? }                  → { id, type: "plugins", plugins, workspaceCwd }
 *       已装插件清单（含组件摘要/开关/诊断；scope="plugin" 条目不进 skills/mcp/subagents 设置页清单；
 *       components.panels = UI 面板贡献清单：{ id, title, icon?, opens, permissions }）
 *   { "type": "get_plugin_panel_asset", "id", "pluginId", "panelId" } → { id, type: "plugin_panel_asset", contentType, base64, rev }
 *       UI 插件面板入口 HTML（sandboxed iframe 的 blob 数据源）；未装/禁用/面板不存在回 error，
 *       rev = 文件 mtime+size 签名（前端 iframe 重载与文档 rev 协商判据）
 *   { "type": "get_plugin_panel_rev", "id", "pluginId", "panelId" } → { id, type: "plugin_panel_rev", pluginId, panelId, rev|null, linked }
 *       入口指纹的轻量查询（只 stat 不读文件）：宿主对 linked（链接装/dev）面板轮询此消息，
 *       rev 变了即重取资产热重载 iframe；rev=null 表示面板当前不可用
 *   { "type": "set_plugin_enabled", "id", "pluginId", "enabled", "cwd"? } → 插件级开关落 kv + 四链全量热重载 → 同款 plugins 应答
 *   { "type": "uninstall_plugin", "id", "pluginId", "cwd"? }  → 删物化目录 + 清 kv + 热重载 → 同款 plugins 应答
 *   { "type": "list_marketplaces", "id" }                     → { id, type: "marketplaces", marketplaces }
 *   { "type": "add_marketplace", "id", "mtype": "directory"|"git", ("path"|"repo") } → 受理（见下）
 *   { "type": "remove_marketplace", "id", "marketplaceId" }   → 删登记（不卸载已装插件）→ marketplaces 应答
 *   { "type": "refresh_marketplace", "id", "marketplaceId" }  → 受理
 *   { "type": "install_plugin", "id", "marketplaceId", "name", "cwd"?, "link"? } → 受理
 *       link=true 链接安装（cache 条目 symlink 指源目录，仅目录市场）；缺省保持现有模式
 *       受理应答 { id, type: "plugin_op_accepted", opId, op }；git clone 等耗时操作在后台执行，
 *       完成后自发 { "type": "plugin_op_result", opId, op, ok, ("plugins"/"marketplaces")?, "errorText"? } 帧
 *       （组件开关走 set_skill_enabled/set_mcp_server_enabled/set_subagent_enabled，scope/layer="plugin" 时必带 pluginId）
 *   { "type": "list_mcp_servers", "id", "cwd"? }             → { id, type: "mcp_servers", servers, workspaceCwd, diagnostics }
 *       MCP 服务器清单（系统 ~/.kova/mcp.json + 工作区 .mcp.json/.kova/mcp.json 合并，
 *       含每台连接状态）；设置 → MCP 页渲染用
 *   { "type": "save_mcp_server", "id", "layer", "cwd"?, ("definition"), "name"? } → 校验后写系统/工作区覆盖文件
 *       + 断连重载 → 同款 mcp_servers 应答（name=编辑前原名，改名时清旧条目）
 *   { "type": "delete_mcp_server", "id", "layer", "name", "cwd"? } → 删条目 + 断连 → 同款应答
 *   { "type": "set_mcp_server_enabled", "id", "layer", "name", "cwd"?, "enabled" } → 开关落 kv + 断连重载 → 同款应答
 *   { "type": "test_mcp_server", "id", "layer", "name", "cwd"? } → { id, type: "mcp_server_test", status }
 *   { "type": "get_mcp_server_tools", "id", "name", "cwd"? } → { id, type: "mcp_server_tools", name, tools }
 *     （工具清单：优先元数据缓存，缺失才握手——展开懒服务器可能等几秒）
 *       强制重新握手（先断后连），设置页"测试连接"用
 *   { "type": "authorize_mcp_server", "id", "name", "cwd"? } → { id, type: "mcp_servers", ... }
 *       HTTP 服务器 OAuth 2.1 授权：开浏览器 + 本地回调等用户批准（可达数分钟，
 *       前端需长超时），完成后同款 mcp_servers 应答刷新全部行状态
 *   { "type": "revoke_mcp_server_auth", "id", "name", "cwd"? } → { id, type: "mcp_servers", ... }
 *       取消 OAuth 授权：清掉该服务器 URL 的存量凭据并断开（下次握手回到 needsAuth）
 *   { "type": "get_mcp_audit_log", "id", "name"?, "limit"? } → { id, type: "mcp_audit_log", events }
 *       观测审计事件（连接/断开/调用/截断/授权/健康探测，跨重启持久，时间升序）
 *   { "type": "usage_stats", "id" }                           → { id, type: "usage_stats", stats }（全局使用统计：增量物化到 SQLite 后从库聚合）
 *   { "type": "trace_query", "id", "sessionId", "limit"? }    → { id, type: "trace_query", runs }（Agent 调用轨迹：traces/<sessionId>.jsonl 的末尾 limit 个 run，文件序即时间序；limit 默认 50 上限 200）
 *   { "type": "get_todo_state", "id", "threadId", "sessionId"? } → { id, type: "todo_state", tasks, nextId }（任务清单水合，只读）
 *   { "type": "get_provider_filter", "id", "provider" }       → { id, type: "provider_filter", provider, models: string[] | null }
 *       models = 勾选（可见）的模型 id；null = 无过滤记录（目录全可见）
 *   { "type": "set_provider_filter", "id", "provider", "models": string[] } → { id, type: "provider_filter", provider, models }
 *       写 models 表行（enabled 位切换，属性覆盖保留）；空数组 = 清除该 provider 的全部行；
 *       目录外的 modelId（内置厂商手动新增）按行挂进目录
 *   { "type": "update_model", "id", "provider", "modelId", name?, reasoning?, contextWindow?, maxTokens?, input?, cost? }
 *                                                             → { id, type: "model_updated", provider, modelId }
 *       消息里携带的字段写入 models 表（null = 重置为继承内置值；未携带 = 保留现值）并原地应用到目录；
 *       目录外的 modelId 同样会挂载为新增模型
 *   { "type": "set_credential", "id", "provider", "apiKey" }  → { id, type: "credential", provider }
 *   { "type": "list_credentials", "id" }                      → { id, type: "credentials", credentials: [...] }
 *   { "type": "delete_credential", "id", "provider" }         → { id, type: "credential_deleted", provider }
 *   { "type": "fetch_models", "id", "baseUrl", "apiKey", "api", "providerId"? } → { id, type: "fetched_models", models: [...] }
 *       api = openai-chat | openai-responses | anthropic-messages，决定列表端点与鉴权方式
 *       apiKey 留空 + providerId = 用已存凭据（编辑弹窗不回填明文 key）
 *   { "type": "add_custom_provider", "providerId"?, "name", "baseUrl", "apiKey", "api", "models": [{ "id", ... }] }
 *                                                             → { id, type: "custom_provider", provider }
 *       providerId = 编辑目标的业务 id（协议 reqId 占用了 "id" 字段，故改名）；缺省为新建
 *   { "type": "list_custom_providers", "id" }                 → { id, type: "custom_providers", providers: [...] }
 *       providers[].apiKeyMasked = 掩码（****+后4位）；明文 key 不回传渲染进程
 *   { "type": "toggle_custom_provider", "id", "provider", "enabled" } → { id, type: "custom_provider_toggled", provider, enabled }
 *   { "type": "set_mode", "id", "threadId", "sessionId"?, "mode" }       → { id, type: "mode_changed", mode, planning }
 *       mode = agent | plan；切换会热替换工具集与系统提示词
 *   { "type": "get_planning_state", "id", "threadId", "sessionId"? }     → { id, type: "planning_state", mode, planning }
 *       拉取当前模式快照（前端刷新/切线程后恢复模式选择器用）
 *   { "type": "tool_confirm", "id", "threadId", "sessionId"?, "approvalId", "approved" } → { id, type: "tool_confirmed", approvalId }
 *       结算逐工具审批（bash/write/edit 执行前）与 plan_exit 的模式退出确认
 *       （prompt 流内 data-toolApproval chunk 发起）
 *   { "type": "question_answer", "id", "threadId", "questionId", "answers": [{ questionId, selectedIds, otherText?, skipped? }] } → { id, type: "question_answered", questionId }
 *       结算 Question 工具的挂起提问（prompt 流内 data-question chunk 发起，前端 AskUserQuestions 卡片作答）
 *   { "type": "context_info", "id", "threadId", "sessionId"? } → { id, type: "context_info", ... }
 *       上下文面板读数：容量/阈值/消息/系统提示词/工具占用 + 平均缓存命中率（现算，零持久化）
 *   { "type": "compact", "id", "threadId", "sessionId"? }     → { id, type: "compacted", generation, tokensBefore, summarized }
 *       手动压缩上下文（仅空闲回合边界；prompt 运行中拒绝）
 *   { "type": "test_provider", "id", "baseUrl", "apiKey", "api", "model", "providerId"? } → { id, type: "tested", ok: true }
 *       apiKey 留空 + providerId = 用已存凭据（编辑弹窗不回填明文 key）
 *   { "type": "delete_custom_provider", "id", "provider" }    → { id, type: "custom_provider_deleted", provider }
 *   prompt 流内模式推送：{ id, chunk: { type: "data-planningState", data: { mode, approvalLevel, planning } } }
 *                 委派绑定：{ id, chunk: { type: "data-subagentDelegation", data: { toolCallId, delegationId, agentName, description? } } }
 *                 （Task 工具启动委派时发起：前端把消息里的 Task 行绑到 delegationId，点击开面板「子智能体」tab）
 *                 审批请求：{ id, chunk: { type: "data-toolApproval", data: { approvalId, toolCallId, toolName, input } } }
 *                 （toolName = plan_exit 时 input 带 { rationale, title, markdown, filePath }，前端渲染计划审批卡）
 *                 交互结算广播：{ id, chunk: { type: "data-interactionResolved", data: { interactionId, resolution } } }
 *                 （pending-interactions 台账结算点统一补发：发起卡片的 data-* chunk 行在 Rust
 *                   重放缓冲里，刷新重放会复活已结算的卡；本帧入同一条缓冲让重放序列 begin→
 *                   resolved 收敛为空，question/逐工具/MCP/plan_exit 四类挂起卡通治。
 *                   无活跃请求时不发，转录行始终是事实源）
 *                 面板唤起：{ id, chunk: { type: "data-panelOpen", data: { type: "browser", url? } } }
 *                 （browser_* 工具动作时发起，前端把浏览器 tab 推到前台并展开面板）
 *                 面板唤起（文件）：{ id, chunk: { type: "data-panelOpen", data: { type: "file", path, cwd } } }
 *                 （open_file 工具发起；path = workspace 相对路径或绝对路径，前端把「文件」tab
 *                   推到前台、按磁盘实时模式加载，与文件树点击同款）
 *                 工具图片投影：{ id, chunk: { type: "data-image", id: "img-<toolCallId>-<n>", data: PiImagePartData } }
 *                 （tool_execution_end 里 ≤2MiB 栅格 image 块随流投影，data 见 types.ts；
 *                   get_history 按同 id 重建同构 part，闸门与拼装单点在 image-parts.ts）
 *
 * prompt 流（stdout）：{ "id": "<reqId>", "chunk": { ...AI SDK UIMessageChunk } }
 *   状态同步 chunk（data-queue-state / data-planningState）行形加盖事件水印：
 *   { "id", "chunk", "sessionId", "eventSeq" }——eventSeq 是 per-session 单调
 *   号（protocol/event-seq.ts），只给确认写出的帧盖章；桌面端检缺口回拉权威
 *   接口（get_queue_state / get_planning_state），见设计文档 §3。
 *
 * 自发通知（stdout，无 id，宿主原样广播给所有前端）：
 *   { "type": "session_state", "sessionId", "phase": "running"|"idle"|"evicted",
 *     "eventSeq" }
 *       派生相位帧（设计文档 §2）：驻留表/activeTurns 的投影，随物化/轮起止/
 *       驱逐广播；缺口回拉 list_running。取代 turn_changed（旧帧保留一版本周期）
 *   { "type": "context_changed", "sessionId", "usedTokens", "threshold",
 *     "contextWindow", "cacheHitRatio", "eventSeq" }
 *       上下文读数变化推送（设计文档 §7）：轮次收尾点现算，桌面占用环镜像直更；
 *       盖事件水印，缺口回拉 context_info
 *   { "type": "turn_changed", "sessionId": "...", "active": true|false }
 *       某会话一轮 turn 开跑/收尾；发起方未带 sessionId 的轮次不广播
 *   { "type": "subagent_activity", "delegationId": "...", "item": SubagentActivityItem }
 *       子代理运行活动（思考/正文增量、工具起止、轮次、结算终态）；父 turn 已结束后
 *       后台委派继续广播；前端 store 按 delegationId 归并，面板 tab 流式渲染
 *   { "type": "automation_fired", "taskId", "taskName", "taskType", "runId", "firedAt" }
 *       定时任务触发开始运行（调度器 onTaskStarted 钩子，见 automation/runtime.ts）
 *   { "type": "automation_run_done", "taskId", "taskName", "runId", "ok",
 *     "sessionId"?, "error"?, "finishedAt" }
 *       该次运行结算（成功/失败）；sessionId 为本次新建的真实 agent 会话
 *       （onTaskFailed 的调度错误路径可能缺省）
 *
 * 物理布局（本文件只保留分发装配；领域逻辑各归其位）：
 *   prompt-pipeline.ts  prompt 入口/单 turn 生命周期/steer/abort（dispatchPrompt 等）
 *   payloads.ts         各域清单应答载荷构建器 + 变更后热重载编排
 *   mgmt-queue.ts       管理命令串行队列原语（enqueueMgmt）
 *   exit.ts             进程退出状态机（stdinClosed/pendingOps/maybeExit）
 *   handlers/           13 个命令域的 handler 注册表（102 个命令按域分组）
 */
import { logErr } from "../log";
import { resolveHostResult } from "../storage/hostdb";
import { beginOp, endOp } from "./exit";
import { enqueueMgmt } from "./mgmt-queue";
import { nextFallbackSeq } from "./command";
import { classifyAgentError, toWireError } from "../agent/agent-errors";
import { send, sendErrorChunk } from "./stream";
import { dispatchPrompt } from "./prompt-pipeline";
import { markStdinClosed } from "./exit";

// 既有公共 API 保持原位（automation/runner 与测试经此导入）
export {
  dispatchPrompt,
  mgmtResolveSession,
  type PromptTurnOutcome,
} from "./prompt-pipeline";
export { markStdinClosed } from "./exit";

import { handlers as lifecycleHandlers } from "./handlers/lifecycle";
import { handlers as queueHandlers } from "./handlers/queue";
import { handlers as sessionHandlers } from "./handlers/sessions";
import { handlers as modelHandlers } from "./handlers/models";
import { handlers as preferenceHandlers } from "./handlers/preferences";
import { handlers as subagentHandlers } from "./handlers/subagents";
import { handlers as automationHandlers } from "./handlers/automations";
import { handlers as pluginHandlers } from "./handlers/plugins";
import { handlers as skillHandlers } from "./handlers/skills";
import { handlers as designMdHandlers } from "./handlers/design-md";
import { handlers as mcpHandlers } from "./handlers/mcp";
import { handlers as providerHandlers } from "./handlers/providers";
import { handlers as interactiveHandlers } from "./handlers/interactive";
import type { CommandHandler } from "./command";

/** 启动初始化闸门：模型目录就绪（自定义提供商注册/覆盖合并）之前到达的命令先缓冲，
 *  避免启动恢复的 set_model 抢在目录就绪前被 "model not found" 拒绝而回落默认模型。
 *  host_result 不经闸门（host_query 的挂起结算必须即时）。gate 由 index.ts 注入且
 *  内部已 catch（不会 reject）。 */
let initGate: Promise<void> = Promise.resolve();

export function setInitGate(gate: Promise<void>): void {
  initGate = gate;
}

/** 命令注册表：全部非 prompt 命令按域登记（97 个命令，见 handlers/ 各域模块） */
const registry: Record<string, CommandHandler> = {
  ...lifecycleHandlers,
  ...queueHandlers,
  ...sessionHandlers,
  ...modelHandlers,
  ...preferenceHandlers,
  ...subagentHandlers,
  ...automationHandlers,
  ...pluginHandlers,
  ...skillHandlers,
  ...designMdHandlers,
  ...mcpHandlers,
  ...providerHandlers,
  ...interactiveHandlers,
};

export async function dispatch(reqId: string, msg: Record<string, unknown>) {
  const handler = registry[String(msg.type ?? "")];
  if (!handler) {
    logErr("unknown message type:", String(msg.type));
    send({
      id: reqId,
      type: "error",
      errorText: `unknown message type: ${String(msg.type)}`,
      error: { code: "UNKNOWN_MESSAGE_TYPE", source: "runtime", retryable: false },
    });
    return;
  }
  await handler(reqId, msg);
}

export function handleLine(raw: string) {
  let msg: Record<string, unknown>;
  try {
    msg = JSON.parse(raw);
  } catch {
    logErr("unparseable line:", String(raw).slice(0, 200));
    return;
  }

  // 宿主对 host_query 的响应：交给 hostdb 的挂起表结算，不走命令分发
  if (resolveHostResult(msg)) return;

  const reqId = typeof msg.id === "string" ? msg.id : `req-${nextFallbackSeq()}`;
  const run = async () => {
    try {
      // 启动恢复命令等目录就绪再分发（set_model 否则会因目录未就绪被拒）
      await initGate;
      await dispatch(reqId, msg);
    } catch (err) {
      logErr("handleLine failed:", err);
      const errorText = err instanceof Error ? err.message : String(err);
      // 管理命令出路的错与供应商话术无关：含糊串按运行时归因（§8）
      send({
        id: reqId,
        type: "error",
        errorText,
        error: toWireError(classifyAgentError(err, { opaqueFallback: "runtime" })),
      });
    } finally {
      endOp();
    }
  };
  beginOp();
  if (msg.type === "prompt") {
    // prompt 主体是长任务，不占队列；但会话准备（建会话/读凭据）作为队列任务执行，
    // 与 set_credential / new_session 等保持严格先后
    void (async () => {
      try {
        await dispatchPrompt(reqId, msg);
      } catch (err) {
        // dispatchPrompt 的意外 reject（provider 流内错误在 stream.ts 出口已归因，
        // 走到这里的多是本地准备路径的抛错）
        const errorText = err instanceof Error ? err.message : String(err);
        sendErrorChunk(reqId, errorText, toWireError(classifyAgentError(err, { opaqueFallback: "runtime" })));
      } finally {
        endOp();
      }
    })();
  } else {
    enqueueMgmt(run);
  }
}
