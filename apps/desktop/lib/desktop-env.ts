/**
 * 桌面环境检测与平台判定（Electron 壳）。
 * 检测标记沿用前端既有约定（__KOVA_DESKTOP__/__KOVA_DESKTOP__ 由 preload 注入），
 * 这样前端桌面分支的既有判断逻辑不需要改动。
 */

/**
 * 检测当前是否在桌面壳（Electron）中运行
 */
export const isDesktop = (): boolean => {
  return (
    typeof window !== "undefined" &&
    ("__KOVA_DESKTOP__" in window || "__KOVA_DESKTOP__" in window)
  );
};

/**
 * 检测桌面平台是否为 macOS（依据 UA）。
 * 仅在 isDesktop() 为 true 时有意义：macOS 保留系统红绿灯，Windows/Linux 需自绘窗口控制。
 */
export const isMacPlatform = (): boolean => {
  return (
    typeof navigator !== "undefined" &&
    /Macintosh|Mac OS X/i.test(navigator.userAgent)
  );
};

/**
 * 检测桌面平台是否为 Windows（依据 UA）。
 * 仅桌面端有意义：WebView2（Chromium）启动参数类设置只在 Windows 生效。
 */
export const isWindowsPlatform = (): boolean => {
  return typeof navigator !== "undefined" && /Windows NT/i.test(navigator.userAgent);
};

/**
 * 检测是否在开发模式（next dev 由 localhost 提供页面）
 */
export const isDesktopDev = (): boolean => {
  return isDesktop() && window.location.hostname === 'localhost';
};

/**
 * 安全调用桌面桥 API
 * @param fn 桌面桥调用函数
 * @param fallback Web降级方案
 */
export async function safeDesktopCall<T>(
  fn: () => Promise<T>,
  fallback?: () => Promise<T>
): Promise<T | undefined> {
  if (!isDesktop()) {
    if (fallback) {
      return await fallback();
    }
    return undefined;
  }

  try {
    return await fn();
  } catch (error) {
    console.error('desktop bridge call failed:', error);
    if (fallback) {
      return await fallback();
    }
    return undefined;
  }
}

/**
 * 获取应用版本
 */
export async function getAppVersion(): Promise<string | undefined> {
  if (!isDesktop()) {
    return undefined;
  }

  const { getVersion } = await import('@/desktop-bridge/app');
  const version = await getVersion();
  return version;
}

/**
 * 获取平台信息
 */
export async function getPlatform(): Promise<string | undefined> {
  if (!isDesktop()) {
    return 'web';
  }

  const { platform } = await import('@/desktop-bridge/plugin-os');
  return await platform();
}