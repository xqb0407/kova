"use client";

import { useState, useMemo, type FC, type ReactNode } from "react";
import { Controller, useWatch, useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import { FieldError } from "@/components/ui/field";
import { Checkbox } from "@/components/ui/checkbox";
import { AnimatedBadge } from "@/components/custom-ui/animated-badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  AGENT_EVENT_REGISTRY,
  eventLabel,
  type AgentEventName,
} from "@/lib/pi/agent-events";
import {
  WEBHOOK_FORMATS,
  addWebhook,
  removeWebhook,
  updateWebhook,
  useWebhookEndpoints,
  type WebhookEndpoint,
  type WebhookFormat,
} from "@/lib/notify/webhooks";
import {
  DELIVERY_KEEP,
  pruneWebhookDeliveries,
  removeWebhookDeliveries,
  sendWebhookTest,
  useWebhookDeliveries,
} from "@/lib/notify/webhook-dispatcher";
import { toast } from "@/components/ui/toast";
import { getLocale, useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import {
  ChevronDownIcon,
  FlaskConicalIcon,
  PlusIcon,
  Trash2Icon,
} from "lucide-react";

// ---------------------------------------------------------------------------
// 端点表单（react-hook-form + zod：校验、错误文案都在 schema 里）
// ---------------------------------------------------------------------------

const ALL_EVENT_NAMES = AGENT_EVENT_REGISTRY.map((e) => e.name);

const createWebhookFormSchema = (t: ReturnType<typeof useT>) =>
  z
    .object({
      name: z.string().trim().min(1, t("settings.webhooks.validationName")),
      url: z
        .string()
        .trim()
        .min(1, t("settings.webhooks.validationUrl"))
        .refine((v) => /^https?:\/\//i.test(v), t("settings.webhooks.validationUrlScheme")),
      secret: z.string().trim(),
      format: z.enum(["generic", "dingtalk", "feishu", "slack", "bark"]),
      allEvents: z.boolean(),
      events: z.array(z.string()),
    })
    .superRefine((val, ctx) => {
      if (!val.allEvents && val.events.length === 0) {
        ctx.addIssue({
          code: "custom",
          path: ["events"],
          message: t("settings.webhooks.validationEvents"),
        });
      }
    });

type WebhookFormValues = z.infer<ReturnType<typeof createWebhookFormSchema>>;

const isHttpUrl = (value: string) => /^https?:\/\//i.test(value.trim());

/** 必填星标（版式对齐模型添加弹窗） */
const Req: FC = () => (
  <span className="text-destructive ms-0.5" aria-hidden>
    *
  </span>
);

/** 字段：小号 medium 标签 + 控件 + 校验错误（同模型添加弹窗的字段版式） */
const Field: FC<{
  label: ReactNode;
  htmlFor: string;
  required?: boolean;
  children: ReactNode;
}> = ({ label, htmlFor, required, children }) => (
  <div className="flex flex-col gap-2">
    <label htmlFor={htmlFor} className="text-sm font-medium">
      {label}
      {required && <Req />}
    </label>
    {children}
  </div>
);

/** 端点编辑对话框（父组件条件挂载，表单 defaultValues 初始化一次即可） */
const WebhookEditor: FC<{
  endpoint: WebhookEndpoint | null;
  onOpenChange: (open: boolean) => void;
}> = ({ endpoint, onOpenChange }) => {
  const t = useT();
  const webhookFormSchema = useMemo(() => createWebhookFormSchema(t), [t]);
  const {
    control,
    handleSubmit,
    getValues,
    formState: { errors },
  } = useForm<WebhookFormValues>({
    resolver: zodResolver(webhookFormSchema),
    defaultValues: {
      name: endpoint?.name ?? "",
      url: endpoint?.url ?? "",
      secret: endpoint?.secret ?? "",
      format: endpoint?.format ?? "generic",
      allEvents: (endpoint?.events ?? "*") === "*",
      events:
        endpoint && Array.isArray(endpoint.events)
          ? endpoint.events
          : ALL_EVENT_NAMES,
    },
  });
  const allEvents = useWatch({ control, name: "allEvents" });
  const formatValue = useWatch({ control, name: "format" });

  /** URL 输入示例随格式切换（Bark 是 App 里复制的「服务器/设备Key」串） */
  const URL_PLACEHOLDER: Record<WebhookFormat, string> = {
    generic: "https://example.com/hook",
    dingtalk: "https://oapi.dingtalk.com/robot/send?access_token=…",
    feishu: "https://open.feishu.cn/open-apis/bot/v2/hook/…",
    slack: "https://hooks.slack.com/services/…",
    bark: t("settings.webhooks.barkUrlPlaceholder"),
  };

  const onSubmit = (values: WebhookFormValues) => {
    const value = {
      name: values.name,
      url: values.url,
      secret: values.secret || undefined,
      format: values.format as WebhookFormat,
      events: values.allEvents
        ? ("*" as const)
        : (values.events as AgentEventName[]),
      enabled: endpoint?.enabled ?? true,
    };
    if (endpoint) updateWebhook(endpoint.id, value);
    else addWebhook(value);
    onOpenChange(false);
  };

  // 对话框内联测试：拿当前表单值直发一条 system.test，无需先保存
  const urlValue = useWatch({ control, name: "url" });
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{
    ok: boolean;
    detail: string;
  } | null>(null);

  const handleTest = async () => {
    const values = getValues();
    const trimmed = values.url.trim();
    if (!isHttpUrl(trimmed)) return;
    setTesting(true);
    const result = await sendWebhookTest({
      id: "draft",
      name: values.name.trim() || trimmed.slice(0, 30),
      url: trimmed,
      secret: values.secret.trim() || undefined,
      format: values.format,
      events: "*",
      enabled: true,
    });
    setTestResult(result);
    setTesting(false);
  };

  return (
    <Dialog open onOpenChange={onOpenChange}>
      {/* 表单项固定、没有长列表：按内容自适应高度，不设内滚动 */}
      <DialogContent className="flex flex-col gap-0 rounded-3xl p-6 sm:max-w-[640px]">
        <DialogTitle className="text-xl font-semibold">
          {endpoint ? t("settings.webhooks.editTitle") : t("settings.webhooks.addTitle")}
        </DialogTitle>
        <DialogDescription className="mt-1.5">
          {t("settings.webhooks.dialogDesc")}
        </DialogDescription>
        <form
          onSubmit={handleSubmit(onSubmit)}
          className="mt-5 flex flex-col gap-5"
        >
          {/* 名称与格式同排 */}
          <div className="grid grid-cols-2 gap-4">
            <Field label={t("settings.webhooks.name")} htmlFor="wh-name" required>
              <Controller
                control={control}
                name="name"
                render={({ field, fieldState }) => (
                  <Input
                    id="wh-name"
                    {...field}
                    aria-invalid={fieldState.invalid}
                    placeholder={t("settings.webhooks.namePlaceholder")}
                  />
                )}
              />
              <FieldError errors={[errors.name]} />
            </Field>
            <Field label={t("settings.webhooks.format")} htmlFor="wh-format">
              <Controller
                control={control}
                name="format"
                render={({ field }) => (
                  <Select
                    value={field.value}
                    onValueChange={field.onChange}
                    items={WEBHOOK_FORMATS.map((f) => ({ value: f.value, label: t(f.labelKey) }))}
                  >
                    <SelectTrigger id="wh-format" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {WEBHOOK_FORMATS.map((f) => (
                        <SelectItem key={f.value} value={f.value}>
                          {t(f.labelKey)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              />
            </Field>
          </div>
          <Field label="URL" htmlFor="wh-url" required>
            <Controller
              control={control}
              name="url"
              render={({ field, fieldState }) => (
                <Input
                  id="wh-url"
                  {...field}
                  aria-invalid={fieldState.invalid}
                  placeholder={URL_PLACEHOLDER[formatValue]}
                />
              )}
            />
            <FieldError errors={[errors.url]} />
          </Field>
          {/* Bark 无加签机制：该格式下不渲染密钥字段，免得用户以为要填 */}
          {formatValue !== "bark" && (
            <Field label={t("settings.webhooks.secret")} htmlFor="wh-secret">
              <Controller
                control={control}
                name="secret"
                render={({ field }) => (
                  <Input
                    id="wh-secret"
                    {...field}
                    type="password"
                    placeholder={t("settings.webhooks.secretPlaceholder")}
                  />
                )}
              />
            </Field>
          )}
          {/* 订阅事件：全部开关在标题行右侧，复选框横向排布一行放不下自动换行 */}
          <div className="flex flex-col gap-2.5">
            <div className="flex items-center justify-between">
              <div className="text-sm font-medium">{t("settings.webhooks.subscribeEvents")}</div>
              <label className="flex cursor-pointer items-center gap-2">
                <span className="text-muted-foreground text-[13px] leading-5">{t("settings.webhooks.allEvents")}</span>
                <Controller
                  control={control}
                  name="allEvents"
                  render={({ field }) => (
                    <Switch
                      checked={field.value}
                      onCheckedChange={field.onChange}
                    />
                  )}
                />
              </label>
            </div>
            <Controller
              control={control}
              name="events"
              render={({ field }) => (
                <div
                  className={cn(
                    "flex flex-wrap gap-x-5 gap-y-2",
                    allEvents && "opacity-50",
                  )}
                >
                  {AGENT_EVENT_REGISTRY.map((entry) => (
                    <label
                      key={entry.name}
                      className="flex items-center gap-2 text-sm"
                    >
                      <Checkbox
                        disabled={allEvents}
                        checked={allEvents || field.value.includes(entry.name)}
                        onCheckedChange={(c) =>
                          field.onChange(
                            c === true
                              ? [...field.value, entry.name]
                              : field.value.filter((e) => e !== entry.name),
                          )
                        }
                      />
                      {eventLabel(entry.name)}
                    </label>
                  ))}
                </div>
              )}
            />
            <FieldError errors={[errors.events]} />
          </div>
          <DialogFooter className="gap-3 sm:justify-between">
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => void handleTest()}
                disabled={testing || !isHttpUrl(urlValue)}
                title={t("settings.webhooks.testTooltip")}
              >
                <FlaskConicalIcon className="size-3.5" />
                {t("settings.webhooks.test")}
              </Button>
              {(testing || testResult) && (
                <AnimatedBadge
                  size="sm"
                  status={
                    testing
                      ? "loading"
                      : testResult!.ok
                        ? "success"
                        : "danger"
                  }
                  layout={false}
                  title={testing ? undefined : testResult?.detail}
                >
                  {testing ? t("settings.webhooks.testing") : testResult!.ok ? t("settings.webhooks.success") : t("settings.webhooks.failure")}
                </AnimatedBadge>
              )}
            </div>
            <div className="flex items-center gap-3">
              <Button
                type="button"
                variant="outline"
                className="min-w-18"
                onClick={() => onOpenChange(false)}
              >
                {t("settings.webhooks.cancel")}
              </Button>
              <Button type="submit" className="min-w-18">
                {t("settings.webhooks.save")}
              </Button>
            </div>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
};

// ---------------------------------------------------------------------------
// Webhooks 设置页：端点管理 + 最近推送记录
// ---------------------------------------------------------------------------

export const WebhooksSettings: FC = () => {
  const t = useT();
  const endpoints = useWebhookEndpoints();
  const deliveries = useWebhookDeliveries();
  const [editing, setEditing] = useState<WebhookEndpoint | "new" | null>(null);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [pruning, setPruning] = useState(false);
  /** 清理动作（下拉菜单选择后进入确认框）：keep20=保留最近 20 条；all=全部清空 */
  const [pruneAction, setPruneAction] = useState<"keep20" | "all" | null>(
    null,
  );
  const [confirmDelete, setConfirmDelete] = useState<WebhookEndpoint | null>(
    null,
  );
  const [testResults, setTestResults] = useState<
    Record<string, { ok: boolean; detail: string }>
  >({});

  const handleTest = async (endpoint: WebhookEndpoint) => {
    setTestingId(endpoint.id);
    const result = await sendWebhookTest(endpoint);
    setTestResults((m) => ({ ...m, [endpoint.id]: result }));
    setTestingId(null);
  };

  const handlePrune = async () => {
    if (!pruneAction || pruning) return;
    const action = pruneAction;
    setPruning(true);
    try {
      const deleted = await pruneWebhookDeliveries(
        action === "all" ? 0 : DELIVERY_KEEP,
      );
      if (deleted > 0) {
        toast.success(
          action === "all"
            ? t("settings.webhooks.clearedAll", { count: deleted })
            : t("settings.webhooks.clearedOlder", { count: deleted }),
        );
      } else {
        toast.message(
          action === "all" ? t("settings.webhooks.noneToClear") : t("settings.webhooks.nothingOlder"),
        );
      }
    } catch {
      toast.error(t("settings.webhooks.cleanFailed"));
    } finally {
      setPruning(false);
      setPruneAction(null);
    }
  };

  const handleDelete = async () => {
    if (!confirmDelete) return;
    const target = confirmDelete;
    // 先收弹窗：removeWebhook 是同步乐观更新，级联清理失败也不该把弹窗卡在屏上
    setConfirmDelete(null);
    try {
      removeWebhook(target.id);
      // 级联清掉该端点的推送记录（内存缓存 + SQLite）
      await removeWebhookDeliveries(target.name);
      toast.success(t("settings.webhooks.deleted", { name: target.name }));
    } catch {
      toast.error(t("settings.webhooks.deleteRecordsFailed", { name: target.name }));
    }
  };

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <div className="flex w-full max-w-5xl flex-col gap-8 self-center px-8 py-8">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">{t("settings.webhooks.title")}</h1>
          </div>
          <Button  onClick={() => setEditing("new")}>
            <PlusIcon className="size-4" />
            {t("settings.webhooks.add")}
          </Button>
        </div>

        {/* 端点列表 */}
        <section>
          {endpoints.length === 0 ? (
            <div className="text-muted-foreground rounded-2xl border border-dashed p-10 text-center text-sm">
              {t("settings.webhooks.empty")}
            </div>
          ) : (
            <div className="bg-muted/50 flex flex-col gap-1 rounded-2xl p-2">
              {endpoints.map((endpoint) => {
                const result = testResults[endpoint.id];
                const isTesting = testingId === endpoint.id;
                return (
                  <div
                    key={endpoint.id}
                    className="flex items-center justify-between gap-3 rounded-xl px-3 py-2"
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium">
                          {endpoint.name}
                        </span>
                        <AnimatedBadge
                          status="neutral"
                          size="sm"
                          showIcon={false}
                          layout={false}
                        >
                          {
                            t(
                              WEBHOOK_FORMATS.find(
                                (f) => f.value === endpoint.format,
                              )?.labelKey ?? endpoint.format,
                            )
                          }
                        </AnimatedBadge>
                        <span className="text-muted-foreground text-[13px] leading-5">
                          {endpoint.events === "*"
                            ? t("settings.webhooks.allEventsLabel")
                            : t("settings.webhooks.eventCount", { count: endpoint.events.length })}
                        </span>
                      </div>
                      <div className="text-muted-foreground truncate text-[13px] leading-5">
                        {endpoint.url}
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={testingId === endpoint.id}
                        onClick={() => handleTest(endpoint)}
                      >
                        <FlaskConicalIcon className="size-3.5" />
                        {t("settings.webhooks.test")}
                      </Button>
                      {/* 测试状态徽标：进行中 loading，结束后成功/失败（悬停看详情） */}
                      {(isTesting || result) && (
                        <AnimatedBadge
                          size="sm"
                          status={
                            isTesting
                              ? "loading"
                              : result!.ok
                                ? "success"
                                : "danger"
                          }
                          title={isTesting ? undefined : result?.detail}
                        >
                          {isTesting
                            ? t("settings.webhooks.testing")
                            : result!.ok
                              ? t("settings.webhooks.success")
                              : t("settings.webhooks.failure")}
                        </AnimatedBadge>
                      )}
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setEditing(endpoint)}
                      >
                        {t("settings.webhooks.edit")}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setConfirmDelete(endpoint)}
                      >
                        <Trash2Icon className="size-3.5" />
                      </Button>
                      <Switch
                        checked={endpoint.enabled}
                        onCheckedChange={(v) =>
                          updateWebhook(endpoint.id, { enabled: v })
                        }
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>

        {/* 最近推送记录 */}
        <section className="flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <h2 className="text-base font-semibold">{t("settings.webhooks.recent")}</h2>
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button size="sm" variant="ghost" className="gap-1">
                    {t("settings.webhooks.clean")}
                    <ChevronDownIcon className="size-3.5 opacity-60" />
                  </Button>
                }
              />
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={() => setPruneAction("keep20")}>
                  {t("settings.webhooks.keepRecent", { count: DELIVERY_KEEP })}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  variant="destructive"
                  onClick={() => setPruneAction("all")}
                >
                  {t("settings.webhooks.clearAllRecords")}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
          {deliveries.length === 0 ? (
            <div className="text-muted-foreground rounded-2xl border border-dashed p-6 text-center text-sm">
              {t("settings.webhooks.noRecords")}
            </div>
          ) : (
            <div className="bg-muted/50 flex flex-col gap-1 rounded-2xl p-2">
              {deliveries.slice(0, 20).map((d) => (
                <div
                  key={d.id}
                  className="flex items-center gap-3 px-3 py-1.5 text-sm"
                >
                  <span className="text-muted-foreground w-24 shrink-0 tabular-nums">
                    {new Date(d.ts).toLocaleTimeString(
                      getLocale() === "zh" ? "zh-CN" : "en-US",
                    )}
                  </span>
                  <span className="w-28 shrink-0 truncate font-medium">
                    {d.endpointName}
                  </span>
                  <span
                    className="w-36 shrink-0 truncate"
                    title={eventLabel(d.event)}
                  >
                    {eventLabel(d.event)}
                  </span>
                  {/* layout={false}：新记录插到列表顶部时整行下移，
                      关掉布局弹簧，否则徽标会自己"游"到新位置（往下飘） */}
                  <AnimatedBadge
                    size="sm"
                    status={d.ok ? "success" : "danger"}
                    layout={false}
                    className="shrink-0"
                  >
                    {d.ok ? t("settings.webhooks.success") : t("settings.webhooks.failure")}
                  </AnimatedBadge>
                  <span className="text-muted-foreground min-w-0 flex-1 truncate">
                    {d.detail}
                  </span>
                  <span className="text-muted-foreground shrink-0 tabular-nums">
                    {d.durationMs}ms
                  </span>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>

      {editing && (
        <WebhookEditor
          key={editing === "new" ? "new" : editing.id}
          endpoint={editing === "new" ? null : editing}
          onOpenChange={(open) => {
            if (!open) setEditing(null);
          }}
        />
      )}

      {/* 删除端点确认：连带删除其推送记录 */}
      <AlertDialog
        open={confirmDelete !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmDelete(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("settings.webhooks.deleteConfirmTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("settings.webhooks.deleteConfirmDesc", { name: confirmDelete?.name ?? "" })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel size="default">{t("settings.webhooks.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              size="default"
              onClick={() => {
                void handleDelete();
              }}
            >
              {t("settings.webhooks.delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* 清理确认：删库操作，先弹 AlertDialog（文案随动作切换） */}
      <AlertDialog
        open={pruneAction !== null}
        onOpenChange={(open) => {
          if (!open) setPruneAction(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {pruneAction === "all" ? t("settings.webhooks.pruneAllTitle") : t("settings.webhooks.pruneSomeTitle")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {pruneAction === "all"
                ? t("settings.webhooks.pruneAllDesc")
                : t("settings.webhooks.pruneSomeDesc", { count: DELIVERY_KEEP })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel size="default">{t("settings.webhooks.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              size="default"
              disabled={pruning}
              onClick={() => {
                void handlePrune();
              }}
            >
              {pruning ? t("settings.webhooks.cleaning") : t("settings.webhooks.clean")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
};
