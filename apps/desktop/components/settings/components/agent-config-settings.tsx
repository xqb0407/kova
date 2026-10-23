"use client";

import type { FC } from "react";
import { ComputerControlSettings } from "./computer-control-settings";
import { AutoReviewSettings } from "./auto-review-settings";
import { SandboxSettingsPanel } from "./sandbox-settings";
import { SubagentConcurrencySettings } from "./subagent-concurrency-settings";

/**
 * 智能体配置页（设置 → 智能体 → 智能体配置）。
 *
 * 原先「电脑控制」和「AI 审查」各占一个入口、各成一页，但它们回答的是同一件事的
 * 两半：智能体能碰本机的什么（能力授权），以及它自动动手前谁把关（风险审查）。
 * 拆成两页时，用户要拼两次才看得全"我到底放开了多少"；合成一页后"能碰什么"
 * 和"谁放行"在同一屏里对照。
 *
 * 各区块仍各自成文件：subagent-concurrency-settings（子智能体并发）、
 * computer-control-settings（浏览器/屏幕三条授权）、auto-review-settings
 * （审查模型与超时）、sandbox-settings（沙箱档位）。这里只出页面骨架与顺序。
 */
export const AgentConfigSettings: FC = () => {
  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <div className="flex w-full max-w-5xl flex-col gap-8 self-center px-8 py-8">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">智能体配置</h1>
          <p className="text-muted-foreground mt-1 text-sm">
            智能体的能力授权、子智能体并发，以及它自动动手时由谁判风险。
          </p>
        </div>

        <SubagentConcurrencySettings />
        <ComputerControlSettings />
        <AutoReviewSettings />
        <SandboxSettingsPanel />
      </div>
    </div>
  );
};
