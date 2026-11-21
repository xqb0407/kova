/**
 * electron-builder afterPack 钩子，两件事：
 *
 * 1.（全平台）sidecar 二进制打包断言。宿主只按稳定别名拉起 sidecar
 *    （kova-worker / kova-automation，见 main/pi-agent.ts 与
 *    main/automation-service.ts 的 candidates）；带 host 三元组的那份是构建/
 *    冒烟中间产物，extraResources 的 !kova-*-filter 负责把它挡在包外——
 *    否则一份 ~90-100MB 的二进制背两遍，压缩后每个仍多 ~40MB（mac dmg
 *    实测 +87MB）。这里兜底防回归：三元组副本再次出现、或别名没进包，
 *    直接 fail 打包，而不是默默背着一堆死重量发版。
 * 2.（仅 macOS）ad-hoc 深签。为什么不用 hardened runtime（旧桌面壳
 *    release.md 的写法）：Electron 自己加载「Electron Framework.framework」，
 *    而 ad-hoc 签名没有 Team ID，runtime 的 library validation 会让 dyld
 *    直接拒载（实测报 "different Team IDs"）。旧桌面壳没有这个问题（用的是
 *    系统 WebKit）。所以口径 = **纯 ad-hoc 深签**：封印自洽（codesign
 *    --verify --deep --strict 通过），未公证的首次打开仍需一次 GUI 引导
 *    （与旧桌面壳版一致）。
 */
const { execFileSync } = require("node:child_process");
const { chmodSync, existsSync, readdirSync } = require("node:fs");
const path = require("node:path");

/** 宿主实际拉起的 sidecar 稳定别名；新增 sidecar 时同步维护这份清单 */
const SIDECAR_ALIASES = ["kova-worker", "kova-automation"];

/**
 * node-pty 的 spawn-helper 经 asar 解包后丢失可执行位——上游 npm 包里
 * prebuilds 目录下的 spawn-helper 就是 644，而 macOS 的 PTY 派生要 exec
 * 这个 helper：没有 x 位，终端面板直接报 posix_spawnp failed。解包后统一
 * 补执行权限（仅 darwin 的 prebuilds 里有这个文件）。
 */
function fixSpawnHelperPerms(context) {
  const resources =
    context.electronPlatformName === "darwin"
      ? path.join(
          context.appOutDir,
          context.packager.appInfo.productFilename + ".app",
          "Contents",
          "Resources",
        )
      : path.join(context.appOutDir, "resources");
  const nodePtyDir = path.join(
    resources,
    "app.asar.unpacked",
    "node_modules",
    "node-pty",
  );
  if (!existsSync(nodePtyDir)) return;
  let fixed = 0;
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.name === "spawn-helper") {
        chmodSync(p, 0o755);
        fixed += 1;
      }
    }
  };
  walk(nodePtyDir);
  if (fixed > 0) console.log(`[after-pack] spawn-helper 执行权限已补: ${fixed} 处`);
}

function checkPackagedBinaries(context) {
  const binariesDir = path.join(
    context.packager.getResourcesDir(context.appOutDir),
    "binaries",
  );
  let entries;
  try {
    entries = readdirSync(binariesDir).filter((name) => !name.startsWith("."));
  } catch {
    throw new Error(
      `[after-pack] binaries 目录没进包：${binariesDir}。` +
        `检查 electron-builder extraResources 的 binaries 配置`,
    );
  }
  // 别名带 .exe 仅在 Windows 目标上（与 build-sidecar 的 aliasExt 同口径）
  const exeSuffix = context.electronPlatformName === "win32" ? ".exe" : "";
  const missing = SIDECAR_ALIASES.filter(
    (alias) => !entries.includes(alias + exeSuffix),
  );
  if (missing.length > 0) {
    throw new Error(
      `[after-pack] 宿主要拉起的 sidecar 别名没进包：${missing.join("、")}` +
        `（找的是 ${binariesDir}）。检查 electron-builder extraResources 的 binaries 配置`,
    );
  }
  const duplicates = entries.filter((name) => {
    const base = name.replace(/\.exe$/i, "");
    return SIDECAR_ALIASES.some((alias) => base.startsWith(`${alias}-`));
  });
  if (duplicates.length > 0) {
    throw new Error(
      `[after-pack] sidecar 的三元组副本周进了包（同一份二进制背两遍，安装包体积翻倍）：` +
        `${duplicates.join("、")}。检查 electron-builder extraResources 的 !kova-*- filter`,
    );
  }
  console.log(`[after-pack] binaries 校验通过（仅稳定别名）：${entries.join("、")}`);
}

exports.default = async function afterPack(context) {
  checkPackagedBinaries(context);
  fixSpawnHelperPerms(context);
  if (context.electronPlatformName !== "darwin") return;
  const appName = context.packager.appInfo.productFilename + ".app";
  const appPath = path.join(context.appOutDir, appName);
  execFileSync("codesign", ["--force", "--deep", "-s", "-", appPath], { stdio: "inherit" });
  execFileSync("codesign", ["--verify", "--deep", "--strict", appPath], { stdio: "inherit" });
  console.log(`[after-pack] ad-hoc signed + verified: ${appPath}`);
};
