# 备份与恢复功能实施计划(S3 + WebDAV,v1 手动)

## 备份范围(已按数据盘点定稿)

**包含:**
- `state.db`(SQLite,WAL)——打包前在 `DbState` 锁内 `PRAGMA wal_checkpoint(TRUNCATE)` 后拷贝单文件。里面已含:kv 全部设置、sessions 索引、credentials(密文)、custom_providers、models、usage 统计、webhook 记录
- `sessions/*.jsonl`(会话消息流,含内联图片附件)
- `task-workspace/`(无目录任务的 agent 产物)——**设置页开关,默认包含**

**排除(写进 UI 说明):**
- `browser-panel/`(webview 缓存/站点数据)、日志(在 app_log_dir,本就不在 data dir)、dev 主密钥文件
- 用户 cwd 下的 agent 文件(属用户项目目录,由 git/用户管理)

**凭据盲区(UI 明确提示):** OS keychain 主密钥不随备份走,换机恢复后加密凭据不可解。恢复就位时清空 `credentials` 表(引导重输 API key),`custom_providers` 等非密配置完整保留。

## 备份包格式(自定义 `.piabk`,单文件)

```
PIABK1\n                        // magic
{一行 JSON header}\n            // formatVersion/schemaVersion/createdAt/device/appVersion/
                                // encrypted/salt/nonce/files:[{path,size,sha256}]/payloadSha256
<tar.gz payload>                // tar + flate2;加密时为 AES-256-GCM(pbkdf2-sha256 派生口令密钥)
```

- 不加密则 payload 为标准 tar.gz,系统 tar 可应急解开
- 恢复时先验 payloadSha256,再逐文件校验 sha256;JSONL 末尾无换行的截断残行丢弃(sidecar 追加写的一致性兜底)

**新增 Rust 依赖(全纯 Rust 小库):** `tar`、`flate2`、`sha2`、`hmac`、`hex`、`pbkdf2`、`quick-xml`(解析 WebDAV PROPFIND)。前端零新增依赖(`@tauri-apps/plugin-dialog` 已装)。

## Rust 侧:新模块 `src-tauri/src/backup.rs`

**命令(注册进 lib.rs 的 generate_handler):**

| 命令 | 职责 |
|---|---|
| `backup_config_get/set` | 配置存 kv `backup.config.v1`;秘密字段(secretAccessKey/webdavPassword/可选记住的口令)经 `secret::encrypt` 后落库 |
| `backup_test` | 连通性检查:S3 ListObjectsV2(max-keys=1);WebDAV PROPFIND,目录不存在则 MKCOL |
| `backup_run` | 打包 → 上传远端或写本地文件;进度经 `app.emit("backup://progress", …)` 推送 |
| `backup_list_remote` | S3 ListObjectsV2(prefix)/WebDAV PROPFIND Depth:1 → [{name,size,modified}] |
| `backup_download(name, savePath)` | 下载远端备份到用户所选路径(路径由前端 save dialog 先选好) |
| `backup_restore(source)` | 远端下载或本地文件 → 解到 `app_data_dir/restore-staging/` → 校验 → 写 `pending-restore.json` 标记,**不动现网文件** |
| `backup_delete_remote(name)` | 删远端备份 |
| `backup_restart_app` | `AppHandle::restart()` |

**恢复就位(原子交换):** lib.rs setup 里、`store::init` **之前**检查 `pending-restore.json` → 把当前数据挪到 `pre-restore-<ts>/`(防误操作,不直接删)→ staging 内容就位 → 删标记 → 正常启动照常跑 data.rs 迁移。恢复 UI 提示"恢复会覆盖全部会话与设置,应用将重启"。

**S3 通道:** 手写 SigV4(PUT/GET/DELETE/ListObjectsV2,~150 行)走已有 reqwest blocking;支持自定义 endpoint + path-style(MinIO/R2/OSS/COS 兼容)。配置:endpoint(留空=AWS)/region/bucket/prefix/accessKeyId/secretAccessKey/pathStyle。
**WebDAV 通道:** MKCOL(逐级建目录)/PUT/GET/PROPFIND(quick-xml 解析)+ Basic auth。配置:url/username/password/子目录。

远程文件名:`<prefix>pi-backup-<device>-<yyyyMMdd-HHmmss>.piabk`。

## 前端

- `lib/backup-config.ts`:`useSyncExternalStore` 配置镜像(同 observability-config 模式,但走 invoke backup_config_*)
- `components/settings/components/backup-settings.tsx`,分区块:
  1. **备份内容**:核心数据(常开+说明文案)、「包含任务工作区」开关(默认开)
  2. **备份目标**:关闭 / S3 / WebDAV 单选 + 各自字段 + 测试连接(toast 反馈)
  3. **立即备份**(远端)/ **备份到本地文件**(save dialog)+ 进度条(listen `backup://progress`)
  4. **远端备份列表**:刷新 → 每行(时间/大小/设备):恢复(两段式确认 + 加密包口令输入)/ 下载(save dialog)/ 删除(两段式确认,同 archive-settings 现有模式)
  5. **从本地文件恢复**(open dialog)
- `settings-page.tsx`:系统分组加「备份」导航项 + section id + 渲染分支
- 恢复成功后 toast + 「立即重启」按钮 → `backup_restart_app`

## 实施顺序

1. Cargo.toml 依赖 + `backup.rs`(envelope 格式/打包、S3 SigV4、WebDAV、命令、startup swap)+ lib.rs 注册
2. Rust 单测:envelope roundtrip(明文/加密)、SigV4 AWS 官方已知向量
3. 前端:`backup-config.ts` → `backup-settings.tsx` → settings-page 注册
4. `cargo check/test` + 前端 tsc/build 验证;手动冒烟:备份到本地 → 改数据 → 恢复重启 → 数据还原