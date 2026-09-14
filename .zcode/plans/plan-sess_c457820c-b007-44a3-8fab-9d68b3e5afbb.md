# MCP 服务器级 callTimeout 配置化 + 补全 idleTimeout 界面入口

目标：为每个 MCP 服务器增加"工具调用超时时间"（`callTimeout`，毫秒，默认 120000），配置文件和设置界面均可配置；顺带把后端已支持但界面缺失的 `idleTimeout`（空闲断开时间，默认 10 分钟）也补进表单。

## Sidecar（sidecar/pi-agent/src/）

1. **mcp-config.ts**
   - `McpServerDef`（约 36-55 行）：新增可选字段 `callTimeout?: number`，注释风格与 `idleTimeout` 一致。
   - `parseEntry`（参考 256-261 行 idleTimeout 的校验写法）：新增 `callTimeout` 校验——必须是有限数字且 ≥ 5000，`Math.floor` 后写入；非法则 push 警告"忽略非法 callTimeout（需 ≥5000 的毫秒数）"。
   - 已知字段白名单（约 274 行）加入 `"callTimeout"`，避免触发未知字段警告。
   - `McpDraft`（531-543 行）加 `callTimeout?: number`；草稿落盘处（584 行附近）加 `if (draft.callTimeout !== undefined) entry.callTimeout = draft.callTimeout;`，同时确认"未传时删除该字段"的行为与 idleTimeout 一致（支持用户清空回默认值）。
2. **mcp-manager.ts**
   - 353 行：`{ timeout: def.callTimeout ?? MCP_CALL_TIMEOUT_MS, signal }`。常量保留作为默认值。
   - 连接超时 `MCP_CONNECT_TIMEOUT_MS` 本次不动。
   - 配置哈希（mcp-cache.ts）无需改动——callTimeout 与 idleTimeout 一样不影响工具清单，且 def 每次调用时新鲜传入，改完保存即热生效。

## 前端

3. **lib/mcp.ts**
   - Draft 类型（28-41 行）加 `callTimeout?: number`；`saveMcpServer`（118-131 行）透传该字段。
4. **components/settings/components/mcp-settings.tsx**
   - `FormDraft`（130-154 行）加 `callTimeoutText: string`（字符串承载，空 = 用默认值）。
   - `formToDraft`（191-219 行）：解析为数字（毫秒），空/非法则置 undefined。
   - 编辑回填（draft→form）路径同步补上 `callTimeout`（以及现有 `idleTimeout` 的回填，如果缺失）。
   - JSON 导入路径（约 538-544 行）已解析 idleTimeout，确认/补上 `callTimeout` 的透传。
   - UI：在"高级选项"折叠区内（lifecycle 附近，403-437 行）新增两个数字输入框，用 `InputGroup` + `InputGroupInput type="number"`（参考 appearance-settings.tsx:291-297）：
     - 工具调用超时（毫秒），placeholder "120000（默认 2 分钟）"，min 5000。
     - 空闲断开时间（毫秒），placeholder "600000（默认 10 分钟）"，min 5000。
   - 单位为毫秒（用户已确认），输入框标签注明单位和"留空使用默认"。

## 验证

- sidecar：tsc 类型检查通过；手工验证非法值（如 100）产生警告且被忽略。
- 前端：typecheck 通过。
- 手工链路：设置页保存带 callTimeout 的服务器 → 配置文件出现该字段 → 无需重启，下次 MCP 工具调用按新超时生效；清空字段恢复默认 2 分钟。