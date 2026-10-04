"use client";

/**
 * 设计主题设置页（设置 → 智能体 → 设计主题）。
 *
 * 事实源在 sidecar design-md/：内置层 = 随产品打包的主题包 zip（首启解压到
 * <appData>/design-md/builtin/，升级按 catalog.version 全量重同步；运行时清单
 * 读 zip 内存副本，本页的内置主题只读——预览 / 另存为自己的主题（fork 进用户层）；
 * 用户层 = <appData>/design-md/user/*.md，表单或 Markdown 原文皆可编辑，
 * 与内置同名会遮蔽内置（行内徽标提示）。
 * 版式与技能页同款：作用域页签 + 搜索/刷新/新建工具行 + 卡片列表；
 * 「在哪选中」不在这页——composer 的主题胶囊（design 档）管会话级使用。
 */
import { useEffect, useMemo, useState, type FC } from "react";
import {
  EyeIcon,
  PaletteIcon,
  PencilIcon,
  PlusIcon,
  RefreshCwIcon,
  SquarePenIcon,
  Trash2Icon,
  CopyIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ChevronDownIcon } from "lucide-react";
import {
  deleteDesignTheme,
  ensureDesignThemePush,
  getDesignThemeDoc,
  hydrateSessionTheme,
  refreshDesignThemes,
  saveDesignTheme,
  setSessionDesignTheme,
  useDesignThemes,
  useSessionDesignTheme,
  type DesignThemeEntry,
} from "@/lib/design-themes/design-themes";
import { extractThemeFonts, extractThemePalette, readableTextOn } from "@/lib/design-themes/theme-preview";
import { toast } from "@/components/ui/toast";
import { useAuiState } from "@assistant-ui/react";
import MarkdownEditDialog from "./markdown-edit-dialog";

/** 与 sidecar MAX_THEME_BYTES 对齐（256 KB） */
const MAX_THEME_BYTES = 256 * 1024;
const byteLength = (s: string) => new TextEncoder().encode(s).length;
const formatBytes = (n: number) => (n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`);

type ScopeTab = "builtin" | "user";

/** 编辑对象：表单（新建/另存为）、导入原文、Markdown 编辑（用户主题全文） */
type EditorTarget =
  | { mode: "form"; title: string; initial: { name: string; description: string; accents: string; content: string }; id?: string }
  | { mode: "import" }
  | { mode: "markdown"; entry: DesignThemeEntry; doc: string };

type PreviewTarget = { entry: DesignThemeEntry; doc: string };

/** 色板串（逗号分隔）→ accents 数组（≤4） */
function parseAccents(s: string): string[] {
  return s
    .split(/[,，\s]+/)
    .map((v) => v.trim())
    .filter(Boolean)
    .slice(0, 4);
}

const Swatches: FC<{ accents: string[]; className?: string }> = ({ accents, className }) => (
  <span className={cn("flex items-center -space-x-1", className)}>
    {(accents.length ? accents : ["#94a3b8"]).slice(0, 4).map((c, i) => (
      <span key={i} className="size-3 rounded-full ring-2 ring-background" style={{ backgroundColor: c }} />
    ))}
  </span>
);

export const DesignThemesSettings: FC = () => {
  const snap = useDesignThemes();
  const [scopeTab, setScopeTab] = useState<ScopeTab>("builtin");
  const [query, setQuery] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [editor, setEditor] = useState<EditorTarget | null>(null);
  const [preview, setPreview] = useState<PreviewTarget | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  // 「用于当前会话」（修复 7）：本页在 runtime 树内（archive-settings 同款），
  // 能拿到主线程 id；选中真值走会话级 store，水合后才有「使用中」标识
  const threadId = useAuiState((s) => s.threads.mainThreadId);
  const activeTheme = useSessionDesignTheme(threadId);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const inScope = snap.entries.filter((e) => e.scope === scopeTab);
    if (!q) return inScope;
    return inScope.filter((e) => [e.name, e.desc, e.id].some((v) => v.toLowerCase().includes(q)));
  }, [snap.entries, scopeTab, query]);

  const refresh = () => {
    setRefreshing(true);
    void refreshDesignThemes().finally(() => setRefreshing(false));
  };

  // 进页订阅推送（惰性幂等）：他窗/远程 save/delete 的清单变化同屏直更，
  // 不靠手动刷新；通道不支持推送时本页仍是纯拉取模型
  useEffect(() => {
    ensureDesignThemePush();
  }, []);

  // 进页水合当前会话的选中真值（胶囊同款链路）：未水合前 activeTheme 为
  // undefined，UI 不猜「使用中」
  useEffect(() => {
    if (threadId) void hydrateSessionTheme(threadId);
  }, [threadId]);

  /** 「用于当前会话」：与 composer 胶囊同一个 set（会话级偏好，即时生效） */
  const applyToCurrentThread = (entry: DesignThemeEntry) => {
    if (!threadId) return;
    void setSessionDesignTheme(threadId, { scope: entry.scope, id: entry.id })
      .then(() => toast.success(`已用于当前会话：${entry.name}`))
      .catch((err) =>
        toast.error(err instanceof Error ? err.message : "应用到当前会话失败，请重试"),
      );
  };

  const isCurrent = (entry: DesignThemeEntry) =>
    activeTheme !== undefined && activeTheme?.scope === entry.scope && activeTheme?.id === entry.id;

  const errMsg = (err: unknown) => (err instanceof Error ? err.message : String(err));

  const openDoc = async (entry: DesignThemeEntry) => {
    try {
      const res = await getDesignThemeDoc({ scope: entry.scope, id: entry.id });
      setPreview({ entry, doc: res.doc });
    } catch (err) {
      toast.error(`读取主题原文失败：${errMsg(err)}`);
    }
  };

  /** fork：内置正文另存为用户主题（表单预填，改名保存） */
  const openFork = async (entry: DesignThemeEntry) => {
    try {
      const res = await getDesignThemeDoc({ scope: entry.scope, id: entry.id });
      setEditor({
        mode: "form",
        title: `另存为我的主题（源自 ${entry.name}）`,
        initial: {
          name: `${entry.name}（我的）`,
          description: entry.desc,
          accents: entry.accents.join(", "),
          content: res.doc,
        },
      });
    } catch (err) {
      toast.error(`读取主题原文失败：${errMsg(err)}`);
    }
  };

  /** 编辑用户主题：磁盘原文进 Markdown 编辑器（frontmatter 保留在文本里） */
  const openMarkdownEdit = async (entry: DesignThemeEntry) => {
    try {
      const res = await getDesignThemeDoc({ scope: entry.scope, id: entry.id });
      setEditor({ mode: "markdown", entry, doc: res.doc });
    } catch (err) {
      toast.error(`读取主题原文失败：${errMsg(err)}`);
    }
  };

  /** 表单编辑用户主题：解析后的字段回填（描述/色板可改，正文进 textarea） */
  const openFormEdit = async (entry: DesignThemeEntry) => {
    try {
      const res = await getDesignThemeDoc({ scope: entry.scope, id: entry.id });
      // 原文含 frontmatter；表单只编辑正文，frontmatter 三字段另填
      const body = res.doc.replace(/^---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/, "").trim();
      setEditor({
        mode: "form",
        title: `编辑 ${entry.name}`,
        initial: {
          name: entry.name,
          description: entry.desc,
          accents: entry.accents.join(", "),
          content: body,
        },
        id: entry.id,
      });
    } catch (err) {
      toast.error(`读取主题原文失败：${errMsg(err)}`);
    }
  };

  const remove = (entry: DesignThemeEntry) => {
    setConfirmDelete(null);
    void deleteDesignTheme(entry.id).catch((err) =>
      toast.error(`删除主题失败：${errMsg(err)}`),
    );
  };

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <div className="flex w-full max-w-7xl flex-col gap-8 self-center px-8 py-8">
        <div className="flex items-baseline justify-between gap-4">
          <h1 className="text-2xl font-bold tracking-tight">设计主题</h1>
          <span className={cn("text-xs", snap.error ? "text-destructive" : "text-muted-foreground")}>
            {snap.error
              ? "清单加载失败，可刷新重试"
              : `主题包${snap.version ? ` v${snap.version}` : ""} · ${snap.builtinCount} 套内置 / ${snap.userCount} 套我的`}
          </span>
        </div>

        <p className="text-muted-foreground -mt-5 text-sm leading-relaxed">
          设计工作模式下，在对话输入框的主题胶囊为每个会话选一套主题；模型动笔前加载其
          DESIGN.md 全文（色板、字体、间距、组件风格）。内置主题随产品升级自动同步、不可修改，
          可「另存为自己的主题」后编辑；我的主题与内置同名时覆盖内置。
        </p>

        <section className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-3">
            <Tabs value={scopeTab} onValueChange={(v) => setScopeTab(v as ScopeTab)}>
              <TabsList className="h-auto rounded-full bg-muted/50 p-[3px]">
                <TabsTrigger value="builtin" className="rounded-full px-3 py-1 text-sm">
                  内置主题包
                </TabsTrigger>
                <TabsTrigger value="user" className="rounded-full px-3 py-1 text-sm">
                  我的主题
                </TabsTrigger>
              </TabsList>
            </Tabs>
            <span className="text-muted-foreground text-sm">{visible.length} 套主题</span>
            <div className="ml-auto flex items-center gap-2">
              <Input
                className="h-8 w-56 bg-muted/50"
                placeholder="搜索名称 / 描述…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              <Button
                variant="ghost"
                size="icon"
                className="shrink-0"
                onClick={refresh}
                disabled={refreshing}
                aria-label="刷新"
              >
                <RefreshCwIcon className={cn("size-4", refreshing && "animate-spin")} />
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger render={<Button className="h-8 shrink-0 gap-1.5" />}>
                  <PlusIcon className="size-4" />
                  新建
                  <ChevronDownIcon className="size-3.5 opacity-60" />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="min-w-40">
                  <DropdownMenuItem
                    onClick={() =>
                      setEditor({
                        mode: "form",
                        title: "新建设计主题",
                        initial: { name: "", description: "", accents: "", content: "" },
                      })
                    }
                  >
                    <SquarePenIcon className="size-4" />
                    表单创建
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => setEditor({ mode: "import" })}>
                    <PencilIcon className="size-4" />
                    导入 Markdown
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>

          {snap.packError && (
            <p className="text-destructive text-xs" role="alert">
              主题包装载失败：{snap.packError}（内置列表可能不完整）
            </p>
          )}

          <div className="flex flex-col gap-2">
            {visible.length === 0 && (
              <div className="text-muted-foreground rounded-xl border border-dashed p-8 text-center text-sm">
                {scopeTab === "user"
                  ? "还没有我的主题：内置主题「另存为自己的主题」，或从「新建」开始。"
                  : "内置主题包为空——若刚升级过应用，点右上角刷新重试。"}
              </div>
            )}
            {visible.map((entry) => (
              <div
                key={`${entry.scope}:${entry.id}`}
                data-slot="design-theme-row"
                className="bg-muted/50 flex items-center gap-3 rounded-xl border px-4 py-3"
              >
                <span className="bg-background flex size-9 shrink-0 items-center justify-center rounded-lg border">
                  <Swatches accents={entry.accents} />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium">{entry.name}</span>
                    {isCurrent(entry) && (
                      <Badge variant="secondary" className="shrink-0 text-[10px]">
                        当前会话使用中
                      </Badge>
                    )}
                    {entry.shadowed && (
                      <Badge variant="secondary" className="shrink-0 text-[10px]">
                        已被同名主题覆盖
                      </Badge>
                    )}
                    {entry.scope === "user" && entry.sizeBytes !== undefined && (
                      <span className="text-muted-foreground shrink-0 text-[10px]">
                        {formatBytes(entry.sizeBytes)}
                      </span>
                    )}
                  </div>
                  <p className="text-muted-foreground truncate text-xs">
                    {entry.desc || entry.id}
                  </p>
                </div>
                {entry.scope === "builtin" ? (
                  <div className="flex shrink-0 items-center gap-1.5">
                    {threadId && (
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7 gap-1 text-xs"
                        disabled={isCurrent(entry)}
                        title="用于当前会话（与 composer 主题胶囊同一开关）"
                        onClick={() => applyToCurrentThread(entry)}
                      >
                        <PaletteIcon className="size-3.5" />
                        {isCurrent(entry) ? "使用中" : "使用"}
                      </Button>
                    )}
                    <Button variant="outline" size="sm" className="h-7 gap-1 text-xs" onClick={() => void openDoc(entry)}>
                      <EyeIcon className="size-3.5" />
                      预览
                    </Button>
                    <Button variant="outline" size="sm" className="h-7 gap-1 text-xs" onClick={() => void openFork(entry)}>
                      <CopyIcon className="size-3.5" />
                      另存为我的主题
                    </Button>
                  </div>
                ) : confirmDelete === entry.id ? (
                  <div className="flex shrink-0 items-center gap-1.5">
                    <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => setConfirmDelete(null)}>
                      取消
                    </Button>
                    <Button variant="destructive" size="sm" className="h-7 text-xs" onClick={() => remove(entry)}>
                      确认删除
                    </Button>
                  </div>
                ) : (
                  <div className="flex shrink-0 items-center gap-1.5">
                    {threadId && (
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7 gap-1 text-xs"
                        disabled={isCurrent(entry)}
                        title="用于当前会话（与 composer 主题胶囊同一开关）"
                        onClick={() => applyToCurrentThread(entry)}
                      >
                        <PaletteIcon className="size-3.5" />
                        {isCurrent(entry) ? "使用中" : "使用"}
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-7 shrink-0"
                      title="Markdown 编辑"
                      onClick={() => void openMarkdownEdit(entry)}
                    >
                      <PencilIcon className="size-3.5" />
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-7 gap-1 text-xs"
                      onClick={() => void openFormEdit(entry)}
                    >
                      <SquarePenIcon className="size-3.5" />
                      编辑
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-7 shrink-0"
                      title="删除"
                      onClick={() => setConfirmDelete(entry.id)}
                    >
                      <Trash2Icon className="size-3.5 text-destructive" />
                    </Button>
                  </div>
                )}
              </div>
            ))}
          </div>
        </section>

        <ThemeDocDialog preview={preview} onClose={() => setPreview(null)} />
        {editor && editor.mode !== "markdown" && (
          <ThemeEditorDialog target={editor} onClose={() => setEditor(null)} />
        )}
        {editor && editor.mode === "markdown" && (
          <MarkdownEditDialog
            open
            onOpenChange={(open) => !open && setEditor(null)}
            title={`${editor.entry.name} · Markdown 源文`}
            value={editor.doc}
            maxLength={MAX_THEME_BYTES}
            onSave={(next) => {
              // 失败不关窗（保住未存盘的编辑），原因 toast 可见
              void saveDesignTheme({
                raw: next,
                id: editor.entry.id,
                fallbackName: editor.entry.id,
              })
                .then(() => setEditor(null))
                .catch((err) => toast.error(`保存失败：${errMsg(err)}`));
            }}
          />
        )}
      </div>
    </div>
  );
};

/**
 * 视觉样例卡（预览对话框顶部）：色带（清单 accents 优先、正文 hex 按首次
 * 出现补齐去重）+ Font Family 小节字体样例行 + 按主题色近似绘制的迷你按钮。
 * 纯展示启发式提取（lib/design-themes/theme-preview 纯函数、可单测），
 * 不承诺复刻 DESIGN.md 的精确声明——正文才是事实源，提取不到就整卡不出现。
 */
const ThemeSampleCard: FC<{ entry: DesignThemeEntry; doc: string }> = ({ entry, doc }) => {
  const palette = useMemo(() => extractThemePalette(entry.accents, doc), [entry.accents, doc]);
  const fonts = useMemo(() => extractThemeFonts(doc), [doc]);
  if (palette.length === 0 && fonts.length === 0) return null;
  const [primary, secondary] = palette;
  return (
    <div data-slot="theme-sample-card" className="flex flex-col gap-3 rounded-xl border p-4">
      {palette.length > 0 && (
        <div className="flex h-16 overflow-hidden rounded-lg border">
          {palette.map((hex, i) => (
            <div
              key={hex}
              className={cn(
                "flex items-end justify-center pb-1 font-mono text-[10px]",
                i === 0 && "flex-[2]",
              )}
              style={{ backgroundColor: hex, color: readableTextOn(hex) }}
            >
              {hex}
            </div>
          ))}
        </div>
      )}
      {fonts.length > 0 && (
        <div className="flex flex-col gap-1.5">
          {fonts.map((f, i) => {
            const mono = /code|mono/i.test(`${f.role} ${f.name}`);
            return (
              <div key={f.name} className="flex items-baseline justify-between gap-3">
                <span
                  className={cn("min-w-0 truncate", i === 0 ? "text-xl font-semibold" : "text-sm", mono && "font-mono text-xs")}
                  style={{
                    fontFamily: mono
                      ? `'${f.name}', ui-monospace, SFMono-Regular, monospace`
                      : `'${f.name}', ui-sans-serif, system-ui, sans-serif`,
                  }}
                >
                  {i === 0 ? "Aa 设计主题样例" : "Aa 节奏与字重 sample"}
                </span>
                <span className="text-muted-foreground shrink-0 font-mono text-[10px]">
                  {f.role} · {f.name}
                </span>
              </div>
            );
          })}
        </div>
      )}
      {(primary || secondary) && (
        <div className="flex items-center gap-2">
          {primary && (
            <span
              className="rounded-full px-3 py-1 text-xs font-medium"
              style={{ backgroundColor: primary, color: readableTextOn(primary) }}
            >
              主按钮
            </span>
          )}
          {secondary && (
            <span className="text-foreground rounded-full border px-3 py-1 text-xs font-medium" style={{ borderColor: secondary }}>
              次按钮
            </span>
          )}
          <span className="text-muted-foreground ml-auto text-[10px]">按主题声明色近似呈现</span>
        </div>
      )}
    </div>
  );
};

/** 预览/取全文对话框（内置只读浏览；用户主题也可先看原文） */
const ThemeDocDialog: FC<{ preview: PreviewTarget | null; onClose: () => void }> = ({
  preview,
  onClose,
}) => {
  if (!preview) return null;
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[calc(100dvh-3rem)] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {preview.entry.name}
            <Badge variant="secondary" className="ml-2 align-middle">
              {preview.entry.scope === "builtin" ? "内置 · 只读" : "我的主题"}
            </Badge>
          </DialogTitle>
          <DialogDescription>{preview.entry.desc || preview.entry.id}</DialogDescription>
        </DialogHeader>
        <ThemeSampleCard entry={preview.entry} doc={preview.doc} />
        <pre className="bg-muted/50 max-h-80 overflow-y-auto rounded-xl p-4 text-xs whitespace-pre-wrap">
          {preview.doc}
        </pre>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            关闭
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

/** 表单对话框：新建 / 另存为（fork） / 编辑（id 传入 = sidecar 改名清旧文件） */
const ThemeEditorDialog: FC<{ target: Exclude<EditorTarget, { mode: "markdown" }>; onClose: () => void }> = ({
  target,
  onClose,
}) => {
  const isImport = target.mode === "import";
  const [form, setForm] = useState(target.mode === "form" ? target.initial : { name: "", description: "", accents: "", content: "" });
  const [raw, setRaw] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const docBytes = byteLength(target.mode === "form" ? form.content : raw);

  const save = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      if (target.mode === "form") {
        await saveDesignTheme({
          ...(target.id ? { id: target.id } : {}),
          definition: {
            name: form.name.trim(),
            description: form.description.trim(),
            content: form.content,
            accents: parseAccents(form.accents),
          },
        });
      } else {
        await saveDesignTheme({ raw });
      }
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[calc(100dvh-3rem)] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {target.mode === "import" ? "导入设计主题 Markdown" : target.title}
          </DialogTitle>
          <DialogDescription>
            {isImport
              ? "DESIGN.md 原文（可带 frontmatter：name/description/accents）；缺 name 用文件兜底名。保存到应用数据 design-md/user/，对本机所有会话可用"
              : "保存到应用数据目录 design-md/user/，对本机所有会话可用；与内置同名时覆盖内置"}
          </DialogDescription>
        </DialogHeader>
        {isImport ? (
          <div className="flex flex-col gap-3">
            <Label className="flex flex-col items-start gap-1 text-sm">
              <span className="text-muted-foreground text-xs">主题原文</span>
              <Textarea
                value={raw}
                onChange={(e) => setRaw(e.target.value)}
                rows={14}
                className="font-mono text-xs"
                spellCheck={false}
                placeholder={"---\nname: my-theme\ndescription: 一句话风格概要\naccents:\n  - \"#ff6b35\"\n---\n\n# 色板\n..."}
              />
            </Label>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            <Label className="flex flex-col items-start gap-1 text-sm">
              <span className="text-muted-foreground text-xs">名称</span>
              <Input
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                placeholder="如 我的品牌风"
              />
            </Label>
            <Label className="flex flex-col items-start gap-1 text-sm">
              <span className="text-muted-foreground text-xs">风格概要（胶囊与清单里的一句话）</span>
              <Input
                value={form.description}
                onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
                placeholder="如 暖橙工坊感，大圆角重投影"
              />
            </Label>
            <Label className="flex flex-col items-start gap-1 text-sm">
              <span className="text-muted-foreground flex w-full items-center justify-between text-xs">
                <span>代表色（逗号分隔，最多 4 个，用于色板预览）</span>
                <Swatches accents={parseAccents(form.accents)} className="scale-75" />
              </span>
              <Input
                value={form.accents}
                onChange={(e) => setForm((f) => ({ ...f, accents: e.target.value }))}
                placeholder="#ff6b35, #0f1117"
              />
            </Label>
            <Label className="flex flex-col items-start gap-1 text-sm">
              <span className="text-muted-foreground flex w-full items-center justify-between text-xs">
                <span>主题正文（DESIGN.md：色板与角色、字体/字号阶梯、间距、组件与氛围规则）</span>
                <span
                  className={cn(
                    "font-mono",
                    docBytes > MAX_THEME_BYTES ? "text-destructive" : "text-muted-foreground/70",
                  )}
                >
                  {formatBytes(docBytes)} / 256 KB
                </span>
              </span>
              <Textarea
                value={form.content}
                onChange={(e) => setForm((f) => ({ ...f, content: e.target.value }))}
                rows={14}
                className="font-mono text-xs"
                spellCheck={false}
              />
            </Label>
          </div>
        )}
        {error && (
          <p className="text-destructive text-xs" role="alert">
            {error}
          </p>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            取消
          </Button>
          <Button
            onClick={save}
            disabled={
              busy ||
              docBytes > MAX_THEME_BYTES ||
              (isImport ? !raw.trim() : !form.name.trim() || !form.content.trim())
            }
          >
            {busy ? "保存中…" : "保存"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
