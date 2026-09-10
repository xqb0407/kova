# 日志系统设计：磁盘持久化 + 按日期 + 分来源

## Context

目前应用没有任何磁盘日志：Rust 端 6 处 `eprintln!` 只打到启动终端，sidecar（pi-agent）的 stderr 被 Rust 读到后也仅 `eprintln!`，前端 console 完全不落盘。用户反馈问题时无从取证。

设置页「关于 → 支持与反馈 → 日志目录」入口已存在（[about-settings.tsx](file:///Users/herther/Desktop/ai-teamplte/components/settings/components/about-settings.tsx) 调 `open_logs_dir`，指向 `app_log_dir()` 并用系统处理器打开），但目录是空的。本设计让日志真正落盘：**按日期分目录、按来源分文件**，现有设置入口无需改动位置。

用户要求：日志分细一些（按来源分文件）+ 按日期组织。

## 日志目录结构

```
<app_log_dir>/                       # macOS: ~/Library/Logs/com.xulux.assistant
  2026-09-10/                        # 按天建目录（本地日期）
    app.log                          # Rust 主进程（log crate 全量）
    pi-agent.log                     # sidecar stderr（Rust 转发落盘）
    web.log                          # 前端 console 转发（warn/error/崩溃）
  2026-09-09/
    ...
```

- 行格式：`2026-09-10 21:33:05.123 [INFO] [pi_agent] spawned pi-agent`（时间戳由 Rust 写入时补）
- 保留 7 天：启动时清理过期日期目录（目录名非法直接跳过）
- 单文件超 10MB 滚动为 `*.log.1`（防单日刷爆，简单一档）
- dev 浏览器模式（走 API route）不落盘，日志仍在 dev 终端可见——桌面场景才需要取证

## 实现步骤

### 1. Rust：新增 `src-tauri/src/logging.rs`（核心，新文件）

自研轻量实现，不引入 tauri-plugin-log（避免为日志多拉一个插件 + JS guest 依赖）：

- 依赖：`Cargo.toml` 加 `log = "0.4"`、`chrono = "0.4"`（本地日期/时间戳；iana-time-zone 已在 tauri依赖树内，增量极小）
- 实现 `log::Log` trait：
  - `enabled()`：级别过滤，`AtomicU8`（默认 Info，环境变量 `XULUX_LOG_LEVEL=debug/info/warn/error` 覆盖）
  - `log()`：按 `Local::now().date_naive()` 决定目标日期目录（跨天自动换目录/建目录），app.log 追加写入；同时 stdout 镜像一份（dev 终端可见性不回退）
  - 文件句柄缓存（当前日期 + File + 已写字节数），跨天或超 10MB 时滚动重建
  - `init(app)`：在 `lib.rs` setup 最先调用（store::init 之前的失败也能记到）；解析 app_log_dir、建目录、启动后台清理过期目录（7 天前，std::fs + 目录名解析）
- 暴露两个小函数供命令复用：
  - `write_source_log(source: &str, line: &str)` — 供 pi-agent stderr 与 web 转发写入 `pi-agent.log` / `web.log`（同样带时间戳、日期目录、大小滚动）
  - `frontend_log(level, message)` Tauri command（放 logging.rs）— 落 `web.log`

### 2. Rust：替换现有打印点 + 补关键路径日志

6 处 `eprintln!` 全部替换（grep 已定位）：
- [pi_agent.rs:123](file:///Users/herther/Desktop/ai-teamplte/src-tauri/src/pi_agent.rs#L123) stderr 行 → `logging::write_source_log("pi-agent", line)`（保留 `log::debug!` 镜像）
- [pi_agent.rs:126,136](file:///Users/herther/Desktop/ai-teamplte/src-tauri/src/pi_agent.rs#L126) → `log::error!/warn!`
- [lib.rs:25](file:///Users/herther/Desktop/ai-teamplte/src-tauri/src/lib.rs#L25) store init → `log::error!`；补 store init 成功 `log::info!`
- [appearance.rs:78](file:///Users/herther/Desktop/ai-teamplte/src-tauri/src/appearance.rs#L78)、[remote.rs:508](file:///Users/herther/Desktop/ai-teamplte/src-tauri/src/remote.rs#L508) → `log::warn!/error!`

补充关键 info：sidecar spawn 成功/退出码、remote 网关启动/停止。不逐行埋点，保持克制。

### 3. 前端：console 转发（`lib/frontend-logging.ts`，新文件）

- 仅 `isTauri()` 时生效（复用 [lib/tauri.ts](file:///Users/herther/Desktop/ai-teamplte/lib/tauri.ts)）
- patch `console.warn/console.error`（保留原行为，旁路 `invoke("frontend_log", { level, message })`，序列化参数、截断超长）
- `window.addEventListener("error")` / `("unhandledrejection")` → 落 web.log
- 在 `app-runtime-provider.tsx` 挂载时调用一次（hydration 后，避开 BootSplash 阶段）

### 4. 设置页：微调文案

[about-settings.tsx](file:///Users/herther/Desktop/ai-teamplte/components/settings/components/about-settings.tsx)「日志目录」行 desc 更新为说明结构（按天分目录，含 app/pi-agent/web 三类文件）；打开行为不变（`open_logs_dir` 已建目录并打开）。

## 不做的事

- 不引入 tauri-plugin-log / plugin-log JS 包
- sidecar 零改动（stderr 照旧 console.error，由 Rust 转发落盘；浏览器 dev 模式走终端）
- 不做日志查看 UI / 上传 / 崩溃上报（只做「打开位置」）
- 不引入 async 写线程（日志量级小，同步追加 + Mutex 足够）

## 验证

1. `cargo test` — logging 模块单测：日期目录解析、7 天清理、10MB 滚动
2. `bun run build:sidecar` + 启动应用：
   - `~/Library/Logs/com.xulux.assistant/<今天>/app.log` 出现 store init / sidecar spawn 记录
   - 在对话里触发一次 sidecar 报错（或杀 sidecar）→ `pi-agent.log` 有 stderr/terminated 记录
   - DevTools console 执行 `console.error("test")` → `web.log` 出现
   - 设置 → 关于 → 日志目录「打开」→ Finder 定位到日志根目录
3. `npx tsc --noEmit` 前端类型检查
