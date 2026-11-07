/**
 * 中文词典汇总（事实源）。英文侧 en.ts 逐命名空间镜像本文件导出的
 * `Dictionary` 类型——新增命名空间时两侧同步加。
 */
import { zhCommon } from "./zh/common";
import { zhOnboarding } from "./zh/onboarding";
import { zhSettings } from "./zh/settings";
import { zhChat } from "./zh/chat";

export const zh = {
  common: zhCommon,
  onboarding: zhOnboarding,
  settings: zhSettings,
  chat: zhChat,
};

export type Dictionary = typeof zh;
