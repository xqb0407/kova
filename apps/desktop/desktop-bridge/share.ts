/**
 * 桌面桥 · 分享：整页截图（主进程渲染）与保存后打开文件。
 * 只有 Electron 壳有这两个命令；网页/远程模式由调用方降级。
 */
import { invokeBridge } from "./_host";

export type ShareImageResult = {
  path: string | null;
  copied: boolean;
  width: number;
  height: number;
  scale: number;
  bytes: number;
};

export async function renderShareImage(input: {
  html: string;
  width?: number;
  scale?: number;
  savePath?: string | null;
  copy?: boolean;
}): Promise<ShareImageResult> {
  return invokeBridge<ShareImageResult>("share_render_image", input);
}

export async function openSharePath(path: string): Promise<void> {
  await invokeBridge("share_open_path", { path });
}
