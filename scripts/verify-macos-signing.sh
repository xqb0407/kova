#!/usr/bin/env bash
#
# verify-macos-signing.sh — macOS 安装包签名态校验(本地打包与 CI 共用一把尺子)
#
# 用法:
#   ./scripts/verify-macos-signing.sh [选项] <Kova.app|Kova_*.dmg> [...]
#
#   --expect <any|signed|unsigned>  期望态(默认 any:只报告;不满足期望则退出码 1)
#   --require-notarized             在 signed 之上再要求公证(Developer ID+spctl+staple)
#   --quiet                         只输出结论行
#   -h, --help                      显示本帮助
#
# 为什么需要它(2026-10-12 实证):
#   macOS 把「签名封印不自洽」和「没签名」都判成「已损坏,应该移到废纸篓」——
#   /Applications/Kova.app 的 codesign --verify 报
#   "code has no resources but signature indicates they must be present",
#   用户侧唯一出路是终端 xattr,对非开发者等于死路。所以发版前必须确认:
#     ① bundle 有 _CodeSignature/CodeResources(封印落地)
#     ② codesign --verify --deep --strict 通过(封印自洽)
#     ③ Contents/MacOS/* 每个可执行文件都签了(含 sidecar pi-agent)
#     ④ hardened runtime + JIT entitlements 齐(缺 allow-jit 应用"启动即死")
#   拿到 Developer ID 后追加:
#     ⑤ spctl accepted(source=Notarized Developer ID)
#     ⑥ xcrun stapler validate 通过(.app 与 .dmg 各自)
#
# .dmg 会**挂载后校验里面的 .app**——旧桌面壳 打完 dmg 就删掉 bundle/macos/*.app,
# 用户拿到的其实是 dmg 里那份,只查 dmg 文件本身等于没查。
#
# 退出码: 0 满足期望;1 校验不通过;2 用法错误
#
set -euo pipefail

EXPECT=any
REQUIRE_NOTARIZED=0
QUIET=0
ARTIFACTS=()

usage() { sed -n '3,32p' "$0" | sed 's/^# \{0,1\}//'; }

while [ $# -gt 0 ]; do
  case "$1" in
    --expect)            EXPECT="${2:-}"; shift 2 ;;
    --expect=*)          EXPECT="${1#*=}"; shift ;;
    --require-notarized) REQUIRE_NOTARIZED=1; shift ;;
    --quiet)             QUIET=1; shift ;;
    -h|--help)           usage; exit 0 ;;
    -*)                  echo "未知选项: $1" >&2; usage >&2; exit 2 ;;
    *)                   ARTIFACTS+=("$1"); shift ;;
  esac
done

if [ "${#ARTIFACTS[@]}" -eq 0 ]; then
  echo "至少给一个 .app 或 .dmg 路径" >&2
  usage >&2
  exit 2
fi
case "$EXPECT" in any|signed|unsigned) ;; *) echo "非法 --expect: $EXPECT" >&2; exit 2 ;; esac

say() { [ "$QUIET" = 1 ] || printf '%s\n' "$1"; }
ok()  { [ "$QUIET" = 1 ] || printf '  \033[1;32m✔\033[0m %s\n' "$1"; }
bad() { printf '  \033[1;31m✗\033[0m %s\n' "$1"; PROBLEMS=$((PROBLEMS + 1)); }

PROBLEMS=0
MODES=""
MOUNT_POINT=""

cleanup() {
  if [ -n "$MOUNT_POINT" ] && [ -d "$MOUNT_POINT" ]; then
    hdiutil detach "$MOUNT_POINT" -quiet >/dev/null 2>&1 || hdiutil detach "$MOUNT_POINT" -force -quiet >/dev/null 2>&1 || true
    rmdir "$MOUNT_POINT" 2>/dev/null || true
    MOUNT_POINT=""
  fi
}
trap cleanup EXIT

# 签名态:unsigned / adhoc / developer-id / unknown
mode_of() {
  local path="$1" dv=""
  if ! dv="$(codesign -dv --verbose=4 "$path" 2>&1)"; then
    echo unsigned
    return
  fi
  case "$dv" in
    *"Authority=Developer ID Application"*) echo developer-id ;;
    *adhoc*)                                echo adhoc ;;
    *)                                      echo unknown ;;
  esac
}

# 编译进 app 的运行时(bun/JSC、wasm、脚本沙箱 eval)在 hardened runtime 下必须有的权限
check_entitlements() {
  local app="$1" ent=""
  ent="$(codesign -d --entitlements :- "$app" 2>/dev/null || true)"
  case "$ent" in
    *allow-jit*) ok "entitlements 含 allow-jit(bun/JSC 的 JIT)" ;;
    *)           bad "entitlements 缺 allow-jit —— hardened runtime 下 sidecar 起来就死" ;;
  esac
  case "$ent" in
    *allow-unsigned-executable-memory*) ok "entitlements 含 allow-unsigned-executable-memory(wasm 截图 / worker eval)" ;;
    *)                                  bad "entitlements 缺 allow-unsigned-executable-memory —— screenshot_doc / run_design_script 会挂" ;;
  esac
}

verify_app() {
  local app="$1" mode="$2" label="${3:-.app}"
  say "== ${label}: ${app}（签名态: ${mode}）"

  if [ -f "$app/Contents/_CodeSignature/CodeResources" ]; then
    ok "bundle 封印存在(_CodeSignature/CodeResources)"
  else
    bad "bundle 无封印(_CodeSignature/CodeResources 缺失)—— quarantine 下必判「已损坏」"
  fi

  if codesign --verify --deep --strict "$app" >/dev/null 2>&1; then
    ok "codesign --verify --deep --strict 通过"
  else
    bad "codesign --verify --deep --strict 失败:$(codesign --verify --deep --strict "$app" 2>&1 | head -2 | tr '\n' ' ')"
  fi

  local exe unsigned_exes=""
  for exe in "$app"/Contents/MacOS/*; do
    [ -e "$exe" ] || continue
    if ! codesign -dv "$exe" >/dev/null 2>&1; then
      unsigned_exes="${unsigned_exes} $(basename "$exe")"
    fi
  done
  if [ -z "$unsigned_exes" ]; then
    ok "Contents/MacOS/* 全部有签名(含 sidecar pi-agent)"
  else
    bad "可执行文件未签名:${unsigned_exes}"
  fi

  local dv=""
  dv="$(codesign -dv --verbose=4 "$app" 2>&1 || true)"
  case "$dv" in
    *runtime*) ok "hardened runtime 已启用" ;;
    *)         bad "未启用 hardened runtime(之后接 Developer ID 公证时必须有)" ;;
  esac

  [ "$mode" = unsigned ] || check_entitlements "$app"

  if [ "$mode" = developer-id ]; then
    if spctl -a -vvv --type execute "$app" 2>&1 | grep -q 'accepted'; then
      ok "spctl: accepted"
    else
      bad "spctl 未 accepted:$(spctl -a -vvv --type execute "$app" 2>&1 | head -2 | tr '\n' ' ')"
    fi
    if xcrun stapler validate "$app" >/dev/null 2>&1; then
      ok "stapler validate 通过(公证票据已 staple)"
    else
      bad "stapler validate 失败 —— 公证票据没贴上,离网设备仍会被拦"
    fi
  elif [ "$REQUIRE_NOTARIZED" = 1 ]; then
    bad "要求公证,但签名态是 $mode(需要 Developer ID Application 证书)"
  fi
}

verify_dmg() {
  local dmg="$1"
  # 结果走全局变量而不是 stdout：本函数还要往 stdout 打报告，混在一起只能靠
  # `| tail -1` 之类的约定去区分，早晚出错
  DMG_APP_MODE="unknown"
  say "== .dmg: ${dmg}"

  if hdiutil verify "$dmg" >/dev/null 2>&1; then
    ok "hdiutil verify 通过(镜像未损坏)"
  else
    bad "hdiutil verify 失败 —— 镜像本身损坏,用户会看到「已损坏」"
  fi

  # 旧桌面壳 出完 dmg 会删掉 bundle 里的 .app:用户实际安装的是 dmg 里这份,
  # 所以必须挂上去查它(只查 dmg 文件等于没查签名)
  MOUNT_POINT="$(mktemp -d)"
  if ! hdiutil attach "$dmg" -readonly -nobrowse -noautoopen -mountpoint "$MOUNT_POINT" >/dev/null 2>&1; then
    bad "dmg 挂载失败(挂不上就无法校验里面的 app)"
    cleanup
    return
  fi

  local inner_app="" app_count=0
  for cand in "$MOUNT_POINT"/*.app; do
    [ -d "$cand" ] || continue
    inner_app="$cand"
    app_count=$((app_count + 1))
  done
  if [ "$app_count" != 1 ]; then
    bad "dmg 里应恰好有一个 .app(实际 ${app_count} 个)"
    cleanup
    return
  fi

  local inner_mode inner_size
  inner_mode="$(mode_of "$inner_app")"
  inner_size="$(du -sh "$inner_app" 2>/dev/null | cut -f1)"
  verify_app "$inner_app" "$inner_mode" "dmg 内 .app（${inner_size:-?}）"
  DMG_APP_MODE="$inner_mode"

  if [ "$inner_mode" = developer-id ] && [ "$REQUIRE_NOTARIZED" = 1 ]; then
    if spctl -a -vvv --type install "$dmg" 2>&1 | grep -q 'accepted'; then
      ok "dmg 的 spctl(install): accepted"
    else
      bad "dmg 的 spctl(install) 未 accepted —— 公证过 dmg 才算数"
    fi
    if xcrun stapler validate "$dmg" >/dev/null 2>&1; then
      ok "dmg 的 stapler validate 通过"
    else
      bad "dmg 的 stapler validate 失败"
    fi
  fi

  cleanup
}

for art in "${ARTIFACTS[@]}"; do
  [ -e "$art" ] || { echo "路径不存在: $art" >&2; exit 2; }
  case "$art" in
    *.app)
      mode="$(mode_of "$art")"
      MODES="$MODES $mode"
      verify_app "$art" "$mode"
      ;;
    *.dmg)
      verify_dmg "$art"
      MODES="$MODES $DMG_APP_MODE"
      ;;
    *)
      bad "不认识的产物类型(要 .app 或 .dmg): $art"
      ;;
  esac
done

# ---------- 期望态判定 ----------
VERDICT=0
case "$EXPECT" in
  any)
    # any:只把"结构性坏掉"(封印不自洽/镜像损坏)当失败 —— 那正是用户看到「已损坏」的原因
    [ "$PROBLEMS" = 0 ] || VERDICT=1
    ;;
  unsigned)
    case "$MODES" in *adhoc*|*developer-id*) VERDICT=1 ;; esac
    ;;
  signed)
    case "$MODES" in *unsigned*|*unknown*) VERDICT=1 ;; esac
    [ "$PROBLEMS" = 0 ] || VERDICT=1
    ;;
esac

say ""
# 有 ✗ 项时"结论"必须让位给失败原因,否则会给出与实际相反的判断(旧产物正是这种情况:
# 它带着链接器裸签名,签名态看着像 adhoc,封印却是坏的)
if [ "$PROBLEMS" != 0 ]; then
  printf '\033[1;31m结论:校验未通过(见上方 ✗ 项)。\033[0m\n' >&2
  printf '      封印不自洽的包在浏览器下载场景下会被 macOS 判「已损坏」——先修构建链(见 docs/release.md「常见问题」),别发出去。\n' >&2
  exit 1
fi

NOTARIZED_TAG=""
[ "$REQUIRE_NOTARIZED" = 1 ] && NOTARIZED_TAG=" + 公证"
case "$MODES" in
  *developer-id*)
    say "结论:Developer ID 签名${NOTARIZED_TAG} —— 用户可以双击直接打开,无需任何手动步骤" ;;
  *adhoc*)
    say "结论:ad-hoc 签名(无证书)且封印自洽 —— 不再是「已损坏」死胡同,但用户首次仍需"
    say "      走一次 系统设置 → 隐私与安全性 →「仍要打开」;指引见 docs/macos-first-open.md" ;;
  *)
    say "结论:未签名。浏览器下载(quarantine)后 macOS 会判「已损坏」,"
    say "      用户只能靠终端 xattr——非开发者不可用。至少执行一次 scripts/ 里的打包以落 ad-hoc 签名。" ;;
esac

if [ "$VERDICT" != 0 ]; then
  say ""
  printf '\033[1;31m产物状态不满足 --expect %s\033[0m\n' "$EXPECT" >&2
fi
exit "$VERDICT"
