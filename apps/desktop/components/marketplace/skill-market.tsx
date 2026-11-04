"use client";

/**
 * 技能市场包装层：只负责「源」的选择与持久化，具体面板各自独立：
 *   - KovaHub：官方精选目录（search.openkova.site），分类/排序/分页
 *   - ClawHub：OpenClaw 技能注册表（MIT-0）
 *   - GitHub：精选仓库直读 SKILL.md
 */
import { useState, type FC } from "react";
import {
  SkillSourceSelect,
  type SkillSource,
} from "@/components/marketplace/skill-source-select";
import { KovahubSkillMarket } from "@/components/marketplace/kovahub-skill-market";
import { ClawhubSkillMarket } from "@/components/marketplace/clawhub-skill-market";
import { GithubSkillMarket } from "@/components/marketplace/github-skill-market";

const SOURCE_KEY = "kova.skillMarketSource";

function readSource(): SkillSource {
  if (typeof window === "undefined") return "kovahub";
  try {
    const saved = window.localStorage.getItem(SOURCE_KEY);
    return saved === "github" || saved === "clawhub" || saved === "kovahub"
      ? saved
      : "kovahub";
  } catch {
    return "kovahub";
  }
}

export const SkillMarket: FC = () => {
  const [source, setSource] = useState<SkillSource>(readSource);

  const changeSource = (next: SkillSource) => {
    setSource(next);
    try {
      window.localStorage.setItem(SOURCE_KEY, next);
    } catch {
      // 隐私模式 / 配额满：本次会话仍可切换
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {source === "kovahub" ? (
        <KovahubSkillMarket source={source} onSourceChange={changeSource} />
      ) : source === "clawhub" ? (
        <ClawhubSkillMarket source={source} onSourceChange={changeSource} />
      ) : (
        <GithubSkillMarket source={source} onSourceChange={changeSource} />
      )}
    </div>
  );
};
