"use client";

/**
 * 技能市场：只保留 GitHub 精选仓库源（直读 SKILL.md）。
 *
 * 具体面板见 github-skill-market.tsx；安装仍走 saveSkill({ raw })，
 * 与设置页「导入 Markdown」同一条管道。
 */
import type { FC } from "react";
import { GithubSkillMarket } from "@/components/marketplace/github-skill-market";

export const SkillMarket: FC = () => (
  <div className="flex min-h-0 flex-1 flex-col">
    <GithubSkillMarket />
  </div>
);
