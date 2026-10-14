import type { ComponentType } from "react";
import { AppearanceStep } from "./steps/appearance-step";
import { ConnectStep } from "./steps/connect-step";

/**
 * 引导的分区清单——整个向导的唯一事实源，与桌面端
 * components/onboarding/onboarding-sections.tsx 同构：外壳按它算进度、
 * 欢迎页按它列目录、完成页按它列回顾，加分区只改这一个数组。
 *
 * 桌面端引导里的「模型服务 / 工作目录 / 个性化 / 工作模式」不在手机端重复：
 * 那些配置活在桌面端本机（模型凭据、工作目录都是网关侧 REMOTE_DENIED 的
 * 管理面），手机改了也不生效，做假入口比不做更糟。移动端真正要走的只有
 * 连接与外观两步。
 */
export type OnboardingSection = {
  /** 稳定 id：配置的归档键，也是 patch 的第一参 */
  id: string;
  /** 欢迎页目录与完成页清单里的名字 */
  title: string;
  /** 欢迎页目录里的一行说明 */
  desc: string;
  /** 没配时完成页的说法——照实写没配，不粉饰 */
  missing: string;
  /** 步骤页的表单 */
  Component: ComponentType;
};

export const ONBOARDING_SECTIONS: readonly OnboardingSection[] = [
  {
    id: "connect",
    title: "连接桌面端",
    desc: "桌面端开启远程访问，扫码或输地址配对",
    missing: "配对屏随时可以完成，凭据只存在本机",
    Component: ConnectStep,
  },
  {
    id: "appearance",
    title: "外观",
    desc: "跟随系统、浅色或深色",
    missing: "默认跟随系统，在「设置」里可改",
    Component: AppearanceStep,
  },
];
