# 密钥存储加固 Plan

状态：完成（P0/P1/P2 已实现并在隔离实例中验证）
范围：Electron 主进程的密钥落盘、迁移、备份与工具输出脱敏
非目标：MCP 密钥注入（已完成，见 [mcp-secret-injection.md](./mcp-secret-injection.md)）、模型上下文中的密钥隔离（只做输出脱敏兜底）

## 背景

`apps/electron/main/secret.ts` 当前 `encrypt()` 明文直通，`state.db` 的
`secrets` / `credentials` / `remote.token` / `backup.config` 都是明文。
UI 上“AES-256-GCM + 系统钥匙串”的文案与实现不一致。MCP 也没有密钥注入链路。

## P0：加密与迁移

### 1. `apps/electron/main/secret-crypto.ts`（新增，纯函数）

- `aes:v1:` 格式：`aes:v1:<base64(nonce(12) | tag(16) | ciphertext)>`
- `encryptWithKey(plain, key: Buffer)`
- `decryptWithKey(stored, key: Buffer)`
- `isAesCiphertext` / `isLegacyCiphertext`（`enc:v1:` 旧 Rust 密文，不可解）
- 不做 Electron 依赖，便于 bun 单测

### 2. `apps/electron/main/secret.ts`

- 主密钥 32 字节随机数；优先由 Electron `safeStorage` 包裹后写
  `master.key.safe`（`safe:v1:<base64>`）
- `safeStorage` 不可用（或 Linux `basic_text`）时，退化为 `master.key`
  （`key:v1:<base64>`，权限 0600），并记录 `backend=local-key-file`
- `initSecretCipher()` 在 `app.whenReady()` 后、`setupIpc()` 前调用
- `encrypt/decrypt` 保持同步 API：
  - `aes:v1:` → 用主密钥解密
  - `enc:v1:` → 返回不可解错误
  - 无前缀 → 旧明文，原样返回（由迁移负责加密）
- `isEncrypted()` 同时识别 `aes:v1:` 与 `enc:v1:`
- 主密钥文件不进 `state.db`、不进备份包

### 3. `apps/electron/main/secret-migration.ts`（新增）

- `migrateSecretsToEncrypted(db, encrypt)`：
  - `secrets.value`
  - `credentials.api_key`
  - `kv['remote.token']`
  - `kv['backup.config.v1']` 里的 `s3SecretAccessKey` / `davPassword` / `passphrase`
- 明文行原地加密；`enc:v1:` 保留并计数；整体事务
- 在 `app.whenReady()` 后、`setupIpc()` 前执行

### 4. 启动顺序

`main/index.ts`：

```text
initStore()
app.whenReady()
  initSecretCipher()
  migrateSecretsToEncrypted(getDb())
  setupIpc()
  registerAllCommands()
```

`applyPendingRestore()` 仍在 ready 前执行；恢复后的库由 ready 后的迁移覆盖。

## P1：备份与 UI

- `backup.ts` 的 `mergeSecret` 改用 `isEncrypted()`，避免把 `aes:v1:` 二次加密
- 确认 `packBackup` 只收 `state.db` / sessions / task-workspace / library，
  不包含 `master.key*`
- `data.ts` 增加 `secret_cipher_status` 查询，返回
  `backend: "system-keychain" | "local-key-file" | "unavailable"`
- `hostdb.ts` / `secretsPayload` / `pi-bridge` / `secrets-store` 透传状态
- 密钥页：
  - `system-keychain`：沿用“系统钥匙串”
  - `local-key-file`：黄色提示“系统钥匙串不可用，主密钥以 0600 文件保存在本机”
  - `unavailable`：红色提示，禁用保存新密钥
- 修正所有“AES-256-GCM + 系统钥匙串”的硬编码文案

## P2：工具输出脱敏

- `tool-exec.ts` 维护线程级已注入密钥表（TTL 24h，最多 32 个/线程）
- bash 注入时登记 `envelopeOwner -> SecretPair[]`
- `handleTool` 统一包装结果，递归脱敏字符串字段：
  - 跳过 `base64` / `data` / `mimeType`（图片数据不能被改写）
  - 覆盖 `read`、`browser_*`、`http`、`task_output` 等输出
- 说明：脱敏只能挡原值与 base64；模型仍可用反转/十六进制/网络请求绕过，
  这不是硬隔离

## 测试与验收

- `apps/electron/test/secret-crypto.test.ts`：AES 往返、错误密钥、前缀、
  旧 `enc:v1:` 不可解
- `apps/electron/test/secret-migration.test.ts`：明文行迁移、旧密文保留、
  `remote.token` 与 `backup.config` 迁移
- `apps/electron/test/secret-redaction.test.ts`：线程登记、read 输出脱敏、
  图片字段不被改写、TTL
- 手工验证：
  - 新建密钥后直接打开 `state.db`，`value` 为 `aes:v1:...`
  - 编辑/删除/注入 bash 正常
  - provider key 仍可用
  - 备份恢复同机可用；换机后密钥显示“无法解密，需重填”
  - `read` 一个包含密钥的文件，输出为 `[REDACTED:NAME]`
- `bun run typecheck`、`bun run build:renderer`、Electron 测试通过

## 执行记录（2026-10-21）

在隔离数据目录 `KOVA_DATA_DIR=/tmp/kova-goal-e2e/data` 上验证：

- 启动日志：`[secret] generated new master key in system keychain`，
  `migration: migrated=9 legacy=0 failed=0`
- `state.db`：`secrets.value`、`credentials.api_key`、`kv['remote.token']`
  全部变为 `aes:v1:...`；`master.key.safe` 为 0600，未生成明文 `master.key`
- `list_secrets`：`readable:true`，`cipher.backend="system-keychain"`
- provider 凭据：`list_models` 中 `custom-custom-gateway/*` 均 `authed:true`
- 写入/删除：新密钥保存后立即为 `aes:v1:`，删除正常
- bash 注入：绑定 `"*"` 后 `printenv E2E_SECRET | wc -c` 输出 304；
  宿主日志 `[secret_env] injecting 1 secret(s): E2E_SECRET`
- read 脱敏：模型用 `read` 读取写入的文件，工具结果为
  `1\t[REDACTED:E2E_SECRET]`，未拿到明文
- 期间修复：Electron `hostToolCall` 把工具参数嵌在 `envelope.params`，
  而 `resolveIntoEnvelope` 只读顶层 `secretEnv`，导致注入名单永远为空；
  已抽出纯函数 `secret-requests.ts` 同时兼容顶层与嵌套形状，并补回归测试
- 测试：Electron 密钥相关 16 pass；sidecar 全量 1746 pass；
  `typecheck`、`build:main`、`build:renderer` 通过
