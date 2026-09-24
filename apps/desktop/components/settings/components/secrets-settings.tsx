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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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

/** 密钥名规则（sidecar / Rust 同款）：它将成为环境变量名 */
const SECRET_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** 值上限与 Rust MAX_SECRET_VALUE_BYTES 对齐 */
const MAX_VALUE_BYTES = 8 * 1024;

type EditorTarget = { mode: "create" } | { mode: "edit"; entry: SecretEntry };

const ANY_SKILL = "*";

const SecretEditorDialog: FC<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
  target: EditorTarget | null;
  /** 可授权的技能名（生效技能清单；不含被遮蔽/停用的） */
  skillNames: string[];
  /** 已有密钥名（新建时查重） */
  existingNames: string[];
  /** 该密钥当前的授权（编辑时回填） */
  currentSkills: string[];
}> = ({ open, onOpenChange, target, skillNames, existingNames, currentSkills }) => {
  const isEdit = target?.mode === "edit";
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [anySkill, setAnySkill] = useState(false);
  const [skills, setSkills] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);

  // 每次打开按目标重置（编辑不带值——明文不回填）
  useEffect(() => {
    if (!open) return;
    setName(isEdit && target?.mode === "edit" ? target.entry.name : "");
    setValue("");
    setAnySkill(currentSkills.includes(ANY_SKILL));
    setSkills(currentSkills.filter((s) => s !== ANY_SKILL));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, target]);

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
      toast.success(isEdit ? "密钥已更新" : "密钥已保存");
      onOpenChange(false);
    } catch (err) {
      toast.add({
        title: "保存失败",
        description: err instanceof Error ? err.message : String(err),
        type: "error",
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{isEdit ? "编辑密钥" : "新建密钥"}</DialogTitle>
          <DialogDescription>
            密钥加密后存在本地（主密钥在系统钥匙串），只在技能脚本执行时注入为环境变量，
            不会进入模型上下文。
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-5">
          <div className="flex flex-col gap-2">
            <Label htmlFor="secret-name">名称（用作环境变量名）</Label>
            <Input
              id="secret-name"
              value={name}
              disabled={isEdit}
              placeholder="例如 GITHUB_TOKEN"
              onChange={(e) => setName(e.target.value)}
            />
            {nameInvalid && (
              <p className="text-destructive text-xs">
                只能是字母、数字、下划线，且不以数字开头（它将作为环境变量名）
              </p>
            )}
            {nameTaken && <p className="text-destructive text-xs">同名密钥已存在</p>}
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="secret-value">值</Label>
            <Textarea
              id="secret-value"
              value={value}
              placeholder={isEdit ? "留空保持不变（不回显已保存的值）" : "粘贴密钥内容"}
              className="min-h-20 font-mono text-xs"
              onChange={(e) => setValue(e.target.value)}
            />
            {valueTooBig && <p className="text-destructive text-xs">值过长（上限 8 KB）</p>}
            <p className="text-muted-foreground text-xs">
              值保存后不再回显；这是唯一一次明文出现在此页面上。
            </p>
          </div>

          <div className="flex flex-col gap-2">
            <Label>授权给哪些技能</Label>
            <p className="text-muted-foreground text-xs">
              只有在这里勾选的技能，其 bash 脚本才能读到这个密钥（默认不授权给任何技能）。
            </p>
            <div className="flex items-center gap-2 pt-1">
              <Checkbox
                id="secret-any-skill"
                checked={anySkill}
                onCheckedChange={(c) => setAnySkill(c === true)}
              />
              <Label htmlFor="secret-any-skill" className="text-sm font-normal">
                任意助手调用（不限定技能）
              </Label>
            </div>
            {skillNames.length === 0 ? (
              <p className="text-muted-foreground pt-1 text-xs">
                还没有可用技能——先在技能页创建一个，或直接选「任意助手调用」。
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
                          c === true ? [...new Set([...prev, skill])] : prev.filter((s) => s !== skill),
                        )
                      }
                    />
                    <Label
                      htmlFor={`secret-skill-${skill}`}
                      className="truncate text-sm font-normal"
                    >
                      {skill}
                    </Label>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button disabled={!canSubmit} onClick={() => void submit()}>
            {saving ? "保存中…" : "保存"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

const SecretRow: FC<{
  entry: SecretEntry;
  /** 该密钥授权的技能（[] = 未授权给任何技能） */
  grantedSkills: string[];
  onEdit: () => void;
  onDelete: () => void;
}> = ({ entry, grantedSkills, onEdit, onDelete }) => (
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
            无法解密，需重填
          </Badge>
        )}
      </div>
      <div className="text-muted-foreground flex items-center gap-2 text-xs">
        <span className="font-mono">{entry.masked}</span>
        <span>·</span>
        <span className="truncate">
          {grantedSkills.length === 0
            ? "未授权给任何技能"
            : grantedSkills.includes(ANY_SKILL)
              ? "任意助手调用可用"
              : `授权：${grantedSkills.join("、")}`}
        </span>
      </div>
    </div>
    <Button variant="ghost" size="icon-sm" title="编辑" onClick={onEdit}>
      <PencilIcon className="size-4" />
    </Button>
    <Button variant="ghost" size="icon-sm" title="删除" onClick={onDelete}>
      <Trash2Icon className="size-4" />
    </Button>
  </div>
);

export const SecretsSettings: FC = () => {
  const secrets = useSecrets();
  const workspace = useWorkspace();
  const skills = useSkills(workspace);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editorTarget, setEditorTarget] = useState<EditorTarget | null>(null);

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

  const editing = editorTarget?.mode === "edit" ? editorTarget.entry : null;
  const editingBinding = editing ? bindingFor(secrets.bindings, editing.name) : undefined;

  const remove = async (entry: SecretEntry) => {
    try {
      await deleteSecret(entry.name, entry.scope, workspace);
      toast.success(`已删除 ${entry.name}`);
    } catch (err) {
      toast.add({
        title: "删除失败",
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
        title: "保存失败",
        description: err instanceof Error ? err.message : String(err),
        type: "error",
      });
    }
  };

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <div className="flex w-full max-w-5xl flex-col gap-6 self-center px-8 py-8">
        <div className="flex items-center justify-between gap-4">
          <div className="flex flex-col gap-1">
            <h1 className="text-2xl font-bold tracking-tight">密钥</h1>
            <p className="text-muted-foreground text-sm">
              加密存储的环境变量：只在被授权的技能跑 bash 脚本时注入，输出回到模型前会脱敏。
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-4">
            <div className="flex items-center gap-2">
              <Label htmlFor="secrets-enabled" className="text-sm font-normal">
                注入总开关
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
              title="刷新"
              onClick={() => void refreshSecrets()}
            >
              <RefreshCwIcon className="size-4" />
            </Button>
            <Button
              onClick={() => {
                setEditorTarget({ mode: "create" });
                setEditorOpen(true);
              }}
            >
              <PlusIcon className="size-4" />
              新建密钥
            </Button>
          </div>
        </div>

        {secrets.error && (
          <p className="text-destructive text-sm">读取失败：{secrets.error}</p>
        )}

        {secrets.entries.length === 0 ? (
          <div className="bg-muted/40 flex flex-col items-center gap-2 rounded-2xl border border-dashed px-6 py-12">
            <KeyRoundIcon className="text-muted-foreground size-6" />
            <p className="text-sm font-medium">还没有密钥</p>
            <p className="text-muted-foreground max-w-md text-center text-xs">
              新建一个密钥（如 <span className="font-mono">GITHUB_TOKEN</span>）并授权给需要它的技能；
              技能脚本里用 <span className="font-mono">$GITHUB_TOKEN</span> 即可读到。
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {secrets.entries.map((entry) => (
              <SecretRow
                key={`${entry.name}::${entry.scope}`}
                entry={entry}
                grantedSkills={bindingFor(secrets.bindings, entry.name)?.skills ?? []}
                onEdit={() => {
                  setEditorTarget({ mode: "edit", entry });
                  setEditorOpen(true);
                }}
                onDelete={() => void remove(entry)}
              />
            ))}
          </div>
        )}

        <div className="text-muted-foreground flex flex-col gap-1 text-xs">
          <p>
            值以 AES-256-GCM 加密存本地库，主密钥在系统钥匙串（macOS Keychain / Windows 凭据管理器 /
            Linux Secret Service）；明文不回传界面，也不进入对话记录。
          </p>
          <p>
            注入只影响那一次 bash 命令的子进程；输出里的密钥值会被替换成
            <span className="font-mono"> [REDACTED:名字]</span>。脱敏是兜底，真正的防线是"只授权给该用的技能"。
          </p>
        </div>
      </div>

      <SecretEditorDialog
        open={editorOpen}
        onOpenChange={setEditorOpen}
        target={editorTarget}
        skillNames={skillNames}
        existingNames={secrets.entries.map((e) => e.name)}
        currentSkills={editingBinding?.skills ?? []}
      />
    </div>
  );
};
