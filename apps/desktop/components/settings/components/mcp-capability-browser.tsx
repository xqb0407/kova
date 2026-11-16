"use client";

/**
 * MCP 服务器详情里的 Resources / Prompts 浏览区。
 *
 * 数据源优先 sidecar 元数据缓存（断开态也能看上次握手拿到的面），缺失才
 * 懒连接——与工具清单展开同一节奏。资源预览只走文本通道：sidecar 已做
 * 8KB/1000 行截断与密钥脱敏，二进制 blob 只回占位说明，不把 base64 塞进
 * 设置页或转录。
 */
import { useEffect, useState, type FC } from "react";
import { Loader2Icon } from "lucide-react";
import {
  fetchMcpPrompts,
  fetchMcpResources,
  readMcpResource,
  type McpPrompt,
  type McpResource,
  type McpResourceTemplate,
} from "@/lib/mcp/mcp";
import { useT } from "@/lib/i18n";

export type McpCapabilityTab = "resources" | "prompts";

function displayUri(uri: string): string {
  const clipped = uri.split(/[?#]/, 1)[0] ?? uri;
  return clipped.length > 120 ? `${clipped.slice(0, 119)}…` : clipped;
}

const ResourceRow: FC<{
  resource: McpResource;
  onPreview: (uri: string) => void;
}> = ({ resource, onPreview }) => {
  const t = useT();
  return (
    <li className="flex items-start gap-2 py-1.5">
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="truncate text-[13px] leading-5 font-medium">
            {resource.title || resource.name}
          </span>
          {resource.mimeType ? (
            <span className="text-muted-foreground shrink-0 font-mono text-3xs">
              {resource.mimeType}
            </span>
          ) : null}
        </div>
        <div
          className="text-muted-foreground truncate font-mono text-3xs"
          title={resource.uri}
        >
          {displayUri(resource.uri)}
        </div>
        {resource.description ? (
          <div className="text-muted-foreground mt-0.5 line-clamp-2 text-[13px] leading-5">
            {resource.description}
          </div>
        ) : null}
      </div>
      <button
        type="button"
        className="text-muted-foreground hover:text-foreground shrink-0 cursor-pointer text-[13px] leading-5 underline-offset-2 hover:underline"
        onClick={() => onPreview(resource.uri)}
      >
        {t("settings.mcp.resourcePreview")}
      </button>
    </li>
  );
};

const TemplateRow: FC<{ template: McpResourceTemplate }> = ({ template }) => (
  <li className="py-1.5">
    <div className="flex min-w-0 items-center gap-1.5">
      <span className="truncate text-[13px] leading-5 font-medium">
        {template.title || template.name}
      </span>
      <span className="text-muted-foreground shrink-0 text-3xs">template</span>
      {template.mimeType ? (
        <span className="text-muted-foreground shrink-0 font-mono text-3xs">
          {template.mimeType}
        </span>
      ) : null}
    </div>
    <div className="text-muted-foreground truncate font-mono text-3xs" title={template.uriTemplate}>
      {displayUri(template.uriTemplate)}
    </div>
    {template.description ? (
      <div className="text-muted-foreground mt-0.5 line-clamp-2 text-[13px] leading-5">
        {template.description}
      </div>
    ) : null}
  </li>
);

const PromptRow: FC<{ prompt: McpPrompt }> = ({ prompt }) => {
  const args = prompt.arguments ?? [];
  return (
    <li className="py-1.5">
      <div className="flex min-w-0 items-center gap-1.5">
        <span className="truncate text-[13px] leading-5 font-medium">
          {prompt.title || prompt.name}
        </span>
        {args.length > 0 ? (
          <span className="text-muted-foreground shrink-0 font-mono text-3xs">
            {args.map((arg) => `${arg.name}${arg.required ? "*" : ""}`).join(", ")}
          </span>
        ) : null}
      </div>
      {prompt.description ? (
        <div className="text-muted-foreground mt-0.5 line-clamp-2 text-[13px] leading-5">
          {prompt.description}
        </div>
      ) : null}
    </li>
  );
};

export const McpCapabilityBrowser: FC<{
  serverName: string;
  cwd?: string | null;
  tab: McpCapabilityTab;
}> = ({ serverName, cwd, tab }) => {
  const t = useT();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [resources, setResources] = useState<McpResource[] | null>(null);
  const [templates, setTemplates] = useState<McpResourceTemplate[]>([]);
  const [prompts, setPrompts] = useState<McpPrompt[] | null>(null);
  const [preview, setPreview] = useState<{ uri: string; text: string; truncated?: boolean } | null>(
    null,
  );
  const [previewBusy, setPreviewBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    setPreview(null);
    const run =
      tab === "resources"
        ? fetchMcpResources(serverName, cwd).then((res) => {
            if (!alive) return;
            setResources(res.resources);
            setTemplates(res.resourceTemplates);
          })
        : fetchMcpPrompts(serverName, cwd).then((res) => {
            if (!alive) return;
            setPrompts(res.prompts);
          });
    run
      .catch((err) => {
        if (alive) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [serverName, cwd, tab]);

  const openPreview = (uri: string) => {
    setPreviewBusy(true);
    setPreview(null);
    readMcpResource(serverName, uri, cwd)
      .then((res) => setPreview({ uri, text: res.text, ...(res.truncated ? { truncated: true } : {}) }))
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setPreviewBusy(false));
  };

  if (loading) {
    return (
      <p className="text-muted-foreground flex items-center gap-1.5 py-2 text-[13px] leading-5">
        <Loader2Icon className="size-3.5 animate-spin" />
        {tab === "resources"
          ? t("settings.mcp.resourcesLoading")
          : t("settings.mcp.promptsLoading")}
      </p>
    );
  }
  if (error) {
    return (
      <p className="text-destructive py-2 text-[13px] leading-5">
        {t("settings.mcp.capabilityLoadFailed", { error })}
      </p>
    );
  }

  if (tab === "resources") {
    const list = resources ?? [];
    return (
      <div className="flex flex-col gap-2 py-1">
        {list.length === 0 && templates.length === 0 ? (
          <p className="text-muted-foreground py-2 text-[13px] leading-5">
            {t("settings.mcp.resourcesEmpty")}
          </p>
        ) : (
          <>
            {list.length > 0 ? (
              <ul className="divide-border/50 flex flex-col divide-y">
                {list.map((resource) => (
                  <ResourceRow key={resource.uri} resource={resource} onPreview={openPreview} />
                ))}
              </ul>
            ) : null}
            {templates.length > 0 ? (
              <div>
                <div className="text-muted-foreground mb-1 text-3xs font-medium tracking-wide uppercase">
                  {t("settings.mcp.resourcesTemplates")}
                </div>
                <ul className="divide-border/50 flex flex-col divide-y opacity-80">
                  {templates.map((template) => (
                    <TemplateRow key={template.uriTemplate} template={template} />
                  ))}
                </ul>
              </div>
            ) : null}
            {previewBusy ? (
              <p className="text-muted-foreground flex items-center gap-1.5 py-2 text-[13px] leading-5">
                <Loader2Icon className="size-3.5 animate-spin" />
                {t("settings.mcp.resourcePreviewLoading")}
              </p>
            ) : preview ? (
              <div className="bg-background rounded-lg border">
                <div className="text-muted-foreground flex items-center gap-2 border-b px-2.5 py-1.5 font-mono text-3xs">
                  <span className="truncate" title={preview.uri}>
                    {displayUri(preview.uri)}
                  </span>
                  {preview.truncated ? (
                    <span className="text-amber-600 dark:text-amber-400 shrink-0">
                      {t("settings.mcp.resourceTruncated")}
                    </span>
                  ) : null}
                </div>
                <pre className="max-h-64 overflow-auto px-2.5 py-2 font-mono text-[12px] leading-5 whitespace-pre-wrap">
                  {preview.text}
                </pre>
              </div>
            ) : null}
          </>
        )}
      </div>
    );
  }

  const list = prompts ?? [];
  return (
    <div className="py-1">
      {list.length === 0 ? (
        <p className="text-muted-foreground py-2 text-[13px] leading-5">
          {t("settings.mcp.promptsEmpty")}
        </p>
      ) : (
        <>
          <ul className="divide-border/50 flex flex-col divide-y">
            {list.map((prompt) => (
              <PromptRow key={prompt.name} prompt={prompt} />
            ))}
          </ul>
          <p className="text-muted-foreground mt-2 text-3xs leading-4">
            {t("settings.mcp.promptsComposerHint")}
          </p>
        </>
      )}
    </div>
  );
};
