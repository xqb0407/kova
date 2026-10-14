/**
 * `@tauri-apps/api/core` 的 Electron 兼容实现（tsconfig paths 别名注入）。
 * 仅实现本项目前端用到的成员：invoke / Channel。
 */
export { ChannelBase as Channel, invokeBridge as invoke } from "./_host";
export type { InvokeResult } from "./_host";
