# Git 功能集成设计(Rust 侧实现)

> 状态:设计稿,待确认排期。目标:给应用加上"工作区即 git 仓库"的感知与操作能力,对齐 Codex 的体验。

## 1. 目标与功能范围

分四层递进:

| 层 | 功能 | 消费方 |
|---|---|---|
| **M1 状态与 diff(只读)** | 当前分支、脏文件数、ahead/behind、最近提交;工作区 vs HEAD 的真实 diff | WorkspacePill 显示分支、面板"审查"标签换成真 diff |
| **M2 检查点/回滚** | 每次 agent 运行前自动打快照,运行后展示"保留 / 撤销本次改动"(Codex 的 keep/revert) | 消息流尾部操作条 + 面板 |
| **M3 提交面板** | 变更文件勾选暂存、commit(消息可由 agent 生成)、历史列表、分支切换/新建 | 面板新增 "Git" 标签类型 |
| **M4(可选)** | git 作为 sidecar 结构化工具;远程网页端经 WS 网关代理 | agent 本身已能用 bash 跑 git,M4 只是锦上添花 |

## 2. 关键技术选型:CLI 包装,不用 git2 crate

**推荐:Rust 侧用 `std::process::Command` 直接调系统 `git`,而不是 `git2`(libgit2)。**理由:

- `src-tauri/src/tool_exec.rs` 已有完整先例:`resolve_shell_command`、`no_window`(Windows 黑框)、`kill_tree`、超时控制,全部可复用同一套进程管理代码;
- 检查点、stash、worktree 等 plumbing 命令 libgit2 不支持或残缺,CLI 保真度 100%;
- 避免 Windows 上 libgit2 的 CMake 构建链风险(项目目前唯一 vendored C 是 rusqlite,不必再加一个);
- 解析成本可控:统一用 `--porcelain=v2 -z` 机器格式 + `git diff` 原文,不解析人类输出。

**前置探测**:首次调用 `git --version` 探测可用性,结果缓存;不可用时前端 git 功能整体降级隐藏(不报错)。

## 3. Rust 侧模块设计

新文件 `src-tauri/src/git.rs`(功能多后可拆 `git/` 目录),命令注册到 `lib.rs` 的 `generate_handler!`:

```text
命令(全部 async,内部 spawn_blocking,参数走 serde):
  git_probe               → { available, version }
  git_status(cwd)         → { branch, upstream, ahead, behind,
                              worktree: [{path, xy, staged…}], untracked[], last_commit }
  git_diff(cwd, opts)     → { patch, truncated, files: [{path, added, removed, binary}] }
                            // opts: vs HEAD / vs checkpoint(ref) / 单文件
  git_show(cwd, ref, path)→ 文件在该版本的内容(审查视图的"改前"侧)
  git_log(cwd, limit)     → 提交历史
  git_checkpoint_create(cwd, tag)  → { hash }            // 见 §4
  git_checkpoint_diff(cwd, hash)   → 复用 git_diff
  git_checkpoint_restore(cwd, hash)→ 恢复工作区
  git_stage(cwd, paths, on) / git_commit(cwd, message)
  git_branches(cwd) / git_checkout(cwd, name, create)
```

**安全约束(重要)**:

- 所有命令第一参数固定注入 `["-C", cwd, "--no-optional-locks", ...]`,参数以数组传递**绝不拼接 shell 字符串**,无注入面;
- `cwd` 只接受前端 workspace-store 里的那个目录(Rust 侧比对 `canonicalize` 后路径),不接受任意路径;
- 输出体积上限(如 diff 1MB)截断 + `truncated` 标记,与 `tool_exec.rs` 现有截断策略一致;
- 只读命令带 `--no-optional-locks`,避免和用户的 git GUI/CLI 抢 index.lock。

**事件回推**:检查点创建/恢复、commit 完成后 `app.emit("git-changed", { cwd })`,前端订阅失效缓存;不做文件 watcher(MVP 靠"运行结束 + 窗口聚焦"两个时机刷新即可)。

## 4. 检查点方案:影子仓库(shadow git-dir)

M2 是设计里最需要想清楚的一点。**推荐 Codex CLI 同款的影子仓库,而不是 `git stash`**:

- 在 app 数据目录(`store.rs` 已有路径基建)下为每个 workspace 建独立仓库:`<app_data>/checkpoints/<sha1(cwd)>/`,用 `git --git-dir=<影子> --work-tree=<workspace>` 操作;
- 打快照 = 影子仓库 `add -A` + `commit -m <tag>`(不写用户仓库的 refs/stash/index,零污染,不会和用户自己的 stash 打架);
- 对比 = `--git-dir` 下 diff 影子 HEAD vs 工作区;恢复 = 影子 `checkout-index -a -f` 或 diff→`apply -R`;
- 未跟踪文件天然纳入(`add -A` 就包含),这是 stash 方案做不到的;
- 忽略规则:影子仓库启动时引用用户仓库的 `.gitignore`,避免把 `node_modules` 提交进快照(可用 `--exclude` 参数 + 读用户 gitignore)。

**编排在 transport 层**(前端 `lib/pi-transport.ts` 的 `sendMessages`):

1. 发 prompt 前 `git_checkpoint_create(cwd, runId)`;
2. 收到 `finish` chunk 后 `git_checkpoint_diff`——非空则在最后一条 assistant 消息下挂"审查本次改动 / 撤销"操作条(复用 `ManualCompactionTailAfter` 的消息锚定思路);
3. abort 路径同样适用:运行中断也要能 diff/回滚。

sidecar 不需要任何协议改动。

## 5. 前端集成设计

```text
lib/git.ts          invoke 封装 + Tauri 门控(网页端整体返回"不可用",接口留同形)
lib/git-status.ts   useSyncExternalStore 状态缓存(仿 lib/pi-todo.ts 的 store 模式):
                    useGitStatus(cwd) / refresh / "git-changed" 事件失效
```

UI 挂点:

1. **WorkspacePill**(`components/agent-thread/composer.tsx`):目录名右侧加 `分支名 + 脏点数`,非仓库不显示;
2. **审查标签**(面板 `review` tab):数据源从"工具调用派生 diff"升级为 `git_diff(vs HEAD)`——这是真 diff,含 agent 用 bash 改的文件;非 git 仓库时回退现有派生视图(两种数据源同一渲染组件,`line-diff` 复用);
3. **Git 标签类型**:`agent-panel/tab-registry.tsx` 注册表加 `git` 类型——上半区变更文件勾选暂存 + commit 输入框,下半区 `git_log` 历史;
4. **检查点操作条**:assistant 消息尾部的 keep/revert 按钮(revert 前二次确认,属破坏性操作)。

## 6. 实施顺序与验证

- **M1**:`git_probe/git_status/git_diff` + `lib/git.ts` + WorkspacePill + 审查标签换源。Rust 侧 `cargo test`:用 `git init` 临时仓库做夹具,断言 porcelain v2 解析;
- **M2**:影子仓库三命令 + transport 编排 + 操作条;
- **M3**:stage/commit/log/branch 命令 + Git 标签 UI;
- 每阶段验收:大仓库(如本项目)status/diff 延迟 <200ms、Windows 无黑框、git 未安装时 UI 静默降级。

## 7. 风险与对策

| 风险 | 对策 |
|---|---|
| 用户机器无 git | `git_probe` 前置,功能整体隐藏;错误码区分"未安装/非仓库" |
| 影子仓库快照体积(大二进制) | `add -A` 前按 .gitignore + 体积上限过滤;快照 LRU 清理(保留最近 N 个) |
| revert 覆盖用户手改 | revert 前 diff 展示 + 二次确认;恢复只覆盖快照后变更,冲突时中止并报错 |
| 并发:index.lock 争抢 | 只读 `--no-optional-locks`;写命令串行化(Rust 侧 per-cwd Mutex) |
| 远程网页端无本地 FS | v1 桌面专属;后续经 `remote.rs` 网关代理 git 命令(网关跑在桌面机上,天然可行) |

## 8. 一句话总结

**Rust 侧新增 `git.rs`,以 CLI 包装(`std::process::Command` + porcelain v2)实现状态/diff/检查点/提交命令,检查点用影子 git-dir 零污染快照,前端在 transport 层编排"运行前快照、结束后 keep/revert",并把面板审查标签升级为真 git diff。**
