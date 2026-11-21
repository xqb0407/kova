# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 格式，
版本号遵循 [SemVer](https://semver.org/lang/zh-CN/)。`v1.2.0` 起进入正式版轨道，
按本文件逐版维护；更早的 `v1.1.x-preview` 迭代以 git tag 与 GitHub Releases 为准。

发版口径见 [docs/versioning.md](docs/versioning.md)。

## [1.2.0] - 2026-11-21

首个开源正式版。

### Added

- 开源上线：Apache-2.0 许可、NOTICE 与第三方依赖清单（自动生成，1830 包）
- README / README_EN 中英双语界面预览（10 张真实界面截图）与社区入口（飞书交流群）
- CI 门禁：PR / push 自动跑 typecheck + sidecar 全量测试（2772 例）

### Changed

- 网页搜索默认服务改为需自行配置 key 的官方 API，移除内置第三方代理端点
- GitHub 访问加速默认直连官方源，加速改为用户显式选择（`PI_GITHUB_MIRROR` 可设分发默认）
- 仓库更名：`kova-electron` → `kova`（开发主仓与发布仓合一）

### Fixed

- git 历史抹除公司邮箱提交者身份
- NOTICE 补充 design-md 主题目录的 MIT 上游声明
- README 致谢移除已迁出仓库的 Univer / Leafer
