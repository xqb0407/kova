# 权限与审批分档

> 这篇只讲「权限档位」这一维。**五个「模式」的全貌**（会话模式 / 权限档位 /
> 工作模式 / 自动化权限档 / 常被误当成模式的东西）见 [modes-overview.md](./modes-overview.md)。

两套正交的档位，别混：**模式**（`SessionMode`）决定「能不能改」，**审批级别**
（`ApprovalLevel`）决定「改之前问不问」。`plan`/`ask` 是模式级门控，不受审批级别
影响——「完全访问」也不能让 plan 档写文件。

## 两个维度在 UI 上是分开的

底栏那个选择器（`mode-picker.tsx`）**只列权限档位**（四项）。能力模式选中时，
在那个选择器右侧出现一行字 —— 一道竖线隔开，形如：

```
[🛡 完全访问 ⌄] │ [💡 计划模式]
```

（`CapabilityModeChip`，只在能力档渲染，agent 档整块消失。）

理由：这两件事正交，混在一个七项下拉里，用户看到一串平铺的档位，分不清哪些是
「问不问」、哪些是「能不能干」。拆开之后下拉回答前者、右边那行字回答后者。

进入能力模式的两个入口：`/` 指令菜单的 `/ask` `/plan` `/goal`，以及 composer 的
「+」菜单（那里列**全量七项**——不跟着收窄，否则就没有一次看全的地方了）。
点右侧那行字 = 退出该模式回 agent（保留当前权限档）；这与在下拉里改选任一权限项
是同一条路（两个维度独立，选权限即离模式），只是把它挪到手边。

Shift+Tab 只在这四个权限档之间循环，不再跨越能力模式。

## 模式（能不能改）

| 档 | 写能力 |
|---|---|
| `agent` | 完整工具集 |
| `plan` | 结构性只读，靠 `plan_exit` 拿批准后回 agent 实施 |
| `ask` | 纯只读子集（无 bash） |
| `goal` | 完整工具集 + 跨轮自治（见 goal-mode-design.md） |

## 审批级别（问不问）

按「问多少」从紧到松：

| 档 | write / edit | bash | 配置类工具 |
|---|---|---|---|
| `ask`（变更前确认） | 每次确认 | 每次确认 | 每次确认 |
| `workspace-write`（工作区内自动） | **工作区内 + 清单内的目录免确认** | 确认（可「允许并记住这类命令」→ 前缀规则） | 确认 |
| `auto-edit`（自动编辑） | 全部免确认（含工作区外） | 确认 | 确认 |
| `auto`（完全访问） | 全免 | 全免 | 全免 |

配置类工具 = 子代理/技能/设计主题/插件的增删（`APPROVAL_REQUIRED_TOOLS` 里除
bash/write/edit 的那些）。它们写的是应用配置目录，本来就在工作区之外，所以在
`workspace-write` 里一律确认。

## 可写根清单（`workspace-write` 的额外放行目录）

工作区内免确认、工作区外要确认——但真实工作常跨项目（前后端两个目录、monorepo 外的
共享库），每次都弹确认就变成噪声。清单解决这个：列进去的目录按「工作区内」对待。

三层文件（并集，不是覆盖）：

```
~/.kova/permissions.json             用户级：所有项目
<cwd>/.kova/permissions.json         项目共享：进 git，团队同一份
<cwd>/.kova/permissions.local.json   项目本地：本机（建议加进 .git/info/exclude）
```

```json
{ "writeRoots": ["../shared-lib", "~/work/cache"] }
```

相对路径相对 `cwd` 解析，`~/` 相对家目录；判定与工作区边界同一套（软链接按真实落点算）。

### 项目文件只能提议，不能授权

`.kova/permissions.json` 跟着仓库走。**clone 一个别人的项目，那个仓库不该有权给
agent 授权写你的家目录** —— 所以项目层声明的根**永不生效**，只出现在审批卡上那句
「这个项目请求放行 X」里。它唯一的作用是**提议**。

用户点了「允许并记住」之后，那条根才被写进 **你自己的** `.kova/permissions.local.json`
（并在 git 仓库里自动加进 `.git/info/exclude`）。也就是说：**唯一能授权的文件都在你
自己机器上**（local 是本机、user 是你的全局配置），结构上不存在可以被仓库伪造的
「信任状态」。

这是抄 Claude Code 的一条安全属性（它那边是「项目文件的 `defaultMode` 不生效 +
`allow` 规则等 workspace trust」），但实现更简单——没有信任状态，就不用维护信任状态。

### 审批卡的三个按钮

`workspace-write` 档下带「可记住的东西」的审批（侧边栏给 `canRemember`）有三个按钮：

| 按钮 | 语义 |
|---|---|
| 拒绝 | 拦下这次调用，模型收到 blocked 结果 |
| 仅这一次 | 放行这一次；**盘上不留任何东西**，下次仍然问 |
| 允许并记住 | 放行，并把它记进 `.kova/permissions.local.json`，之后同类不再问 |

「它」是什么，按工具分两种：

- **`write`/`edit` → 一条可写根**：目标落在项目声明的根里就记那一条，否则记目标文件
  所在目录。
- **`bash` → 命令词前缀**，形态与 Claude Code 的 `Bash(pnpm add *)` 对齐：

```json
{ "allowCommands": ["pnpm add *", "git log *", "cat *", "lsof -ti:1420"] }
```

记的粒度是**前两个词**，第二个词长得像值（含 `/`、`.`、`=` 或以 `-` 开头）时只取第一个：

| 你批准的命令 | 记下的规则 |
|---|---|
| `pnpm add -D react` | `pnpm add *` |
| `git log --oneline` | `git log *` |
| `cat package.json` | `cat *` |
| `lsof -ti:1420`（第二个词就是值） | 逐字相等，不带 `*` |

`cd` 段不记（它进不了规则集，但匹配时天然放行——否则 `cd X && cat Y` 这种最常见的
写法永远命中不了）。一条 `&&`/`|` 链的每一段各记一条规则。

### 前缀规则为什么**必须**配两道守卫

前缀本身只是个便利，不是边界。少了下面两条，`cat *` 就等于放行 `cat x > /etc/hosts`：

1. **逐段校验**：命令按 `&&` `||` `;` `|` 换行拆成简单命令，**每段都要命中某条规则**。
   不拆段的话 `git log && rm -rf ~` 会被「第一段命中」整条放行。
2. **反藏写守卫**：含反引号、`$(...)` 一律不命中；**写方向**的重定向（`>` `>>` `&>`）只有
   目标是 `/dev/null`（垃圾桶）或 `&1`/`&2`（fd 复制）才放行。
   读方向的 `<` 不管——这一层管写不管读，读从来没经过审批。

**残留风险要说清**：前缀命中的是一条**词前缀**，同一前缀下自带写能力的旗标拦不住
（`curl -o <文件>`、`git checkout`）。这类规则是用户自己点头记下的，且文件是普通 JSON，
想收窄直接改（和 Claude Code 一样）。要真正把命令关进笼子，只能靠 OS 级沙箱。

其余审批（配置类工具、MCP）不带可记住的东西，卡上只有两个按钮。

记哪条根：目标落在项目声明的根里就记**那一条**（正是该项目请求的、也够宽），否则记
**目标文件所在目录**（与用户看到的写入路径一致）。写相对还是绝对，取**字面更短的那
个** —— 兄弟目录写成 `../shared-lib`（跟着仓库走的人看得懂），家目录缓存写绝对路径。

其余审批（bash、配置类工具、MCP）不带可写根上下文，卡上就只有两个按钮：它们没有
「一条可记住的路径」可言，给第三个按钮是骗人。

拒绝、以及只点「仅这一次」，都不会在盘上留下任何东西。

### 草稿期的档位必须补发（一条真实漏洞）

新对话在发出第一条消息前还没有 sessionId。此时在底栏选档位走的是「只写前端内存快照」
的分支——**一个请求都不发**。等首条消息建出会话，run 按全局默认档（kv `pi.mode` 的
「最近一次使用」）装配，而 UI 一直显示用户选的那一档。

**这不是显示问题，是权限档没生效**：用户以为选了「工作区内自动、改动前会问」，实际
那一轮跑的是全局那一档（可能更宽松）。

修法照抄同族三例（模型/思考档/工作模式都有 `flushDraftXxxSelection`）：草稿期选的档
记在 `draftPicks` 里，会话绑定那一刻由 `flushDraftModeSelection` 定靶补发，并且在
`usePiRuntime.initialize` 里 **await** —— 它决定首轮怎么执行，晚一拍就等于首轮按错档跑。

> 排查时最有用的三处证据（都在盘上）：会话行 `mode` / `approval_level` 两列是否 NULL、
> 转录里有没有 `pending_interaction`（kind=permission）行、以及 sidecar 日志里的
> `set_mode:` 行。三者同指「这个选择从没告诉过服务端」时，就是这条。

### 与沙箱的关系

清单目前只作用于 `write`/`edit` 的审批判定（带路径、可判）。**bash 不受它影响** ——
一条命令写到哪无法从参数判断，所以 bash 在 `workspace-write` 档下照常每次确认。
要让命令也守边界需要 OS 级沙箱，见下。

## workspace-write 的边界怎么判

判据在 `apps/sidecar/pi-agent/src/agent/workspace-boundary.ts`，三条规矩：

1. **只有 `write` / `edit` 有路径可判**，其余一律不放行（落到挂起审批）。
2. **软链接按真实落点算**：`realResolve` 从目标往上找到第一个真实存在的祖先做
   `realpath`，再把剩下的段拼回去——新建文件（目标还不存在）也能判，而工作区内
   一个指向外部的软链接不会因为字符串前缀好看就被放行。
3. **拼路径必须用 `resolve` 不用 `join`**：`join` 对绝对路径不丢弃前缀，会把
   `/other/secret.ts` 拼成 `<cwd>/other/secret.ts`，再被「向上找存在的祖先」圆回
   工作区内部——绝对路径指向外部反而被放行。这条是写测试时抓到的真绕过。

判不了就是不放行：安全判据的方向永远是「不确定就拦」。

## ⚠️ 这一档管不住 bash

一条 `bash -c` 能写到任何地方（重定向、绝对路径、脚本、`cd ..`），**参数里看不出
目标路径**。所以 `workspace-write` 档下 bash 照常弹确认——这不是偷懒，是这一层的
能力边界。

主流工具（Codex / Claude Code）之所以能做到「bash 也在沙箱里」，是因为它们在 OS
层做了强制：macOS 的 seatbelt（`sandbox-exec`）、Linux 的 landlock / seccomp，
把进程能写的路径从内核层面限死。本项目目前**没有任何 OS 级沙箱**
（`apps/desktop/src-tauri/src/` 里搜不到 seatbelt/sandbox-exec/landlock）。要做到
真正等价，得在 Rust 侧给 bash 执行加沙箱并处理它带来的连锁问题（依赖缓存、git、
node_modules 的临时文件都要放行，白名单会迅速变长）。

所以现状的定位是：**文件工具的边界是真的，命令的边界还不是**。用户在
`workspace-write` 档下仍会在每次 bash 时被打断——这是诚实的代价，好过假装拦住了。

## 枚举扩容检查表

加一个审批级别时，下面每处都要同步（漏改的表现都是**静默回落**而不是报错）：

- [x] sidecar `src/types.ts` 的 `ApprovalLevel` 与偏好行字段
- [x] sidecar `src/agent/modes.ts` 的 `approvalBeforeToolCall` 分支 + 文档注释
- [x] sidecar `src/protocol/handlers/interactive.ts` 的 `set_mode` 入参校验
- [x] sidecar `src/protocol/handlers/sessions.ts` 的会话投影校验
- [x] sidecar `src/sessions/resolve.ts` 的两处恢复白名单（偏好行 / kv `pi.mode`）
- [x] `packages/pi-protocol` 的 `sessionSummarySchema.approvalLevel` 与 `PlanningSnapshot`
- [x] desktop `lib/pi/pi-session-mode.ts` 的 `ApprovalLevel` + 两处归一
- [x] desktop `lib/pi/pi-bridge.ts` 的 `mode_changed` / `planning_state` 响应类型
- [x] desktop `components/agent-thread/mode-picker.tsx` 的 `PERMISSION_OPTIONS`
      （`+` 菜单引全量表 `ALL_MODE_OPTIONS`；能力三项在 `CAPABILITY_OPTIONS`，
      加**能力模式**时改那张表，与权限档互不影响）

> 同一族的漏项：`sessions.mode` 的恢复白名单曾经漏掉 `goal`，症状是「重启后模式
> 回到默认档」——偏好行里明明存着。白名单少一个字符串不会报错，只会静默降级。
