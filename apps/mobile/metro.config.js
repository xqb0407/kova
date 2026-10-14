const { getDefaultConfig } = require("expo/metro-config");
const { withAui } = require("@assistant-ui/metro");
const { withUniwindConfig } = require("uniwind/metro");
const path = require("node:path");

const projectRoot = __dirname;
const monorepoRoot = path.resolve(projectRoot, "../..");
const workspacePackages = path.join(monorepoRoot, "packages");
const config = getDefaultConfig(projectRoot);

// 本仓是 bun workspaces（根 package.json 声明 apps/* packages/* plugins/*）。
// apps/mobile 的 package.json 里写了 install.hoistingLimits = "workspaces"：
// 移动端全部依赖装进 apps/mobile/node_modules，不与 apps/desktop 的
// Next 16 + react 19.3 争抢根上那一份 react——RN 0.86 只能配 react 19.2.3，
// 一旦被抬到 19.3 会在 Metro 里出现双实例红屏（或更糟：hooks dispatcher 不匹配
// 的运行时崩溃）。桌面侧同理，各自 node_modules 各自版本。
//
// 代价是 workspace 源码包（pi-protocol，以及后续抽出的 pi-client）在
// apps/mobile/node_modules 下是 symlink，且它们的 exports 直指 .ts 源码。Metro
// 默认既不跟 symlink、也看不到仓库根，所以必须显式放开这三件事。
config.watchFolders = [workspacePackages];
config.resolver.unstable_enableSymlinks = true;
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, "node_modules"),
  path.resolve(workspacePackages),
  monorepoRoot,
];

module.exports = withUniwindConfig(withAui(config), {
  cssEntryFile: "./global.css",
  dtsFile: "./uniwind-types.d.ts",
});

// uniwind 的 web resolver 会把「解析到 react-native-web 里某个 index 组件」的导入
// 重定向到 uniwind 的包装版。它本意只是拦 `import { View } from "react-native"`，
// 但 RNW 自己的内部导入（dist/index.js → ./exports/InputAccessoryView）形态完全一样，
// 于是被一起拦下并绕回 RNW 自身：懒 getter 在本模块 eval 结束前被读，web 端直接报
// "Cannot read properties of undefined (reading 'default')"，整页白掉。
//
// 例外必须留着 createOrderedCSSStyleSheet：uniwind 的包装版会把 RNW 的所有原子规则
// 包进 `@layer rnw { … }`，而 Tailwind v4 的工具类在 `@layer utilities` 里——
// CSS 规范下后声明的层覆盖先声明的层，uniwind 正是靠这个让工具类压过 RNW 的基础
// 重置（RNW 的 View 重置含 padding:0 / border:0 solid black / background-color:transparent，
// 不分层的话会把 bg-card、border、p-2 全部压没，只剩 border-radius 这类重置里没有的属性生效）。
// 拦掉它 = 页面看着像完全没上样式。
const uniwindResolveRequest = module.exports.resolver.resolveRequest;
const isUniwindStylesheetSwap = (moduleName) =>
  moduleName.includes("createOrderedCSSStyleSheet");

module.exports.resolver.resolveRequest = (context, moduleName, platform) => {
  const origin = context.originModulePath ?? "";
  if (
    moduleName.startsWith(".") &&
    !isUniwindStylesheetSwap(moduleName) &&
    origin.includes(`${path.sep}react-native-web${path.sep}`)
  ) {
    return context.resolveRequest(
      { ...context, resolveRequest: undefined },
      moduleName,
      platform,
    );
  }

  return uniwindResolveRequest(context, moduleName, platform);
};
