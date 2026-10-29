"use client";

/**
 * 【校对页】插件详情弹窗新版版式：/dev-preview/plugin-dialog
 *
 * 跑法：cd apps/desktop && bun run dev → http://localhost:3000/dev-preview/plugin-dialog
 *
 * 夹具覆盖弹窗的几种真实状态：未安装 / 已安装 / 有更新 / 链接安装（开发）/
 * 内置（不可卸载，页脚带说明）。数据口径照 sidecar 的 list_plugins 应答，
 * 组件清单用参考图那套名字，方便和设计稿逐项对照。
 */

import { useState } from "react";
import { CheckIcon } from "lucide-react";
import {
  PluginPreviewDialog,
  type PluginPreviewData,
  type PluginPreviewMenuAction,
  type PluginPreviewPrimaryAction,
} from "@/components/marketplace/plugin-preview-dialog";
import { Button } from "@/components/ui/button";
import type { PluginEntry } from "@/lib/plugins/plugins";

const DESCRIPTION =
  "连接华宇元典法律数据，查询法律法规、案例文书与企业信息，并按中国大陆法域开展可核验的法律研究。";

const COMPONENTS: PluginEntry["components"] = {
  skills: [
    {
      name: "prc-legal-research-law-search",
      description: "检索现行有效的法律法规条文，返回条文原文与出处。",
      enabled: true,
    },
    {
      name: "prc-legal-research-deep-research",
      description: "围绕一个法律问题做多轮检索、比对与归纳，输出带引用的研究结论。",
      enabled: true,
    },
    {
      name: "prc-legal-research-case-search",
      description: "检索案例文书，按案由、法院层级与裁判年份筛选同类裁判。",
      enabled: true,
    },
    {
      name: "prc-legal-research-company-search",
      description: "查询企业工商信息、股权结构与司法风险。",
      enabled: false,
    },
  ],
  mcpServers: [
    {
      name: "华宇元典法律数据",
      description: "法律法规、案例文书与企业信息的统一数据源。",
      enabled: true,
      transport: "stdio",
    },
  ],
  subagents: [
    {
      name: "法律研究助手",
      description: "独立完成多步法律检索，汇总可核验的法条与判例引用。",
      enabled: true,
    },
  ],
  panels: [
    {
      id: "legal-research",
      title: "法律研究工作区",
      opens: ["*.legal.json"],
      permissions: ["document", "export", "agent"],
    },
  ],
};

function installedEntry(overrides: Partial<PluginEntry> = {}): PluginEntry {
  return {
    pluginId: "kova-local:prc-legal",
    name: "华宇元典法律数据",
    marketplaceId: "kova-local",
    marketplaceName: "本仓库插件市场",
    version: "1.1.0",
    installedAt: "2026-10-20T09:30:00.000Z",
    description: DESCRIPTION,
    category: "效率",
    manifestKind: "kova",
    sourceMissing: false,
    enabled: true,
    components: COMPONENTS,
    diagnostics: [],
    ...overrides,
  };
}

type Variant = "available" | "installed" | "update" | "linked" | "builtin";

const VARIANTS: { value: Variant; label: string }[] = [
  { value: "available", label: "未安装" },
  { value: "installed", label: "已安装" },
  { value: "update", label: "有更新" },
  { value: "linked", label: "链接安装" },
  { value: "builtin", label: "内置" },
];

export default function PluginDialogPreviewPage() {
  const [variant, setVariant] = useState<Variant>("available");
  const [open, setOpen] = useState(true);

  const installed: PluginEntry | null =
    variant === "available"
      ? null
      : variant === "linked"
        ? installedEntry({
            linked: true,
            sourcePath: "/Users/kova/plugins/prc-legal-research",
          })
        : variant === "builtin"
          ? installedEntry({
              marketplaceId: "builtin",
              marketplaceName: "内置插件",
              manifestKind: "claude",
            })
          : installedEntry({
              version: variant === "update" ? "1.0.0" : "1.1.0",
            });

  const preview: PluginPreviewData = {
    name: "华宇元典法律数据",
    version: "1.1.0",
    description: DESCRIPTION,
    category: "效率",
    keywords: ["legal", "law", "research", "china"],
    marketplaceName: installed?.marketplaceName ?? "本仓库插件市场",
    installed,
  };

  const primaryAction: PluginPreviewPrimaryAction | undefined = !installed
    ? { label: "安装", onClick: () => setOpen(false) }
    : variant === "linked"
      ? { label: "已链接安装", variant: "outline", disabled: true }
      : variant === "update"
        ? { label: "更新", onClick: () => setOpen(false) }
        : {
            label: "已安装",
            icon: <CheckIcon className="size-4" />,
            variant: "outline",
            disabled: true,
          };

  const menuActions: PluginPreviewMenuAction[] =
    variant === "available"
      ? [{ label: "链接安装（开发）", onSelect: () => setOpen(false) }]
      : variant === "builtin"
        ? []
        : [
            ...(variant === "installed"
              ? [{ label: "转为链接安装", onSelect: () => setOpen(false) }]
              : []),
            { label: "卸载", destructive: true, onSelect: () => setOpen(false) },
          ];

  return (
    <div className="bg-background min-h-svh p-10">
      <div className="mx-auto flex max-w-3xl flex-col gap-4">
        <h1 className="text-lg font-semibold">插件详情弹窗 · 版式校对</h1>
        <div className="flex flex-wrap items-center gap-2">
          {VARIANTS.map((v) => (
            <Button
              key={v.value}
              size="sm"
              variant={variant === v.value ? "default" : "outline"}
              onClick={() => {
                setVariant(v.value);
                setOpen(true);
              }}
            >
              {v.label}
            </Button>
          ))}
          <Button size="sm" onClick={() => setOpen(true)}>
            打开弹窗
          </Button>
        </div>
        <p className="text-muted-foreground text-sm">
          切换上方状态查看弹窗的安装 / 已装 / 更新 / 开发模式 / 内置版式；
          关闭后可再次打开。
        </p>
      </div>

      <PluginPreviewDialog
        preview={open ? preview : null}
        onClose={() => setOpen(false)}
        primaryAction={primaryAction}
        menuActions={menuActions}
        footerNote={
          variant === "builtin"
            ? "首方插件随应用分发与更新，不可卸载，可禁用。"
            : undefined
        }
      />
    </div>
  );
}
