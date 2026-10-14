/**
 * 连接类失败判定（与 core patch 里的同一口径，见
 * patches/@assistant-ui%2Fcore@0.3.22.patch）：
 *
 * 网关没开/网络断了时，"列表加载失败""请求失败""连接已关闭"这些都是**预期状态**，
 * 不是 bug。它们在 RN 开发构建里走 console.error 会被 LogBox 弹成底部红条盖住 UI
 * （用户看到的"底部 expo 错误"），所以统一降级为 log —— 提示交给应用自己的弹窗。
 * 注意：只有明确的连接类才降级；其它错误照旧 error，不掩盖真问题。
 */
const CONNECTIVITY_PATTERN =
  /connection closed|not connected|failed to fetch|network request failed|network error|timeout|unauthorized|is not running|reconnecting|socket/i;

export function isConnectivityFailure(error: unknown): boolean {
  const text =
    error instanceof Error
      ? `${error.name}: ${error.message}`
      : typeof error === "string"
        ? error
        : (() => {
            try {
              return JSON.stringify(error);
            } catch {
              return String(error);
            }
          })();
  return CONNECTIVITY_PATTERN.test(text);
}
