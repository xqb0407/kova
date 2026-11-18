"use client";

/**
 * Connectors 市场（市场页「连接器」段）。
 *
 * 数据源是本地静态目录（lib/connectors/catalog.ts），不走网络。安装动作与
 * 设置页/MCP 市场同一条 saveMcpServer 管道：HTTP 传输 + connectorId 标识；
 * OAuth 服务器加完后在 MCP 管理页点「授权」（authorize_mcp_server 两段式）。
 *
 * 版式对齐 MCP 市场：搜索工具行 + 分类 chips + 行卡片 + 详情弹窗（OAuth 说明）；
 * 连接器一律系统级安装（账号级 OAuth 凭据，本机全局生效，无工作区级选项）。
 */
import { useEffect, useMemo, useState, type FC } from "react";
import {
  BadgeCheckIcon,
  ExternalLinkIcon,
  KeyRoundIcon,
  PackageOpenIcon,
  ShieldCheckIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from "@/components/ui/dialog";
import { PluginIcon } from "@/components/marketplace/plugin-icon";
import { SkillMarketToolbar } from "@/components/marketplace/skill-market-toolbar";
import { useProjectWorkspaceDir } from "@/lib/pi/pi-projects";
import {
  CONNECTOR_CATALOG,
  connectorDraft,
  connectorForUrl,
  type ConnectorCatalogEntry,
} from "@/lib/connectors/catalog";
import { saveMcpServer, useMcpServers } from "@/lib/mcp/mcp";
import { useT } from "@/lib/i18n";

const ConnectorCard: FC<{
  entry: ConnectorCatalogEntry;
  installed: boolean;
  onOpen: () => void;
}> = ({ entry, installed, onOpen }) => {
  const t = useT();
  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={t("marketplace.connectors.cardAria", { title: entry.title })}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen();
        }
      }}
      title={t("marketplace.connectors.cardOpen")}
      className="hover:bg-muted/40 focus-visible:bg-muted/40 border-border/50 flex cursor-pointer items-center gap-3.5 rounded-xl border p-3 transition-colors outline-none"
    >
      <div className="bg-background grid size-10 shrink-0 place-items-center overflow-hidden rounded-lg">
        <PluginIcon src={entry.iconUrl} name={entry.title} className="text-lg" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="truncate text-sm font-medium">{entry.title}</span>
          <Badge variant="secondary" className="shrink-0 gap-0.5 px-1.5 text-2xs font-normal">
            <BadgeCheckIcon className="size-3" />
            {t("marketplace.connectors.verified")}
          </Badge>
          <Badge variant="outline" className="shrink-0 px-1.5 text-2xs font-normal">
            {entry.auth === "oauth"
              ? t("marketplace.connectors.oauth")
              : entry.auth === "header"
                ? t("marketplace.connectors.header")
                : t("marketplace.connectors.none")}
          </Badge>
          {installed && (
            <Badge variant="outline" className="shrink-0 px-1.5 text-2xs font-normal">
              {t("marketplace.connectors.added")}
            </Badge>
          )}
        </div>
        <p className="text-muted-foreground mt-0.5 truncate text-xs leading-5">
          {entry.description || t("marketplace.connectors.noDescription")}
        </p>
      </div>
    </div>
  );
};

const ConnectorDetailDialog: FC<{
  target: ConnectorCatalogEntry | null;
  installedByConnector: boolean;
  onClose: () => void;
}> = ({ target, installedByConnector, onClose }) => {
  const t = useT();
  // 连接器是账号级 OAuth 凭据，一律系统级安装（~/.kova/mcp.json，本机全局生效）
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (target) {
      setBusy(false);
      setError(null);
    }
  }, [target]);

  if (!target) return null;

  const install = async () => {
    if (busy || installedByConnector) return;
    setBusy(true);
    setError(null);
    try {
      await saveMcpServer({
        layer: "system",
        definition: connectorDraft(target),
      });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="flex max-h-[calc(100dvh-6rem)] w-full flex-col gap-0 overflow-hidden p-0 sm:max-w-xl">
        <div className="flex shrink-0 items-start gap-4 px-6 py-5 pr-14">
          <div className="bg-muted/40 grid size-12 shrink-0 place-items-center overflow-hidden rounded-2xl">
            <PluginIcon src={target.iconUrl} name={target.title} className="text-xl" />
          </div>
          <div className="min-w-0 flex-1">
            <DialogTitle className="flex flex-wrap items-center gap-2 text-xl font-semibold tracking-tight">
              <span className="truncate">{target.title}</span>
              <Badge variant="secondary" className="shrink-0 gap-0.5 font-normal">
                <ShieldCheckIcon className="size-3" />
                {t("marketplace.connectors.verified")}
              </Badge>
              {installedByConnector && (
                <Badge variant="outline" className="shrink-0 font-normal">
                  {t("marketplace.connectors.added")}
                </Badge>
              )}
            </DialogTitle>
            <DialogDescription className="mt-1 line-clamp-3">
              {target.description || t("marketplace.connectors.noDescription")}
            </DialogDescription>
          </div>
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-6 pb-4">
          {target.toolsPreview?.length ? (
            <p className="text-muted-foreground text-[13px] leading-5">
              {t("marketplace.connectors.toolsPreview", {
                tools: target.toolsPreview.join(" · "),
              })}
            </p>
          ) : null}
          {target.auth === "oauth" ? (
            <div className="bg-amber-500/10 text-amber-700 dark:text-amber-400 flex items-start gap-2 rounded-lg px-3 py-2 text-[13px] leading-5">
              <KeyRoundIcon className="mt-0.5 size-3.5 shrink-0" />
              <span>{t("marketplace.connectors.oauthNote")}</span>
            </div>
          ) : null}
          <div className="bg-muted/40 rounded-lg px-3 py-2 text-[13px] leading-5">
            {t("marketplace.connectors.warning")}
          </div>
          {error ? <p className="text-destructive text-[13px] leading-5">{error}</p> : null}
        </div>

        <DialogFooter className="shrink-0 border-t px-6 py-3">
          {target.docsUrl ? (
            <Button
              variant="ghost"
              className="mr-auto gap-1"
              onClick={() => void import("@/lib/external-link").then((m) => m.openExternal(target.docsUrl!))}
            >
              <ExternalLinkIcon className="size-3.5" />
              {t("marketplace.connectors.docs")}
            </Button>
          ) : null}
          <Button onClick={() => void install()} disabled={busy || installedByConnector}>
            {installedByConnector ? t("marketplace.connectors.added") : t("marketplace.connectors.install")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export const ConnectorsMarket: FC = () => {
  const t = useT();
  // 与 MCP 市场同口径：useMcpServers/保存的 cwd 都是目录（项目主目录）
  const workspace = useProjectWorkspaceDir();
  const mcpSnap = useMcpServers(workspace);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<
    "all" | ConnectorCatalogEntry["category"]
  >("all");
  const [detail, setDetail] = useState<ConnectorCatalogEntry | null>(null);

  // 已装判定两条路：connectorId 正向识别（连接器管道装的）+ URL 反向识别。
  // 插件/MCP 市场/手写配置装入的同源服务器没有 connectorId，只按 URL 比对，
  // 避免同一端点被引导重复添加。
  const installedIds = useMemo(() => {
    const set = new Set<string>();
    const all = [...mcpSnap.servers, ...mcpSnap.pluginServers];
    for (const server of all) {
      if (server.connectorId) set.add(server.connectorId);
    }
    for (const entry of CONNECTOR_CATALOG) {
      if (all.some((server) => connectorForUrl(server.url)?.id === entry.id)) {
        set.add(entry.id);
      }
    }
    return set;
  }, [mcpSnap.servers, mcpSnap.pluginServers]);

  // 分类 chip：顺序沿用目录出现顺序，没有条目的分类不出现（新增条目自动带出）
  const categories = useMemo(() => {
    const seen: ConnectorCatalogEntry["category"][] = [];
    for (const entry of CONNECTOR_CATALOG) {
      if (!seen.includes(entry.category)) seen.push(entry.category);
    }
    return seen;
  }, []);

  /** 分类标签走词典字面量键（键位守卫测试只认字面量） */
  const categoryLabel = (key: ConnectorCatalogEntry["category"]): string => {
    switch (key) {
      case "code":
        return t("marketplace.connectors.categories.code");
      case "docs":
        return t("marketplace.connectors.categories.docs");
      case "project":
        return t("marketplace.connectors.categories.project");
      case "chat":
        return t("marketplace.connectors.categories.chat");
      case "data":
        return t("marketplace.connectors.categories.data");
      case "business":
        return t("marketplace.connectors.categories.business");
      case "automation":
        return t("marketplace.connectors.categories.automation");
      case "design":
        return t("marketplace.connectors.categories.design");
    }
  };

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return CONNECTOR_CATALOG.filter((entry) => {
      if (category !== "all" && entry.category !== category) return false;
      if (!q) return true;
      return (
        entry.title.toLowerCase().includes(q) ||
        entry.description.toLowerCase().includes(q)
      );
    });
  }, [query, category]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <SkillMarketToolbar
        query={query}
        onQueryChange={setQuery}
        placeholder={t("marketplace.connectors.searchPlaceholder")}
        ariaLabel={t("marketplace.connectors.searchAria")}
        loading={false}
        onRefresh={() => {}}
        hint={t("marketplace.connectors.hint")}
        inputClassName="w-72"
      />
      {/* 分类 chips：版式对齐插件段的筛选 chip（全部 + 各分类，含计数） */}
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {(
          [
            {
              value: "all" as const,
              label: t("marketplace.connectors.categories.all"),
              count: CONNECTOR_CATALOG.length,
            },
            ...categories.map((key) => ({
              value: key,
              label: categoryLabel(key),
              count: CONNECTOR_CATALOG.filter((e) => e.category === key).length,
            })),
          ]
        ).map(({ value, label, count }) => {
          const active = category === value;
          return (
            <button
              key={value}
              type="button"
              onClick={() => setCategory(value)}
              aria-pressed={active}
              className={
                "h-8 rounded-lg border px-3 text-sm transition-colors " +
                (active
                  ? "bg-muted text-foreground border-transparent font-medium"
                  : "text-muted-foreground hover:bg-muted/50 border-border/60")
              }
            >
              {label}
              <span className="text-muted-foreground/70 ml-1 tabular-nums">
                {count}
              </span>
            </button>
          );
        })}
      </div>
      <div className="mt-3 min-h-0 flex-1 overflow-y-auto pb-6">
        {visible.length === 0 ? (
          <div className="text-muted-foreground flex flex-col items-center justify-center gap-2 py-20 text-sm">
            <PackageOpenIcon className="size-8" />
            {query ? t("marketplace.connectors.noMatch", { query }) : t("marketplace.connectors.empty")}
          </div>
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(340px,1fr))] gap-x-6 gap-y-2">
            {visible.map((entry) => (
              <ConnectorCard
                key={entry.id}
                entry={entry}
                installed={installedIds.has(entry.id)}
                onOpen={() => setDetail(entry)}
              />
            ))}
          </div>
        )}
      </div>
      <ConnectorDetailDialog
        target={detail}
        installedByConnector={detail ? installedIds.has(detail.id) : false}
        onClose={() => setDetail(null)}
      />
    </div>
  );
};
