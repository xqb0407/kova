#!/usr/bin/env bash
#
# 打一个可自签安装的 iOS Release IPA（给 i4/爱思助手等工具重签名用）。
#
# 为什么不用 `xcodebuild archive`：
#   本机 Xcode 26 只装了 iPhoneOS SDK，没装 iOS 平台组件（8.4GB）——
#   `archive` 会因 destination 不可用直接失败；即使绕过 destination，
#   ibtool 编译启动图 storyboard 时也会报 "iOS 26.2 Platform Not Installed"。
#   所以这里走两件事：
#     1) 用 `-project -target`（不经 scheme/destination 解析）构建 Release；
#     2) 把启动图从 storyboard 换成 `UILaunchScreen` 字典（iOS 官方支持，
#        不需要 ibtool），仅作用于本地产物。
#   装好平台组件后，可以改回标准的 archive 流程（启动图的品牌化恢复）。
#
# 产物：apps/mobile/build/kova-mobile-<version>.ipa（未签名）。
# 安装：i4/爱思助手 → 我的设备 → 安装（它会用你的 Apple ID 自签，7 天有效）。
set -euo pipefail

cd "$(dirname "$0")/.."
APP_DIR="$(pwd)"
IOS_DIR="$APP_DIR/ios"
BUILD_DIR="$APP_DIR/build"
SCHEME_TARGET="app"

if [ ! -d "$IOS_DIR" ]; then
  echo "==> 没有 ios/ 原生工程，先 prebuild"
  bunx expo prebuild --platform ios --no-install
  (cd "$IOS_DIR" && pod install)
fi

echo "==> 启动图改走 UILaunchScreen（绕开 ibtool/平台组件依赖）"
python3 - "$IOS_DIR" <<'PY'
import re, sys, pathlib
ios = pathlib.Path(sys.argv[1])
proj = ios / "app.xcodeproj" / "project.pbxproj"
s = proj.read_text()
if "SplashScreen.storyboard" in s:
    # 1) 去掉 Resources 构建阶段里的 storyboard 构建条目
    s = re.sub(r'\n\t\t[0-9A-F]{24} /\* SplashScreen\.storyboard in Resources \*/ = \{[^}]*\};', '', s)
    s = re.sub(r'\n\t\t\t\t[0-9A-F]{24} /\* SplashScreen\.storyboard in Resources \*/,', '', s)
    # 2) 去掉文件引用与分组条目
    s = re.sub(r'\n\t\t[0-9A-F]{24} /\* SplashScreen\.storyboard \*/ = \{[^}]*\};', '', s)
    s = re.sub(r'\n\t\t\t\t[0-9A-F]{24} /\* SplashScreen\.storyboard \*/,', '', s)
    proj.write_text(s)
    print("   pbxproj: 已移除 storyboard 引用")
else:
    print("   pbxproj: 无 storyboard 引用（幂等跳过）")

plist = ios / "app" / "Info.plist"
p = plist.read_text()
changed = False
if "UILaunchStoryboardName" in p:
    p = re.sub(r'\t<key>UILaunchStoryboardName</key>\n\t<string>[^<]*</string>\n', '', p)
    changed = True
if "UILaunchScreen" not in p:
    anchor = "\t<key>UIRequiredDeviceCapabilities</key>"
    add = "\t<key>UILaunchScreen</key>\n\t<dict/>\n"
    p = p.replace(anchor, add + anchor, 1) if anchor in p else p.replace("</dict>", add + "</dict>", 1)
    changed = True
if changed:
    plist.write_text(p)
    print("   Info.plist: UILaunchScreen 字典已就位（移除 UILaunchStoryboardName）")
PY

echo "==> Release 构建（免签名）"
rm -rf "$BUILD_DIR/ios"
mkdir -p "$BUILD_DIR/ios"
xcodebuild \
  -project "$IOS_DIR/app.xcodeproj" \
  -target "$SCHEME_TARGET" \
  -configuration Release \
  -sdk iphoneos \
  CONFIGURATION_BUILD_DIR="$BUILD_DIR/ios" \
  CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO \
  CODE_SIGN_IDENTITY="" CODE_SIGN_ENTITLEMENTS="" \
  ONLY_ACTIVE_ARCH=NO \
  > "$BUILD_DIR/xcodebuild.log" 2>&1 || {
    echo "!! xcodebuild 失败，最后 40 行：" >&2
    tail -40 "$BUILD_DIR/xcodebuild.log" >&2
    exit 1
  }

APP_PATH="$BUILD_DIR/ios/app.app"
if [ ! -d "$APP_PATH" ]; then
  echo "!! 构建产物不在 $APP_PATH —— 看上面的 xcodebuild 输出" >&2
  exit 1
fi

echo "==> 打 IPA（Payload 结构；未签名，留给 i4 自签）"
VERSION="$(python3 -c "import json;print(json.load(open('app.json'))['expo']['version'])")"
rm -rf "$BUILD_DIR/payload" "$BUILD_DIR"/*.ipa
mkdir -p "$BUILD_DIR/payload/Payload"
cp -R "$APP_PATH" "$BUILD_DIR/payload/Payload/"
(cd "$BUILD_DIR/payload" && zip -qry "$BUILD_DIR/kova-mobile-$VERSION.ipa" Payload)
rm -rf "$BUILD_DIR/payload"
echo "==> 完成：$BUILD_DIR/kova-mobile-$VERSION.ipa"
ls -lh "$BUILD_DIR/kova-mobile-$VERSION.ipa"
