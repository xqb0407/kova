# 版本管理

## 版本号规范

- [SemVer](https://semver.org/lang/zh-CN/)：`主.次.修订`，预发布阶段加
  `-preview` 后缀（如 `1.1.27-preview`）。
- 桌面端**最低系统**由 Electron 版本决定：当前 Electron 44 → **macOS 13
  Ventura** 起；macOS 安装包含 **arm64 + x64 双架构**，Windows 为 x64。
- 去掉 `-preview` 的第一个正式版即开源首个稳定版；此后按语义递增：
  破坏性变更升主版本、新能力升次版本、修复升修订号。

## 单一事实源

- **`apps/electron/package.json`** —— 打包权威来源（electron-builder 从它读
  version，产物与 Release 命名都跟随它）。
- 仓库根 `package.json` 与 `apps/desktop/package.json` 由发版脚本同步；
  **三处必须一致**，不要手改其中一处。
- `apps/mobile` 独立版本（`0.1.0`），不参与桌面发版。

## 发版流程

1. 发版内容已提交，工作区干净。
2. `node scripts/release.mjs 1.2.0 --dry-run` 预演确认；去掉 `--dry-run` 执行
   —— 自动完成：三处版本号改写 → `release: vX.Y.Z` 提交 → `vX.Y.Z` tag →
   推送当前分支与 tag。
3. tag 推送触发 `.github/workflows/release.yml`：构建 macOS dmg 与 Windows
   安装包，产物上传到 **Draft Release**（对公众不可见）。
4. 维护者检查 Draft（产物、说明、大小），确认后手动 Publish 对外发布。
5. **发布更新清单**（Cloudflare KV 存储，`dl.openkova.site` Worker 只读转发）：

   ```bash
   node scripts/publish-update.mjs --version 1.2.0 \
     --notes-file NOTES.md \
     --electron-dmg Kova_1.2.0_arm64.dmg \
     --electron-exe Kova_1.2.0_x64-setup.exe
   # 正式版默认写 stable 渠道；再跑一次加 --channel preview，
   # 让 preview 渠道的存量用户也收到升级提示
   ```

   不做这一步，应用内更新检查永远显示「已是最新」。

## 应用内更新检查（版本审计）

应用自带版本检测（设置 → 关于 → 更新）：

- **时机**：启动后静默检查（每 12 小时最多一次，节流进 kv）+ 设置页「检查更新」
  手动触发；检查失败完全静默，不打扰使用。
- **清单**：`https://dl.openkova.site/{channel}/latest.json`（Cloudflare KV 存储、
  Worker 只读转发，见独立仓 `cloudfleare/kova-update`）；渠道按当前版本号
  自动分流——含 `-preview` 走 `preview` 渠道，正式版走 `stable` 渠道，互不串扰。
  端点可被 kv `update.endpoint` 覆盖（测试与私有部署用，不用改代码）。
- **清单协议**：`version` + `downloads[platform]`（平台键
  `macos-aarch64` / `macos-x64` / `windows-x64` / `linux-x64`）+ `pageUrl`。
- **安装动作**：发现新版本 → 应用内提示；`update_install` 打开对应平台下载
  直链（不做原地替换），下载安装由用户完成。
- **实现**：`apps/electron/main/update.ts`（清单拉取/节流/缓存）。

## 版本与依赖审计

- **版本一致性**：`bun run check:versions`（root / desktop / electron 三处
  必须一致，`--fix` 以 apps/electron 为准自动回写）；已纳入 `verify:goal`。
- **依赖漏洞审计**：仓库已开启 **Dependabot 漏洞告警 + 自动安全修复**——
  有漏洞依赖时 GitHub 自动在 Security 页告警并开修复 PR。本地 `bun audit`
  需临时切官方源（当前 npmmirror 镜像无审计端点）。

## 当前策略

- **安装包随正式版对外发布**（GitHub Releases）；预览迭代回到 `-preview`
  后缀走 preview 渠道，正式版走 stable 渠道。
- 合入 `main` 走 PR + 分支保护（禁强推、禁删除）。
- [CHANGELOG.md](../CHANGELOG.md) 逐版维护；发版时把 `[Unreleased]` 改写为
  带日期的版本节。
