# Shell 写入策略

## 目的

Kova 的逐文件 diff / checkpoint 只覆盖 `write` / `edit`。如果模型用
`sed -i`、重定向、heredoc、`tee` 直接改文件，会出现两个问题：

- 改动没有逐文件 diff，回滚只能靠整轮快照；
- shell 读取不进入 read-state，后续结构化编辑反而会被“read it first”挡住，
  模型更容易继续用 shell 写。

这份策略把“查看 / 验证 / 命令自身写 / 手工改 / 动态”分开，保证手工编辑
必须走 `write` / `edit`，同时不误伤测试、构建、formatter、codegen。

## 分类

| 分类 | 典型命令 |
|---|---|
| `inspect` | `sed -n`、`cat`、`head`、`tail`、`grep`、`rg`、`ls`、`git status/diff/log/show`、`git stash list/show/log`、`git tag`（无标签名/`-l`）、`git config <key>`、`git submodule status`、`tar -t`（含老式 `tar tzf`）、`unzip -l/-p`、`sips -g`、`curl/wget` 的 GET/HEAD |
| `verify` | `pnpm test`、`bun test`、`npm run build`、裸子命令 `pnpm build/typecheck/lint`（与 `run` 同判）、`tsc`、`eslint`（无 `--fix`）、`prettier --check`、`cargo test`、`go test`、`pytest` |
| `managed-write` | `prettier --write`、`eslint --fix`、包管理器安装、`npm ci`、`pnpm test -u`（快照更新）、`git checkout/commit`、`git branch <名>`、`git remote add`、`git tag <名>`、`git config <key> <value>`、`cp/mv/rm/mkdir/touch`、`curl -o`/`wget -O`、`sips -s/--out`、`find -delete`、`find -exec` 非编辑器命令 |
| `inline-edit` | `sed -i`、`perl -i`、`awk -i inplace`、`tee`、输出重定向到项目文件、heredoc 写文件、`patch`、`git apply/am`、`dd`、`truncate`、`find -exec sed -i`（任意一段）、`xargs sed -i` |
| `dynamic` | 命令替换、子 shell、循环/函数、`eval`/`source`、解释器与脚本文件（`python/node/ruby/php`、`perl 脚本`、`sed/awk -f`、`gawk -i/--include/-l/--load`（非 inplace））、`awk '"cmd" | getline'` 管道执行、带数据或非 GET 的 `curl/wget`、`kill/pkill`、无法解析或未知命令 |

原则：脚本来源在命令行上可见才允许静态判断——`perl -e`/`sed '...'`/`awk '{...}'`
的内容就在参数里，可以检查写通道；`perl 脚本.pl`、`sed -f`、`awk -f`、
`gawk -i/--include/--load` 的内容在磁盘上，分类器看不见，一律 `dynamic`
（Agent 弹审批、Plan 拒绝），不静默当只读。

重定向目标：

- 落在项目根（cwd + 项目附加根）→ `inline-edit`；
- 落在 `/dev/null`、`/dev/stdout`、`/dev/stderr` 或临时目录 → 不算项目手写；
- 落在项目外真实路径 → `managed-write`。

## 模式策略

| 模式 | inspect | verify | managed-write | inline-edit | dynamic |
|---|---|---|---|---|---|
| Plan | 允许 | 允许 | 拒绝 | 拒绝 | 拒绝 |
| Goal 验收协商期 | 允许 | 允许 | 拒绝 | 拒绝 | 拒绝 |
| Agent / Goal 正常轮 | 允许 | 允许 | 允许（现有审批） | 拦截 | 允许（现有审批） |
| Ask | 无 bash | — | — | — | — |
| 无人值守自动化 | 保持原有策略 | | | | |

- `inline-edit` 在审批之前拦截，`完全访问` 也拦；
- Plan / Goal 协商期的 `managed-write` / `dynamic` 拒绝是结构性的，不依赖提示词；
- 子代理与主代理共用同一 gate。

错误文案：

```text
Shell hand-edits are blocked: this command would modify project files outside
write/edit, bypassing the per-file diff and checkpoint. Use edit for partial
changes or write for new/full files.
```

## 实现

- `apps/sidecar/pi-agent/src/permissions/shell-policy.ts`
  - `tree-sitter-bash` + `web-tree-sitter`：WASM 随 sidecar 编译产物嵌入；
  - 启动闸门内 `initShellPolicy()`；解析器不可用时退回保守扫描器；
  - `classifyShellCommand(command, { cwd, roots, tempRoots })` 同步分类。
- `apps/sidecar/pi-agent/src/agent/modes.ts`
  - `modeBeforeToolCall`：Plan / Goal 协商期拦截；
  - `gateToolCall`：Agent/Goal 正常轮在审批前拦截 `inline-edit`；
  - `subagentToolGate` 复用同一入口。
- `apps/sidecar/pi-agent/src/tools/tools.ts`：bash 描述说明 shell 手写会被拒绝。

## 边界

- `formatter` / `codegen` / 包管理器 / git 写属于 `managed-write`：普通模式允许，
  Plan/Goal 协商期拒绝；它们仍只有整轮快照 diff，没有逐文件回滚。
- `python -c` / `node -e` 归 `dynamic`：Plan 拒绝，普通模式走审批。
- 复杂 shell（函数、循环、嵌套 heredoc）可能归 `dynamic`，不会静默当只读。
- Windows/Linux 的 OS 级沙箱隔离不在本策略范围内。

### 已知启发式取舍（保守方向，刻意保留）

- 项目内重定向日志（如 `pnpm test 2>err.log`）按手写拦截：日志应发
  `/tmp`（bash 工具描述里已写明），换取 workspace 内所有 shell 写文件都可拦。
- `sed` 的 `w/W/e` 靠脚本文本正则识别：替换文本里出现单字母后接空格
  （如 `s/e E/g`）会误报为 `inline-edit`；收紧正则会漏掉 `/x/w file`
  这种地址写法，保留宁严勿松。
- `cd` 之后命令的相对重定向仍按原 cwd 解析：方向保守（把 `/tmp` 写当
  项目写），不做 `cd` 追踪。
- `diff <(sort a) <(sort b)`、`export FOO=$(date)`、`mktemp` 归 `dynamic`：
  Plan 下被拒，代价是少量只读命令的可用性。
- `.json` 的 `append` 校验的是“已有内容 + 追加”的最终结果：每一步都必须保持
  合法 JSON，所以大 JSON 用“先写合法骨架、再用 edit 扩展”，append 只适合纯文本。
- Plan 档同时拒绝 `kill/pkill` 与带数据/非 GET 的 `curl/wget`：只读边界不只
  覆盖本地文件，也覆盖进程与远端状态。

## 测试

- `test/permissions/shell-policy.test.ts`：分类器覆盖 inspect/verify/managed-write/
  inline-edit/dynamic、重定向路径、wrapper、fallback。
- `test/e2e/shell-policy.e2e.test.ts`：真实宿主 + 模式/审批/子代理场景。
- `test/agent/modes.test.ts`：Plan / Goal 协商 / Agent/auto 的模式门控。
- Electron 用户场景见 `docs/e2e/tool-policy/REPORT.md`。
