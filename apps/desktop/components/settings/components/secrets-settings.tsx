"use client";

/**
 * 密钥页（设置 → 智能体 → 密钥）。
 *
 * 用户在这里登记**加密存储**的密钥（token 之类），并把它们授权给具体技能；
 * agent 通过 bash 跑该技能的脚本时，密钥以环境变量形式注入那一次子进程，
 * 输出回到模型前会被脱敏。设计：docs/secrets-env-design.md。
 *
 * 两条硬边界体现在这个页面的版式上：
 * - **值只进不出**：清单里只有名字与 `****` 掩码，编辑弹窗不回填明文
 *   （留空 = 不改值），与模型 provider 的 key 同款处理。
 * - **授权在用户手里**：技能不能自己声明需要密钥，只能在这里勾选"哪个密钥
 *   给哪个技能用"；没勾的技能拿不到（默认拒绝）。
 *
 * 版式：卡片列表（名字 + 作用域徽标 + 掩码 + 已授权技能）+ 新建/编辑弹窗，
 * 与技能页、MCP 页同款。
 */
import { useEffect, useMemo, useState, type FC } from "react";
import {
  KeyRoundIcon,
  PencilIcon,
  PlusIcon,
  RefreshCwIcon,
  Trash2Icon,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Field, FieldLabel } from "@/components/ui/field";
import { toast } from "@/components/ui/toast";
import { useWorkspace } from "@/lib/workspace/workspace-store";
import { useSkills } from "@/lib/skills/skills";
import {
  bindingFor,
  deleteSecret,
  refreshSecrets,
  saveSecret,
  saveSecretBindings,
  scopeLabel,
  useSecrets,
  type SecretEntry,
} from "@/lib/secrets/secrets-store";
import { useT } from "@/lib/i18n";

/** 密钥名规则（sidecar / Rust 同款）：它将成为环境变量名 */
const SECRET_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** 值上限与 Rust MAX_SECRET_VALUE_BYTES 对齐 */
const MAX_VALUE_BYTES = 8 * 1024;

type EditorTarget = { mode: "create" } | { mode: "edit"; entry: SecretEntry };

const ANY_SKILL = "*";

const SecretEditorCard: FC<{
  target: EditorTarget;
  /** 可授权的技能名（生效技能清单；不含被遮蔽/停用的） */
  skillNames: string[];
  /** 已有密钥名（新建时查重） */
  existingNames: string[];
  /** 该密钥当前的授权（编辑时回填） */
  currentSkills: string[];
  onDone: () => void;
  onCancel: () => void;
}> = ({ target, skillNames, existingNames, currentSkills, onDone, onCancel }) => {
  const t = useT();
  const initial = target.mode === "edit" ? target.entry : null;
  const isEdit = initial !== null;
  const [name, setName] = useState(initial?.name ?? "");
  const [value, setValue] = useState("");
  const [anySkill, setAnySkill] = useState(currentSkills.includes(ANY_SKILL));
  const [skills, setSkills] = useState<string[]>(
    currentSkills.filter((s) => s !== ANY_SKILL),
  );
  const [saving, setSaving] = useState(false);

  const trimmed = name.trim();
  const nameTaken =
    !isEdit && trimmed.length > 0 && existingNames.includes(trimmed);
  const nameInvalid = trimmed.length > 0 && !SECRET_NAME_RE.test(trimmed);
  const valueTooBig = new TextEncoder().encode(value).length > MAX_VALUE_BYTES;
  const canSubmit =
    trimmed.length > 0 &&
    !nameInvalid &&
    !nameTaken &&
    !valueTooBig &&
    // 新建必须给值；编辑留空 = 不改值
    (isEdit || value.length > 0) &&
    !saving;

  const submit = async () => {
    if (!canSubmit) return;
    setSaving(true);
    try {
      await saveSecret({
        name: trimmed,
        scope: "global",
        ...(value ? { value } : {}),
        skills: anySkill ? [ANY_SKILL, ...skills] : skills,
      });
      toast.success(isEdit ? t("settings.secrets.updated") : t("settings.secrets.saved"));
      onDone();
    } catch (err) {
      toast.add({
        title: t("settings.secrets.saveFailed"),
        description: err instanceof Error ? err.message : String(err),
        type: "error",
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
      className="bg-muted/30 flex flex-col gap-5 rounded-2xl border p-5"
    >
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Field>
          <FieldLabel htmlFor="secret-name">
            {t("settings.secrets.name")}
            <span className="text-destructive">*</span>
          </FieldLabel>
          <Input
            id="secret-name"
            value={name}
            disabled={isEdit}
            placeholder={t("settings.secrets.namePlaceholder")}
            className="font-mono"
            onChange={(e) => setName(e.target.value)}
          />
          {nameInvalid && (
            <p className="text-destructive text-[13px] leading-5">
              {t("settings.secrets.nameInvalid")}
            </p>
          )}
          {nameTaken && <p className="text-destructive text-[13px] leading-5">{t("settings.secrets.nameTaken")}</p>}
        </Field>
        <Field>
          <FieldLabel htmlFor="secret-scope">{t("settings.secrets.scope")}</FieldLabel>
          <Input id="secret-scope" value={t("settings.secrets.scopeAll")} disabled />
          <p className="text-muted-foreground text-[13px] leading-5">
            {t("settings.secrets.scopeHint")}
          </p>
        </Field>
      </div>

      <Field>
        <FieldLabel htmlFor="secret-value">
          {t("settings.secrets.value")}
          <span className="text-destructive">*</span>
        </FieldLabel>
        {/* field-sizing-content 会按内容撑宽：密钥是不可断词的超长串，
            会把表单撑出容器。固定尺寸 + break-all 让它内部换行。 */}
        <Textarea
          id="secret-value"
          value={value}
          placeholder={isEdit ? t("settings.secrets.valuePlaceholderEdit") : t("settings.secrets.valuePlaceholderCreate")}
          className="field-sizing-fixed min-h-24 min-w-0 max-w-full font-mono text-[13px] leading-5 break-all"
          onChange={(e) => setValue(e.target.value)}
        />
        {valueTooBig && <p className="text-destructive text-[13px] leading-5">{t("settings.secrets.valueTooBig")}</p>}
        <p className="text-muted-foreground text-[13px] leading-5">
          {t("settings.secrets.valueHint")}
        </p>
      </Field>

      <Field>
        <FieldLabel>{t("settings.secrets.grant")}</FieldLabel>
        <p className="text-muted-foreground text-[13px] leading-5">
          {t("settings.secrets.grantHint")}
        </p>
        <div className="flex items-center gap-2 pt-1">
          <Checkbox
            id="secret-any-skill"
            checked={anySkill}
            onCheckedChange={(c) => setAnySkill(c === true)}
          />
          <Label htmlFor="secret-any-skill" className="text-sm font-normal">
            {t("settings.secrets.anySkill")}
          </Label>
        </div>
        {skillNames.length === 0 ? (
          <p className="text-muted-foreground pt-1 text-[13px] leading-5">
            {t("settings.secrets.noSkills")}
          </p>
        ) : (
          <div className="mt-1 flex max-h-48 flex-col gap-1 overflow-y-auto rounded-xl border p-2">
            {skillNames.map((skill) => (
              <div key={skill} className="flex items-center gap-2 px-1 py-1">
                <Checkbox
                  id={`secret-skill-${skill}`}
                  checked={skills.includes(skill)}
                  onCheckedChange={(c) =>
                    setSkills((prev) =>
                      c === true
                        ? [...new Set([...prev, skill])]
                        : prev.filter((s) => s !== skill),
                    )
                  }
                />
                <Label
                  htmlFor={`secret-skill-${skill}`}
                  className="min-w-0 truncate text-sm font-normal"
                >
                  {skill}
                </Label>
              </div>
            ))}
          </div>
        )}
      </Field>

      <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-4">
        <p className="text-muted-foreground text-[13px] leading-5">
          {isEdit
            ? t("settings.secrets.editFooter")
            : t("settings.secrets.createFooter")}
        </p>
        <div className="flex shrink-0 gap-2">
          <Button type="button" variant="ghost" onClick={onCancel}>
            {t("settings.secrets.cancel")}
          </Button>
          <Button type="submit" disabled={!canSubmit}>
            {saving ? t("settings.secrets.saving") : t("settings.secrets.save")}
          </Button>
        </div>
      </div>
    </form>
  );
};

const SecretRow: FC<{
  entry: SecretEntry;
  /** 该密钥授权的技能（[] = 未授权给任何技能） */
  grantedSkills: string[];
  onEdit: () => void;
  onDelete: () => void;
}> = ({ entry, grantedSkills, onEdit, onDelete }) => {
  const t = useT();
  return (
  <div className="bg-muted/50 flex items-center gap-3 rounded-2xl p-3">
    <div className="bg-background flex size-9 shrink-0 items-center justify-center rounded-xl border">
      <KeyRoundIcon className="size-4" />
    </div>
    <div className="flex min-w-0 flex-1 flex-col gap-1">
      <div className="flex items-center gap-2">
        <span className="truncate font-mono text-sm font-medium">{entry.name}</span>
        <Badge variant="secondary" className="shrink-0">
          {scopeLabel(entry.scope)}
        </Badge>
        {!entry.readable && (
          <Badge variant="destructive" className="shrink-0">
            {t("settings.secrets.decryptFailed")}
          </Badge>
        )}
      </div>
      <div className="text-muted-foreground flex items-center gap-2 text-[13px] leading-5">
        <span className="font-mono">{entry.masked}</span>
        <span>·</span>
        <span className="truncate">
          {grantedSkills.length === 0
            ? t("settings.secrets.notGranted")
            : grantedSkills.includes(ANY_SKILL)
              ? t("settings.secrets.anyGranted")
              : t("settings.secrets.granted", { skills: grantedSkills.join("、") })}
        </span>
      </div>
    </div>
    <Button variant="ghost" size="icon-sm" title={t("settings.secrets.edit")} onClick={onEdit}>
      <PencilIcon className="size-4" />
    </Button>
    <Button variant="ghost" size="icon-sm" title={t("settings.secrets.delete")} onClick={onDelete}>
      <Trash2Icon className="size-4" />
    </Button>
  </div>
  );
};

export const SecretsSettings: FC = () => {
  const t = useT();
  const secrets = useSecrets();
  const workspace = useWorkspace();
  const skills = useSkills(workspace);
  /** null = 不在编辑；创建/编辑共用一个内联卡片（参考钩子页） */
  const [editingTarget, setEditingTarget] = useState<EditorTarget | null>(null);

  useEffect(() => {
    void refreshSecrets();
  }, []);

  /** 可授权的技能：排除被遮蔽/被模型调用开关禁用的（那些技能模型本来就调不到） */
  const skillNames = useMemo(
    () =>
      skills.skills
        .filter((s) => s.enabled && !s.shadowed && !s.disableModelInvocation)
        .map((s) => s.name)
        .sort(),
    [skills.skills],
  );

  const editingEntry =
    editingTarget?.mode === "edit" ? editingTarget.entry : null;
  const editingBinding = editingEntry
    ? bindingFor(secrets.bindings, editingEntry.name)
    : undefined;

  const remove = async (entry: SecretEntry) => {
    try {
      await deleteSecret(entry.name, entry.scope, workspace);
      toast.success(t("settings.secrets.deleted", { name: entry.name }));
    } catch (err) {
      toast.add({
        title: t("settings.secrets.deleteFailed"),
        description: err instanceof Error ? err.message : String(err),
        type: "error",
      });
    }
  };

  const toggleEnabled = async (enabled: boolean) => {
    try {
      await saveSecretBindings({ enabled });
    } catch (err) {
      toast.add({
        title: t("settings.secrets.saveFailed"),
        description: err instanceof Error ? err.message : String(err),
        type: "error",
      });
    }
  };

  const cipherCopy =
    secrets.cipher.backend === "system-keychain"
      ? t("settings.secrets.cipherSystem")
      : secrets.cipher.backend === "local-key-file"
        ? t("settings.secrets.cipherLocal")
        : t("settings.secrets.cipherUnavailable");

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <div className="flex w-full max-w-5xl flex-col gap-6 self-center px-8 py-8">
        <div className="flex items-center justify-between gap-4">
          <div className="flex flex-col gap-1">
            <h1 className="text-2xl font-bold tracking-tight">{t("settings.secrets.title")}</h1>
            <p className="text-muted-foreground text-sm leading-relaxed">
              {t("settings.secrets.desc")}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-4">
            <div className="flex items-center gap-2">
              <Label htmlFor="secrets-enabled" className="text-sm font-normal">
                {t("settings.secrets.injectToggle")}
              </Label>
              <Switch
                id="secrets-enabled"
                checked={secrets.enabled}
                onCheckedChange={(c) => void toggleEnabled(c === true)}
              />
            </div>
            <Button
              variant="outline"
              size="icon-sm"
              title={t("settings.secrets.refresh")}
              onClick={() => void refreshSecrets()}
            >
              <RefreshCwIcon className="size-4" />
            </Button>
            {!editingTarget && (
              <Button
                disabled={secrets.cipher.backend === "unavailable"}
                title={
                  secrets.cipher.backend === "unavailable"
                    ? t("settings.secrets.encryptionUnavailableNew")
                    : undefined
                }
                onClick={() => setEditingTarget({ mode: "create" })}
              >
                <PlusIcon className="size-4" />
                {t("settings.secrets.newSecret")}
              </Button>
            )}
          </div>
        </div>

        {secrets.cipher.backend === "local-key-file" && (
          <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[13px] leading-relaxed text-amber-700 dark:text-amber-300">
            {t("settings.secrets.keychainWarning")}
          </div>
        )}
        {secrets.cipher.backend === "unavailable" && (
          <div className="border-destructive/30 bg-destructive/10 text-destructive rounded-xl border px-3 py-2 text-[13px] leading-relaxed">
            {t("settings.secrets.unavailableWarning")}
          </div>
        )}

        {editingTarget && (
          <SecretEditorCard
            key={
              editingTarget.mode === "edit"
                ? editingTarget.entry.name
                : "new"
            }
            target={editingTarget}
            skillNames={skillNames}
            existingNames={secrets.entries.map((e) => e.name)}
            currentSkills={editingBinding?.skills ?? []}
            onDone={() => setEditingTarget(null)}
            onCancel={() => setEditingTarget(null)}
          />
        )}

        {secrets.error && (
          <p className="text-destructive text-sm">{t("settings.secrets.loadFailed", { error: secrets.error })}</p>
        )}

        {secrets.entries.length === 0 ? (
          <div className="bg-muted/40 flex flex-col items-center gap-2 rounded-2xl border border-dashed px-6 py-12">
            <KeyRoundIcon className="text-muted-foreground size-6" />
            <p className="text-sm font-medium">{t("settings.secrets.emptyTitle")}</p>
            <p className="text-muted-foreground max-w-md text-center text-[13px] leading-5">
              {t("settings.secrets.emptyDescBefore")}{" "}
              <span className="font-mono">GITHUB_TOKEN</span>
              {t("settings.secrets.emptyDescMiddle")}{" "}
              <span className="font-mono">$GITHUB_TOKEN</span>
              {t("settings.secrets.emptyDescAfter")}
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {secrets.entries.map((entry) => (
              <SecretRow
                key={`${entry.name}::${entry.scope}`}
                entry={entry}
                grantedSkills={bindingFor(secrets.bindings, entry.name)?.skills ?? []}
                onEdit={() => setEditingTarget({ mode: "edit", entry })}
                onDelete={() => void remove(entry)}
              />
            ))}
          </div>
        )}

        <div className="text-muted-foreground flex flex-col gap-1 text-[13px] leading-5">
          <p>{cipherCopy}</p>
          <p>
            {t("settings.secrets.redactNoteBefore")}
            <span className="font-mono"> [REDACTED:{"名字"}]</span>
            {t("settings.secrets.redactNoteAfter")}
          </p>
        </div>
      </div>
    </div>
  );
};
