/**
 * Tauri全局类型声明
 */
declare global {
  interface Window {
    __TAURI__?: {
      convertFileSrc: (filePath: string, protocol?: string) => string;
    };
  }
}

export {};