"use client";

import { useState, type FC } from "react";
import { Controller, useWatch, useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import {
  Field,
  FieldError,
  FieldLabel,
} from "@/components/ui/field";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
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
  AGENT_EVENT_REGISTRY,
  eventLabel,
  type AgentEventName,
} from "@/lib/agent-events";
import {
  WEBHOOK_FORMATS,
  addWebhook,
  removeWebhook,
  updateWebhook,
  useWebhookEndpoints,
  type WebhookEndpoint,
  type WebhookFormat,
} from "@/lib/webhooks";
import {
  pruneWebhookDeliveries,
  sendWebhookTest,
  useWebhookDeliveries,
} from "@/lib/webhook-dispatcher";
import { toast } from "@/components/ui/toast";
import { cn } from "@/lib/utils";
import { FlaskConicalIcon, PlusIcon, Trash2Icon } from "lucide-react";

// ---------------------------------------------------------------------------
// 端点表单（react-hook-form + zod：校验、错误文案都在 schema 里）
// ---------------------------------------------------------------------------

const ALL_EVENT_NAMES = AGENT_EVENT_REGISTRY.map((e) => e.name);

const webhookFormSchema = z
  .object({
    name: z.string().trim().min(1, "请输入名称"),
    url: z
      .string()
      .trim()
      .min(1, "请输入 URL")
      .refine((v) => /^https?:\/\//i.test(v), "需以 http(s):// 开头"),
    secret: z.string().trim(),
    format: z.enum(["generic", "dingtalk", "feishu", "slack"]),
    allEvents: z.boolean(),
    events: z.array(z.string()),
  })
  .superRefine((val, ctx) => {
    if (!val.allEvents && val.events.length === 0) {
      ctx.addIssue({
        code: "custom",
        path: ["events"],
        message: "至少选择一个事件",
      });
    }
  });

type WebhookFormValues = z.infer<typeof webhookFormSchema>;

/** 端点编辑对话框（父组件条件挂载，表单 defaultValues 初始化一次即可） */
const WebhookEditor: FC<{
  endpoint: WebhookEndpoint | null;
  onOpenChange: (open: boolean) => void;
}> = ({ endpoint, onOpenChange }) => {
  const {
    control,
    handleSubmit,
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

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{endpoint ? "编辑 Webhook" : "添加 Webhook"}</DialogTitle>
          <DialogDescription>
            事件将以所选平台的格式推送到该 URL，发送走应用内通道，无跨域限制。
          </DialogDescription>
        </DialogHeader>
        <form
          onSubmit={handleSubmit(onSubmit)}
          className="grid grid-cols-2 gap-x-4 gap-y-4"
        >
          <Field data-invalid={!!errors.name}>
            <FieldLabel htmlFor="wh-name">
              名称<span className="text-destructive">*</span>
            </FieldLabel>
            <Controller
              control={control}
              name="name"
              render={({ field, fieldState }) => (
                <Input
                  id="wh-name"
                  {...field}
                  aria-invalid={fieldState.invalid}
                  placeholder="例如：值班群通知"
                />
              )}
            />
            <FieldError errors={[errors.name]} />
          </Field>
          <Field>
            <FieldLabel>格式</FieldLabel>
            <Controller
              control={control}
              name="format"
              render={({ field }) => (
                <Select
                  value={field.value}
                  onValueChange={field.onChange}
                  items={WEBHOOK_FORMATS}
                >
                  <SelectTrigger
                    size="sm"
                    className="w-full border bg-muted"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {WEBHOOK_FORMATS.map((f) => (
                      <SelectItem key={f.value} value={f.value}>
                        {f.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            />
          </Field>
          <Field className="col-span-2" data-invalid={!!errors.url}>
            <FieldLabel htmlFor="wh-url">
              URL<span className="text-destructive">*</span>
            </FieldLabel>
            <Controller
              control={control}
              name="url"
              render={({ field, fieldState }) => (
                <Input
                  id="wh-url"
                  {...field}
                  aria-invalid={fieldState.invalid}
                  placeholder="https://oapi.dingtalk.com/robot/send?access_token=…"
                />
              )}
            />
            <FieldError errors={[errors.url]} />
          </Field>
          <Field className="col-span-2">
            <FieldLabel htmlFor="wh-secret">加签密钥（可选）</FieldLabel>
            <Controller
              control={control}
              name="secret"
              render={({ field }) => (
                <Input
                  id="wh-secret"
                  {...field}
                  type="password"
                  placeholder="钉钉/飞书安全设置的 secret，或通用 HMAC 密钥"
                />
              )}
            />
          </Field>
          <Field className="col-span-2" data-invalid={!!errors.events}>
            <div className="flex items-center justify-between">
              <FieldLabel>订阅事件</FieldLabel>
              <div className="flex items-center gap-2">
                <span className="text-muted-foreground text-xs">全部</span>
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
              </div>
            </div>
            {/* 事件复选框横向排布，一行放不下自动换行 */}
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
                      {entry.label}
                    </label>
                  ))}
                </div>
              )}
            />
            <FieldError errors={[errors.events]} />
          </Field>
          <DialogFooter className="col-span-2">
            <Button
              type="button"
              variant="ghost"
              onClick={() => onOpenChange(false)}
            >
              取消
            </Button>
            <Button type="submit">保存</Button>
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
  const endpoints = useWebhookEndpoints();
  const deliveries = useWebhookDeliveries();
  const [editing, setEditing] = useState<WebhookEndpoint | "new" | null>(null);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [pruning, setPruning] = useState(false);
  const [pruneConfirm, setPruneConfirm] = useState(false);
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
    setPruning(true);
    const deleted = await pruneWebhookDeliveries();
    setPruning(false);
    setPruneConfirm(false);
    if (deleted > 0) toast.success(`已清理 ${deleted} 条较早的推送记录`);
    else toast.message("没有比最近 20 条更早的记录");
  };

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <div className="flex w-full max-w-5xl flex-col gap-8 self-center px-8 py-8">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Webhooks</h1>
            <p className="text-muted-foreground mt-1 text-sm">
              把任务完成、等待审批、出错等事件推送到钉钉/飞书/Slack 或任意 HTTP 端点。
            </p>
          </div>
          <Button  onClick={() => setEditing("new")}>
            <PlusIcon className="size-4" />
            添加
          </Button>
        </div>

        {/* 端点列表 */}
        <section>
          {endpoints.length === 0 ? (
            <div className="text-muted-foreground rounded-2xl border border-dashed p-10 text-center text-sm">
              还没有 webhook，点「添加」创建第一个
            </div>
          ) : (
            <div className="bg-muted/50 flex flex-col gap-1 rounded-2xl p-2">
              {endpoints.map((endpoint) => {
                const result = testResults[endpoint.id];
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
                        <Badge variant="secondary" className="text-xs">
                          {
                            WEBHOOK_FORMATS.find(
                              (f) => f.value === endpoint.format,
                            )?.label
                          }
                        </Badge>
                        <span className="text-muted-foreground text-xs">
                          {endpoint.events === "*"
                            ? "全部事件"
                            : `${endpoint.events.length} 个事件`}
                        </span>
                      </div>
                      <div className="text-muted-foreground truncate text-xs">
                        {endpoint.url}
                      </div>
                      {result && (
                        <div
                          className={cn(
                            "text-xs",
                            result.ok
                              ? "text-green-600 dark:text-green-400"
                              : "text-destructive",
                          )}
                        >
                          {result.ok ? "✓ " : "✗ "}
                          {result.detail}
                        </div>
                      )}
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={testingId === endpoint.id}
                        onClick={() => handleTest(endpoint)}
                      >
                        <FlaskConicalIcon className="size-3.5" />
                        {testingId === endpoint.id ? "测试中…" : "测试"}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setEditing(endpoint)}
                      >
                        编辑
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => removeWebhook(endpoint.id)}
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
            <h2 className="text-base font-semibold">最近推送</h2>
            <Button
              size="sm"
              variant="ghost"
              title="删除最近 20 条以外的历史记录"
              disabled={pruning}
              onClick={() => setPruneConfirm(true)}
            >
              {pruning ? "清理中…" : "清理"}
            </Button>
          </div>
          {deliveries.length === 0 ? (
            <div className="text-muted-foreground rounded-2xl border border-dashed p-6 text-center text-sm">
              暂无推送记录
            </div>
          ) : (
            <div className="bg-muted/50 flex flex-col gap-1 rounded-2xl p-2">
              {deliveries.slice(0, 20).map((d) => (
                <div
                  key={d.id}
                  className="flex items-center gap-3 px-3 py-1.5 text-sm"
                >
                  <span className="text-muted-foreground w-20 shrink-0 tabular-nums">
                    {new Date(d.ts).toLocaleTimeString()}
                  </span>
                  <span className="w-28 shrink-0 truncate font-medium">
                    {d.endpointName}
                  </span>
                  <span className="w-16 shrink-0">{eventLabel(d.event)}</span>
                  <Badge
                    variant="outline"
                    className={
                      d.ok
                        ? "bg-green-600/10 shrink-0 dark:text-green-400"
                        : "text-destructive shrink-0"
                    }
                  >
                    {d.ok ? "成功" : "失败"}
                  </Badge>
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

      {/* 清理确认：删库操作，先弹 AlertDialog */}
      <AlertDialog open={pruneConfirm} onOpenChange={setPruneConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>清理推送记录？</AlertDialogTitle>
            <AlertDialogDescription>
              将删除最近 20 条以外的全部历史推送记录，此操作无法撤销。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel size="default">取消</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              size="default"
              disabled={pruning}
              onClick={() => {
                void handlePrune();
              }}
            >
              {pruning ? "清理中…" : "清理"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
};
