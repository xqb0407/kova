#!/usr/bin/env bash
#
# build-release.sh — 一键打包(依赖安装 → sidecar → 前端 → 安装包)
#
# 在项目根目录执行 ./scripts/build-release.sh;Windows 用 build-release.bat。
# 兼容 macOS 自带 bash 3.2。
#
# 用法:
#   ./scripts/build-release.sh [选项]
#
#   --skip-install   跳过 bun install(依赖已是最新时)
#   --debug          产出 debug 包(tauri build --debug,编译快,仅自测用)
#   --allow-dev      检测到正在运行的开发服务时仍然继续
#   --check          只做环境预检,不构建
#
# 阶段(共 5 步):
#   1. 预检    工具链(bun/cargo/rustc、Xcode CLT)与运行中的 dev
#   2. 依赖    bun install(全部 workspace,含 plugins/*)
#   3. sidecar bun run build:sidecar → src-tauri/binaries/pi-agent-<triple>
#   4. 前端    bun run build(Next.js 静态导出 → apps/desktop/out)
#   5. 打包    tauri build(3/4 已完成,故跳过其 beforeBuildCommand 免重复构建)
#
# 产物: apps/desktop/src-tauri/target/release/bundle/
#   macOS → .dmg / .app;Linux → .deb / .AppImage;Windows 请用 .bat(.msi/.exe)
# 注意: 打包≠发布。发版(同步版本号+打 tag+推送远端)是另一条命令:
#   node scripts/release.mjs <版本号>
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"
cd "$REPO_ROOT"

usage() { sed -n '3,25p' "$0" | sed 's/^# \{0,1\}//'; }

SKIP_INSTALL=0
BUILD_DEBUG=0
ALLOW_DEV=0
CHECK_ONLY=0

while [ $# -gt 0 ]; do
  case "$1" in
    --skip-install) SKIP_INSTALL=1; shift ;;
    --debug)        BUILD_DEBUG=1; shift ;;
    --allow-dev)    ALLOW_DEV=1; shift ;;
    --check)        CHECK_ONLY=1; shift ;;
    -h|--help)      usage; exit 0 ;;
    *) echo "未知选项: $1" >&2; usage >&2; exit 1 ;;
  esac
done

step() { printf '\n\033[1;36m==> %s\033[0m\n' "$1"; }
ok()   { printf '\033[1;32m✔ %s\033[0m\n' "$1"; }
die()  { printf '\033[1;31m✗ %s\033[0m\n' "$1" >&2; exit "${2:-1}"; }

# ---------- 1. 预检 ----------
step "1/5 环境预检"
OS="$(uname -s)"

need() { command -v "$1" >/dev/null 2>&1 || die "缺少工具: $1 —— 安装方法见 README「环境要求」"; }
need bun
need cargo
need rustc

HOST_TRIPLE="$(rustc -vV | sed -n 's/^host: //p')"
[ -n "$HOST_TRIPLE" ] || die "取不到 rustc host triple"
ok "rust 工具链就绪($HOST_TRIPLE)"

case "$OS" in
  Darwin)
    xcode-select -p >/dev/null 2>&1 || die "未安装 Xcode 命令行工具: xcode-select --install"
    ok "Xcode CLT 就绪"
    ;;
  Linux)
    need cc
    ok "Linux 构建链就绪(若缺 webkit2gtk 等系统库,tauri build 会报 pkg-config 错)"
    ;;
  *)
    die "不支持的平台: $OS —— Windows 请运行 scripts/build-release.bat"
    ;;
esac

# 运行中的 dev 会与打包抢 cargo 锁、并且 next build 会重写 .next 目录
if [ "$ALLOW_DEV" != 1 ]; then
  DEV_PIDS="$(pgrep -f 'tauri dev|src-tauri/target/debug|next dev|next-server' 2>/dev/null || true)"
  if [ -n "$DEV_PIDS" ]; then
    echo "检测到正在运行的开发服务:" >&2
    # shellcheck disable=SC2086
    ps -o pid=,command= -p $(echo "$DEV_PIDS" | tr ' ' ',' | cut -c1-200) 2>/dev/null | head -5 >&2
    die "请先停掉 dev(bun run tauri:dev / bun run dev)再打包;确需继续请加 --allow-dev" 2
  fi
fi

if [ "$CHECK_ONLY" = 1 ]; then
  ok "预检通过(--check 未执行构建)"
  exit 0
fi

# ---------- 2. 依赖 ----------
if [ "$SKIP_INSTALL" = 1 ]; then
  step "2/5 依赖安装(已跳过 --skip-install)"
else
  step "2/5 依赖安装 bun install"
  bun install || die "bun install 失败"
fi

# ---------- 3. sidecar ----------
step "3/5 构建 sidecar(pi-agent)"
bun run build:sidecar || die "sidecar 构建失败"
SIDECAR_BIN="apps/desktop/src-tauri/binaries/pi-agent-$HOST_TRIPLE"
[ -f "$SIDECAR_BIN" ] || die "未找到 sidecar 产物: $SIDECAR_BIN(tauri build 依赖它)"
ok "sidecar 就绪: $SIDECAR_BIN"

# ---------- 4. 前端 ----------
step "4/5 构建前端(next build)"
bun run build || die "前端构建失败"
[ -d "apps/desktop/out" ] || die "未找到前端产物 apps/desktop/out"
ok "前端就绪: apps/desktop/out"

# ---------- 5. 打包 ----------
step "5/5 打包(tauri build,首次约数分钟)"
# 3/4 已显式完成,置空 beforeBuildCommand 避免 npm 再跑一遍(双份耗时)
PROF="release"
TAURI_ARGS=(build --config '{"build":{"beforeBuildCommand":""}}')
if [ "$BUILD_DEBUG" = 1 ]; then
  TAURI_ARGS+=(--debug)
  PROF="debug"
fi
TAURI_BIN="$REPO_ROOT/apps/desktop/node_modules/.bin/tauri"
if [ ! -x "$TAURI_BIN" ]; then
  need bunx
  ( cd apps/desktop && bunx tauri "${TAURI_ARGS[@]}" ) || die "tauri build 失败"
else
  ( cd apps/desktop && "$TAURI_BIN" "${TAURI_ARGS[@]}" ) || die "tauri build 失败"
fi

# ---------- 产物 ----------
step "完成: 安装包产物"
BUNDLE_DIR="apps/desktop/src-tauri/target/$PROF/bundle"
if [ -d "$BUNDLE_DIR" ]; then
  find "$BUNDLE_DIR" -maxdepth 3 \
    \( -name '*.dmg' -o -name '*.app' -o -name '*.msi' -o -name '*.exe' \
       -o -name '*.deb' -o -name '*.AppImage' -o -name '*.rpm' \) -print
  printf '\n产物目录: %s\n' "$BUNDLE_DIR"
else
  printf '\033[1;33m未找到 bundle 目录: %s(请检查上方 tauri 输出)\033[0m\n' "$BUNDLE_DIR" >&2
  exit 1
fi

cat <<'TIP'

下一步:
  · 本地自测:   open 产物里的 .app(或双击 .dmg 安装)
  · 正式发版:   node scripts/release.mjs <版本号>   # 同步版本号 + git tag + 推送远端
  · dev 与正式版数据已隔离: 正式版 identifier 为 com.kova.assistant,
    dev(经 tauri:dev)为 com.kova.assistant.dev,互不覆盖、卸载互不影响。
TIP
