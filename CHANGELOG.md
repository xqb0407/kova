# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 格式，
版本号遵循 [SemVer](https://semver.org/lang/zh-CN/)。`v1.2.0` 起进入正式版轨道，
按本文件逐版维护；更早的 `v1.1.x-preview` 迭代以 git tag 与 GitHub Releases 为准。

发版口径见 [docs/versioning.md](docs/versioning.md)。

## [1.2.6] - 2026-11-26

### Added

- UHP（Unified Harness Protocol）双向接入：Electron 主进程内置 UHP Server，
  把 pi-agent 暴露为 `2026-10-19` Core + Extended harness（discovery、SSE 任务、
  会话续接/取消、文件与产物、会话列表）；设置 → 智能体 → UHP 可启停、轮换
  API Key、配置工作区与审批档
- Task 子代理新增 `backend: uhp`：可把任务委派给外部 HarnessRouter/兼容
  UHP 服务，SSE 事件映射到子代理活动面板，支持 Stop 取消与 previous_response_id
  续接
- UHP 契约包 `packages/uhp-protocol`、官方 conformance 包装脚本与
  [docs/uhp.md](docs/uhp.md) / [docs/uhp-conformance.md](docs/uhp-conformance.md) /
  [docs/uhp-roadmap.md](docs/uhp-roadmap.md)
- 收件箱接入外部来源 GitHub / GitLab / Jira / Linear：主进程连接器负责 Token
  加密存储、独立代理、429 退避与 401/403 待重新连接；sidecar 增量同步按稳定
  ID upsert，分页未拉全不误删，墓碑跨重启不复活，内容不变不清已读
- 收件箱双栏视图与来源设置：待关注 / 历史 / 已归档分段、按来源筛选、外部详情
  按需拉取；事项可作为芯片交给 Agent（隐藏上下文快照 + 会话回链），支持 Ask
  留言与直接发送；设置 → 收件箱来源按品牌分组连接/检查/暂停/断开
- 设置页全局搜索与导航合并：⌘K / Ctrl+K 检索中英文设置页与设置行并直接定位；
  「模型 + 网页搜索」「访问加速 + 网络代理 + SSH 主机」「收件箱来源 + Webhooks」
  收成三个入口，页内标签切换
- Codex 插件兼容：支持 `.codex-plugin` / 根 Agent Plugins `plugin.json` /
  `.cursor-plugin` 清单；skills、hooks、commands 支持多路径数组，MCP 支持内联
  `mcpServers` 与裸 server map；补齐 `cwd`、`env_vars`、`http_headers`、
  `env_http_headers`、`bearer_token_env_var`、超时与工具过滤字段
- Codex 插件 MCP 默认以插件根为 cwd，支持 `${PLUGIN_ROOT}` / `${PLUGIN_DATA}`；
  `node` / `npx` 不在 PATH 时回退内置运行时；安装/启用后后台预热工具目录，
  `mcp` 网关接受 `server.tool` 与 `server__tool` 两种写法
- Codex personal marketplace 的 source 按真实市场根解析（`$HOME/.agents/plugins`
  下的 `./plugins/x` 指向 `$HOME/plugins/x`）；市场条目名与源目录名可不同
- 市场 source 支持 Codex 的 `git` / `git-subdir` / `url`：按 `ref`/`sha` 浅克隆
  并材料化仓库子目录，安装与预览共用缓存、更新时重新拉取；`npm` source 与
  `policy.installation=NOT_AVAILABLE` 给出明确诊断/隐藏；只接受
  https/ssh/file transport，git source 缓存按 30 天清理，预览/安装后回填
  远程清单的图标与展示名
- 插件技能按 Codex 语义暴露为 `plugin:skill`：跨插件同名技能共存，
  `use_skill` 支持全名精确匹配、裸名唯一兜底与歧义报错；系统提示词与设置页
  显示带插件前缀的技能名。技能目录预算提升到 16KB、插件描述上限 400 字符，
  减少长描述插件技能被预算挤掉
- Codex personal marketplace 自动发现：存在 `$HOME/.agents/plugins/marketplace.json`
  时市场页直接出现只读「personal」市场，无需手动登记
- 插件详情新增「安装依赖」入口：有 `package.json` 但缺 `node_modules` 时可显式
  执行 npm ci/install（`--omit=dev --ignore-scripts`），npm 缺失时回退内置运行时
- Codex hooks 补齐 `commandWindows` / `onFailure` / `async` / `statusMessage` /
  插件根 cwd / `PLUGIN_DATA` 注入与 payload `turn_id`，并新增 `SessionEnd` /
  `PostCompact` / `Interrupt` / `SubagentStart` 触发点；插件数据目录加入沙箱
  可写根（插件安装根保持只读）
- 插件技能读取 Codex `agents/openai.yaml`：`policy.allow_implicit_invocation:false`
  映射为不进入模型目录，`dependencies.tools` 在诊断中提示
- MCP Apps：保留 `tool._meta.ui`（含废弃的平铺 `ui/resourceUri`），
  `visibility:["app"]` 的工具不再进模型目录/搜索；带 UI 的 MCP 工具结果可在
  桌面端沙箱 iframe 中打开 `ui://` 界面，并桥接 initialize、tool-input/result、
  tools/call、resources/read、open-link、message、size-changed
- Codex hooks 补齐 `PreModelRequest` / `PostModelRequest` 与通用 payload
  （`model`、`permission_mode`、`transcript_path`、`attempt_number`、
  `request_id`、`turn_id`、`status`、`token_usage`）
- 代码视图支持行悬浮「+」添加评论：右侧文件源码视图与 Git diff 均可单行/拖选
  多行，编辑框内联在代码行下方；提交后代码行下保留评论卡片（可删除并同步移除
  输入框芯片），点击芯片可查看源码 + 完整评论，发送时展开为文件行号引用 + 评论正文
- 资料库笔记升级为原生 `.knote` 格式（JSON envelope）：正文以 Plate 块直接
  落盘，Markdown 降级为导入/导出与 AI 检索缓存；新建笔记与「存为笔记」默认
  写 `.knote`，损坏/未知版本文件只读保护、绝不覆盖
- Notion 式块编辑器：表格支持合并/拆分单元格、列宽拖拽、行高、单元格背景与
  表头行切换；新增 callout（高亮块）、折叠块（toggle）与两栏分栏；页面图标、
  封面与标签直接编辑；正文列放宽到 64rem
- 一次性迁移：原 `.md` 先完整备份到 `.kova/markdown-backup/` 再逐篇转换，
  可中断续跑；不兼容富文本的笔记保持 Markdown；旧路径写入
  `library_note_aliases` 别名表，历史聊天引用与 AI 读取自动解析到新文件，
  标题/标签元数据与 knowledge_refs 同步搬迁
- 高级块 Markdown 导出降级：callout→引用、折叠块→标题+正文、分栏按列展开，
  合并单元格按内容合并；`.knote` 支持一键导出 Markdown 副本到
  `.kova/exports/`

### Changed

- 收件箱工具栏重排：来源选择改为可横向滚动的 tabs，溢出时显示左右箭头；搜索框常驻独立一行；
  视图分类并入筛选弹层，来源管理入口收进筛选菜单
- 代码行评论编辑器优化：增加「评论第 N 行 / N-M 行」标题，选中代码行与编辑器共用连片背景，
  提交快捷键移入确认按钮
- 插件 MCP 服务器与系统/工作区配置同名时，用户配置优先，插件不再覆盖；冲突
  会写进插件诊断。已装插件扫描跳过物化 staging/backup 临时目录

### Fixed

- Codex 插件从 GitHub zip（`<name>-main`）或官方符号链接目录安装时，不再因
  目录名不一致或 `cpSync` 符号链接报 `ENOTDIR` 失败
- Codex 插件 `.mcp.json` 的相对 `cwd`/`args`、`http_headers`、`env_vars`、
  `enabled:false` 与超时配置不再被静默丢弃；插件详情会显示 MCP 解析诊断
- 同时包含 `.codex-plugin` 与 `.claude-plugin` 的插件按 Codex 优先探测，避免
  读错清单；缺失 `name` 的生态清单回退目录名
- Codex MCP 字段（插件根默认 cwd、`env_vars`、`http_headers` 等）只对
  Codex / Agent Plugins 清单生效，Claude/Kova 插件保持原有 MCP 行为
- 插件依赖状态不再把只有 `package.json`、没有运行期依赖的插件误判为缺依赖；
  安装失败的输出（含超时）统一脱敏
- Codex 插件运行时诊断：`.mcp.json` 启动脚本/文件缺失时在安装前提示「插件包
  不完整」；MCP 握手失败附带服务器 stderr，不再只剩 `Connection closed`
- 插件更新/重装后主动断开旧 MCP 连接并清工具缓存，避免 `.mcp.json` 未变时
  继续运行旧进程/daemon；物化改为 staging + 原子 rename，更新失败保留旧版本
- Windows 平台优先读取插件自带的 `.mcp.windows.json`；hooks 在 PATH 无 node
  时回退内置运行时（process 与 shell 两种形态）；Agent Plugins 的
  `extensions["com.openai"].interface` 归一为展示元数据
- 外部来源通知点击后按 sidecar 的 `external:<provider>:<id>` 口径定位条目，
  修复点击通知后收件箱无法选中对应事项
- Stop 落在轮前压缩期间不再被 provider 的摘要请求拖住：压缩摘要与中止信号
  竞速，停止后不再启动新的 agent 轮；已发出的用户消息会立即落盘，刷新后不再
  丢失，前端乐观气泡等快照/回显接管后再清理
- 附件处理阶段触发 Stop 时跳过 SessionStart Hook，并补齐消息落盘
- 会话页加载/设置页请求不再因单个长任务被拖到 20s 超时：手动压缩与外部收件箱
  同步移出管理串行队列；压缩增加 300s 硬超时，同会话新消息等待压缩收尾，
  手动压缩的前端等待同步放宽；队列阻塞日志现在会直接打出当前占用的命令
- 压缩摘要按实际输入动态 clamp 输出上限，避免 `input + maxTokens` 顶穿模型
  窗口触发 `ContextWindowExceededError`；裁剪重试不再沿用裁剪前的旧 usage
  估算输入
- 只读命令（会话快照/历史/轨迹查询/项目目录等）移出管理串行队列，慢读不再
  把凭据写入、会话物化等写命令一起堵到超时
- 并入当前回复后的队列条不再按固定时间消失：ghost 保留到注入消息上屏或回队；
  子代理收敛期间 `runStatus` 保持 running，不再出现「队列条没了、消息也没出现」
- 系统通知只有用户点击卡片时才切换到对应会话；窗口重新聚焦不再自动跳到
  另一个正在等待审批或回答的会话
- 内置浏览器切换会话时不再复用同一个 `<webview>` 并把页面交给新会话的 agent；
  切会话重建 guest，主进程拒绝 guest 跨会话转属主
- 工具结果图片卡片在窄聊天列中不再超出容器：按消息列宽度收缩并裁切圆角
- 收件箱点击任务行、阅读窗「打开会话」或从系统通知打开条目时，把该任务下全部
  未读标为已读；组内较早的未读事件没有单独入口，蓝点不再只能靠归档或「全部已读」
  清除（已归档 Tab 的未读条目查看后也会清点；仍需处理的事项继续留在待关注）
- 收件箱交互修复：审批/提问动作透传 payload（「允许并记住」与回答不再丢失）；
  列表加载失败显示错误条；客户端筛选不再因首屏被滤空而卡死分页；系统通知在
  历史/归档 Tab 下会重置筛选并定位条目；搜索防抖不再回退到旧来源；行级归档/恢复
  按整组生效；批量删除确认补组名与条数；后台任务被信号杀死按失败处理
- 收件箱界面：恢复可见的待关注/历史/已归档切换与「全部已读」，窄窗口与 200%
  zoom 改为上下堆叠；修正时间戳、错误文本与焦点环的对比度；行支持 ↑/↓/j/k
  浏览；筛选菜单改用 radio 语义并暴露激活筛选数量

## [1.2.5] - 2026-11-24

### Added

- 网络代理设置页：支持跟随系统 / 直连 / 自定义代理，自定义绕过列表与连通性
  测试；保存后可立即重启生效
- 生命周期钩子新增 `Notification` / `SubagentStop` / `PreCompact` 事件与
  matcher；PreToolUse 审批门禁下沉到子代理，approve 不再绕过结构校验
- 图片输入能力改为三态（支持 / 明确不支持 / 未声明）：未声明能力的自定义
  端点不再被当成纯文本预剥图，先按原样发送，由端点拒图与 400/422 修复兜底
- 模型选择器新增输入能力修正入口，区分「纯文本输入」与「输入能力未声明」

### Changed

- 设置页说明文案整体精简约 46%；项目 / 记忆 / 备份通道统一为分段控件，
  收件箱 tabs 改为统一下划线样式
- sidecar 与 automation 启动时跟随系统代理；修复 Bun 不读系统代理导致海外
  provider 长流被重置的问题，NO_PROXY 默认覆盖回环与 RFC1918 网段
- 钩子统一以会话 cwd 执行，超时改为杀进程组；匹配钩子并行执行，兼容 Claude
  `hookSpecificOutput` / `continue` / `systemMessage`，`set_hooks` 失败回错，
  多窗口同步 `hooks_changed`，远程模式禁用 hooks
- 图片降级占位改为带附件标识的中性文案，按单条消息内序号稳定生成；
  OpenAI-compatible / Responses / Google / Mistral adapter 统一按三态能力
  决定是否携带图片
- 400/422 拒图重试与本地降级复用同一句说明，sticky 记忆逻辑不变

### Fixed

- 再次进入设置页默认落在上次跳转目标（如更新日志）而不是「通用」；
  跳转改为一次性消费，不再残留
- 网络代理：IPv6 主机测试失败、NO_PROXY 未合并绕过列表、备份恢复后仍指向
  旧代理、非手动模式可能落库非法或带凭据的代理地址
- 钩子后台超时未生效、只杀直接子进程；PreToolUse 结构门禁可被 approve 绕过；
  systemMessage toast 重复刷屏
- 自定义端点未声明输入能力时被误判为纯文本并静默剥图；图片入口硬闸导致
  拖拽附件入口一并被禁用

## [1.2.4] - 2026-11-23

### Added

- AI 个性化管理工具 `personalization_get` / `personalization_update`：对话中可直接
  读取并修改全局称呼、回复风格、自定义风格、人设（soul.md）与自定义指令
  （rules.md）；`update` 逐次审批，写入后立即重排所有活动会话的系统提示词
- 内置服务支持手填目录外模型 ID：模型勾选区可回车添加，支持多行、逗号、分号
  与 JSON 数组批量粘贴，带非法字符/重复校验；保存后沿用该服务的鉴权与流式
  实现，多 API 服务（如 OpenCode）优先选择 OpenAI 兼容端点

### Changed

- 个性化设置页改为字段级保存：只提交本次真正改过的字段，未改动的 soul.md /
  rules.md 由 sidecar 保留磁盘实时内容，不再被页面旧快照整包覆盖
- 设置页挂载与窗口重新聚焦时重新拉取个性化设置，AI 或外部编辑器写入的
  人设/规则即时可见
- 标题自动总结为 OpenCode 等网关补会话亲和头，修复 `MissingSessionID`；
  OpenCode 响应头的 `x-opencode-log-id` / `cf-ray` 写入日志，便于断流排查
- 浏览器拖拽工具的说明明确要求两端都在当前视口内（按 ref 拖拽不再自动滚动）

### Fixed

- 设置页与引导页的整包保存会用旧快照覆盖 AI 刚写入的规则文件；持久化失败
  不再静默成功，未提交的字段也不会被当作清空
- 清空内置服务的模型过滤后，目录外手填模型会重新出现在全可见清单；最近
  使用模型可能指向已摘除的条目
- 浏览器弹窗：`evaluate` / 点击 / 输入遇到 alert、confirm 时不再白等 10 秒，
  弹窗处理命令可插队立即执行；命令超时判断改用错误类型，正常返回后清理定时器
- 浏览器截图：越界 clip 开启 `captureBeyondViewport`（此前会得到白图）；
  `maxDim` 与 1600 万像素预算按物理像素计算（已扣除页面 zoom），Retina 下
  不再输出双倍边长；兜底 `capturePage` 同样遵守 `maxDim`
- 浏览器输入：右键/中键的 `buttons` 位掩码修正（此前会带上左键）；按 ref
  拖拽时两端共享同一滚动状态，解析终点不再滚走起点；Shift+字符可正常输入，
  Cmd/Ctrl/Alt 快捷键不再额外插入字符
- 分享长截图在 Retina 上按设备像素比折算，不再输出 4 倍像素、打穿纹理上限
  或误报内容过长

## [1.2.3] - 2026-11-22

### Added

- 应用内更新日志与升级弹窗：关于页新增更新时间线入口，升级后展示本次版本变化，
  首次安装与远程/网页端不打扰
- 后台任务支持手动停止与空闲自动回收：快速查看浮层运行中的任务带「停止」按钮
- PTY spawn 失败时写入自诊断快照，便于定位长跑实例的偶发启动失败
- 自定义模型「获取模型」增强：分页跟随（最多 20 页）、候选端点并集，兼容
  `data` / `models` / `items` / `result` / `list` 等响应信封与更多 ID 别名
- 模型输入框支持多行、逗号、分号、制表符、全角分隔符与 JSON 数组批量粘贴

### Changed

- 更新日志升级弹窗改为无内层卡片的扁平列表，版本号与日期并入副标题
- ⌘Q 退出长按确认缩短到 1.5 秒，减少正常退出等待
- 模型配置接口地址统一校验与归一：粘贴 `/v1/models`、`/chat/completions` 等
  完整端点会自动收敛，保存、获取、测试连接使用同一门禁
- 「获取模型」增加诊断日志（原始/解析条数、页数、截断状态；URL query 已脱敏）；
  分页撞到 20 页上限时弹窗提示清单可能不完整
- 自动发现不注册图片/向量模型的行为在表单文案中明示，跳过清单写入日志

### Fixed

- 大技能包吃满目录签名预算，导致后续安装的技能不触发热加载
- 模型输入框会接受带空格/括号的非法 ID、重复 ID 无提示；保存时未回车的草稿
  可能被静默丢弃
- 非法 URL 下「获取模型/保存」仍可执行、完整端点会拼出 `/models/models`、
  候选端点先到先得会截胡更完整的列表
- 项目删除或胶囊 × 后，新对话不再自动恢复已删除的工作区
- 会话右键菜单缺 key 的开发期告警
- 打包后 spawn-helper 缺少执行权限
- 后台任务被管理队列占用时，停止操作可能无响应或占用队列
- 收件箱「全部已读」遇到待关注的失败报告残留时会挂死；现在会标记已读并归档
  失败报告，未结算的审批/提问/目标只标已读
- 主进程构建因 `logging` 缺少 `logErr` 导出而失败（改用现有 `logError`）
- 退出时写流迟到帧触发 `write after end` 未捕获异常；任务会话查询
  `project_dirs` 会刷错误日志

### Removed

- `apps/mobile` 迁出为独立仓库（桌面端远程网关与配对能力不受影响）

## [1.2.2] - 2026-11-21

### Added

- 自定义搜索服务支持 **JSON 整段配置**与 **cURL 一键导入**(带 schema 与解析器单测)
- 自定义 API 的 `resultsPath` 支持**字符串化 JSON 数组**双层解包——
  兼容 deepcode 等聚合网关的 `{"result":"[{…}]"}` 形态(实测可用)

### Changed

- Key 行按需显示并动态提示注入位置：模板引用 `{{apiKey}}` 时才出现凭据输入，
  并提示 Key 会注入到 URL / 请求头 / 请求体
- 请求体模板与 Headers 输入固定宽度；校验失败时检测全角标点并给出专门提示

### Fixed

- run_code 工具描述的并行工具清单按实际可用动态生成——WebSearch 关闭后
  不再在提示词里宣称它存在

## [1.2.1] - 2026-11-21

### Added

- 中国风主题五款（青花瓷 / 水墨 / 大漆描金 / 青瓷开片 / 莫文竹）与内置壁纸
- 主题导入升级：JSON 编辑器、`$schema` 校验、一键回填当前主题
- macOS **Intel（x64）安装包**——此前仅 Apple Silicon；最低系统显式声明为
  macOS 13 Ventura（由 Electron 44 决定），arm64 + x64 双架构分发

### Fixed

- 把手 / 灵感面板 / 收件箱动作跟随主题令牌

## [1.2.0] - 2026-11-21

首个开源正式版。

### Added

- 开源上线：Apache-2.0 许可、NOTICE 与第三方依赖清单（自动生成，1830 包）
- README / README_EN 中英双语界面预览（10 张真实界面截图）与社区入口（飞书交流群）
- CI 门禁：PR / push 自动跑 typecheck + sidecar 全量测试（2772 例）

### Changed

- 网页搜索默认服务改为需自行配置 key 的官方 API，移除内置第三方代理端点
- GitHub 访问加速默认直连官方源，加速改为用户显式选择（`PI_GITHUB_MIRROR` 可设分发默认）
- 仓库更名：`kova-electron` → `kova`（开发主仓与发布仓合一）

### Fixed

- git 历史抹除公司邮箱提交者身份
- NOTICE 补充 design-md 主题目录的 MIT 上游声明
- README 致谢移除已迁出仓库的 Univer / Leafer
