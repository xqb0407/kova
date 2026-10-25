// vendored from assistant-ui `@assistant-ui/react-pi@0.0.25` (MIT) —
// https://github.com/assistant-ui/assistant-ui/tree/main/packages/react-pi
// 保留上游文件名与结构以便对照上游 cherry-pick；改动需在此注明：
// vendored path: src/sdkIdentity.ts（runtime/ 子目录对应上游 src/runtime/）
// 改动：assistant-cloud 未 link 进本仓库，改为本地定义 SdkIdentity 结构类型

type SdkIdentity = { name: string; version: string };

// 改动：上游由包构建流程注入该全局常量；本仓库为 vendored 源码，无构建期 define，
// 声明为 undefined 并保留 typeof 守卫（运行时回退 "0.0.0"）
declare const __AUI_PACKAGE_VERSION__: string | undefined;

export const PI_SDK: SdkIdentity = {
  name: "@assistant-ui/react-pi",
  version:
    typeof __AUI_PACKAGE_VERSION__ === "string"
      ? __AUI_PACKAGE_VERSION__
      : "0.0.0",
};
