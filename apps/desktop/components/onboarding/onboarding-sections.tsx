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
  Component: FC;
};

export const ONBOARDING_SECTIONS: readonly OnboardingSection[] = [
  {
    id: "model",
    title: "模型服务",
    desc: "选服务商，填 API Key，再挑一个默认模型",
    missing: "到「设置 → 模型配置」补上就能开聊",
    Component: ModelStep,
  },
  {
    id: "workspace",
    title: "工作目录",
    desc: "智能体默认在这个目录里读写文件",
    missing: "顶栏随时可以切换",
    Component: WorkspaceStep,
  },
  {
    id: "personalization",
    title: "个性化",
    desc: "定个称呼，挑一种回复风格",
    missing: "到「设置 → 个性化」随时补",
    Component: PersonalizationStep,
  },
  {
    id: "appMode",
    title: "工作模式",
    desc: "编码、工作还是设计，之后能改",
    missing: "默认是「编码」，在「设置 → 通用」可改",
    Component: ModeStep,
  },
  {
    id: "appearance",
    title: "外观",
    desc: "深色或浅色，再挑一个主题色",
    missing: "跟随系统，在「设置 → 外观」可改",
    Component: AppearanceStep,
  },
];
