# MCP 密钥注入（stdio）

状态：完成（用户级绑定、宿主解密、stdio 子进程注入、输出脱敏、设置页与端到端验证）
范围：`stdio` MCP 服务器的环境变量注入
非目标：HTTP MCP 的 header 注入（下一阶段）、把密钥提供给模型上下文

## 为什么需要单独一条链路

bash 的密钥注入由宿主直接完成：sidecar 只发密钥名字，宿主解密后注入 bash
子进程，明文不跨 RPC。stdio MCP 子进程却由 sidecar 拉起，宿主无法直接改它的
环境变量。因此新增 `secret_env_resolve` 查询：sidecar 把「环境变量名 → 密钥名」
交给宿主，宿主解密后只回 env 映射，sidecar 再交给 `StdioClientTransport`。

## 安全边界

- **绑定只存本机 SQLite kv**（`pi.mcp.secretBindings`）。`.mcp.json` /
  `.kova/mcp.json` / 插件清单里不能声明自己要哪些密钥——工作区文件跟着仓库走，
  不能自我授权。
- **绑定按 `server name + configHash` 生效**。`configHash` 覆盖 transport /
  command / args / env / url / headers（env/headers 键序已规范化）。工作区覆盖
  或手工改启动命令都会改变哈希，旧绑定立即失效，不会出现「同名服务器换了命令
  却继续拿到原来那批密钥」。
- **只允许 global 作用域的密钥**。MCP 连接池按服务器名跨会话/工作区共享，
  工作区作用域的密钥塞进全局子进程会产生「这是哪个工作区的值」的歧义。宿主
  侧也会再拒绝一次，不依赖 sidecar 自觉。
- **配置里只有绑定关系，没有值**。设置页保存的是
  `{ envName, name, scope: "global" }`；密钥值不写入 `mcp.json`，也不回传界面。
- **同名时绑定覆盖字面量 env**。用户在设置页显式选择密钥后，配置里的旧占位符
  不应把真正的值挡住。
- **值只在 sidecar 内存里活到连接断开**。用于子进程 env 与输出脱敏；连接断开、
  配置变更、密钥值变更都会丢弃并强制下次重连。
- **输出脱敏**。MCP 工具结果在进入 `mcp-output-guard` 之前先做递归脱敏：
  原值 + base64 变体 → `[REDACTED:<NAME>]`；图片 `data` / `mimeType` 保持原样。
  `stderr` 与传输错误同样先脱敏再写日志。

## 数据流

```text
设置页（编辑 MCP 服务器）
  └─ save_mcp_server { definition, secretEnv, secretBindingHash? }
       ├─ 写 mcp.json（definition，不含密钥值）
       ├─ 用户级 kv 写 { configHash, env: [{envName,name,scope}] }
       └─ 断开旧连接（配置/绑定变了）

首次调用 / test_mcp_server
  └─ McpManager.ensureConnected
       └─ resolveMcpSecretEnvForSpawn(def)
            ├─ 查 kv 绑定；configHash 不一致 → 不注入
            └─ host_query secret_env_resolve
                 └─ 宿主：校验 global + 名字 → 解密 → { env: { ENV_NAME: value } }
       └─ StdioClientTransport({ env: { ...def.env, ...secretEnv } })
```

## 配置变更时的绑定处理

编辑弹窗打开时带回当前 `configHash`。保存时：

- 配置字段没变：绑定按原哈希保存，继续生效。
- 配置字段变了、用户没动密钥行：旧绑定**自动解除**（响应里不再有
  `secretEnv`）。不把旧密钥续到新命令上。
- 配置字段变了、用户勾选「保留」或实际改过密钥行：视为对新配置的显式重新
  授权，按新哈希保存。
- 工作区文件被外部改动：`configHash` 不匹配，绑定变为
  `secretBindingStale`；设置页行上显示「密钥绑定失效」，编辑器里提示需要重新
  选择。管理器不会使用 stale 绑定，但绑定本身保留——把配置改回原样即可恢复，
  不需要重新选密钥。
- 新建同名工作区覆盖且没有填写密钥：不发送 `secretEnv`，避免顺手清掉系统层
  已有绑定。

## 协议

`save_mcp_server` 新增两个可选字段：

```json
{
  "secretEnv": [{ "envName": "GITHUB_TOKEN", "name": "GH_PAT", "scope": "global" }],
  "secretBindingHash": "打开编辑器时的 configHash"
}
```

`secretEnv: []` 表示明确解除绑定。`secretBindingHash` 与保存后的 effective def
不一致时，非空 `secretEnv` 会被丢弃（防止把旧授权带到新配置）。

宿主新增 `host_query kind="secret_env_resolve"`：

```json
{ "server": "github", "requests": [{ "envName": "GITHUB_TOKEN", "name": "GH_PAT", "scope": "global" }] }
→ { "env": { "GITHUB_TOKEN": "<decrypted>" } }
```

## 设置页

- MCP 编辑器（本地进程）新增「密钥注入」区块：环境变量名 + 全局密钥下拉。
- 仅列出 `scope=global` 且 `readable=true` 的密钥；没有可用密钥时提示先去
  「设置 → 智能体 → 密钥」创建。
- 行上显示 `N 密钥` 或 `密钥绑定失效` 徽标。
- 配置变更且已有绑定时显示显式确认；不勾选则保存时解除。
- 编辑弹窗改为限高 + 中段滚动，密钥行多时 footer 始终可见。

## 测试

- `apps/sidecar/pi-agent/test/mcp/mcp-secrets.test.ts`
  - 绑定保存/命中、configHash 失效、键序不影响哈希
  - 只接受 global、拒绝 HTTP、空数组解除
  - 真实 fake MCP server：密钥确实进入子进程；工具回显被脱敏
  - 未绑定/配置变更后不注入；绑定覆盖 literal env
  - 文本/base64 脱敏，图片 data 不被改写
- `apps/sidecar/pi-agent/test/mcp/mcp-protocol.test.ts`
  - `save_mcp_server` 携带 `secretEnv` 的回读
  - 配置变更且未重新授权时丢弃旧绑定
- `apps/electron/test/secret-requests.test.ts`
  - MCP 请求只保留合法 global 条目、envName 可不同于密钥名、重复 envName 去重
- `apps/electron/test/secret-mcp-env.test.ts`
  - 宿主解密路径：命名映射、缺失/旧密文跳过
- 全量：sidecar 1756 pass；Electron 25 pass；desktop/main/sidecar typecheck 通过

## 端到端验证（2026-10-21，隔离实例）

在 `KOVA_DATA_DIR=/tmp/kova-mcp-e2e/data`、独立 `PI_MCP_CONFIG` 上启动第二个
Electron 实例（不影响已打开的 dev 窗口），使用会回显环境变量的 fake MCP
服务器：

- 保存全局密钥 `MCP_E2E_SECRET` 与绑定
  `PI_MCP_TEST_SECRET ← MCP_E2E_SECRET` 后，`test_mcp_server` 返回
  `ready / 6 tools`；子进程启动时写出的环境快照为
  `{"secret":"mcp-e2e-secret-123456","declared":"declared","hasPath":true}`
  ——宿主解密、RPC、sidecar 注入整条链路已验证。
- 新会话要求模型调用 `fake__env_check`，模型看到的工具返回为
  `{"declared":"declared","secret":"[REDACTED:MCP_E2E_SECRET]","pathPresent":true}`
  ——脱敏在进入模型上下文前完成。
- 把 MCP 配置的启动参数改成另一个脚本：`list_mcp_servers` 返回
  `secretEnv` 消失、`secretBindingStale=true`，设置页行显示「密钥绑定失效」；
  把参数改回原值后绑定自动恢复生效。
- 设置页截图确认「密钥注入」区块、`N 密钥` 徽标与限高滚动布局正常。

## 已知限制

- HTTP MCP 仍使用配置里的 literal headers，尚未接密钥库；需要的话下一阶段做
  宿主代理或在受控解析后注入请求头。
- 脱敏只覆盖原值与 base64；模型仍可通过反转、十六进制、网络请求等方式绕过。
  这是输出兜底，不是硬隔离。
- 短于 8 字符的密钥不参与脱敏（与 bash 注入策略一致，避免误伤普通文本）。
- 同一个密钥名被多台服务器绑定时，任何一处修改密钥值都会断开所有使用它的
  MCP 连接，下次调用按当前绑定重新解析。
