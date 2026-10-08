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
import dynamic from "next/dynamic";
import { useCallback, useEffect, useState, type FC, type ReactNode } from "react";
import {
  BotIcon,
  EyeIcon,
  InfoIcon,
  LayersIcon,
  Loader2Icon,
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
import { ClampedText } from "@/components/ui/clamped-text";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  getPluginComponentDoc,
  type PluginEntry,
  type PiPluginComponentKind,
} from "@/lib/plugins/plugins";
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

/** 正文视图带 Streamdown 重依赖：点开"查看内容"才异步拉取，不进市场页首屏包 */
const ComponentDocView = dynamic(() => import("./component-doc-view"), {
  ssr: false,
  // 分块在飞的时候留一行占位：只渲染 null 会在正文已到手、视图还没到位时
  // 露出一块空白，看着像"内容是空的"
  loading: () => (
    <p className="text-muted-foreground mt-3 text-sm">正在加载视图…</p>
  ),
});

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

/** 二级弹窗当前展示的组件（null = 未打开） */
type ComponentDocTarget = {
  pluginId: string;
  kind: PiPluginComponentKind;
  name: string;
};

const COMPONENT_KIND_LABEL: Record<PiPluginComponentKind, string> = {
  skill: "技能",
  mcp: "MCP 服务器",
  subagent: "子智能体",
};

/** 组件正文二级弹窗：按需现取的原文 + 来源路径（懒加载，打开才发请求）。
 *  走二级弹窗而非卡片内联展开：正文可达几十 KB，在三列网格卡里就地展开会把
 *  整行撑成参差的高墙，也把滚动位置挤乱；独立窗口让详情页版式保持不动。 */
const ComponentDocDialog: FC<{
  target: ComponentDocTarget | null;
  onClose: () => void;
}> = ({ target, onClose }) => {
  const [state, setState] = useState<
    | { status: "loading" }
    | { status: "ready"; path: string; content: string; truncated: boolean }
    | { status: "error"; text: string }
    | null
  >(null);

  // 换组件（target 变化）重置：先归零再取，避免上一条的正文在新标题下闪一下
  useEffect(() => {
    if (!target) {
      setState(null);
      return;
    }
    let cancelled = false;
    setState({ status: "loading" });
    void (async () => {
      try {
        const doc = await getPluginComponentDoc(target.pluginId, target.kind, target.name);
        if (!cancelled) {
          setState({
            status: "ready",
            path: doc.path,
            content: doc.content,
            truncated: doc.truncated,
          });
        }
      } catch (err) {
        if (!cancelled) {
          setState({
            status: "error",
            text: err instanceof Error ? err.message : String(err),
          });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [target]);

  return (
    <Dialog open={target !== null} onOpenChange={(open) => !open && onClose()}>
      {/* 正文可能几十 KB：整窗封顶 + 头部/页脚固定、只有正文区滚动。
          上限取 min(70vh, 36rem)：短文档不该占满视口（这是嵌在详情页上的二级
          窗口，全屏高会把底下的详情整页盖掉），长文档又确实需要一个能滚动的
          阅读区。少了 max-h，minmax(0,1fr) 那行没有可解算的高度，会一路撑到
          内容高度并溢出视口。 */}
      <DialogContent className="max-h-[min(70vh,36rem)] grid-rows-[auto_minmax(0,1fr)_auto] gap-0 overflow-hidden rounded-2xl p-0 sm:max-w-3xl">
        <DialogHeader className="px-6 pt-6 pb-4">
          <DialogTitle className="flex items-center gap-2 text-base">
            {target?.name ?? ""}
            {target && (
              <Badge variant="secondary" className="font-normal">
                {COMPONENT_KIND_LABEL[target.kind]}
              </Badge>
            )}
          </DialogTitle>
          <DialogDescription className="text-xs">
            内容来自插件安装目录，只读。
          </DialogDescription>
        </DialogHeader>
        <div className="min-h-0 overflow-y-auto px-6 pb-6">
          {!target || !state || state.status === "loading" ? (
            <p className="text-muted-foreground flex items-center gap-2 text-sm">
              <Loader2Icon className="size-4 animate-spin" />
              正在读取内容…
            </p>
          ) : state.status === "error" ? (
            <p className="text-destructive text-sm break-words">{state.text}</p>
          ) : (
            <>
              <ComponentDocView
                markdown={target.kind === "skill"}
                content={state.content}
              />
            </>
          )}
        </div>
        <DialogFooter className="px-6 py-4">
          <Button variant="outline" onClick={onClose}>
            关闭
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

/** 组件条目卡：名称 + 启用状态点 + 描述（网格排布）+ "查看内容"入口。
 *  pluginId 为 null 时（市场里未安装的条目）没有本地文件可读，不给入口。 */
const ComponentCard: FC<{
  name: string;
  description: string;
  enabled: boolean;
  onInspect: (() => void) | null;
  extra?: ReactNode;
}> = ({ name, description, enabled, onInspect, extra }) => (
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
      <ClampedText
        text={description}
        lines={2}
        className="text-muted-foreground mt-1.5 text-[13px] leading-6"
      />
    )}
    {/* 徽标与"查看内容"同处一条弹性行：卡片本体是普通块级容器，而 Badge 和
        Button 都是 inline-flex，直接并排写在 JSX 里会流到同一行、且按钮原先的
        -ml-2 会把它顶进徽标里（截图里 stdio 与按钮贴成一坨就是这个原因）。
        收进 flex + gap 后既有间距，宽度不够时也只会折行而不是重叠。 */}
    {(extra || onInspect) && (
      <div className="mt-2.5 flex flex-wrap items-center gap-2">
        {extra}
        {onInspect && (
          <Button
            variant="ghost"
            size="sm"
            onClick={onInspect}
            className="text-muted-foreground hover:text-foreground h-7 gap-1 px-2 text-xs"
          >
            <EyeIcon className="size-3.5" />
            查看内容
          </Button>
        )}
      </div>
    )}
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
  kind: PiPluginComponentKind;
  /** 未安装的插件没有本地组件文件，传 null 收起"查看内容"入口 */
  pluginId: string | null;
  onInspect: (target: Omit<ComponentDocTarget, "kind">) => void;
  render?: (item: PreviewComponentItem) => ReactNode;
}> = ({ items, kind, pluginId, onInspect, render }) => (
  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
    {items.map((c) => (
      <ComponentCard
        key={c.name}
        name={c.name}
        description={c.description}
        enabled={c.enabled}
        onInspect={
          pluginId ? () => onInspect({ pluginId, name: c.name }) : null
        }
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
  // 组件正文二级弹窗的目标组件（null = 未打开）
  const [docTarget, setDocTarget] = useState<ComponentDocTarget | null>(null);
  const inspect = useCallback(
    (kind: PiPluginComponentKind) => (base: Omit<ComponentDocTarget, "kind">) =>
      setDocTarget({ ...base, kind }),
    [],
  );
  // 关掉详情弹窗时一并收起二级弹窗：否则它会孤零零留在已关闭的详情之上
  useEffect(() => {
    if (preview === null) setDocTarget(null);
  }, [preview]);
  return (
    <>
      <Dialog open={preview !== null} onOpenChange={(open) => !open && onClose()}>
        <DialogContent className="max-h-[85vh] w-[min(92vw,64rem)] max-w-none grid-rows-[auto_minmax(0,1fr)_auto] gap-0 overflow-hidden rounded-2xl p-0 sm:max-w-none">
        {/* 头部：大图标 + 名称/徽标/来源，底部分隔线 */}
        <div className="px-8 pt-7 pb-6">
          <DialogHeader>
            <div className="flex items-start gap-5 pr-8">
              <div className="bg-background grid size-16 shrink-0 place-items-center overflow-hidden rounded-2xl ">
                <PluginIcon src={preview?.icon} name={preview?.name} className="size-10 text-xl" />
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
              hint="Skills 会在与对话相关时由智能体自动调用。点标题右侧箭头可展开查看 SKILL.md 原文。"
            >
              <ComponentGrid
                items={components.skills}
                kind="skill"
                pluginId={installed?.pluginId ?? null}
                onInspect={inspect("skill")}
              />
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
                kind="mcp"
                pluginId={installed?.pluginId ?? null}
                onInspect={inspect("mcp")}
                render={(c) =>
                  c.transport ? (
                    <Badge
                      variant="outline"
                      className="px-1.5 font-mono text-[11px] font-normal"
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
              <ComponentGrid
                items={components.subagents}
                kind="subagent"
                pluginId={installed?.pluginId ?? null}
                onInspect={inspect("subagent")}
              />
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

      {/* 组件正文二级弹窗：与详情弹窗平级（不嵌在 DialogContent 内），
          关闭详情时由上面的 effect 连带收起，不会孤零零留在已关的详情之上 */}
      <ComponentDocDialog target={docTarget} onClose={() => setDocTarget(null)} />
    </>
  );
};
