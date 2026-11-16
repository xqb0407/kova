"use client";

/**
 * Connectors 市场（市场页「连接器」段）。
 *
 * 数据源是本地静态目录（lib/connectors/catalog.ts），不走网络。安装动作与
 * 设置页/MCP 市场同一条 saveMcpServer 管道：HTTP 传输 + connectorId 标识；
 * OAuth 服务器加完后在 MCP 管理页点「授权」（authorize_mcp_server 两段式）。
 *
 * 版式对齐 MCP 市场：搜索工具行 + 行卡片 + 详情弹窗（层级选择 + OAuth 说明）。
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
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from "@/components/ui/dialog";
import { Segmented } from "@/components/custom-ui/segmented";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { WorkspaceCreateDialog } from "@/components/agent-thread/workspace-create-dialog";
import { PluginIcon } from "@/components/marketplace/plugin-icon";
import { SkillMarketToolbar } from "@/components/marketplace/skill-market-toolbar";
import { useProjectWorkspaceDir } from "@/lib/pi/pi-projects";
import {
  CONNECTOR_CATALOG,
  connectorDraft,
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
      className="hover:bg-muted/40 flex cursor-pointer items-center gap-3.5 rounded-xl p-3 transition-colors outline-none focus-visible:bg-muted/40"
    >
      <div className="bg-background grid size-10 shrink-0 place-items-center overflow-hidden rounded-lg border">
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
  // 工作区级安装的 cwd 语义是目录（<cwd>/.kova/mcp.json），与 MCP 市场同口径
  const workspace = useProjectWorkspaceDir();
  const [scope, setScope] = useState<"system" | "workspace">("system");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [workspacePickOpen, setWorkspacePickOpen] = useState(false);

  useEffect(() => {
    if (target) {
      setScope(target.defaultLayer);
      setBusy(false);
      setError(null);
    }
  }, [target]);

  if (!target) return null;
  const workspaceMissing = scope === "workspace" && !workspace;

  const install = async () => {
    if (busy || installedByConnector) return;
    if (workspaceMissing) {
      setError(t("marketplace.connectors.workspaceMissingError"));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await saveMcpServer({
        layer: scope,
        // save 的 cwd 语义是目录（写入 <cwd>/.kova/mcp.json），不是项目 id
        cwd: scope === "workspace" ? workspace : undefined,
        definition: connectorDraft(target, scope),
      });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
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
            <div className="flex items-center gap-3">
              <span className="text-muted-foreground shrink-0 text-[13px]">
                {t("marketplace.connectors.installTo")}
              </span>
              <Segmented
                value={scope}
                onChange={setScope}
                options={[
                  { value: "system", label: t("marketplace.connectors.systemScope") },
                  { value: "workspace", label: t("marketplace.connectors.workspaceScope") },
                ]}
              />
              <span className="text-muted-foreground min-w-0 flex-1 truncate font-mono text-3xs">
                {scope === "system"
                  ? t("marketplace.connectors.systemPath")
                  : (workspace ?? t("marketplace.connectors.noWorkspace"))}
              </span>
            </div>
            {scope === "workspace" && !workspace ? (
              <p className="text-muted-foreground text-[13px] leading-5">
                {t("marketplace.connectors.workspaceHelp")}
              </p>
            ) : null}
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
            {scope === "workspace" && !workspace ? (
              <Button variant="outline" onClick={() => setWorkspacePickOpen(true)}>
                {t("marketplace.connectors.chooseWorkspace")}
              </Button>
            ) : null}
            <Button onClick={() => void install()} disabled={busy || installedByConnector}>
              {installedByConnector ? t("marketplace.connectors.added") : t("marketplace.connectors.install")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <WorkspaceCreateDialog
        open={workspacePickOpen}
        onClose={() => setWorkspacePickOpen(false)}
      />
    </>
  );
};

export const ConnectorsMarket: FC = () => {
  const t = useT();
  // 与 MCP 市场同口径：useMcpServers/保存的 cwd 都是目录（项目主目录）
  const workspace = useProjectWorkspaceDir();
  const mcpSnap = useMcpServers(workspace);
  const [query, setQuery] = useState("");
  const [detail, setDetail] = useState<ConnectorCatalogEntry | null>(null);

  const installedIds = useMemo(() => {
    const set = new Set<string>();
    for (const server of [...mcpSnap.servers, ...mcpSnap.pluginServers]) {
      if (server.connectorId) set.add(server.connectorId);
    }
    return set;
  }, [mcpSnap.servers, mcpSnap.pluginServers]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return CONNECTOR_CATALOG;
    return CONNECTOR_CATALOG.filter(
      (entry) =>
        entry.title.toLowerCase().includes(q) ||
        entry.description.toLowerCase().includes(q),
    );
  }, [query]);

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
      <div className="mt-3 min-h-0 flex-1 overflow-y-auto pb-6">
        {visible.length === 0 ? (
          <div className="text-muted-foreground flex flex-col items-center justify-center gap-2 py-20 text-sm">
            <PackageOpenIcon className="size-8" />
            {query ? t("marketplace.connectors.noMatch", { query }) : t("marketplace.connectors.empty")}
          </div>
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(340px,1fr))] gap-x-6 gap-y-1">
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
