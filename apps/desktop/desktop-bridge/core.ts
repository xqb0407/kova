/**
 * 桌面桥 · 核心：为前端既有的桌面 API 形状（invoke / Channel）提供 Electron 实现，
 * 业务代码不必改动（原 import 路径经 codemod 指到本模块）。
 */
export {
  ChannelBase as Channel,
  invokeBridge as invoke,
  unregisterChannel,
} from "./_host";
export type { InvokeResult } from "./_host";
/** 拖拽 File → 磁盘绝对路径（资料库拖入导入用；无路径返回 null） */
export { filePathOf } from "./_host";
