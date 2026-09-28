"use client";

/**
 * 插件预览弹窗：市场卡片与已装列表共用（点卡片/详情唤起）。
 * 大窗版式（对齐主流插件市场详情页）：头部大图标 + 名称 + 徽标行 + 来源/安装时间；
 * 正文分节滚动——描述与关键词、组件构成（技能/MCP/子智能体/面板，各节带一句
 * 用途说明，条目以卡片网格呈现）、基本信息表（版本/市场/清单/时间/状态等）、
 * 诊断卡；页脚动作条由调用方经 footer 注入（市场=安装/更新/链接装/卸载，
 * 已装=启停/检查更新/卸载），本组件纯展示。
 * 关闭态（preview=null）children 仍挂载，一律按空值安全求值。
 */
import type { FC, ReactNode } from "react";
import {
  BotIcon,
  InfoIcon,
  LayersIcon,
  ServerIcon,
  SparklesIcon,
  TriangleAlertIcon,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { PluginEntry } from "@/lib/plugins/plugins";
import { PluginIcon } from "@/components/marketplace/plugin-icon";

export type PluginPreviewData = {
  name: string;
  version?: string;
  description?: string;
  icon?: string;
  category?: string;
  keywords?: string[];
  marketplaceName: string;
  /** 已装镜像；null = 市场里未安装的条目 */
  installed: PluginEntry | null;
};

const MANIFEST_KIND_LABEL: Record<PluginEntry["manifestKind"], string> = {
  kova: "kova",
  claude: "Claude 生态",
  codex: "Codex 生态",
};

function formatInstalledAt(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

/** 分节标题：图标 + 名称 + 可选一句用途说明（参考主流市场的详情页分节法） */
const Section: FC<{
  icon: ReactNode;
  title: string;
  hint?: string;
  children: ReactNode;
}> = ({ icon, title, hint, children }) => (
  <section>
    <div className="mb-1 flex items-center gap-2">
      <span className="text-muted-foreground">{icon}</span>
      <h3 className="text-base font-semibold">{title}</h3>
    </div>
    {hint && <p className="text-muted-foreground mb-3 text-sm">{hint}</p>}
    {children}
  </section>
);

/** 组件条目卡：名称 + 启用状态点 + 完整描述（网格排布，替代旧的一行摘要） */
const ComponentCard: FC<{
  name: string;
  description: string;
  enabled: boolean;
  extra?: ReactNode;
}> = ({ name, description, enabled, extra }) => (
  <div className="rounded-xl border p-4">
    <div className="flex items-center gap-2">
      <span
        className={cn(
          "size-2 shrink-0 rounded-full",
          enabled ? "bg-emerald-500" : "bg-muted-foreground/40",
        )}
        title={enabled ? "已启用" : "已停用"}
      />
      <span className="min-w-0 truncate text-sm font-medium">{name}</span>
    </div>
    {description && (
      <p className="text-muted-foreground mt-1.5 line-clamp-3 text-[13px] leading-6">
        {description}
      </p>
    )}
    {extra}
  </div>
);

/** 与 PiPluginComponentEntry 对齐的宽松形状（transport 仅 MCP 条目携带） */
type PreviewComponentItem = {
  name: string;
  description: string;
  enabled: boolean;
  transport?: "stdio" | "http";
};

const ComponentGrid: FC<{
  items: PreviewComponentItem[];
  render?: (item: PreviewComponentItem) => ReactNode;
}> = ({ items, render }) => (
  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
    {items.map((c) => (
      <ComponentCard
        key={c.name}
        name={c.name}
        description={c.description}
        enabled={c.enabled}
        extra={render?.(c)}
      />
    ))}
  </div>
);

/** 基本信息行：左标签右值；整表坐进一块浅灰面板，行与行不再画线 */
const InfoRow: FC<{ label: string; value: ReactNode }> = ({ label, value }) => (
  <div className="flex items-baseline justify-between gap-6 py-2.5">
    <span className="text-muted-foreground shrink-0 text-sm">{label}</span>
    <span className="min-w-0 text-right text-sm">{value}</span>
  </div>
);

export const PluginPreviewDialog: FC<{
  preview: PluginPreviewData | null;
  onClose: () => void;
  footer?: ReactNode;
}> = ({ preview, onClose, footer }) => {
  const installed = preview?.installed ?? null;
  const components = installed?.components;
  return (
    <Dialog open={preview !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[85vh] w-[min(92vw,64rem)] max-w-none grid-rows-[auto_minmax(0,1fr)_auto] gap-0 overflow-hidden rounded-2xl p-0 sm:max-w-none">
        {/* 头部：大图标 + 名称/徽标/来源，底部分隔线 */}
        <div className="px-8 pt-7 pb-6">
          <DialogHeader>
            <div className="flex items-start gap-5 pr-8">
              <div className="bg-background grid size-16 shrink-0 place-items-center overflow-hidden rounded-2xl ">
                <PluginIcon src={preview?.icon} className="size-10" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <DialogTitle className="text-xl leading-6 font-semibold">
                    {preview?.name ?? ""}
                  </DialogTitle>
                  {preview?.version && (
                    <Badge
                      variant="outline"
                      className="px-2 font-mono text-[11px] font-normal"
                    >
                      v{preview.version}
                    </Badge>
                  )}
                  {installed && installed.manifestKind !== "kova" && (
                    <Badge variant="secondary" className="font-normal">
                      {MANIFEST_KIND_LABEL[installed.manifestKind]}
                    </Badge>
                  )}
                  {installed?.linked && (
                    <Badge variant="outline" className="font-normal">
                      开发模式
                    </Badge>
                  )}
                  {installed?.sourceMissing && (
                    <Badge variant="destructive" className="font-normal">
                      市场已移除
                    </Badge>
                  )}
                  {installed && !installed.enabled && (
                    <Badge variant="outline" className="text-muted-foreground font-normal">
                      已停用
                    </Badge>
                  )}
                  {!installed && preview && (
                    <Badge variant="outline" className="text-muted-foreground font-normal">
                      未安装
                    </Badge>
                  )}
                </div>
                <DialogDescription className="mt-2 text-sm">
                  来自 {preview?.marketplaceName ?? ""}
                  {installed
                    ? ` · 安装于 ${formatInstalledAt(installed.installedAt)}`
                    : ""}
                </DialogDescription>
              </div>
            </div>
          </DialogHeader>
        </div>

        {/* 正文：分节滚动 */}
        <div className="min-h-0 space-y-8 overflow-y-auto px-8 py-6">
          <section>
            {preview?.description ? (
              <p className="text-[15px] leading-7 whitespace-pre-line">
                {preview.description}
              </p>
            ) : (
              <p className="text-muted-foreground text-[15px] leading-7">
                暂无描述。
              </p>
            )}
            {preview?.keywords && preview.keywords.length > 0 && (
              <div className="mt-3 flex flex-wrap gap-1.5">
                {preview.keywords.map((k) => (
                  <Badge key={k} variant="secondary" className="font-normal">
                    {k}
                  </Badge>
                ))}
              </div>
            )}
          </section>

          {components && components.skills.length > 0 && (
            <Section
              icon={<SparklesIcon className="size-4" />}
              title="技能"
              hint="Skills 会在与对话相关时由智能体自动调用。"
            >
              <ComponentGrid items={components.skills} />
            </Section>
          )}

          {components && components.mcpServers.length > 0 && (
            <Section
              icon={<ServerIcon className="size-4" />}
              title="MCP 服务器"
              hint="为智能体提供外部工具与数据源连接。"
            >
              <ComponentGrid
                items={components.mcpServers}
                render={(c) =>
                  c.transport ? (
                    <Badge
                      variant="outline"
                      className="mt-2 px-1.5 font-mono text-[11px] font-normal"
                    >
                      {c.transport}
                    </Badge>
                  ) : null
                }
              />
            </Section>
          )}

          {components && components.subagents.length > 0 && (
            <Section
              icon={<BotIcon className="size-4" />}
              title="子智能体"
              hint="可被主智能体委派，独立执行子任务。"
            >
              <ComponentGrid items={components.subagents} />
            </Section>
          )}

          {components && components.panels.length > 0 && (
            <Section
              icon={<LayersIcon className="size-4" />}
              title="面板"
              hint="按打开文件的类型自动出现在右侧栏。"
            >
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {components.panels.map((panel) => (
                  <div key={panel.id} className="rounded-xl border p-4">
                    <span className="text-sm font-medium">{panel.title}</span>
                    {panel.opens.length > 0 && (
                      <p className="text-muted-foreground mt-1.5 font-mono text-xs break-all">
                        {panel.opens.join("  ")}
                      </p>
                    )}
                    {panel.permissions.length > 0 && (
                      <p className="text-muted-foreground mt-1 text-xs">
                        权限：{panel.permissions.join(" / ")}
                      </p>
                    )}
                  </div>
                ))}
              </div>
            </Section>
          )}

          {components &&
            components.skills.length === 0 &&
            components.mcpServers.length === 0 &&
            components.subagents.length === 0 &&
            components.panels.length === 0 && (
              <p className="text-muted-foreground text-sm">
                该插件不包含可列出的组件。
              </p>
            )}

          {/* 基本信息：市场条目与已装共用一张表 */}
          <Section icon={<InfoIcon className="size-4" />} title="基本信息">
            <dl className="bg-muted/40 rounded-xl px-4 py-1">
              {(preview?.version || installed) && (
                <InfoRow
                  label="版本"
                  value={
                    <span className="font-mono">
                      v{installed?.version ?? preview?.version}
                    </span>
                  }
                />
              )}
              <InfoRow label="来源市场" value={preview?.marketplaceName ?? ""} />
              {preview?.category && <InfoRow label="分类" value={preview.category} />}
              {installed && (
                <InfoRow
                  label="清单类型"
                  value={MANIFEST_KIND_LABEL[installed.manifestKind]}
                />
              )}
              {installed && (
                <InfoRow label="状态" value={installed.enabled ? "已启用" : "已停用"} />
              )}
              {installed && (
                <InfoRow
                  label="安装时间"
                  value={formatInstalledAt(installed.installedAt)}
                />
              )}
              {installed?.linked && installed.sourcePath && (
                <InfoRow
                  label="源目录"
                  value={
                    <span className="font-mono text-xs break-all">
                      {installed.sourcePath}
                    </span>
                  }
                />
              )}
            </dl>
          </Section>

          {installed && installed.diagnostics.length > 0 && (
            <Section
              icon={<TriangleAlertIcon className="size-4" />}
              title="诊断"
            >
              <ul className="text-amber-700 dark:text-amber-500 space-y-1 rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-[13px] leading-6">
                {installed.diagnostics.map((d) => (
                  <li key={d}>{d}</li>
                ))}
              </ul>
            </Section>
          )}
        </div>

        {footer ? (
          <DialogFooter className="px-8 py-4">{footer}</DialogFooter>
        ) : null}
      </DialogContent>
    </Dialog>
  );
};
