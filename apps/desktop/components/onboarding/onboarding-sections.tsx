"use client";

import type { FC } from "react";
import { AppearanceStep } from "./steps/appearance-step";
import { ModelStep } from "./steps/model-step";
import { ModeStep } from "./steps/mode-step";
import { PersonalizationStep } from "./steps/personalization-step";
import { WorkspaceStep } from "./steps/workspace-step";

/**
 * 引导的分区清单——整个向导的唯一事实源。
 *
 * 之前 STEPS 是一个写死在 onboarding-flow 里的 FC 数组，欢迎页的目录、完成页的
 * 回顾清单都各自维护一份文案：加一节要改三个地方，漏一处就前后对不上。
 * 现在这里声明一次，外壳按它算进度、欢迎页按它列目录、完成页按它列回顾，
 * 以后加分区只改这一个数组。
 *
 * 每个分区自己负责两件事：用 patch(id, …) 把结果写回来，以及校验能否进入下一步。
 * 门槛看的是实时状态（工作目录必须选、模型 Key 必填），所以留在步骤组件里，
 * 清单不重复描述它。步骤页的大标题也由各分区自己写——模型那步的标题要跟着
 * 阶段变（选服务商 / 填 Key / 挑模型），统一到这里反而要开特例。
 *
 * 文案只存词典 key（lib/i18n/locales），展示时经 t() 解析——欢迎页目录、
 * 完成页清单、顶栏进度共用这三个 key，语言切换三处同时生效。
 */
export type OnboardingSection = {
  /** 稳定 id：配置的归档键，也是 patch 的第一参 */
  id: string;
  /** 欢迎页目录与完成页清单里的名字（词典 key：onboarding.sections.<id>.title） */
  titleKey: string;
  /** 欢迎页目录里的一行说明（词典 key） */
  descKey: string;
  /** 没配时完成页的说法——照实写没配，不粉饰（词典 key） */
  missingKey: string;
  /** 步骤页的表单 */
  Component: FC;
};

export const ONBOARDING_SECTIONS: readonly OnboardingSection[] = [
  {
    id: "model",
    titleKey: "onboarding.sections.model.title",
    descKey: "onboarding.sections.model.desc",
    missingKey: "onboarding.sections.model.missing",
    Component: ModelStep,
  },
  {
    id: "workspace",
    titleKey: "onboarding.sections.workspace.title",
    descKey: "onboarding.sections.workspace.desc",
    missingKey: "onboarding.sections.workspace.missing",
    Component: WorkspaceStep,
  },
  {
    id: "personalization",
    titleKey: "onboarding.sections.personalization.title",
    descKey: "onboarding.sections.personalization.desc",
    missingKey: "onboarding.sections.personalization.missing",
    Component: PersonalizationStep,
  },
  {
    id: "appMode",
    titleKey: "onboarding.sections.appMode.title",
    descKey: "onboarding.sections.appMode.desc",
    missingKey: "onboarding.sections.appMode.missing",
    Component: ModeStep,
  },
  {
    id: "appearance",
    titleKey: "onboarding.sections.appearance.title",
    descKey: "onboarding.sections.appearance.desc",
    missingKey: "onboarding.sections.appearance.missing",
    Component: AppearanceStep,
  },
];
