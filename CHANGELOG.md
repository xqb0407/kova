# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 格式，
版本号遵循 [SemVer](https://semver.org/lang/zh-CN/)。`v1.2.0` 起进入正式版轨道，
按本文件逐版维护；更早的 `v1.1.x-preview` 迭代以 git tag 与 GitHub Releases 为准。

发版口径见 [docs/versioning.md](docs/versioning.md)。

## [1.2.2] - 2026-11-21

### Added

- 自定义搜索服务支持 **JSON 整段配置**与 **cURL 一键导入**(带 schema 与解析器单测)
- 自定义 API 的 `resultsPath` 支持**字符串化 JSON 数组**双层解包——
  兼容 deepcode 等聚合网关的 `{"result":"[{…}]"}` 形态(实测可用)

### Changed

- Key 行按需显示并动态提示注入位置：模板引用 `{{apiKey}}` 时才出现凭据输入，
  并提示 Key 会注入到 URL / 请求头 / 请求体
- 请求体模板与 Headers 输入固定宽度；校验失败时检测全角标点并给出专门提示

### Fixed

- run_code 工具描述的并行工具清单按实际可用动态生成——WebSearch 关闭后
  不再在提示词里宣称它存在

## [1.2.1] - 2026-11-21

### Added

- 中国风主题五款（青花瓷 / 水墨 / 大漆描金 / 青瓷开片 / 莫文竹）与内置壁纸
- 主题导入升级：JSON 编辑器、`$schema` 校验、一键回填当前主题
- macOS **Intel（x64）安装包**——此前仅 Apple Silicon；最低系统显式声明为
  macOS 13 Ventura（由 Electron 44 决定），arm64 + x64 双架构分发

### Fixed

- 把手 / 灵感面板 / 收件箱动作跟随主题令牌

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
