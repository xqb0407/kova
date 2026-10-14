#!/usr/bin/env bash
#
# rename.sh — 把项目改成新的产品名 / bundle id（Electron 版）。
#
# 用法：
#   ./scripts/rename.sh <new-slug> [--app-name "显示名"] [--bundle-id com.x.y] [--dry-run]
#
# 例：
#   ./scripts/rename.sh kova2 --app-name "扣瓦二代" --bundle-id com.kova2.assistant --dry-run
#
# 改写范围（只动这些文件，其余代码不碰）：
#   apps/electron/electron-builder.yml      productName / appId
#   apps/electron/electron-builder.dev.yml  productName "<名> Dev" / appId "<id>.dev"
#   apps/electron/main/paths.ts             运行期 identifier（正式/ dev 两处）与应用显示名
#   apps/electron/main/window.ts            窗口标题
#   scripts/publish-update.mjs              --repo 默认值（owner/<slug>）
#   README.md                               首行标题
#
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]:-$0}")/.."

SLUG=""; APP_NAME=""; BUNDLE_ID=""; DRY=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --app-name)  APP_NAME="${2:?缺少参数}"; shift 2 ;;
    --bundle-id) BUNDLE_ID="${2:?缺少参数}"; shift 2 ;;
    --dry-run)   DRY=1; shift ;;
    -*) echo "未知参数: $1" >&2; exit 1 ;;
    *)  SLUG="$1"; shift ;;
  esac
done
[[ -n "$SLUG" ]] || { echo "用法: ./scripts/rename.sh <new-slug> [--app-name 显示名] [--bundle-id com.x.y] [--dry-run]"; exit 1; }
[[ "$SLUG" =~ ^[a-z0-9][a-z0-9._-]*$ ]] || { echo "slug 只允许小写字母/数字/.-_" >&2; exit 1; }

# 读取当前值作为替换源
OLD_PRODUCT=$(grep -m1 -E "^productName:" apps/electron/electron-builder.yml | sed -E 's/^productName:[[:space:]]*//')
OLD_ID=$(grep -m1 -E "^appId:" apps/electron/electron-builder.yml | sed -E 's/^appId:[[:space:]]*//')
[[ -n "$OLD_PRODUCT" && -n "$OLD_ID" ]] || { echo "读不到 electron-builder.yml 的 productName/appId" >&2; exit 1; }
APP_NAME="${APP_NAME:-$OLD_PRODUCT}"
BUNDLE_ID="${BUNDLE_ID:-$(echo "$OLD_ID" | sed -E "s/\\.[a-z0-9-]+$/.$SLUG/")}"
OLD_REPO=$(grep -m1 -oE '"xqb0407/[a-z0-9-]+"' scripts/publish-update.mjs | tr -d '"' || true)

echo "产品名:   $OLD_PRODUCT → ${APP_NAME}（dev 包: $APP_NAME Dev）"
echo "bundleId: $OLD_ID → ${BUNDLE_ID}（dev: $BUNDLE_ID.dev）"
[[ -n "$OLD_REPO" ]] && echo "仓库默认: $OLD_REPO → owner/$SLUG"
[[ "$DRY" == "1" ]] && { echo "（dry-run，未写入）"; exit 0; }

# electron-builder 两份配置
perl -pi -e "s/^productName: .*/productName: $APP_NAME/; s/^appId: .*/appId: $BUNDLE_ID/" apps/electron/electron-builder.yml
perl -pi -e "s/^productName: .*/productName: $APP_NAME Dev/; s/^appId: .*/appId: $BUNDLE_ID.dev/" apps/electron/electron-builder.dev.yml
# 运行期：identifier 两处 + 显示名
perl -pi -e "s/com\.kova\.assistant\.dev/$BUNDLE_ID.dev/g; s/com\.kova\.assistant/$BUNDLE_ID/g; s/app\.setName\(isDevRun \? \".*?\" : \".*?\"\)/app.setName(isDevRun ? \"$APP_NAME Dev\" : \"$APP_NAME\")/" apps/electron/main/paths.ts
# 窗口标题
perl -pi -e "s/title: \"扣瓦\"/title: \"$APP_NAME\"/g" apps/electron/main/window.ts
# 发版仓库默认值
[[ -n "$OLD_REPO" ]] && perl -pi -e "s{\Q$OLD_REPO\E}{$(dirname "$OLD_REPO")/$SLUG}g" scripts/publish-update.mjs
# README 标题
perl -pi -e "s/^# .*/# $SLUG/" README.md
echo "✓ 改名完成；建议接着跑：bun run build && ./scripts/build-release.sh --check"
