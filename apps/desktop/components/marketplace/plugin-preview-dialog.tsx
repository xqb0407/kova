"use client";

/**
 * 插件预览弹窗：市场卡片与已装列表共用（点卡片/详情唤起）。
 * 版式对齐主流插件市场详情页：头部大图标 + 名称/来源，正文按「描述 → 组件
 * 清单（技能 / MCP / 子智能体 / 钩子 / 面板）→ 诊断 → 详情」分节滚动，清单用单列
 * 行式（图标 + 名称 + 右侧状态胶囊；技能等条目的说明在点开的正文里），最底部
 * 只留一条整宽主操作（安装/更新/启停）；次要动作收进右上「⋯」菜单。本组件纯
 * 展示，动作由调用方注入。关闭态（preview=null）children 仍挂载，一律按空值
 * 安全求值。
 */
import dynamic from "next/dynamic";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FC,
  type ReactNode,
} from "react";
import {
  BotIcon,
  ChevronRightIcon,
  FileTextIcon,
  LayersIcon,
  Loader2Icon,
  MoreHorizontalIcon,
  ServerIcon,
  TriangleAlertIcon,
  WebhookIcon,
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
import { connectorForUrl } from "@/lib/connectors/catalog";
import {
  authorizeMcpServer,
  setMcpAuthHandler,
  useMcpServers,
} from "@/lib/mcp/mcp";
import { useProjectWorkspaceDir } from "@/lib/pi/pi-projects";
import { getLocale, t as translate, useT } from "@/lib/i18n";
import { toast } from "@/components/ui/toast";

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
  /** 展示名（可中文）；缺省回退 name */
  displayName?: string;
  version?: string;
  description?: string;
  icon?: string;
  category?: string;
  keywords?: string[];
  marketplaceName: string;
  /** 已装镜像；null = 市场里未安装的条目 */
  installed: PluginEntry | null;
  /** 未安装条目：市场源现读的组件清单（已装时忽略，用 installed.components） */
  components?: PluginEntry["components"];
  /** 未安装条目的组件清单读取中 */
  componentsLoading?: boolean;
  /** 未安装条目的组件清单读取失败（目录未刷新/源目录缺失） */
  componentsError?: string;
  /** 未安装条目：清单生态来源与解析诊断 */
  manifestKind?: PluginEntry["manifestKind"];
  diagnostics?: string[];
};

/** 正文视图带 Streamdown 重依赖：点开组件行查看原文时才异步拉取，不进市场页首屏包 */
const ComponentDocView = dynamic(() => import("./component-doc-view"), {
  ssr: false,
  // 分块在飞的时候留一行占位：只渲染 null 会在正文已到手、视图还没到位时
  // 露出一块空白，看着像"内容是空的"
  loading: () => (
    <p className="text-muted-foreground mt-3 text-sm">
      {translate("marketplace.preview.loadingView")}
    </p>
  ),
});

const MANIFEST_KIND_LABEL_KEY: Record<PluginEntry["manifestKind"], string> = {
  kova: "kova",
  claude: "marketplace.plugins.manifest.claude",
  codex: "marketplace.plugins.manifest.codex",
};

function formatInstalledAt(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleString(getLocale() === "zh" ? "zh-CN" : "en-US");
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
 *  行本身不画分隔线（参考图技能清单），悬停给一层浅底，点按有明确落点。
 *  action = 行内实体按钮（连接器行「待连接/授权」）：button 不能嵌套，
 *  有 action 时整行降级为 div（放弃原文点入，连接好后恢复）。 */
const ComponentRow: FC<{
  icon: ReactNode;
  name: string;
  description?: ReactNode;
  extra?: ReactNode;
  action?: ReactNode;
  disabled?: boolean;
  onClick?: (() => void) | null;
}> = ({ icon, name, description, extra, action, disabled, onClick }) => {
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
      {action && <span className="mt-0.5 shrink-0">{action}</span>}
      {!action && onClick && (
        <ChevronRightIcon className="text-muted-foreground/50 mt-1 size-4 shrink-0" />
      )}
    </>
  );
  const rowClass = "flex w-full items-start gap-3 rounded-xl px-3 py-2.5 text-left";
  return onClick && !action ? (
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
  /** 展示名（弹窗标题） */
  name: string;
  /** 取文用的稳定键：钩子传 id，同名条目也能精确命中 */
  docKey?: string;
};

const COMPONENT_KIND_LABEL_KEY: Record<PiPluginComponentKind, string> = {
  skill: "marketplace.preview.component.skill",
  mcp: "marketplace.preview.component.mcp",
  subagent: "marketplace.preview.component.subagent",
  hook: "marketplace.preview.component.hook",
};

/** 钩子事件标签（与设置 → 钩子页保持同一套文案） */
const HOOK_EVENT_LABEL_KEY: Record<string, string> = {
  SessionStart: "marketplace.preview.hookEvent.SessionStart",
  UserPromptSubmit: "marketplace.preview.hookEvent.UserPromptSubmit",
  PreToolUse: "marketplace.preview.hookEvent.PreToolUse",
  PermissionRequest: "marketplace.preview.hookEvent.PermissionRequest",
  Notification: "marketplace.preview.hookEvent.Notification",
  PostToolUse: "marketplace.preview.hookEvent.PostToolUse",
  PostToolUseFailure: "marketplace.preview.hookEvent.PostToolUseFailure",
  Stop: "marketplace.preview.hookEvent.Stop",
  SubagentStop: "marketplace.preview.hookEvent.SubagentStop",
  PreCompact: "marketplace.preview.hookEvent.PreCompact",
};

/** 组件正文二级弹窗：按需现取的原文 + 来源路径（懒加载，打开才发请求）。
 *  走二级弹窗而非行内展开：正文可达几十 KB，在详情页里就地展开会把整页
 *  撑成参差的高墙，也把滚动位置挤乱；独立窗口让详情页版式保持不动。 */
const ComponentDocDialog: FC<{
  target: ComponentDocTarget | null;
  onClose: () => void;
}> = ({ target, onClose }) => {
  const t = useT();
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
        const doc = await getPluginComponentDoc(
          target.pluginId,
          target.kind,
          target.docKey ?? target.name,
        );
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
                {t(COMPONENT_KIND_LABEL_KEY[target.kind])}
              </Badge>
            )}
          </DialogTitle>
          <DialogDescription className="mt-1.5 text-xs">
            {t("marketplace.preview.docReadonly")}
          </DialogDescription>
        </div>
        <div className="min-h-0 overflow-y-auto px-6 pb-6">
          {!target || !state || state.status === "loading" ? (
            <p className="text-muted-foreground flex items-center gap-2 text-sm">
              <Loader2Icon className="size-4 animate-spin" />
              {t("marketplace.preview.docLoading")}
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
            {t("marketplace.preview.close")}
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
  /** 主操作下方的补充说明 */
  footerNote?: ReactNode;
}> = ({ preview, onClose, primaryAction, menuActions, footerNote }) => {
  const t = useT();
  // 关闭动画期间父级已把 preview 置空：退场那 100ms 里若直接按空值渲染，
  // 标题/正文/页脚会先被清空再淡出（ESC 关闭时能看到一帧空壳）。这里保留
  // 最后一次打开时的完整快照（含注入的动作），关闭动画走完前一直有效。
  const lastRef = useRef<{
    preview: PluginPreviewData;
    primaryAction?: PluginPreviewPrimaryAction | null;
    menuActions?: PluginPreviewMenuAction[];
    footerNote?: ReactNode;
  } | null>(null);
  if (preview) {
    lastRef.current = { preview, primaryAction, menuActions, footerNote };
  }
  const data = preview ?? lastRef.current?.preview ?? null;
  const activePrimaryAction = preview
    ? primaryAction
    : lastRef.current?.primaryAction;
  const activeMenuActions = preview ? menuActions : lastRef.current?.menuActions;
  const activeFooterNote = preview ? footerNote : lastRef.current?.footerNote;
  const installed = data?.installed ?? null;
  // 未安装条目由市场源现读组件清单（components）；已装条目用快照里的。
  // 两者条目形状一致，下面的分节渲染不分叉
  const components = installed?.components ?? data?.components;
  const diagnostics = installed?.diagnostics ?? data?.diagnostics ?? [];
  const manifestKind = installed?.manifestKind ?? data?.manifestKind;
  const componentsLoading = !installed && data?.componentsLoading === true;
  const componentsError = installed ? undefined : data?.componentsError;
  // 连接器「应用」行：插件 MCP 组件的端点撞连接器目录时亮官方身份 + 内联授权。
  // 服务器连接态来自 MCP 镜像（授权结果帧整包并入，pill 即时翻转）。
  const workspace = useProjectWorkspaceDir();
  const mcpSnap = useMcpServers(workspace);
  const [authBusyName, setAuthBusyName] = useState<string | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);
  // 授权结果帧（第二阶段）：收 busy、成功刷清单（帧自带）、失败呈现原因。
  // ⚠️ setMcpAuthHandler 是全局单槽（lib/mcp 既有设计）：本注册在市场页挂载
  // 期间持有，设置页（mcp-settings）挂载时会覆盖回来——两个视图实际不同时
  // 常驻，风险可控；若未来出现双视图同挂，需重构为共享 auth-flow hook。
  useEffect(() => {
    setMcpAuthHandler((frame) => {
      setAuthBusyName((cur) => (cur === frame.name ? null : cur));
      if (!frame.ok) {
        setAuthError(frame.errorText ?? translate("settings.mcp.authorizeFailedUnknown"));
        return;
      }
      setAuthError(null);
      toast.success({
        title: translate("settings.mcp.authorizeDone", { name: frame.name }),
      });
    });
    return () => setMcpAuthHandler(null);
  }, []);
  const startAuth = useCallback(
    async (serverName: string) => {
      setAuthBusyName(serverName);
      setAuthError(null);
      try {
        const started = await authorizeMcpServer(serverName, workspace);
        if (!started.authUrl) {
          // 握手没走到需要授权那一步（存量凭据仍有效，已直接连上）
          setAuthBusyName(null);
          toast.success({
            title: translate("settings.mcp.testSuccessTitle", { name: serverName }),
            description: translate("settings.mcp.authorizeSuccessDesc"),
          });
          return;
        }
        if (!started.browserOpened) {
          // 浏览器没自动起来：手动打开，别让链接躺在错误文案里
          void import("@/lib/external-link").then((m) => m.openExternal(started.authUrl!));
        }
        // 已拉起浏览器：保持 busy，等结果帧收尾
      } catch (err) {
        setAuthError(err instanceof Error ? err.message : String(err));
        setAuthBusyName(null);
      }
    },
    [workspace],
  );
  // 组件正文二级弹窗的目标组件（null = 未打开）
  const [docTarget, setDocTarget] = useState<ComponentDocTarget | null>(null);
  const inspect = useCallback(
    (kind: PiPluginComponentKind) => (base: Omit<ComponentDocTarget, "kind">) =>
      setDocTarget({ ...base, kind }),
    [],
  );
  // 关掉详情弹窗时一并收起二级弹窗与授权等待态：否则前者孤零零留在已关闭
  // 的详情之上，后者在用户放弃浏览器授权后重开详情会一直卡转圈
  useEffect(() => {
    if (preview === null) {
      setDocTarget(null);
      setAuthBusyName(null);
      setAuthError(null);
    }
  }, [preview]);
  const hasMenu = Boolean(activeMenuActions && activeMenuActions.length > 0);
  const noComponents = components
    ? components.skills.length === 0 &&
      components.mcpServers.length === 0 &&
      components.subagents.length === 0 &&
      (components.hooks?.length ?? 0) === 0 &&
      components.panels.length === 0
    : false;
  const version = installed?.version ?? data?.version;

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
                src={data?.icon}
                name={data?.displayName ?? data?.name}
                className="size-16 text-2xl"
              />
            </div>
            <div className="min-w-0 flex-1 pr-16">
              <DialogTitle className="truncate text-[22px] leading-7 font-semibold tracking-tight">
                {data?.displayName ?? data?.name ?? ""}
              </DialogTitle>
              <DialogDescription className="mt-1 text-sm">
                {t("marketplace.preview.from", {
                  marketplaceName: data?.marketplaceName ?? "",
                })}
              </DialogDescription>
              {(installed?.linked ||
                installed?.sourceMissing ||
                (installed && !installed.enabled)) && (
                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                  {installed?.linked && (
                    <Badge variant="outline" className="font-normal">
                      {t("marketplace.preview.devMode")}
                    </Badge>
                  )}
                  {installed?.sourceMissing && (
                    <Badge variant="destructive" className="font-normal">
                      {t("marketplace.preview.sourceMissing")}
                    </Badge>
                  )}
                  {installed && !installed.enabled && (
                    <Badge
                      variant="outline"
                      className="text-muted-foreground font-normal"
                    >
                      {t("marketplace.preview.disabled")}
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
                      aria-label={t("marketplace.preview.moreActions")}
                      className="text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:bg-muted focus-visible:text-foreground grid size-7 place-items-center rounded-lg outline-none transition-colors"
                    />
                  }
                >
                  <MoreHorizontalIcon className="size-4" />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-44">
                  {activeMenuActions!.map((action) => (
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
              aria-label={t("marketplace.preview.close")}
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
                {data?.description || (
                  <span className="text-muted-foreground">
                    {t("marketplace.preview.noDescription")}
                  </span>
                )}
              </p>

              {/* 未安装条目的组件清单从市场源现读：读取期间给明确进度，
                  失败（目录未刷新/源目录缺失）内联说明，不假装「无组件」 */}
              {componentsLoading && (
                <p className="text-muted-foreground flex items-center gap-2 text-sm">
                  <Loader2Icon className="size-4 animate-spin" />
                  {t("marketplace.preview.componentsLoading")}
                </p>
              )}
              {componentsError && (
                <p className="text-amber-700 dark:text-amber-500 flex items-start gap-2 text-sm">
                  <TriangleAlertIcon className="mt-1 size-3.5 shrink-0" />
                  <span className="break-words">
                    {t("marketplace.preview.componentsUnavailable", {
                      error: componentsError,
                    })}
                  </span>
                </p>
              )}
              {authError && (
                <p className="text-destructive flex items-start gap-2 text-sm">
                  <TriangleAlertIcon className="mt-1 size-3.5 shrink-0" />
                  <span className="break-words">{authError}</span>
                </p>
              )}

              {components && components.skills.length > 0 && (
                <Section
                  title={t("marketplace.preview.section.skills", {
                    count: components.skills.length,
                  })}
                >
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
                <Section
                  title={t("marketplace.preview.section.mcpServers", {
                    count: components.mcpServers.length,
                  })}
                >
                  <div className="-mx-3">
                    {components.mcpServers.map((c) => {
                      // MiniMax「应用」形态：组件端点撞连接器目录 = 同一个官方
                      // 远程 MCP，行升级为应用身份（官方图标 + 连接态 + 内联授权）
                      const connector = connectorForUrl(c.url);
                      if (!connector) {
                        return (
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
                        );
                      }
                      const server = mcpSnap.pluginServers.find(
                        (s) => s.name === c.name,
                      );
                      const st = installed ? server?.status : undefined;
                      const connected = st?.state === "ready";
                      const serverEnabled = server?.enabled !== false;
                      const authAction =
                        installed && !connected && serverEnabled ? (
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-7 px-2.5 text-xs"
                            disabled={authBusyName === c.name || !c.enabled}
                            onClick={() => void startAuth(c.name)}
                          >
                            {authBusyName === c.name ? (
                              <Loader2Icon className="size-3.5 animate-spin" />
                            ) : null}
                            {t("marketplace.preview.connectNow")}
                          </Button>
                        ) : null;
                      return (
                        <ComponentRow
                          key={c.name}
                          icon={
                            <PluginIcon
                              src={connector.iconUrl}
                              name={connector.title}
                              className="size-4"
                            />
                          }
                          name={c.name}
                          disabled={!c.enabled}
                          description={connector.description}
                          extra={
                            <span className="flex shrink-0 items-center gap-1.5">
                              <Pill>{connector.title}</Pill>
                              {!installed ? (
                                <Pill>
                                  {t("marketplace.preview.willInstall")}
                                </Pill>
                              ) : connected ? (
                                <Pill>
                                  {t("marketplace.preview.connected")}
                                </Pill>
                              ) : !serverEnabled ? (
                                <Pill>
                                  {t("marketplace.preview.disabled")}
                                </Pill>
                              ) : st?.state === "connecting" || authBusyName === c.name ? (
                                <Pill>
                                  {t("marketplace.preview.connecting")}
                                </Pill>
                              ) : null}
                            </span>
                          }
                          action={authAction}
                          onClick={
                            connected && installed
                              ? () =>
                                  inspect("mcp")({
                                    pluginId: installed.pluginId,
                                    name: c.name,
                                  })
                              : null
                          }
                        />
                      );
                    })}
                  </div>
                </Section>
              )}

              {components && components.subagents.length > 0 && (
                <Section
                  title={t("marketplace.preview.section.subagents", {
                    count: components.subagents.length,
                  })}
                >
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

              {components && components.hooks && components.hooks.length > 0 && (
                <Section
                  title={t("marketplace.preview.section.hooks", {
                    count: components.hooks.length,
                  })}
                >
                  <div className="-mx-3">
                    {components.hooks.map((c, i) => (
                      <ComponentRow
                        key={`${c.name}-${i}`}
                        icon={<WebhookIcon />}
                        name={c.name}
                        description={
                          c.matcher
                            ? t("marketplace.preview.hookMatcher", {
                                matcher: c.matcher,
                              })
                            : undefined
                        }
                        extra={
                          c.event ? (
                            <span title={c.event}>
                              <Pill>
                                {HOOK_EVENT_LABEL_KEY[c.event]
                                  ? t(HOOK_EVENT_LABEL_KEY[c.event])
                                  : c.event}
                              </Pill>
                            </span>
                          ) : null
                        }
                        disabled={!c.enabled}
                        onClick={
                          installed
                            ? () =>
                                inspect("hook")({
                                  pluginId: installed.pluginId,
                                  name: c.name,
                                  docKey: c.id,
                                })
                            : null
                        }
                      />
                    ))}
                  </div>
                </Section>
              )}

              {components && components.panels.length > 0 && (
                <Section
                  title={t("marketplace.preview.section.panels", {
                    count: components.panels.length,
                  })}
                >
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
                                {t("marketplace.preview.permissions", {
                                  list: panel.permissions.join(" / "),
                                })}
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
                  {t("marketplace.preview.noComponents")}
                </p>
              )}

              {diagnostics.length > 0 && (
                <Section title={t("marketplace.preview.section.diagnostics")}>
                  <ul className="text-amber-700 dark:text-amber-500 space-y-1 rounded-2xl border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-[13px] leading-6">
                    {diagnostics.map((d) => (
                      <li key={d} className="flex items-start gap-2">
                        <TriangleAlertIcon className="mt-1 size-3.5 shrink-0" />
                        <span>{d}</span>
                      </li>
                    ))}
                  </ul>
                </Section>
              )}

              {/* 详情：市场条目与已装共用一张网格 */}
              <Section title={t("marketplace.preview.section.details")}>
                <dl className="grid grid-cols-2 gap-x-6 gap-y-4 rounded-2xl border p-5">
                  {version && (
                    <DetailField
                      label={t("marketplace.preview.detail.version")}
                      value={<span className="font-mono">v{version}</span>}
                    />
                  )}
                  {data?.displayName &&
                    data.displayName !== data.name && (
                      <DetailField
                        label={t("marketplace.preview.detail.name")}
                        value={<span className="font-mono">{data.name}</span>}
                      />
                    )}
                  {data?.category && (
                    <DetailField
                      label={t("marketplace.preview.detail.category")}
                      value={data.category}
                    />
                  )}
                  <DetailField
                    label={t("marketplace.preview.detail.marketplace")}
                    value={data?.marketplaceName ?? ""}
                  />
                  {manifestKind && (
                    <DetailField
                      label={t("marketplace.preview.detail.manifestKind")}
                      value={t(MANIFEST_KIND_LABEL_KEY[manifestKind])}
                    />
                  )}
                  {installed && (
                    <DetailField
                      label={t("marketplace.preview.detail.status")}
                      value={
                        installed.enabled
                          ? t("marketplace.preview.detail.enabled")
                          : t("marketplace.preview.detail.disabled")
                      }
                    />
                  )}
                  {installed && (
                    <DetailField
                      label={t("marketplace.preview.detail.installedAt")}
                      value={formatInstalledAt(installed.installedAt)}
                    />
                  )}
                  {data?.keywords && data.keywords.length > 0 && (
                    <DetailField
                      span
                      label={t("marketplace.preview.detail.keywords")}
                      value={
                        <span className="flex flex-wrap gap-1.5">
                          {data.keywords.map((k) => (
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
                      label={t("marketplace.preview.detail.sourcePath")}
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

          {(activePrimaryAction || activeFooterNote) && (
            <div className="px-6 pt-2 pb-6">
              {activePrimaryAction && (
                <Button
                  size="lg"
                  variant={activePrimaryAction.variant ?? "default"}
                  className={cn(
                    "h-11 w-full rounded-xl text-[15px] font-medium",
                    // 状态位（outline + disabled）要读得清：只压低交互感，不再叠一层 50% 透明
                    activePrimaryAction.variant === "outline" &&
                      "disabled:opacity-100",
                  )}
                  disabled={activePrimaryAction.disabled}
                  onClick={activePrimaryAction.onClick}
                >
                  {activePrimaryAction.busy ? (
                    <Loader2Icon className="size-4 animate-spin" />
                  ) : (
                    activePrimaryAction.icon
                  )}
                  {activePrimaryAction.label}
                </Button>
              )}
              {activeFooterNote && (
                <p className="text-muted-foreground mt-2 text-center text-xs">
                  {activeFooterNote}
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
