# 沙箱（V1）

状态：V1 已实现。目标不是 VM 级隔离，而是把 Agent 的写操作限制在工作区与用户显式授权的目录内，并拦住对高危凭据目录的读取。

## 范围

| 工具 | macOS | Windows | Linux |
|---|---|---|---|
| `bash` / 后台 `bash` | `sandbox-exec` + Seatbelt，写隔离 | 无 OS 沙箱（按现有审批执行） | 无 OS 沙箱 |
| `read` | 宿主校验：高危凭据目录拒绝 | 同左 | 同左 |
| `write` / `edit` | 宿主校验：只能写计划内的写根 | 同左 | 同左 |
| `http` / `WebFetch` / `WebSearch` / `generate_image` | 校验：`network=deny` 时拒绝 | 同左 | 同左 |
| `browser` / `screenshot` / MCP | V1 不纳入 | 同左 | 同左 |

**Windows 的 bash 明确没有 OS 沙箱。** 用户批准或 `auto` 档下，bash 仍可写到工作区外；设置页与工具结果会标注这一点。需要 Windows bash 隔离时，必须单独立项做原生 helper。

## 默认策略（workspace 档）

发布默认关闭，用户在设置页显式开启「工作区」档后生效。开发和灰度可用 `KOVA_SANDBOX=workspace` 强制开启；`KOVA_SANDBOX=off` 始终优先。

- 可写：
  - 工作区 `cwd`
  - 项目设置里挂载的外部目录
  - 本机 write roots（`.kova/permissions.local.json` / 用户级清单）
  - 会话临时目录
  - 常见包管理器缓存（可通过设置关闭）
- 可读：默认放行；以下目录拒绝：
  - `~/.ssh`、`~/.aws`、`~/.gnupg`、`~/.kube`、`~/.docker`、`~/.git-credentials`
  - macOS 另加 `~/Library/Keychains`
  - Windows 另加 `%APPDATA%\gcloud`
- 禁写（即使落在工作区内）：
  - `<cwd>/.kova/permissions.json`
  - `<cwd>/.kova/permissions.local.json`
  - `~/.kova/permissions.json`
- 网络：默认允许；设置里可切到禁止（bash 与 WebFetch/WebSearch 一起生效）。

## 配置

设置 → 智能体 → 智能体配置 → 沙箱：

- 档位：关闭 / 工作区（默认）。
- 网络：允许 / 禁止。
- 包缓存：允许写 / 不允许。
- 沙箱不可用：拒绝执行 / 允许降级（仅 macOS Seatbelt 缺失时生效）。

全局 kill switch：`KOVA_SANDBOX=off`，优先级高于设置页；`KOVA_SANDBOX=workspace` 强制开启（同样压过会话级覆盖）。

## 与权限档位的关系

权限档回答「动之前问不问」，沙箱回答「执行起来能碰哪里」——两者完全正交，互不联动：

- 切任何权限档（含「完全访问」）都不会改变沙箱状态；沙箱只在设置页和 `KOVA_SANDBOX` 环境变量控制。
- 「完全访问」= 不再弹审批卡，但沙箱开启时越界写仍会被物理拦截（工具结果里说明原因并指引加目录/关沙箱）。
- 越界需求的正道：审批卡「允许并记住」（目录进 write roots）或项目设置挂外部目录。

## 被拒绝时

## 被拒绝时

模型会收到结构化错误，例如：

```
sandbox: write denied: /Users/x/other/file.ts. Allowed write roots: /Users/x/project, …. Add the directory as a project directory or write root in settings if this is intended.
```

处理方式：

1. 写到工作区内；或
2. 在项目设置里把目录加为外部目录；或
3. 在审批卡上点「允许并记住」，把目录写进本机 write roots；或
4. 在设置里关闭沙箱。

模型不能自己请求关闭沙箱；授权清单本身也被禁写，防止 Agent 自己扩权。

## 已知限制

- 沙箱内仍是同一用户进程，不是 VM；不防内核漏洞或沙箱实现漏洞。
- 不按域名过滤网络；`network` 只有全允许/全拒绝。
- 硬链接可以绕过路径归属判断（工作区内硬链接指向外部文件）。
- `.git/hooks`、`.git/config`、`package.json` 的 install 脚本等仓库内可执行配置仍可写；它们可能在沙箱外被用户或后续命令执行。V1 不拦截，需要时单独加禁写路径。
- 环境变量未清洗；需要处理 API key/token 外泄时应另行设计 env allowlist。
- 高并发下 `sandbox-exec` 每次命令启动有一次进程开销（几十毫秒）。
- 工具行会显示 `sandboxed` / `no OS sandbox` / `sandbox denied` badge；数据来自工具结果的 `details.sandbox`，刷新后从转录回放。

## 测试

- `packages/pi-sandbox/test/`：策略与路径判定（含 Windows 大小写折叠的禁写比较与写根截断）。
- `apps/electron/test/sandbox-seatbelt.test.ts`：真实 Seatbelt 行为（写内/写外、读拒绝、子进程继承、`/dev/null`、空格路径、network deny、授权清单禁写）。
- `apps/electron/test/sandbox-path-guard.test.ts`：宿主 read/write/edit/http 校验与 symlink 逃逸。
- `apps/sidecar/pi-agent/test/permissions/sandbox-config.test.ts`：配置归一化与 kv 往返。
- `apps/sidecar/pi-agent/test/permissions/sandbox-plan.test.ts`：设置切换后下一次 plan 立即变化。
- `apps/sidecar/pi-agent/test/e2e/sandbox.e2e.test.ts`：端到端——sidecar buildTools 信封 → 宿主 handleTool 裁决 → Seatbelt 执行 → sandbox 信息回传（含越界拒绝、预检拦截、伪造 sandbox 字段剔除、tier=off 放行）。
- `bun scripts/sandbox-matrix.ts`：真实 Seatbelt 下的 git/node/bun/npm/python/make 兼容矩阵（macOS）。
