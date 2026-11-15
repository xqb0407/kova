/**
 * 英文词典汇总：逐命名空间镜像 zh.ts 的 `Dictionary` 形状。
 * 新增命名空间时：zh/ 加文件 + zh.ts 聚合，这里与 en/ 同步补齐——
 * 顶层 `en: Dictionary` 保证两侧命名空间集合一致，子文件 `typeof zhXxx`
 * 保证叶子 key 一致，任何一侧漏翻都是编译错误。
 */
import { zh, type Dictionary } from "./zh";
import { enCommon } from "./en/common";
import { enOnboarding } from "./en/onboarding";
import { enSettings } from "./en/settings";
import { enChat } from "./en/chat";
import { enLibrary } from "./en/library";
import { enRemote } from "./en/remote";
import { enAutomation } from "./en/automation";
import { enMarketplace } from "./en/marketplace";
import { enInbox } from "./en/inbox";

export const en: Dictionary = {
  common: enCommon,
  onboarding: enOnboarding,
  settings: enSettings,
  chat: enChat,
  library: enLibrary,
  remote: enRemote,
  automation: enAutomation,
  marketplace: enMarketplace,
  inbox: enInbox,
};
