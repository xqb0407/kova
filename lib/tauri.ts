/**
 * Tauri环境检测和工具函数
 */

/**
 * 检测当前是否在Tauri桌面环境中运行
 */
export const isTauri = (): boolean => {
  return (
    typeof window !== "undefined" &&
    ("__TAURI_INTERNALS__" in window || "__TAURI__" in window)
  );
};

/**
 * 检测桌面平台是否为 macOS（依据 WebView UA）。
 * 仅在 isTauri() 为 true 时有意义：macOS 保留系统红绿灯，Windows/Linux 需自绘窗口控制。
 */
export const isMacPlatform = (): boolean => {
  return (
    typeof navigator !== "undefined" &&
    /Macintosh|Mac OS X/i.test(navigator.userAgent)
  );
};

/**
 * 检测是否在Tauri开发模式中
 */
export const isTauriDev = (): boolean => {
  return isTauri() && window.location.hostname === 'localhost';
};

/**
 * 安全调用Tauri API
 * @param fn Tauri API调用函数
 * @param fallback Web降级方案
 */
export async function safeTauriCall<T>(
  fn: () => Promise<T>,
  fallback?: () => Promise<T>
): Promise<T | undefined> {
  if (!isTauri()) {
    if (fallback) {
      return await fallback();
    }
    return undefined;
  }

  try {
    return await fn();
  } catch (error) {
    console.error('Tauri API call failed:', error);
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
  if (!isTauri()) {
    return undefined;
  }

  const { getVersion } = await import('@tauri-apps/api/app');
  const version = await getVersion();
  return version;
}

/**
 * 获取平台信息
 */
export async function getPlatform(): Promise<string | undefined> {
  if (!isTauri()) {
    return 'web';
  }

  const { platform } = await import('@tauri-apps/plugin-os');
  return await platform();
}