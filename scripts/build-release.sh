#!/usr/bin/env bash
#
# build-release.sh（Electron 版）— 一键打包：依赖 → sidecar → 前端 → 主进程 → 安装包
#
# 用法（项目根目录执行，macOS 自带 bash 3.2 兼容）：
#   ./scripts/build-release.sh [--skip-install] [--check] [--dev-channel]
#
#   默认出「正式渠道」(Kova.app / com.kova.assistant)；--dev-channel 出 Kova Dev.app
#   --check 只做环境预检不构建；--skip-install 依赖已最新时跳过 bun install
#
# 产物：apps/electron/release/（或 release-dev/）下的 .dmg / .app，
#       macOS 包在打包流程里做 **ad-hoc 深签**（apps/electron/scripts/after-pack.cjs），
#       未公证 → 用户首次打开需一次 GUI 引导（与 旧桌面壳版口径一致）。
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT"

SKIP_INSTALL=0
CHECK_ONLY=0
CFG="--config"   # 参数占位，见下
BUILDER_ARGS=()
for arg in "$@"; do
  case "$arg" in
    --skip-install) SKIP_INSTALL=1 ;;
    --check) CHECK_ONLY=1 ;;
    --dev-channel) BUILDER_ARGS+=(--config electron-builder.dev.yml) ;;
    *) echo "未知参数: $arg"; exit 1 ;;
  esac
done

ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
info() { printf '  \033[36m·\033[0m %s\n' "$*"; }
fail() { printf '  \033[31m✗\033[0m %s\n' "$*"; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || fail "缺少 $1（请先安装）"; ok "$1 $(command -v "$1")"; }

echo "== 1/5 环境预检 =="
need bun
need node
need rustc   # 仅用于取 host 三元组给 sidecar 产物命名（bun --compile 不依赖 cargo）
if [[ "$(uname -s)" == "Darwin" ]]; then
  xcode-select -p >/dev/null 2>&1 || fail "缺少 Xcode Command Line Tools（node-pty 编译需要）"
  ok "Xcode CLT 就绪"
fi
[[ "$CHECK_ONLY" == "1" ]] && { echo "仅预检，结束"; exit 0; }

echo "== 2/5 依赖安装 =="
if [[ "$SKIP_INSTALL" == "1" ]]; then
  info "--skip-install：跳过"
else
  bun install
  ok "bun install 完成"
fi

echo "== 3/5 sidecar（bun --compile + ping/pong 冒烟）=="
bun run build:sidecar
ok "sidecar/automation 产物：apps/electron/binaries/kova-worker*、kova-automation*"

echo "== 4/5 前端静态导出 + 主进程 =="
bun run build:renderer   # next build → out/，并自动同步到 apps/electron/renderer-out
bun run build:main
ok "renderer-out 与 dist/ 就绪"

echo "== 5/5 打包（--dir + ad-hoc 深签 + hdiutil 出 dmg）=="
# 为什么不用 electron-builder 的 dmg target：它会额外下载 dmg 工具包
# （dmgbuild-bundle），本机到 GitHub 超时（实测 read ETIMEDOUT）；
# --dir + hdiutil 全程本地、可重复。CI（GitHub runner）网络好，两条路都行，
# 这里统一走本地路线保持一条真相。
( cd apps/electron && ./node_modules/.bin/electron-builder ${BUILDER_ARGS[@]+"${BUILDER_ARGS[@]}"} --mac dir )
OUT_DIR=release
[[ ${BUILDER_ARGS[*]:-} == *dev.yml* ]] && OUT_DIR=release-dev
APP_NAME=$([[ "$OUT_DIR" == "release-dev" ]] && echo "Kova Dev" || echo "Kova")
APP_PATH="$ROOT/apps/electron/$OUT_DIR/mac-arm64/$APP_NAME.app"
[[ -d "$APP_PATH" ]] || fail "未找到 .app 产物: $APP_PATH"

VER=$(node -p "require('$ROOT/apps/electron/package.json').version")
DMG="$ROOT/apps/electron/$OUT_DIR/${APP_NAME// /_}_${VER}_$(uname -m).dmg"
rm -f "$DMG"
hdiutil create -volname "$APP_NAME" -srcfolder "$APP_PATH" -ov -format UDZO "$DMG" >/dev/null
shasum -a 256 "$DMG" | awk '{print $1"  "$2}' > "$(dirname "$DMG")/SHA256SUMS.txt"
codesign --verify --deep --strict "$APP_PATH" && ok "ad-hoc 封印自洽（codesign --verify --deep --strict 通过）"
ok "产物: $DMG"
ok "校验和: $(dirname "$DMG")/SHA256SUMS.txt"
echo
echo "下一步（发布）：node scripts/release.mjs <版本号>  → CI 出 Draft Release"
