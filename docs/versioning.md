# 版本管理

## 版本号规范

- [SemVer](https://semver.org/lang/zh-CN/)：`主.次.修订`，预发布阶段加
  `-preview` 后缀（如 `1.1.27-preview`）。
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

## 当前策略

- **安装包暂不对外发布**：Draft 只进不出，Publish 时机由维护者决定。
- 合入 `main` 需 CI `verify` 通过（分支保护：禁强推、禁删除、必需状态检查）。
- [CHANGELOG.md](../CHANGELOG.md) 自首个正式版起逐版维护；`preview` 阶段以
  git tag 粒度记录。
