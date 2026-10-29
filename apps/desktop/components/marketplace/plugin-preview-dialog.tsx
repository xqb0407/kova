"use client";

/**
 * 插件预览弹窗：市场卡片与已装列表共用（点卡片/详情唤起）。
 * 版式对齐主流插件市场详情页：头部大图标 + 名称/来源，正文按「描述 → 组件
 * 清单（技能 / MCP / 子智能体 / 面板）→ 诊断 → 详情」分节滚动，清单用单列
 * 行式（图标 + 名称 + 右侧状态胶囊；技能等条目的说明在点开的正文里），最底部
 * 只留一条整宽主操作（安装/更新/启停）；次要动作收进右上「⋯」菜单。本组件纯
 * 展示，动作由调用方注入。关闭态（preview=null）children 仍挂载，一律按空值
 * 安全求值。
 */
import dynamic from "next/dynamic";
import { useCallback, useEffect, useState, type FC, type ReactNode } from "react";
import {
  BotIcon,
  ChevronRightIcon,
  FileTextIcon,
  LayersIcon,
  Loader2Icon,
  MoreHorizontalIcon,
  ServerIcon,
  TriangleAlertIcon,
  XIcon,
} from "lucide-react";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import {
  getPluginComponentDoc,
  type PluginEntry,
  type PiPluginComponentKind,
} from "@/lib/plugins/plugins";
import { PluginIcon } from "@/components/marketplace/plugin-icon";

/** 页脚主操作：整宽一条，安装/更新/启停共用 */
export type PluginPreviewPrimaryAction = {
  label: string;
  onClick?: () => void;
  disabled?: boolean;
  busy?: boolean;
  icon?: ReactNode;
  /** 已装/链接装这类纯状态位用 outline，避免一条灰掉的实心大按钮压在页脚 */
  variant?: "default" | "outline";
};

/** 右上「⋯」里的次要动作（卸载 / 链接安装 / 检查更新等） */
export type PluginPreviewMenuAction = {
  label: string;
  onSelect: () => void;
  disabled?: boolean;
  destructive?: boolean;
};

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

/** 正文视图带 Streamdown 重依赖：点开组件行查看原文时才异步拉取，不进市场页首屏包 */
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

/** 分节标题：纯文本 + 计数（参考主流市场详情页的分节法，不用图标抢视线） */
const Section: FC<{ title: string; children: ReactNode }> = ({
  title,
  children,
}) => (
  <section>
    <h3 className="text-muted-foreground mb-1.5 text-sm">{title}</h3>
    {children}
  </section>
);

/** 右侧状态胶囊（对齐参考图「待连接」那种细描边小胶囊） */
const Pill: FC<{ children: ReactNode; mono?: boolean }> = ({
  children,
  mono,
}) => (
  <span
    className={cn(
      "text-muted-foreground inline-flex items-center rounded-lg border px-2 py-0.5 text-xs whitespace-nowrap",
      mono && "font-mono",
    )}
  >
    {children}
  </span>
);

/** 组件条目行：图标 + 名称 + 一句说明 + 右侧胶囊；可查看原文时整行可点。
 *  行本身不画分隔线（参考图技能清单），悬停给一层浅底，点按有明确落点。 */
const ComponentRow: FC<{
  icon: ReactNode;
  name: string;
  description?: ReactNode;
  extra?: ReactNode;
  disabled?: boolean;
  onClick?: (() => void) | null;
}> = ({ icon, name, description, extra, disabled, onClick }) => {
  const body = (
    <>
      <span className="text-muted-foreground mt-1 shrink-0 [&_svg]:size-4">
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span
          className={cn(
            "block truncate text-[15px] leading-6",
            disabled && "text-muted-foreground",
          )}
        >
          {name}
        </span>
        {description && (
          <span className="text-muted-foreground mt-0.5 block text-[13px] leading-5">
            {description}
          </span>
        )}
      </span>
      {extra && <span className="mt-0.5 shrink-0">{extra}</span>}
      {onClick && (
        <ChevronRightIcon className="text-muted-foreground/50 mt-1 size-4 shrink-0" />
      )}
    </>
  );
  const rowClass = "flex w-full items-start gap-3 rounded-xl px-3 py-2.5 text-left";
  return onClick ? (
    <button
      type="button"
      onClick={onClick}
      className={cn(rowClass, "hover:bg-muted/60 transition-colors")}
    >
      {body}
    </button>
  ) : (
    <div className={rowClass}>{body}</div>
  );
};

/** 详情项：上标签下值；span = 独占整行（长路径/关键词） */
const DetailField: FC<{ label: string; value: ReactNode; span?: boolean }> = ({
  label,
  value,
  span,
}) => (
  <div className={cn("min-w-0", span && "col-span-2")}>
    <dt className="text-muted-foreground text-xs">{label}</dt>
    <dd className="mt-1 text-[15px] leading-6 break-words">{value}</dd>
  </div>
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
 *  走二级弹窗而非行内展开：正文可达几十 KB，在详情页里就地展开会把整页
 *  撑成参差的高墙，也把滚动位置挤乱；独立窗口让详情页版式保持不动。 */
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
      <DialogContent className="grid-rows-[auto_minmax(0,1fr)_auto] gap-0 overflow-hidden rounded-2xl p-0 max-h-[min(70vh,36rem)] sm:max-w-3xl">
        <div className="px-6 pt-6 pb-4">
          <DialogTitle className="flex items-center gap-2 text-base">
            {target?.name ?? ""}
            {target && (
              <Badge variant="secondary" className="font-normal">
                {COMPONENT_KIND_LABEL[target.kind]}
              </Badge>
            )}
          </DialogTitle>
          <DialogDescription className="mt-1.5 text-xs">
            内容来自插件安装目录，只读。
          </DialogDescription>
        </div>
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
        <div className="flex justify-end px-6 py-4">
          <Button variant="outline" onClick={onClose}>
            关闭
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
};

export const PluginPreviewDialog: FC<{
  preview: PluginPreviewData | null;
  onClose: () => void;
  /** 页脚整宽主操作（安装 / 更新 / 启停）；null = 不渲染页脚 */
  primaryAction?: PluginPreviewPrimaryAction | null;
  /** 右上「⋯」菜单的次要动作；空数组 = 不显示菜单 */
  menuActions?: PluginPreviewMenuAction[];
  /** 主操作下方的补充说明（如内置插件不可卸载） */
  footerNote?: ReactNode;
}> = ({ preview, onClose, primaryAction, menuActions, footerNote }) => {
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
  const hasMenu = Boolean(menuActions && menuActions.length > 0);
  const noComponents = components
    ? components.skills.length === 0 &&
      components.mcpServers.length === 0 &&
      components.subagents.length === 0 &&
      components.panels.length === 0
    : false;
  const version = installed?.version ?? preview?.version;

  return (
    <>
      <Dialog open={preview !== null} onOpenChange={(open) => !open && onClose()}>
        <DialogContent
          showCloseButton={false}
          className="grid-rows-[auto_minmax(0,1fr)_auto] gap-0 overflow-hidden rounded-3xl p-0 w-[min(92vw,40rem)] max-w-none max-h-[85vh] sm:max-w-none"
        >
          {/* 头部：64px 图标 + 名称/来源，右上「⋯」与关闭 */}
          <div className="flex items-start gap-4 px-6 pt-6 pb-4">
            <div className="bg-muted/40 grid size-16 shrink-0 place-items-center overflow-hidden rounded-2xl">
              <PluginIcon
                src={preview?.icon}
                name={preview?.name}
                className="size-16 text-2xl"
              />
            </div>
            <div className="min-w-0 flex-1 pr-16">
              <DialogTitle className="truncate text-[22px] leading-7 font-semibold tracking-tight">
                {preview?.name ?? ""}
              </DialogTitle>
              <DialogDescription className="mt-1 text-sm">
                来自 {preview?.marketplaceName ?? ""}
              </DialogDescription>
              {(installed?.linked ||
                installed?.sourceMissing ||
                (installed && !installed.enabled)) && (
                <div className="mt-2 flex flex-wrap items-center gap-1.5">
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
                    <Badge
                      variant="outline"
                      className="text-muted-foreground font-normal"
                    >
                      已停用
                    </Badge>
                  )}
                </div>
              )}
            </div>
          </div>

          <div className="absolute top-5 right-4 flex items-center gap-0.5">
            {hasMenu && (
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <button
                      type="button"
                      aria-label="更多操作"
                      className="text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:bg-muted focus-visible:text-foreground grid size-7 place-items-center rounded-lg outline-none transition-colors"
                    />
                  }
                >
                  <MoreHorizontalIcon className="size-4" />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-44">
                  {menuActions!.map((action) => (
                    <DropdownMenuItem
                      key={action.label}
                      disabled={action.disabled}
                      variant={action.destructive ? "destructive" : "default"}
                      onClick={action.onSelect}
                    >
                      {action.label}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
            <DialogClose
              aria-label="关闭"
              className="text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:bg-muted focus-visible:text-foreground grid size-7 place-items-center rounded-lg outline-none transition-colors"
            >
              <XIcon className="size-4" />
            </DialogClose>
          </div>

          {/* 正文：分节滚动；上下缘各留一段渐隐，内容滑到头部/页脚边界时
              不会像被硬切一刀。上 16px 对应 pt-4 的留白，停在顶部时淡掉的
              只是留白；下 24px 对应 pb-8 的留白，滚到底也看不到文字被切。 */}
          <div className="min-h-0 overflow-y-auto px-6 pt-4 pb-8 [mask-image:linear-gradient(to_bottom,transparent,black_16px,black_calc(100%_-_24px),transparent)] [-webkit-mask-image:linear-gradient(to_bottom,transparent,black_16px,black_calc(100%_-_24px),transparent)]">
            <div className="space-y-7">
              <p className="text-[15px] leading-7 whitespace-pre-line">
                {preview?.description || (
                  <span className="text-muted-foreground">暂无描述。</span>
                )}
              </p>

              {components && components.skills.length > 0 && (
                <Section title={`技能 ${components.skills.length}`}>
                  <div className="-mx-3">
                    {components.skills.map((c) => (
                      <ComponentRow
                        key={c.name}
                        icon={<FileTextIcon />}
                        name={c.name}
                        disabled={!c.enabled}
                        onClick={
                          installed
                            ? () =>
                                inspect("skill")({
                                  pluginId: installed.pluginId,
                                  name: c.name,
                                })
                            : null
                        }
                      />
                    ))}
                  </div>
                </Section>
              )}

              {components && components.mcpServers.length > 0 && (
                <Section title={`MCP 服务器 ${components.mcpServers.length}`}>
                  <div className="-mx-3">
                    {components.mcpServers.map((c) => (
                      <ComponentRow
                        key={c.name}
                        icon={<ServerIcon />}
                        name={c.name}
                        disabled={!c.enabled}
                        extra={
                          c.transport ? <Pill mono>{c.transport}</Pill> : null
                        }
                        onClick={
                          installed
                            ? () =>
                                inspect("mcp")({
                                  pluginId: installed.pluginId,
                                  name: c.name,
                                })
                            : null
                        }
                      />
                    ))}
                  </div>
                </Section>
              )}

              {components && components.subagents.length > 0 && (
                <Section title={`子智能体 ${components.subagents.length}`}>
                  <div className="-mx-3">
                    {components.subagents.map((c) => (
                      <ComponentRow
                        key={c.name}
                        icon={<BotIcon />}
                        name={c.name}
                        disabled={!c.enabled}
                        onClick={
                          installed
                            ? () =>
                                inspect("subagent")({
                                  pluginId: installed.pluginId,
                                  name: c.name,
                                })
                            : null
                        }
                      />
                    ))}
                  </div>
                </Section>
              )}

              {components && components.panels.length > 0 && (
                <Section title={`面板 ${components.panels.length}`}>
                  <div className="-mx-3">
                    {components.panels.map((panel) => (
                      <ComponentRow
                        key={panel.id}
                        icon={<LayersIcon />}
                        name={panel.title}
                        description={
                          <>
                            {panel.opens.length > 0 && (
                              <span className="block font-mono text-xs break-all">
                                {panel.opens.join("  ")}
                              </span>
                            )}
                            {panel.permissions.length > 0 && (
                              <span className="block text-xs">
                                权限：{panel.permissions.join(" / ")}
                              </span>
                            )}
                          </>
                        }
                      />
                    ))}
                  </div>
                </Section>
              )}

              {components && noComponents && (
                <p className="text-muted-foreground text-sm">
                  该插件不包含可列出的组件。
                </p>
              )}

              {installed && installed.diagnostics.length > 0 && (
                <Section title="诊断">
                  <ul className="text-amber-700 dark:text-amber-500 space-y-1 rounded-2xl border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-[13px] leading-6">
                    {installed.diagnostics.map((d) => (
                      <li key={d} className="flex items-start gap-2">
                        <TriangleAlertIcon className="mt-1 size-3.5 shrink-0" />
                        <span>{d}</span>
                      </li>
                    ))}
                  </ul>
                </Section>
              )}

              {/* 详情：市场条目与已装共用一张网格 */}
              <Section title="详情">
                <dl className="grid grid-cols-2 gap-x-6 gap-y-4 rounded-2xl border p-5">
                  {version && (
                    <DetailField
                      label="版本"
                      value={<span className="font-mono">v{version}</span>}
                    />
                  )}
                  {preview?.category && (
                    <DetailField label="分类" value={preview.category} />
                  )}
                  <DetailField
                    label="来源市场"
                    value={preview?.marketplaceName ?? ""}
                  />
                  {installed && (
                    <DetailField
                      label="清单类型"
                      value={MANIFEST_KIND_LABEL[installed.manifestKind]}
                    />
                  )}
                  {installed && (
                    <DetailField
                      label="状态"
                      value={installed.enabled ? "已启用" : "已停用"}
                    />
                  )}
                  {installed && (
                    <DetailField
                      label="安装时间"
                      value={formatInstalledAt(installed.installedAt)}
                    />
                  )}
                  {preview?.keywords && preview.keywords.length > 0 && (
                    <DetailField
                      span
                      label="关键词"
                      value={
                        <span className="flex flex-wrap gap-1.5">
                          {preview.keywords.map((k) => (
                            <span
                              key={k}
                              className="bg-muted/60 text-muted-foreground rounded-md px-1.5 py-0.5 text-xs"
                            >
                              {k}
                            </span>
                          ))}
                        </span>
                      }
                    />
                  )}
                  {installed?.linked && installed.sourcePath && (
                    <DetailField
                      span
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
            </div>
          </div>

          {(primaryAction || footerNote) && (
            <div className="px-6 pt-2 pb-6">
              {primaryAction && (
                <Button
                  size="lg"
                  variant={primaryAction.variant ?? "default"}
                  className={cn(
                    "h-11 w-full rounded-xl text-[15px] font-medium",
                    // 状态位（outline + disabled）要读得清：只压低交互感，不再叠一层 50% 透明
                    primaryAction.variant === "outline" && "disabled:opacity-100",
                  )}
                  disabled={primaryAction.disabled}
                  onClick={primaryAction.onClick}
                >
                  {primaryAction.busy ? (
                    <Loader2Icon className="size-4 animate-spin" />
                  ) : (
                    primaryAction.icon
                  )}
                  {primaryAction.label}
                </Button>
              )}
              {footerNote && (
                <p className="text-muted-foreground mt-2 text-center text-xs">
                  {footerNote}
                </p>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* 组件正文二级弹窗：与详情弹窗平级（不嵌在 DialogContent 内），
          关闭详情时由上面的 effect 连带收起，不会孤零零留在已关的详情之上 */}
      <ComponentDocDialog target={docTarget} onClose={() => setDocTarget(null)} />
    </>
  );
};
