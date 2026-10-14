"use client";

import { useState, type FC } from "react";
import { Controller, useForm, useWatch } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Field,
  FieldError,
  FieldLabel,
} from "@/components/ui/field";
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  addHookConfig,
  removeHookConfig,
  updateHookConfig,
  useHookConfigs,
  type HookConfig,
} from "@/lib/pi/hooks";
import type { PiHookEventName } from "@/lib/pi/pi-bridge";
import { toast } from "@/components/ui/toast";
import { PlusIcon, Trash2Icon } from "lucide-react";

// ---------------------------------------------------------------------------
// 事件清单（与 Claude Code 官方钩子事件 1:1 对齐；执行细节见 sidecar hooks.ts）
// ---------------------------------------------------------------------------

const HOOK_EVENT_REGISTRY: {
  name: PiHookEventName;
  label: string;
}[] = [
  { name: "SessionStart", label: "会话启动" },
  { name: "UserPromptSubmit", label: "用户提交消息" },
  { name: "PreToolUse", label: "工具调用前" },
  { name: "PermissionRequest", label: "请求审批时" },
  { name: "PostToolUse", label: "工具成功后" },
  { name: "PostToolUseFailure", label: "工具失败后" },
  { name: "Stop", label: "回合结束" },
];

const EVENT_SELECT_ITEMS = HOOK_EVENT_REGISTRY.map((e) => ({
  label: `${e.label}（${e.name}）`,
  value: e.name,
}));

/** 支持 matcher（工具名过滤）的事件 */
const TOOL_EVENTS = new Set<PiHookEventName>([
  "PreToolUse",
  "PermissionRequest",
  "PostToolUse",
  "PostToolUseFailure",
]);

const eventLabel = (name: PiHookEventName) =>
  HOOK_EVENT_REGISTRY.find((e) => e.name === name)?.label ?? name;

// ---------------------------------------------------------------------------
// 钩子表单（react-hook-form + zod：校验、错误文案都在 schema 里）
// ---------------------------------------------------------------------------

const hookFormSchema = z.object({
  name: z.string().trim().min(1, "请输入名称"),
  /** "shell"（整串交 shell 解释，默认）| "process"（argv 直接执行） */
  type: z.enum(["shell", "process"]),
  command: z.string().trim().min(1, "请输入命令"),
  /** shell 命令类型的解释器，空 = 系统默认（$SHELL） */
  shell: z.string().trim(),
  /** 进程类型的参数，每行一个 */
  argsText: z.string(),
  event: z.enum([
    "SessionStart",
    "UserPromptSubmit",
    "PreToolUse",
    "PermissionRequest",
    "PostToolUse",
    "PostToolUseFailure",
    "Stop",
  ]),
  /** 工具名过滤：逗号分隔精确名（"Write, Edit, Bash"）或单个正则；空 = 全部 */
  matcher: z.string().trim(),
  /** 后台运行：不等待命令结束（决策类事件视为无决策） */
  background: z.boolean(),
  /** 空串 = 默认 10s；否则 1–120 整数秒（存储侧换算为毫秒） */
  timeoutSecText: z
    .string()
    .trim()
    .refine(
      (v) => v === "" || (/^\d+$/.test(v) && Number(v) >= 1 && Number(v) <= 120),
      "超时需为 1–120 之间的整数秒",
    ),
});

type HookFormValues = z.infer<typeof hookFormSchema>;

/** 内联编辑卡片（父组件条件挂载，表单 defaultValues 初始化一次即可） */
const HookEditorCard: FC<{
  hook: HookConfig | null;
  onDone: () => void;
  onCancel: () => void;
}> = ({ hook, onDone, onCancel }) => {
  const {
    control,
    handleSubmit,
    formState: { errors },
  } = useForm<HookFormValues>({
    resolver: zodResolver(hookFormSchema),
    defaultValues: {
      name: hook?.name ?? "",
      type: hook?.type ?? "shell",
      command: hook?.command ?? "",
      shell: hook?.shell ?? "",
      argsText: (hook?.args ?? []).join("\n"),
      event: hook?.event ?? "Stop",
      matcher: hook?.matcher ?? "",
      background: hook?.background ?? false,
      timeoutSecText: hook?.timeoutMs ? String(hook.timeoutMs / 1000) : "",
    },
  });
  const event = useWatch({ control, name: "event" });
  const type = useWatch({ control, name: "type" });

  const onSubmit = (values: HookFormValues) => {
    const isShell = values.type === "shell";
    const value = {
      name: values.name,
      type: values.type,
      command: values.command,
      shell: isShell && values.shell ? values.shell : undefined,
      args: !isShell
        ? values.argsText
            .split("\n")
            .map((s) => s.trim())
            .filter(Boolean)
        : undefined,
      event: values.event,
      matcher: TOOL_EVENTS.has(values.event) ? values.matcher || undefined : undefined,
      background: values.background,
      timeoutMs: values.timeoutSecText ? Number(values.timeoutSecText) * 1000 : undefined,
      enabled: hook?.enabled ?? true,
    };
    const save = hook ? updateHookConfig(hook.id, { ...value, id: hook.id }) : addHookConfig(value);
    void save.then(onDone).catch(() => toast.error("保存失败：与 agent 服务通信中断"));
  };

  return (
    <form
      onSubmit={handleSubmit(onSubmit)}
      className="bg-muted/30 flex flex-col gap-5 rounded-2xl border p-5"
    >
      <div className="grid grid-cols-2 items-end gap-4">
        <Field data-invalid={!!errors.name}>
          <FieldLabel htmlFor="hook-name">
            名称<span className="text-destructive">*</span>
          </FieldLabel>
          <Controller
            control={control}
            name="name"
            render={({ field, fieldState }) => (
              <Input
                id="hook-name"
                {...field}
                aria-invalid={fieldState.invalid}
                placeholder="例如：拦截危险命令"
              />
            )}
          />
          <FieldError errors={[errors.name]} />
        </Field>
        <Field>
          <FieldLabel>触发事件</FieldLabel>
          <Controller
            control={control}
            name="event"
            render={({ field }) => (
              <Select
                value={field.value}
                onValueChange={field.onChange}
                items={EVENT_SELECT_ITEMS}
              >
                <SelectTrigger size="sm" className="w-full border bg-muted">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {EVENT_SELECT_ITEMS.map((e) => (
                    <SelectItem key={e.value} value={e.value}>
                      {e.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          />
        </Field>
      </div>

      <div className="grid grid-cols-2 items-end gap-4">
        <Field>
          <FieldLabel>类型</FieldLabel>
          <Controller
            control={control}
            name="type"
            render={({ field }) => (
              <Select
                value={field.value}
                onValueChange={field.onChange}
                items={[
                  { label: "Shell 命令", value: "shell" },
                  { label: "进程", value: "process" },
                ]}
              >
                <SelectTrigger size="sm" className="w-full border bg-muted">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="shell">Shell 命令</SelectItem>
                  <SelectItem value="process">进程</SelectItem>
                </SelectContent>
              </Select>
            )}
          />
        </Field>
        {TOOL_EVENTS.has(event) && (
          <Field>
            <FieldLabel htmlFor="hook-matcher">匹配器</FieldLabel>
            <Controller
              control={control}
              name="matcher"
              render={({ field }) => (
                <Input
                  id="hook-matcher"
                  {...field}
                  className="font-mono"
                  placeholder="例如 Write, Edit, Bash"
                />
              )}
            />
            <p className="text-muted-foreground text-xs">
              逗号分隔工具名，留空匹配该事件的所有输入
            </p>
          </Field>
        )}
      </div>

      <Field data-invalid={!!errors.command}>
        <FieldLabel htmlFor="hook-command">
          命令<span className="text-destructive">*</span>
        </FieldLabel>
        <Controller
          control={control}
          name="command"
          render={({ field, fieldState }) => (
            <Input
              id="hook-command"
              {...field}
              aria-invalid={fieldState.invalid}
              className="font-mono"
              placeholder={
                type === "shell" ? "例如 echo 'Hello from hook'" : "例如 /usr/local/bin/notify-hook"
              }
            />
          )}
        />
        <FieldError errors={[errors.command]} />
      </Field>

      {type === "shell" ? (
        <Field>
          <FieldLabel htmlFor="hook-shell">Shell</FieldLabel>
          <Controller
            control={control}
            name="shell"
            render={({ field }) => (
              <Input
                id="hook-shell"
                {...field}
                className="font-mono"
                placeholder="系统默认（$SHELL）"
              />
            )}
          />
        </Field>
      ) : (
        <Field>
          <FieldLabel htmlFor="hook-args">参数（每行一个，可选）</FieldLabel>
          <Controller
            control={control}
            name="argsText"
            render={({ field }) => (
              <Textarea
                id="hook-args"
                {...field}
                className="min-h-16 font-mono text-xs"
                placeholder={"--verbose\n--tag agent"}
              />
            )}
          />
        </Field>
      )}

      <div className="flex items-center justify-between gap-4 border-t pt-4">
        <Controller
          control={control}
          name="background"
          render={({ field }) => (
            <div className="flex items-center gap-3">
              <Switch checked={field.value} onCheckedChange={field.onChange} />
              <div>
                <div className="text-sm font-medium">后台运行</div>
                <p className="text-muted-foreground text-xs">
                  不等待命令结束；决策类事件（PreToolUse / PermissionRequest）将视为无决策
                </p>
              </div>
            </div>
          )}
        />
        <Field className="w-40" data-invalid={!!errors.timeoutSecText}>
          <FieldLabel htmlFor="hook-timeout">超时（秒）</FieldLabel>
          <Controller
            control={control}
            name="timeoutSecText"
            render={({ field, fieldState }) => (
              <Input
                id="hook-timeout"
                {...field}
                inputMode="numeric"
                aria-invalid={fieldState.invalid}
                placeholder="10"
              />
            )}
          />
          <FieldError errors={[errors.timeoutSecText]} />
        </Field>
      </div>

      <div className="flex items-center justify-between">
        <p className="text-muted-foreground text-xs">
          负载以 JSON 经标准输入传入。
          {event === "PreToolUse" &&
            " PreToolUse 可拦截：退出码 2 或输出 {\"decision\":\"block\"} 拒绝工具调用。"}
          {event === "PermissionRequest" &&
            " PermissionRequest 可自动裁决：输出 {\"decision\":\"approve\"} 放行、{\"decision\":\"block\"} 拒绝，否则照常弹审批。"}
          {event !== "PreToolUse" && event !== "PermissionRequest" &&
            " 命令失败静默，不影响对话。"}
        </p>
        <div className="flex shrink-0 gap-2">
          <Button type="button" variant="ghost" onClick={onCancel}>
            取消
          </Button>
          <Button type="submit">保存</Button>
        </div>
      </div>
    </form>
  );
};

// ---------------------------------------------------------------------------
// 钩子设置页
// ---------------------------------------------------------------------------

export const HooksSettings: FC = () => {
  const hooks = useHookConfigs();
  const [editing, setEditing] = useState<HookConfig | "new" | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<HookConfig | null>(null);

  const handleDelete = async () => {
    if (!confirmDelete) return;
    try {
      await removeHookConfig(confirmDelete.id);
      toast.success(`已删除「${confirmDelete.name}」`);
    } catch {
      toast.error("删除失败：与 agent 服务通信中断");
    }
    setConfirmDelete(null);
  };

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <div className="flex w-full max-w-5xl flex-col gap-8 self-center px-8 py-8">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">钩子</h1>
            <p className="text-muted-foreground mt-1 text-sm">
              在 agent 生命周期事件（会话启动、工具调用、回合结束等）触发时于本机执行命令。
            </p>
          </div>
          {!editing && (
            <Button onClick={() => setEditing("new")}>
              <PlusIcon className="size-4" />
              添加
            </Button>
          )}
        </div>

        {editing && (
          <HookEditorCard
            key={editing === "new" ? "new" : editing.id}
            hook={editing === "new" ? null : editing}
            onDone={() => setEditing(null)}
            onCancel={() => setEditing(null)}
          />
        )}

        <section>
          {hooks.length === 0 ? (
            <div className="text-muted-foreground rounded-2xl border border-dashed p-10 text-center text-sm">
              还没有钩子，点「添加」创建第一个
            </div>
          ) : (
            <div className="bg-muted/50 flex flex-col gap-1 rounded-2xl p-2">
              {hooks.map((hook) => (
                <div
                  key={hook.id}
                  className="flex items-center justify-between gap-3 rounded-xl px-3 py-2"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium">{hook.name}</span>
                      <span className="text-muted-foreground rounded-md bg-background px-1.5 py-0.5 text-xs">
                        {eventLabel(hook.event)}
                      </span>
                      {hook.matcher && (
                        <span className="text-muted-foreground font-mono text-xs">
                          {hook.matcher}
                        </span>
                      )}
                      {hook.background && (
                        <span className="text-muted-foreground rounded-md bg-background px-1.5 py-0.5 text-xs">
                          后台
                        </span>
                      )}
                    </div>
                    <div className="text-muted-foreground truncate font-mono text-xs">
                      {hook.type === "shell"
                        ? [hook.shell ? `${hook.shell} -c` : null, hook.command]
                            .filter(Boolean)
                            .join(" ")
                        : [hook.command, ...(hook.args ?? [])].join(" ")}
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <Button size="sm" variant="ghost" onClick={() => setEditing(hook)}>
                      编辑
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(hook)}>
                      <Trash2Icon className="size-3.5" />
                    </Button>
                    <Switch
                      checked={hook.enabled}
                      onCheckedChange={(v) => {
                        void updateHookConfig(hook.id, { ...hook, enabled: v }).catch(() =>
                          toast.error("保存失败：与 agent 服务通信中断"),
                        );
                      }}
                    />
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>

      <AlertDialog
        open={confirmDelete !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmDelete(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除钩子？</AlertDialogTitle>
            <AlertDialogDescription>
              {`将删除「${confirmDelete?.name ?? ""}」配置，此操作无法撤销。`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel size="default">取消</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              size="default"
              onClick={() => {
                void handleDelete();
              }}
            >
              删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
};
