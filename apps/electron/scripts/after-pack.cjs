/**
 * electron-builder afterPack 钩子：macOS ad-hoc 深签。
 * 为什么不用 hardened runtime（旧桌面壳 release.md 的写法）：Electron 自己加载
 * 「Electron Framework.framework」，而 ad-hoc 签名没有 Team ID，runtime 的
 * library validation 会让 dyld 直接拒载（实测报 "different Team IDs"）。
 * 旧桌面壳没有这个问题（用的是系统 WebKit）。所以口径 = **纯 ad-hoc 深签**：
 * 封印自洽（codesign --verify --deep --strict 通过），未公证的首次打开仍需
 * 一次 GUI 引导（与旧桌面壳版一致）。
 */
const { execFileSync } = require("node:child_process");
const path = require("node:path");

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== "darwin") return;
  const appName = context.packager.appInfo.productFilename + ".app";
  const appPath = path.join(context.appOutDir, appName);
  execFileSync("codesign", ["--force", "--deep", "-s", "-", appPath], { stdio: "inherit" });
  execFileSync("codesign", ["--verify", "--deep", "--strict", appPath], { stdio: "inherit" });
  console.log(`[after-pack] ad-hoc signed + verified: ${appPath}`);
};
