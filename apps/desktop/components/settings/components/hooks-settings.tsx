"use client";

import { useState, useMemo, type FC } from "react";
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
import { useT } from "@/lib/i18n";

// ---------------------------------------------------------------------------
// 事件清单（与 Claude Code 官方钩子事件 1:1 对齐；执行细节见 sidecar hooks.ts）
// ---------------------------------------------------------------------------

const HOOK_EVENT_REGISTRY: {
  name: PiHookEventName;
  labelKey: string;
}[] = [
  { name: "SessionStart", labelKey: "settings.hooks.events.sessionStart" },
  { name: "UserPromptSubmit", labelKey: "settings.hooks.events.userPromptSubmit" },
  { name: "PreToolUse", labelKey: "settings.hooks.events.preToolUse" },
  { name: "PermissionRequest", labelKey: "settings.hooks.events.permissionRequest" },
  { name: "PostToolUse", labelKey: "settings.hooks.events.postToolUse" },
  { name: "PostToolUseFailure", labelKey: "settings.hooks.events.postToolUseFailure" },
  { name: "Stop", labelKey: "settings.hooks.events.stop" },
];

const hookEventSelectItems = (t: ReturnType<typeof useT>) =>
  HOOK_EVENT_REGISTRY.map((e) => ({
    label: `${t(e.labelKey)} (${e.name})`,
    value: e.name,
  }));

/** 支持 matcher（工具名过滤）的事件 */
const TOOL_EVENTS = new Set<PiHookEventName>([
  "PreToolUse",
  "PermissionRequest",
  "PostToolUse",
  "PostToolUseFailure",
]);

const hookEventLabel = (t: ReturnType<typeof useT>, name: PiHookEventName) => {
  const entry = HOOK_EVENT_REGISTRY.find((e) => e.name === name);
  return entry ? t(entry.labelKey) : name;
};

// ---------------------------------------------------------------------------
// 钩子表单（react-hook-form + zod：校验、错误文案都在 schema 里）
// ---------------------------------------------------------------------------

const createHookFormSchema = (t: ReturnType<typeof useT>) =>
  z.object({
    name: z.string().trim().min(1, t("settings.hooks.validationName")),
    /** "shell"（整串交 shell 解释，默认）| "process"（argv 直接执行） */
    type: z.enum(["shell", "process"]),
    command: z.string().trim().min(1, t("settings.hooks.validationCommand")),
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
        t("settings.hooks.validationTimeout"),
      ),
  });

type HookFormValues = z.infer<ReturnType<typeof createHookFormSchema>>;

/** 内联编辑卡片（父组件条件挂载，表单 defaultValues 初始化一次即可） */
const HookEditorCard: FC<{
  hook: HookConfig | null;
  onDone: () => void;
  onCancel: () => void;
}> = ({ hook, onDone, onCancel }) => {
  const t = useT();
  const hookFormSchema = useMemo(() => createHookFormSchema(t), [t]);
  const eventSelectItems = useMemo(() => hookEventSelectItems(t), [t]);
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
    void save.then(onDone).catch(() => toast.error(t("settings.hooks.saveFailed")));
  };

  return (
    <form
      onSubmit={handleSubmit(onSubmit)}
      className="bg-muted/30 flex flex-col gap-5 rounded-2xl border p-5"
    >
      <div className="grid grid-cols-2 items-end gap-4">
        <Field data-invalid={!!errors.name}>
          <FieldLabel htmlFor="hook-name">
            {t("settings.hooks.name")}
            <span className="text-destructive">*</span>
          </FieldLabel>
          <Controller
            control={control}
            name="name"
            render={({ field, fieldState }) => (
              <Input
                id="hook-name"
                {...field}
                aria-invalid={fieldState.invalid}
                placeholder={t("settings.hooks.namePlaceholder")}
              />
            )}
          />
          <FieldError errors={[errors.name]} />
        </Field>
        <Field>
          <FieldLabel>{t("settings.hooks.event")}</FieldLabel>
          <Controller
            control={control}
            name="event"
            render={({ field }) => (
              <Select
                value={field.value}
                onValueChange={field.onChange}
                items={eventSelectItems}
              >
                <SelectTrigger size="sm" className="w-full border bg-muted">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {eventSelectItems.map((e) => (
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
          <FieldLabel>{t("settings.hooks.type")}</FieldLabel>
          <Controller
            control={control}
            name="type"
            render={({ field }) => (
              <Select
                value={field.value}
                onValueChange={field.onChange}
                items={[
                  { label: t("settings.hooks.typeShell"), value: "shell" },
                  { label: t("settings.hooks.typeProcess"), value: "process" },
                ]}
              >
                <SelectTrigger size="sm" className="w-full border bg-muted">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="shell">{t("settings.hooks.typeShell")}</SelectItem>
                  <SelectItem value="process">{t("settings.hooks.typeProcess")}</SelectItem>
                </SelectContent>
              </Select>
            )}
          />
        </Field>
        {TOOL_EVENTS.has(event) && (
          <Field>
            <FieldLabel htmlFor="hook-matcher">{t("settings.hooks.matcher")}</FieldLabel>
            <Controller
              control={control}
              name="matcher"
              render={({ field }) => (
                <Input
                  id="hook-matcher"
                  {...field}
                  className="font-mono"
                  placeholder={t("settings.hooks.matcherPlaceholder")}
                />
              )}
            />
            <p className="text-muted-foreground text-[13px] leading-5">
              {t("settings.hooks.matcherHint")}
            </p>
          </Field>
        )}
      </div>

      <Field data-invalid={!!errors.command}>
        <FieldLabel htmlFor="hook-command">
          {t("settings.hooks.command")}
          <span className="text-destructive">*</span>
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
                type === "shell" ? t("settings.hooks.commandPlaceholderShell") : t("settings.hooks.commandPlaceholderProcess")
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
                placeholder={t("settings.hooks.shellPlaceholder")}
              />
            )}
          />
        </Field>
      ) : (
        <Field>
          <FieldLabel htmlFor="hook-args">{t("settings.hooks.args")}</FieldLabel>
          <Controller
            control={control}
            name="argsText"
            render={({ field }) => (
              <Textarea
                id="hook-args"
                {...field}
                className="min-h-16 font-mono text-[13px] leading-5"
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
                <div className="text-sm font-medium">{t("settings.hooks.backgroundLabel")}</div>
                <p className="text-muted-foreground text-[13px] leading-5">
                  {t("settings.hooks.backgroundHint")}
                </p>
              </div>
            </div>
          )}
        />
        <Field className="w-40" data-invalid={!!errors.timeoutSecText}>
          <FieldLabel htmlFor="hook-timeout">{t("settings.hooks.timeout")}</FieldLabel>
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
        <p className="text-muted-foreground text-[13px] leading-5">
          {t("settings.hooks.payloadHint")}
          {event === "PreToolUse" && t("settings.hooks.preToolUseHint")}
          {event === "PermissionRequest" && t("settings.hooks.permissionRequestHint")}
          {event !== "PreToolUse" && event !== "PermissionRequest" && t("settings.hooks.otherHint")}
        </p>
        <div className="flex shrink-0 gap-2">
          <Button type="button" variant="ghost" onClick={onCancel}>
            {t("settings.hooks.cancel")}
          </Button>
          <Button type="submit">{t("settings.hooks.save")}</Button>
        </div>
      </div>
    </form>
  );
};

// ---------------------------------------------------------------------------
// 钩子设置页
// ---------------------------------------------------------------------------

export const HooksSettings: FC = () => {
  const t = useT();
  const hooks = useHookConfigs();
  const [editing, setEditing] = useState<HookConfig | "new" | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<HookConfig | null>(null);

  const handleDelete = async () => {
    if (!confirmDelete) return;
    try {
      await removeHookConfig(confirmDelete.id);
      toast.success(t("settings.hooks.deleted", { name: confirmDelete.name }));
    } catch {
      toast.error(t("settings.hooks.deleteFailed"));
    }
    setConfirmDelete(null);
  };

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <div className="flex w-full max-w-5xl flex-col gap-8 self-center px-8 py-8">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">{t("settings.hooks.title")}</h1>
            <p className="text-muted-foreground mt-1 text-sm">
              {t("settings.hooks.desc")}
            </p>
          </div>
          {!editing && (
            <Button onClick={() => setEditing("new")}>
              <PlusIcon className="size-4" />
              {t("settings.hooks.add")}
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
              {t("settings.hooks.empty")}
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
                      <span className="text-muted-foreground rounded-md bg-background px-1.5 py-0.5 text-[13px] leading-5">
                        {hookEventLabel(t, hook.event)}
                      </span>
                      {hook.matcher && (
                        <span className="text-muted-foreground font-mono text-[13px] leading-5">
                          {hook.matcher}
                        </span>
                      )}
                      {hook.background && (
                        <span className="text-muted-foreground rounded-md bg-background px-1.5 py-0.5 text-[13px] leading-5">
                          {t("settings.hooks.background")}
                        </span>
                      )}
                    </div>
                    <div className="text-muted-foreground truncate font-mono text-[13px] leading-5">
                      {hook.type === "shell"
                        ? [hook.shell ? `${hook.shell} -c` : null, hook.command]
                            .filter(Boolean)
                            .join(" ")
                        : [hook.command, ...(hook.args ?? [])].join(" ")}
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <Button size="sm" variant="ghost" onClick={() => setEditing(hook)}>
                      {t("settings.hooks.edit")}
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(hook)}>
                      <Trash2Icon className="size-3.5" />
                    </Button>
                    <Switch
                      checked={hook.enabled}
                      onCheckedChange={(v) => {
                        void updateHookConfig(hook.id, { ...hook, enabled: v }).catch(() => {
                          toast.error(t("settings.hooks.saveFailed"));
                        });
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
            <AlertDialogTitle>{t("settings.hooks.deleteConfirmTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("settings.hooks.deleteConfirmDesc", { name: confirmDelete?.name ?? "" })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel size="default">{t("settings.hooks.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              size="default"
              onClick={() => {
                void handleDelete();
              }}
            >
              {t("settings.hooks.delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
};
