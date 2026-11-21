"use client";

import { useEffect, useState, type FC } from "react";
import { Loader2Icon, SearchIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { parseCurlCommand } from "@/lib/settings/curl-import";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { SettingRow } from "@/components/custom-ui/setting-row";
import { Segmented } from "@/components/custom-ui/segmented";
import { toast } from "@/components/ui/toast";
import { useT } from "@/lib/i18n";
import {
  getWebSearchSettings,
  refreshWebSearchSettings,
  saveWebSearchKey,
  saveWebSearchSettings,
  testWebSearch,
  useWebSearchSettings,
} from "@/lib/settings/websearch-config";
import type {
  PiWebSearchKeyStatus,
  PiWebSearchPreset,
  PiWebSearchProvider,
  PiWebSearchProviderKind,
  PiWebSearchSettings,
  PiWebSearchTestResult,
} from "@/lib/pi/pi-bridge";

/**
 * 网页搜索设置页（设置 → 智能体 → 网页搜索）。
 *
 * 只维护一个搜索服务：内置代理（默认，免 key）或某一家预置/自定义 API。
 * 修改即时保存（与访问加速/可观测性同款），文本字段失焦/回车提交；
 * 「测试连接」用当前配置实时打一次，不保存、不回显 key。
 * 事实源在 sidecar：kv pi.websearch + 加密凭据表（websearch:<kind>）。
 */

const CUSTOM_DEFAULT_BODY = '{"query":"{{query}}","count":{{count}}}';

/** headers 对象 ↔ 多行 `Key: Value`（与可观测性页同款，解析失败的行丢弃） */
const headersToText = (headers: Record<string, string>): string =>
  Object.entries(headers)
    .map(([key, value]) => `${key}: ${value}`)
    .join("\n");

const textToHeaders = (text: string): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const at = line.indexOf(":");
    if (at <= 0) continue;
    const key = line.slice(0, at).trim();
    const value = line.slice(at + 1).trim();
    if (key && value) out[key] = value;
  }
  return out;
};

/** 请求体模板校验：把占位符换成样例值后必须是合法 JSON */
function bodyTemplateValid(template: string): boolean {
  const filled = template
    .replace(/\{\{\s*query\s*\}\}/g, "q")
    .replace(/\{\{\s*count\s*\}\}/g, "8")
    .replace(/\{\{\s*apiKey\s*\}\}/g, "key");
  try {
    JSON.parse(filled);
    return true;
  } catch {
    return false;
  }
}

/** 中文输入法常见的全角标点（引号/冒号/逗号/花括号）——JSON 必须用半角 */
function hasFullwidthPunct(text: string): boolean {
  return /[\u201C\u201D\u2018\u2019\uFF1A\uFF0C\uFF5B\uFF5D]/.test(text);
}

function providerFor(
  kind: PiWebSearchProviderKind,
  presets: PiWebSearchPreset[],
): PiWebSearchProvider {
  if (kind === "custom") {
    return {
      id: "custom",
      kind,
      label: "Custom",
      baseUrl: "",
      method: "POST",
      headers: { "Content-Type": "application/json" },
      bodyTemplate: CUSTOM_DEFAULT_BODY,
      resultsPath: "results",
      titlePath: "title",
      urlPath: "url",
      snippetPath: "snippet",
      sourcePath: "",
    };
  }
  const preset = presets.find((item) => item.kind === kind);
  return {
    id: kind,
    kind,
    label: preset?.label ?? kind,
    baseUrl: "",
    method: "POST",
    headers: {},
    bodyTemplate: "",
    resultsPath: "",
    titlePath: "",
    urlPath: "",
    snippetPath: "",
    sourcePath: "",
  };
}

/** 失焦/回车才提交的文本输入（避免逐字符打协议） */
const TextCommit: FC<{
  value: string;
  placeholder?: string;
  multiline?: boolean;
  rows?: number;
  password?: boolean;
  className?: string;
  invalid?: boolean;
  onCommit: (value: string) => void;
}> = ({
  value,
  placeholder,
  multiline = false,
  rows = 4,
  password = false,
  className,
  invalid = false,
  onCommit,
}) => {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const commit = () => {
    if (draft !== value) onCommit(draft);
  };
  if (multiline) {
    return (
      <Textarea
        className={className}
        rows={rows}
        value={draft}
        placeholder={placeholder}
        spellCheck={false}
        aria-invalid={invalid}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
      />
    );
  }
  return (
    <Input
      className={className}
      type={password ? "password" : "text"}
      autoComplete={password ? "off" : undefined}
      value={draft}
      placeholder={placeholder}
      spellCheck={false}
      aria-invalid={invalid}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing) return;
        if (event.key === "Enter") event.currentTarget.blur();
      }}
    />
  );
};

/** 数字输入：失焦/回车提交，非法值回退当前值 */
const NumberCommit: FC<{
  value: number;
  min: number;
  max: number;
  step?: number;
  onCommit: (value: number) => void;
}> = ({ value, min, max, step = 1, onCommit }) => {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  const commit = () => {
    const next = Number(draft);
    if (!Number.isFinite(next)) {
      setDraft(String(value));
      return;
    }
    const clamped = Math.min(max, Math.max(min, Math.trunc(next)));
    setDraft(String(clamped));
    if (clamped !== value) onCommit(clamped);
  };
  return (
    <Input
      className="bg-background h-8 w-24 text-sm tabular-nums"
      type="number"
      min={min}
      max={max}
      step={step}
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing) return;
        if (event.key === "Enter") event.currentTarget.blur();
      }}
    />
  );
};

export const WebSearchSettings: FC = () => {
  const t = useT();
  const { settings, keys, presets, defaults } = useWebSearchSettings();
  const [testQuery, setTestQuery] = useState("Kova desktop AI assistant");
  const [testBusy, setTestBusy] = useState(false);
  const [testResult, setTestResult] = useState<PiWebSearchTestResult | null>(
    null,
  );
  const [bodyInvalid, setBodyInvalid] = useState<"" | "invalid" | "fullwidth">(
    "",
  );
  const [keyDraft, setKeyDraft] = useState("");
  const [jsonOpen, setJsonOpen] = useState(false);
  const [jsonDraft, setJsonDraft] = useState("");
  const [jsonError, setJsonError] = useState("");
  const [curlOpen, setCurlOpen] = useState(false);
  const [curlDraft, setCurlDraft] = useState("");
  const [curlError, setCurlError] = useState("");

  useEffect(() => {
    void refreshWebSearchSettings();
  }, []);

  const provider = settings.provider;
  const keyStatus: PiWebSearchKeyStatus | undefined = keys[provider.id];
  const isCustom = provider.kind === "custom";
  // 自定义服务是否引用了 Key：与 sidecar usesApiKey 的占位符判断一致——
  // 模板里没写 {{apiKey}} 就不显示 Key 行（免 Key 服务不该看到凭据输入）
  const usesApiKeyPlaceholder = isCustom
    ? /\{\{\s*apiKey\s*\}\}/.test(provider.baseUrl) ||
      Object.values(provider.headers).some((v) =>
        /\{\{\s*apiKey\s*\}\}/.test(v),
      ) ||
      /\{\{\s*apiKey\s*\}\}/.test(provider.bodyTemplate)
    : true;
  const preset = presets.find((item) => item.kind === provider.kind);
  const missingUrl =
    (provider.kind === "custom" || provider.kind === "searxng") &&
    !provider.baseUrl.trim();
  const endpointDesc =
    provider.kind === "custom"
      ? t("settings.webSearch.endpointCustomDesc")
      : provider.kind === "searxng"
        ? t("settings.webSearch.endpointSearxngDesc")
        : t("settings.webSearch.endpointDesc", {
            default: preset?.baseUrl || "—",
          });

  // 配置一变，上一次测试的「成功/失败」就是旧配置的结果，不能继续挂着误导。
  // 用值签名而不是 settings 引用：保存响应即使晚到，只要值没变就不清结果
  const testSignature = JSON.stringify({
    enabled: settings.enabled,
    provider: settings.provider,
    requestTimeoutMs: settings.requestTimeoutMs,
    maxResults: settings.maxResults,
  });
  useEffect(() => {
    setTestResult(null);
  }, [testSignature]);

  // 切服务后行内 key/测试反馈属于上一家，清掉
  useEffect(() => {
    setKeyDraft("");
    setTestResult(null);
    setBodyInvalid("");
  }, [provider.kind]);

  // GET 不用请求体：切到 GET 时清掉上一份 POST 模板的非法态，避免测试按钮被
  // 一个已卸载字段卡住
  useEffect(() => {
    setBodyInvalid("");
  }, [provider.method]);

  const bodyInvalidActive =
    isCustom && provider.method === "POST" && bodyInvalid !== "";

  const save = (next: PiWebSearchSettings) => {
    saveWebSearchSettings(next).catch(() =>
      toast.error(t("settings.webSearch.saveFailed")),
    );
  };
  const patchProvider = (patch: Partial<PiWebSearchProvider>) =>
    save({ ...settings, provider: { ...provider, ...patch } });

  // 「JSON 编辑」导出的整段定义;应用时按白名单字段回写,结构不对报专门错误
  const buildExport = (p: PiWebSearchProvider) => ({
    $schema:
      "https://raw.githubusercontent.com/xqb0407/kova/main/apps/desktop/public/schemas/kova-websearch-custom-1.json",
    format: "kova-websearch-custom",
    version: 1,
    label: p.label,
    method: p.method,
    baseUrl: p.baseUrl,
    headers: p.headers,
    bodyTemplate: p.bodyTemplate,
    resultsPath: p.resultsPath,
    titlePath: p.titlePath,
    urlPath: p.urlPath,
    snippetPath: p.snippetPath,
    sourcePath: p.sourcePath,
  });

  const applyJson = () => {
    let doc: Record<string, unknown>;
    try {
      doc = JSON.parse(jsonDraft) as Record<string, unknown>;
    } catch {
      setJsonError(t("settings.webSearch.jsonInvalid"));
      return;
    }
    if (doc.format !== "kova-websearch-custom") {
      setJsonError(t("settings.webSearch.jsonBadFormat"));
      return;
    }
    const method =
      doc.method === "GET" ? "GET" : doc.method === "POST" ? "POST" : null;
    const baseUrl = typeof doc.baseUrl === "string" ? doc.baseUrl.trim() : "";
    if (!method || !/^https?:\/\//i.test(baseUrl)) {
      setJsonError(t("settings.webSearch.jsonBadUrl"));
      return;
    }
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(
      (doc.headers ?? {}) as Record<string, unknown>,
    )) {
      if (typeof v === "string") headers[k] = v;
    }
    const bodyTemplate =
      typeof doc.bodyTemplate === "string" ? doc.bodyTemplate : "";
    if (
      method === "POST" &&
      bodyTemplate.trim() &&
      !bodyTemplateValid(bodyTemplate)
    ) {
      setJsonError(t("settings.webSearch.jsonBadBody"));
      return;
    }
    patchProvider({
      ...(typeof doc.label === "string" && doc.label.trim()
        ? { label: doc.label }
        : {}),
      method,
      baseUrl,
      headers,
      bodyTemplate,
      ...(typeof doc.resultsPath === "string"
        ? { resultsPath: doc.resultsPath }
        : {}),
      ...(typeof doc.titlePath === "string" ? { titlePath: doc.titlePath } : {}),
      ...(typeof doc.urlPath === "string" ? { urlPath: doc.urlPath } : {}),
      ...(typeof doc.snippetPath === "string"
        ? { snippetPath: doc.snippetPath }
        : {}),
      ...(typeof doc.sourcePath === "string"
        ? { sourcePath: doc.sourcePath }
        : {}),
    });
    setJsonError("");
    setJsonOpen(false);
  };

  const applyCurl = () => {
    const parsed = parseCurlCommand(curlDraft);
    if (!parsed?.url) {
      setCurlError(t("settings.webSearch.curlInvalid"));
      return;
    }
    patchProvider({
      ...(parsed.method ? { method: parsed.method } : {}),
      baseUrl: parsed.url,
      headers: { ...provider.headers, ...parsed.headers },
      ...(parsed.body !== undefined ? { bodyTemplate: parsed.body } : {}),
    });
    setCurlError("");
    setCurlOpen(false);
  };
  const changeKind = (kind: PiWebSearchProviderKind) =>
    save({ ...settings, provider: providerFor(kind, presets) });

  const serviceItems = [
    ...presets.map((item) => ({ value: item.kind, label: item.label })),
    { value: "custom", label: t("settings.webSearch.custom") },
  ];

  const saveKey = async (clear: boolean) => {
    try {
      await saveWebSearchKey(provider.id, clear ? "" : keyDraft, clear);
      setKeyDraft("");
      toast.success(
        clear
          ? t("settings.webSearch.keyCleared")
          : t("settings.webSearch.keySaved"),
      );
    } catch {
      toast.error(t("settings.webSearch.keyFailed"));
    }
  };

  const runTest = async () => {
    if (testBusy) return;
    setTestBusy(true);
    setTestResult(null);
    try {
      const result = await testWebSearch({
        query: testQuery.trim() || undefined,
        apiKey: keyDraft.trim() || undefined,
        // 用最新镜像：失焦提交刚保存的端点/超时要立刻参与测试
        settings: getWebSearchSettings(),
      });
      setTestResult(result);
      if (result.ok) {
        toast.success(
          t("settings.webSearch.testOk", {
            count: result.results.length,
            ms: result.durationMs,
          }),
        );
      } else {
        toast.error(t("settings.webSearch.testFailed"));
      }
    } catch {
      toast.error(t("settings.webSearch.testUnavailable"));
    } finally {
      setTestBusy(false);
    }
  };

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <div className="flex w-full max-w-5xl flex-col gap-8 self-center px-8 py-8">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">
            {t("settings.webSearch.title")}
          </h1>
          <p className="text-muted-foreground mt-1 text-sm leading-relaxed">
            {t("settings.webSearch.desc")}
          </p>
        </div>

        <section className="flex flex-col gap-3">
          <h2 className="text-base font-semibold">
            {t("settings.webSearch.general")}
          </h2>
          <div className="bg-muted/50 flex flex-col gap-1 rounded-2xl p-2">
            <SettingRow
              label={t("settings.webSearch.enabled")}
              desc={t("settings.webSearch.enabledDesc")}
            >
              <Switch
                checked={settings.enabled}
                onCheckedChange={(enabled) => save({ ...settings, enabled })}
              />
            </SettingRow>
            <SettingRow
              label={t("settings.webSearch.service")}
              desc={t("settings.webSearch.serviceDesc")}
            >
              <Select
                value={provider.kind}
                onValueChange={(value) => {
                  if (value) changeKind(value as PiWebSearchProviderKind);
                }}
                items={serviceItems}
              >
                <SelectTrigger size="sm" className="w-56 border bg-background">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent align="end">
                  {serviceItems.map((item) => (
                    <SelectItem key={item.value} value={item.value}>
                      {item.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </SettingRow>
            <SettingRow
              label={t("settings.webSearch.timeout")}
              desc={t("settings.webSearch.timeoutDesc", {
                default: defaults.requestTimeoutMs,
              })}
            >
              <NumberCommit
                value={settings.requestTimeoutMs}
                min={1_000}
                max={30_000}
                step={500}
                onCommit={(requestTimeoutMs) =>
                  save({ ...settings, requestTimeoutMs })
                }
              />
            </SettingRow>
            <SettingRow
              label={t("settings.webSearch.maxResults")}
              desc={t("settings.webSearch.maxResultsDesc", {
                default: defaults.maxResults,
              })}
            >
              <NumberCommit
                value={settings.maxResults}
                min={1}
                max={20}
                onCommit={(maxResults) => save({ ...settings, maxResults })}
              />
            </SettingRow>
          </div>
          <p className="text-muted-foreground border-border/50 px-1 text-[13px] leading-5">
            {t("settings.webSearch.enabledImpact")}
          </p>
        </section>

        <section className="flex flex-col gap-3">
          <h2 className="text-base font-semibold">
            {t("settings.webSearch.serviceConfig")}
          </h2>
          <div className="bg-muted/50 flex flex-col gap-1 rounded-2xl p-2">
            <SettingRow
              label={t("settings.webSearch.endpoint")}
              desc={endpointDesc}
            >
              <div className="flex w-full max-w-md flex-col gap-1">
                <TextCommit
                  className="bg-background h-8 text-sm"
                  value={provider.baseUrl}
                  placeholder={preset?.baseUrl || "https://…"}
                  invalid={missingUrl}
                  onCommit={(baseUrl) => patchProvider({ baseUrl })}
                />
                {missingUrl ? (
                  <span className="text-destructive text-xs">
                    {t("settings.webSearch.baseUrlRequired")}
                  </span>
                ) : null}
              </div>
            </SettingRow>

            {isCustom ? (
              <SettingRow
                label={t("settings.webSearch.quickConfig")}
                desc={t("settings.webSearch.quickConfigDesc")}
              >
                <div className="flex w-[28rem] items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setJsonDraft(JSON.stringify(buildExport(provider), null, 2));
                      setJsonError("");
                      setJsonOpen((v) => !v);
                      setCurlOpen(false);
                    }}
                  >
                    {t("settings.webSearch.jsonEdit")}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setCurlDraft("");
                      setCurlError("");
                      setCurlOpen((v) => !v);
                      setJsonOpen(false);
                    }}
                  >
                    {t("settings.webSearch.curlImport")}
                  </Button>
                </div>
              </SettingRow>
            ) : null}
            {isCustom && jsonOpen ? (
              <SettingRow
                label={t("settings.webSearch.jsonEditor")}
                desc={t("settings.webSearch.jsonEditorDesc")}
              >
                <div className="flex w-[28rem] flex-col gap-2">
                  <Textarea
                    className="bg-background min-h-48 font-mono text-xs"
                    value={jsonDraft}
                    onChange={(event) => setJsonDraft(event.target.value)}
                    spellCheck={false}
                  />
                  {jsonError ? (
                    <span className="text-destructive text-xs">{jsonError}</span>
                  ) : null}
                  <div className="flex gap-2">
                    <Button size="sm" onClick={applyJson}>
                      {t("settings.webSearch.jsonApply")}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setJsonOpen(false)}
                    >
                      {t("settings.webSearch.editorCollapse")}
                    </Button>
                  </div>
                </div>
              </SettingRow>
            ) : null}
            {isCustom && curlOpen ? (
              <SettingRow
                label={t("settings.webSearch.curlImport")}
                desc={t("settings.webSearch.curlImportDesc")}
              >
                <div className="flex w-[28rem] flex-col gap-2">
                  <Textarea
                    className="bg-background min-h-24 font-mono text-xs"
                    value={curlDraft}
                    onChange={(event) => setCurlDraft(event.target.value)}
                    spellCheck={false}
                  />
                  {curlError ? (
                    <span className="text-destructive text-xs">{curlError}</span>
                  ) : null}
                  <div className="flex gap-2">
                    <Button size="sm" onClick={applyCurl}>
                      {t("settings.webSearch.curlApply")}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setCurlOpen(false)}
                    >
                      {t("settings.webSearch.editorCollapse")}
                    </Button>
                  </div>
                  <span className="text-muted-foreground text-xs">
                    {t("settings.webSearch.curlHint")}
                  </span>
                </div>
              </SettingRow>
            ) : null}

            {!usesApiKeyPlaceholder ? null : (
            <SettingRow
              label={t("settings.webSearch.apiKey")}
              desc={
                keyStatus?.hasKey
                  ? t("settings.webSearch.apiKeySaved", {
                      mask: keyStatus.masked,
                    })
                  : t("settings.webSearch.apiKeyDesc")
              }
            >
              <div className="flex w-full max-w-md items-center gap-2">
                <Input
                  className="bg-background h-8 min-w-0 flex-1 text-sm"
                  type="password"
                  autoComplete="off"
                  value={keyDraft}
                  placeholder={
                    keyStatus?.hasKey
                      ? t("settings.webSearch.apiKeyPlaceholderSaved")
                      : t("settings.webSearch.apiKeyPlaceholder")
                  }
                  onChange={(event) => setKeyDraft(event.target.value)}
                />
                <Button
                  variant="outline"
                  size="sm"
                  className="h-8 shrink-0"
                  disabled={!keyDraft.trim()}
                  onClick={() => void saveKey(false)}
                >
                  {t("settings.webSearch.keySave")}
                </Button>
                {keyStatus?.hasKey ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-8 shrink-0"
                    onClick={() => void saveKey(true)}
                  >
                    {t("settings.webSearch.keyClear")}
                  </Button>
                ) : null}
              </div>
            </SettingRow>
            )}

            <SettingRow
              label={t("settings.webSearch.testQuery")}
              desc={t("settings.webSearch.testQueryDesc")}
            >
              <div className="flex w-full max-w-md items-center gap-2">
                <Input
                  className="bg-background h-8 min-w-0 flex-1 text-sm"
                  value={testQuery}
                  placeholder="Kova desktop AI assistant"
                  onChange={(event) => setTestQuery(event.target.value)}
                />
                <Button
                  variant="outline"
                  size="sm"
                  className="h-8 shrink-0"
                  disabled={testBusy || missingUrl || bodyInvalidActive}
                  onClick={() => void runTest()}
                >
                  {testBusy ? (
                    <Loader2Icon className="size-3.5 animate-spin" />
                  ) : (
                    <SearchIcon className="size-3.5" />
                  )}
                  {testBusy
                    ? t("settings.webSearch.testing")
                    : t("settings.webSearch.test")}
                </Button>
              </div>
            </SettingRow>
          </div>
          {testResult ? (
            <p
              className={
                testResult.ok
                  ? "text-muted-foreground px-1 text-[13px] leading-5"
                  : "text-destructive px-1 text-[13px] leading-5"
              }
            >
              {testResult.ok
                ? t("settings.webSearch.testOk", {
                    count: testResult.results.length,
                    ms: testResult.durationMs,
                  })
                : `${t("settings.webSearch.testFailed")}：${testResult.errorText ?? ""}`}
              {testResult.ok && testResult.results[0]
                ? ` · ${testResult.results[0].title}`
                : ""}
            </p>
          ) : null}
        </section>

        {isCustom ? (
          <section className="flex flex-col gap-3">
            <h2 className="text-base font-semibold">
              {t("settings.webSearch.advanced")}
            </h2>
            <p className="text-muted-foreground text-sm leading-relaxed">
              {t("settings.webSearch.advancedDesc")}
            </p>
            <div className="bg-muted/50 flex flex-col gap-1 rounded-2xl p-2">
              <SettingRow label={t("settings.webSearch.method")}>
                <Segmented
                  value={provider.method}
                  options={[
                    { value: "POST", label: "POST" },
                    { value: "GET", label: "GET" },
                  ]}
                  onChange={(method) =>
                    patchProvider({ method: method as "GET" | "POST" })
                  }
                />
              </SettingRow>
              <SettingRow
                label={t("settings.webSearch.headers")}
                desc={t("settings.webSearch.headersDesc")}
              >
                <div className="w-[28rem]">
                  <TextCommit
                    multiline
                    className="bg-background min-h-20 font-mono text-xs"
                    value={headersToText(provider.headers)}
                    onCommit={(text) =>
                      patchProvider({ headers: textToHeaders(text) })
                    }
                  />
                </div>
              </SettingRow>
              {provider.method === "POST" ? (
                <SettingRow
                  label={t("settings.webSearch.bodyTemplate")}
                  desc={t("settings.webSearch.bodyTemplateDesc")}
                >
                  <div className="flex w-[28rem] flex-col gap-1">
                    <TextCommit
                      multiline
                      rows={4}
                      className="bg-background min-h-24 font-mono text-xs"
                      value={provider.bodyTemplate}
                      invalid={bodyInvalid !== ""}
                      onCommit={(bodyTemplate) => {
                        if (!bodyTemplateValid(bodyTemplate)) {
                          setBodyInvalid(
                            hasFullwidthPunct(bodyTemplate)
                              ? "fullwidth"
                              : "invalid",
                          );
                          return;
                        }
                        setBodyInvalid("");
                        patchProvider({ bodyTemplate });
                      }}
                    />
                    {bodyInvalid ? (
                      <span className="text-destructive text-xs">
                        {bodyInvalid === "fullwidth"
                          ? t("settings.webSearch.invalidBodyFullwidth")
                          : t("settings.webSearch.invalidBody")}
                      </span>
                    ) : null}
                  </div>
                </SettingRow>
              ) : null}
              <SettingRow
                label={t("settings.webSearch.resultsPath")}
                desc={t("settings.webSearch.resultsPathDesc")}
              >
                <TextCommit
                  className="bg-background h-8 w-48 font-mono text-xs"
                  value={provider.resultsPath}
                  placeholder="results"
                  onCommit={(resultsPath) => patchProvider({ resultsPath })}
                />
              </SettingRow>
              <SettingRow label={t("settings.webSearch.titlePath")}>
                <TextCommit
                  className="bg-background h-8 w-48 font-mono text-xs"
                  value={provider.titlePath}
                  placeholder="title"
                  onCommit={(titlePath) => patchProvider({ titlePath })}
                />
              </SettingRow>
              <SettingRow label={t("settings.webSearch.urlPath")}>
                <TextCommit
                  className="bg-background h-8 w-48 font-mono text-xs"
                  value={provider.urlPath}
                  placeholder="url"
                  onCommit={(urlPath) => patchProvider({ urlPath })}
                />
              </SettingRow>
              <SettingRow label={t("settings.webSearch.snippetPath")}>
                <TextCommit
                  className="bg-background h-8 w-48 font-mono text-xs"
                  value={provider.snippetPath}
                  placeholder="snippet"
                  onCommit={(snippetPath) => patchProvider({ snippetPath })}
                />
              </SettingRow>
              <SettingRow label={t("settings.webSearch.sourcePath")}>
                <TextCommit
                  className="bg-background h-8 w-48 font-mono text-xs"
                  value={provider.sourcePath}
                  placeholder="source"
                  onCommit={(sourcePath) => patchProvider({ sourcePath })}
                />
              </SettingRow>
            </div>
          </section>
        ) : null}

        <p className="text-muted-foreground border-border/50 px-1 text-[13px] leading-5">
          {t("settings.webSearch.footer")}
        </p>
      </div>
    </div>
  );
};
