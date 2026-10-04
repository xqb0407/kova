import { isConnectivityFailure } from "./connectivity-errors";

/**
 * 连接类噪声闸门（全局，装一次）。
 *
 * 为什么需要它：网关没开/网络断了时，各层都会往 console 丢"失败"日志——
 * 核心库的列表加载失败、我们自己的运行期错误、第三方 WebSocket 封装等。RN 开发
 * 构建把 `console.error`/`console.warn` 弹成 LogBox 红黄条盖住 UI（用户看到的
 * "底部 expo 错误"）；生产构建虽没有 LogBox，这类**预期失败**也不该伪装成错误。
 *
 * 口径：只拦 connectivity 白名单（connection closed / failed to fetch /
 * ECONNREFUSED / timeout / unauthorized …），降级为 console.log；其余原样透传
 * ——真 bug 照旧是 error，不掩盖。提示由应用自己的弹窗/横幅负责（见
 * components/ui/gateway-offline-dialog.tsx）。
 */
export function installConnectivityLogGate(): void {
  if ((globalThis as { __piConnectivityLogGate?: boolean }).__piConnectivityLogGate) {
    return; // 幂等（HMR / StrictMode 重放都可能再调一次）
  }
  (globalThis as { __piConnectivityLogGate?: boolean }).__piConnectivityLogGate = true;

  const originalError = console.error;
  const originalWarn = console.warn;

  const shouldDowngrade = (args: readonly unknown[]): boolean =>
    args.some((arg) => isConnectivityFailure(arg));

  console.error = (...args: unknown[]) => {
    if (shouldDowngrade(args)) {
      console.log(...args);
      return;
    }
    originalError(...args);
  };
  console.warn = (...args: unknown[]) => {
    if (shouldDowngrade(args)) {
      console.log(...args);
      return;
    }
    originalWarn(...args);
  };
}
