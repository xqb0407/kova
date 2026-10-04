#!/usr/bin/env bash
#
# rename.sh — 项目一键改名
#
# 把当前模板项目的品牌名(kova / Kova / KOVA)与内部标识(pi-kova)
# 批量替换为新名称: 文件内容、文件/目录名、tauri 显示名与 bundle id 一次改完。
# 兼容 macOS 自带 bash 3.2。
#
# 用法:
#   ./scripts/rename.sh <new-slug> [--app-name "显示名"] [--bundle-id com.x.y]
#                                  [--dir] [--dry-run] [--force] [-y]
#
#   <new-slug>        新品牌标识, 小写字母/数字/连字符, 如 myapp 或 my-app
#                     大小写联动: kova->myapp  Kova->Myapp  KOVA->MYAPP
#                     pi-kova->pi-myapp; 包名 pi-agent-sidecar/pi-protocol 不动
#   --app-name NAME   应用显示名, 替换旧 productName(默认由 slug 推导)
#   --bundle-id ID    应用标识, 替换旧 identifier(默认沿用旧 id 的域名结构换 slug)
#   --dir             同时重命名项目根目录文件夹(默认不改)
#   --dry-run         只预览, 不写入
#   --force           跳过 git 工作区干净检查
#   -y, --yes         跳过确认
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"
cd "$REPO_ROOT"

OLD_SLUG="kova"
OLD_KEBAB="pi-kova"

usage() {
  sed -n '3,25p' "$0" | sed 's/^# \{0,1\}//'
}

# ---------- 参数解析 ----------
NEW_SLUG=""
APP_NAME=""
BUNDLE_ID=""
DO_DIR=0
ASSUME_YES=0
DRY_RUN=0
FORCE=0

while [ $# -gt 0 ]; do
  case "$1" in
    --app-name)    APP_NAME="${2:---app-name 需要参数}"; shift 2 ;;
    --bundle-id)   BUNDLE_ID="${2:---bundle-id 需要参数}"; shift 2 ;;
    --dir)         DO_DIR=1; shift ;;
    --force)       FORCE=1; shift ;;
    -y|--yes)      ASSUME_YES=1; shift ;;
    --dry-run)     DRY_RUN=1; shift ;;
    -h|--help)     usage; exit 0 ;;
    -*)            echo "未知选项: $1" >&2; usage >&2; exit 1 ;;
    *)             NEW_SLUG="$1"; shift ;;
  esac
done

[ -n "$NEW_SLUG" ] || { echo "错误: 缺少 <new-slug> 参数" >&2; usage >&2; exit 1; }
case "$NEW_SLUG" in
  *[!a-z0-9-]*|-*) echo "错误: slug '$NEW_SLUG' 不合法, 只允许小写字母/数字/连字符, 且不能以 - 开头" >&2; exit 1 ;;
esac
case "$NEW_SLUG" in
  *-|[0-9]*) echo "错误: slug '$NEW_SLUG' 不能以 - 结尾或以数字开头" >&2; exit 1 ;;
esac

if [ "$NEW_SLUG" = "$OLD_SLUG" ]; then
  echo "新 slug 与当前品牌名相同, 无事可做。"
  exit 0
fi

# ---------- 派生名称 ----------
pascal() {
  printf '%s' "$1" | awk -F- '{for(i=1;i<=NF;i++) $i=toupper(substr($i,1,1)) substr($i,2)}1' OFS=''
}
upper() { printf '%s' "$1" | tr '[:lower:]-' '[:upper:]_'; }  # 连字符转下划线: UPPER 用于环境变量前缀(XULUX_*), 不允许 '-'

NEW_PASCAL="$(pascal "$NEW_SLUG")"
NEW_UPPER="$(upper "$NEW_SLUG")"
OLD_PASCAL="$(pascal "$OLD_SLUG")"
OLD_UPPER="$(upper "$OLD_SLUG")"
NEW_KEBAB="pi-$NEW_SLUG"

if [ -n "$APP_NAME" ]; then
  APP_NAME="$(printf '%s' "$APP_NAME" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')"
fi
if [ -n "$BUNDLE_ID" ]; then
  printf '%s' "$BUNDLE_ID" | grep -qE '^[A-Za-z0-9][A-Za-z0-9.-]*$' || {
    echo "错误: bundle-id '$BUNDLE_ID' 只允许字母/数字/点/连字符" >&2; exit 1; }
fi

# ---------- 扫描(内容) ----------
GREP_COMMON=( -rlI
  --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=target \
  --exclude-dir=.next --exclude-dir=out --exclude-dir=dist --exclude-dir=gen \
  --exclude=bun.lock --exclude=pnpm-lock.yaml --exclude='*.tsbuildinfo'
  --exclude=rename.sh --exclude=rename.bat --exclude=rename.ps1 \
  --exclude-dir='.rename-backup-*' )
# sessions/.zcode 是"顶层"运行数据目录: --exclude-dir 会匹配任意层级,
# 误伤 src/sessions/ 这类源码目录, 故改为扫描后按路径前缀过滤。
TOP_ONLY_EXCLUDES='^\./(sessions|\.zcode)/'

MATCH_FILES=()
while IFS= read -r f; do [ -n "$f" ] && MATCH_FILES+=("$f"); done < <(
  grep "${GREP_COMMON[@]}" -e "$OLD_SLUG" -e "$OLD_UPPER" -e "$OLD_PASCAL" -e "$OLD_KEBAB" . 2>/dev/null \
    | grep -Ev "$TOP_ONLY_EXCLUDES" | sort -u || true
)

# ---------- 扫描(路径名) ----------
FIND_PRUNE=( \( -name node_modules -o -name .git -o -name target -o -name .next
               -o -name dist -o -name scripts -o -name '.rename-backup-*' \) -prune -o )
FIND_NAMES=( \( -name "*$OLD_SLUG*" -o -name "*$OLD_UPPER*"
               -o -name "*$OLD_PASCAL*" -o -name "*$OLD_KEBAB*" \) -print )
MATCH_PATHS=()
while IFS= read -r p; do [ -n "$p" ] && MATCH_PATHS+=("$p"); done < <(
  find . "${FIND_PRUNE[@]}" "${FIND_NAMES[@]}" 2>/dev/null | sort -u || true
)

# ---------- 读取旧显示名 / 旧 bundle id ----------
OLD_PRODUCT=""
OLD_IDENTIFIER=""
if [ -f apps/desktop/src-tauri/tauri.conf.json ] && command -v node >/dev/null 2>&1; then
  OLD_PRODUCT="$(node -e 'try{process.stdout.write(require("./apps/desktop/src-tauri/tauri.conf.json").productName||"")}catch(e){}' || true)"
  OLD_IDENTIFIER="$(node -e 'try{process.stdout.write(require("./apps/desktop/src-tauri/tauri.conf.json").identifier||"")}catch(e){}' || true)"
fi

if [ -z "$APP_NAME" ]; then
  # 默认: 保留旧显示名的其余部分, 只替换品牌词 (Kova Assistant -> Myapp Assistant)
  if [ -n "$OLD_PRODUCT" ]; then
    APP_NAME="${OLD_PRODUCT/$OLD_PASCAL/$NEW_PASCAL}"
    APP_NAME="${APP_NAME/$OLD_SLUG/$NEW_SLUG}"
  else
    APP_NAME="$NEW_PASCAL"
  fi
fi
if [ -z "$BUNDLE_ID" ] && [ -n "$OLD_IDENTIFIER" ]; then
  BUNDLE_ID="${OLD_IDENTIFIER/$OLD_SLUG/$NEW_SLUG}"
fi

# 显示名 & bundle id 的具体替换目标(缺省时退回大小写规则处理)
NEW_PRODUCT="$APP_NAME"
NEW_IDENTIFIER="$BUNDLE_ID"

CUR_DIR_NAME="$(basename "$PWD")"

# ---------- 计划 ----------
echo "================================================"
echo " 项目改名计划  (仓库: $REPO_ROOT)"
echo "================================================"
echo " 品牌 slug   : $OLD_SLUG  ->  $NEW_SLUG"
echo "               $OLD_PASCAL  ->  $NEW_PASCAL"
echo "               $OLD_UPPER  ->  $NEW_UPPER"
echo " 内部 id     : $OLD_KEBAB  ->  $NEW_KEBAB"
echo " 显示名      : ${OLD_PRODUCT:-<未找到>}  ->  $NEW_PRODUCT"
echo " 应用标识    : ${OLD_IDENTIFIER:-<未找到>}  ->  ${NEW_IDENTIFIER:-<未指定>}"
echo " 内容替换    : ${#MATCH_FILES[@]} 个文件"
echo " 路径重命名  : ${#MATCH_PATHS[@]} 个"
[ "$DO_DIR" = 1 ] && echo " 根目录改名  : $CUR_DIR_NAME  ->  $NEW_SLUG"
echo "------------------------------------------------"
if [ "${#MATCH_FILES[@]}" -gt 0 ]; then
  printf '%s\n' "${MATCH_FILES[@]}" | sed 's|^\./||' | head -60
  [ "${#MATCH_FILES[@]}" -gt 60 ] && echo "  ... 及其余 $(( ${#MATCH_FILES[@]} - 60 )) 个"
fi
if [ "${#MATCH_PATHS[@]}" -gt 0 ]; then
  echo "[路径重命名]"
  printf '%s\n' "${MATCH_PATHS[@]}" | sed 's|^\./||'
fi
echo "------------------------------------------------"

if [ "$DRY_RUN" = 1 ]; then
  echo "[dry-run] 未做任何修改。"
  exit 0
fi

if [ "$ASSUME_YES" != 1 ]; then
  printf '确认执行以上改名? [y/N] '
  read -r ans || ans=""
  case "$ans" in [yY]*) ;; *) echo "已取消。"; exit 1 ;; esac
fi

# ---------- git 安全检查 ----------
if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  if [ "$FORCE" != 1 ] && [ -n "$(git status --porcelain)" ]; then
    echo "错误: git 工作区不干净。请先 commit / stash, 或用 --force 跳过此检查。" >&2
    exit 1
  fi
fi

# ---------- 备份 ----------
STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP_DIR=".rename-backup-$STAMP"
if [ "${#MATCH_FILES[@]}" -gt 0 ]; then
  mkdir -p "$BACKUP_DIR"
  for f in "${MATCH_FILES[@]}"; do
    [ -f "$f" ] || continue
    mkdir -p "$BACKUP_DIR/$(dirname "$f")"
    cp -p "$f" "$BACKUP_DIR/$f"
  done
fi

# ---------- 文件内容替换 ----------
MAC_OS=""
[ "$(uname -s)" = "Darwin" ] && MAC_OS=1

sed_escape_repl() { # 转义替换串: 先 \ 再 & 再 /
  printf '%s' "$1" | sed -e 's/[\\&/]/\\&/g'
}
apply_sed() { # file, old, new
  local file="$1" old="$2" new="$3" esc_old esc_new
  [ -n "$old" ] && [ -n "$new" ] || return 0
  [ "$old" = "$new" ] && return 0
  esc_new="$(sed_escape_repl "$new")"
  # 模式侧: 转义 \ 与 /, 其余按字面(grep 阶段已确认是普通单词)
  esc_old="$(printf '%s' "$old" | sed -e 's/[\\/]/\\&/g')"
  if [ -n "$MAC_OS" ]; then
    sed -i '' "s/$esc_old/$esc_new/g" "$file"
  else
    sed -i "s/$esc_old/$esc_new/g" "$file"
  fi
}

if [ "${#MATCH_FILES[@]}" -gt 0 ]; then
  for f in "${MATCH_FILES[@]}"; do
    [ -f "$f" ] || continue
    # 顺序: 最长串优先(整显示名、bundle id), 再 kebab, 再大小写变体
    apply_sed "$f" "$OLD_PRODUCT" "$NEW_PRODUCT"
    apply_sed "$f" "$OLD_IDENTIFIER" "$NEW_IDENTIFIER"
    apply_sed "$f" "$OLD_KEBAB" "$NEW_KEBAB"
    apply_sed "$f" "$OLD_PASCAL" "$NEW_PASCAL"
    apply_sed "$f" "$OLD_UPPER" "$NEW_UPPER"
    apply_sed "$f" "$OLD_SLUG" "$NEW_SLUG"
  done
fi

# ---------- 路径重命名(深->浅) ----------
if [ "${#MATCH_PATHS[@]}" -gt 0 ]; then
  while IFS= read -r p; do
    [ -e "$p" ] || continue
    base="$(basename "$p")"
    parent="$(dirname "$p")"
    newbase="$base"
    newbase="${newbase//$OLD_KEBAB/$NEW_KEBAB}"
    newbase="${newbase//$OLD_PASCAL/$NEW_PASCAL}"
    newbase="${newbase//$OLD_UPPER/$NEW_UPPER}"
    newbase="${newbase//$OLD_SLUG/$NEW_SLUG}"
    if [ "$newbase" != "$base" ]; then
      mv "$p" "$parent/$newbase" && echo "  mv $p -> $parent/$newbase"
    fi
  done < <(
    find . "${FIND_PRUNE[@]}" "${FIND_NAMES[@]}" 2>/dev/null \
      | awk -F/ '{print NF "\t" $0}' | sort -rn | cut -f2-
  )
fi

# ---------- 锁文件提醒 ----------
if grep -q -e "$OLD_SLUG" -e "$OLD_KEBAB" bun.lock 2>/dev/null \
   || grep -q -e "$OLD_SLUG" -e "$OLD_KEBAB" pnpm-lock.yaml 2>/dev/null; then
  echo ""
  echo "注意: bun.lock / pnpm-lock.yaml 仍含旧名称, 请运行 'bun install' 重新生成。"
fi

# ---------- 根目录改名 ----------
if [ "$DO_DIR" = 1 ]; then
  if [ -e "../$NEW_SLUG" ]; then
    echo "警告: 上级目录已存在 '$NEW_SLUG', 跳过根目录改名。" >&2
  else
    cd ..
    mv "$CUR_DIR_NAME" "$NEW_SLUG"
    echo "根目录已改名 -> $(pwd)/$NEW_SLUG"
    echo "请执行: cd \"$NEW_SLUG\""
  fi
fi

echo ""
echo "✅ 改名完成。"
if [ -n "$BACKUP_DIR" ] && [ -d "$BACKUP_DIR" ]; then
  echo "   备份在 $BACKUP_DIR/ (git 用户可 'git checkout .' 回滚, 确认无误后删除备份目录)"
fi
echo ""
echo "后续步骤:"
echo "  1) bun install                    # 重新生成锁文件"
echo "  2) 全局搜索旧名做最终核对: grep -ri '$OLD_SLUG' . --exclude-dir=node_modules"
echo "  3) 旧数据目录(如 ~/$OLD_SLUG)不会自动迁移, 新名称首启会创建新目录"
