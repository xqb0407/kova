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
  MoreHorizontalIcon,
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
  DropdownMenuSeparator,
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
import { useT } from "@/lib/i18n";
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
  <span className={cn("flex items-center -space-x-1.5", className)}>
    {(accents.length ? accents : ["#94a3b8"]).slice(0, 4).map((c, i) => (
      <span key={i} className="size-3.5 rounded-full ring-2 ring-background" style={{ backgroundColor: c }} />
    ))}
  </span>
);

/** 卡片主操作：填充主色的「使用」；当前会话正在用时退成次要色的禁用态，
 *  与卡片里次要操作（… 菜单）拉开层级 */
const UseThemeButton: FC<{
  current: boolean;
  onUse: () => void;
}> = ({ current, onUse }) => {
  const t = useT();
  return (
    <Button
      size="sm"
      variant={current ? "secondary" : "default"}
      className="h-7 text-ui leading-5"
      disabled={current}
      title={
        current
          ? t("settings.designThemes.useThemeTitleCurrent")
          : t("settings.designThemes.useThemeTitle")
      }
      onClick={onUse}
    >
      {current ? t("settings.designThemes.inUse") : t("settings.designThemes.useTheme")}
    </Button>
  );
};

export const DesignThemesSettings: FC = () => {
  const t = useT();
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
      .then(() => toast.success(t("settings.designThemes.applySuccess", { name: entry.name })))
      .catch((err) =>
        toast.error(err instanceof Error ? err.message : t("settings.designThemes.applyFailed")),
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
      toast.error(t("settings.designThemes.readDocFailed", { error: errMsg(err) }));
    }
  };

  /** fork：内置正文另存为用户主题（表单预填，改名保存） */
  const openFork = async (entry: DesignThemeEntry) => {
    try {
      const res = await getDesignThemeDoc({ scope: entry.scope, id: entry.id });
      setEditor({
        mode: "form",
        title: t("settings.designThemes.forkTitle", { name: entry.name }),
        initial: {
          name: t("settings.designThemes.forkName", { name: entry.name }),
          description: entry.desc,
          accents: entry.accents.join(", "),
          content: res.doc,
        },
      });
    } catch (err) {
      toast.error(t("settings.designThemes.readDocFailed", { error: errMsg(err) }));
    }
  };

  /** 编辑用户主题：磁盘原文进 Markdown 编辑器（frontmatter 保留在文本里） */
  const openMarkdownEdit = async (entry: DesignThemeEntry) => {
    try {
      const res = await getDesignThemeDoc({ scope: entry.scope, id: entry.id });
      setEditor({ mode: "markdown", entry, doc: res.doc });
    } catch (err) {
      toast.error(t("settings.designThemes.readDocFailed", { error: errMsg(err) }));
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
        title: t("settings.designThemes.editThemeTitle", { name: entry.name }),
        initial: {
          name: entry.name,
          description: entry.desc,
          accents: entry.accents.join(", "),
          content: body,
        },
        id: entry.id,
      });
    } catch (err) {
      toast.error(t("settings.designThemes.readDocFailed", { error: errMsg(err) }));
    }
  };

  const remove = (entry: DesignThemeEntry) => {
    setConfirmDelete(null);
    void deleteDesignTheme(entry.id).catch((err) => {
      toast.error(t("settings.designThemes.deleteFailed", { error: errMsg(err) }));
    });
  };

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <div className="flex w-full max-w-7xl flex-col gap-8 self-center px-8 py-8">
        <div className="flex items-baseline justify-between gap-4">
          <h1 className="text-2xl font-bold tracking-tight">{t("settings.designThemes.title")}</h1>
          <span className={cn("text-ui leading-5", snap.error ? "text-destructive" : "text-muted-foreground")}>
            {snap.error
              ? t("settings.designThemes.statusLoadFailed")
              : t("settings.designThemes.packSummary", {
                  version: snap.version
                    ? t("settings.designThemes.packVersion", { version: snap.version })
                    : "",
                  builtin: snap.builtinCount,
                  user: snap.userCount,
                })}
          </span>
        </div>

        <section className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-3">
            <Tabs value={scopeTab} onValueChange={(v) => setScopeTab(v as ScopeTab)}>
              <TabsList className="h-auto rounded-full bg-muted/50 p-[3px]">
                <TabsTrigger value="builtin" className="rounded-full px-3 py-1 text-sm">
                  {t("settings.designThemes.builtinTab")}
                  <span className="text-muted-foreground ml-1 text-ui leading-5 tabular-nums">
                    {snap.builtinCount}
                  </span>
                </TabsTrigger>
                <TabsTrigger value="user" className="rounded-full px-3 py-1 text-sm">
                  {t("settings.designThemes.userTab")}
                  <span className="text-muted-foreground ml-1 text-ui leading-5 tabular-nums">
                    {snap.userCount}
                  </span>
                </TabsTrigger>
              </TabsList>
            </Tabs>
            {query.trim() ? (
              <span className="text-muted-foreground text-sm leading-relaxed">
                {t("settings.designThemes.matchCount", { count: visible.length })}
              </span>
            ) : null}
            <div className="ml-auto flex items-center gap-2">
              <Input
                className="h-8 w-56 bg-muted/50"
                placeholder={t("settings.designThemes.searchPlaceholder")}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              <Button
                variant="ghost"
                size="icon"
                className="shrink-0"
                onClick={refresh}
                disabled={refreshing}
                aria-label={t("settings.designThemes.refresh")}
              >
                <RefreshCwIcon className={cn("size-4", refreshing && "animate-spin")} />
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger render={<Button className="h-8 shrink-0 gap-1.5" />}>
                  <PlusIcon className="size-4" />
                  {t("settings.designThemes.new")}
                  <ChevronDownIcon className="size-3.5 opacity-60" />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="min-w-40">
                  <DropdownMenuItem
                    onClick={() =>
                      setEditor({
                        mode: "form",
                        title: t("settings.designThemes.newTheme"),
                        initial: { name: "", description: "", accents: "", content: "" },
                      })
                    }
                  >
                    <SquarePenIcon className="size-4" />
                    {t("settings.designThemes.formCreate")}
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => setEditor({ mode: "import" })}>
                    <PencilIcon className="size-4" />
                    {t("settings.designThemes.importMarkdown")}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>

          {snap.packError && (
            <p className="text-destructive text-ui leading-5" role="alert">
              {t("settings.designThemes.packError", { error: snap.packError })}
            </p>
          )}

          {/* 卡片网格：色带是视觉主角，一屏能扫到更多主题（59 套单列太长） */}
          <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
            {visible.length === 0 && (
              <div className="text-muted-foreground rounded-xl border border-dashed p-8 text-center text-sm sm:col-span-2 xl:col-span-3">
                {scopeTab === "user"
                  ? t("settings.designThemes.emptyUser")
                  : t("settings.designThemes.emptyBuiltin")}
              </div>
            )}
            {visible.map((entry) => (
              <div
                key={`${entry.scope}:${entry.id}`}
                data-slot="design-theme-row"
                className="bg-background hover:border-foreground/15 flex min-w-0 flex-col gap-2.5 rounded-xl border p-3 shadow-xs transition-colors"
              >
                {/* 色带：accent 色横排（最多 4 段） */}
                <div className="bg-background flex h-9 overflow-hidden rounded-lg border">
                  {(entry.accents.length ? entry.accents : ["#94a3b8"])
                    .slice(0, 4)
                    .map((c, i) => (
                      <span
                        key={i}
                        className="flex-1"
                        style={{ backgroundColor: c }}
                      />
                    ))}
                </div>

                <div className="min-w-0">
                  <div className="flex items-center gap-1.5">
                    <span className="truncate text-sm font-medium">{entry.name}</span>
                    {/* 使用中：有「使用」按钮时由按钮表达，这里只在无按钮时兜底 */}
                    {isCurrent(entry) && !threadId && (
                      <Badge variant="secondary" className="shrink-0 text-2xs">
                        {t("settings.designThemes.inUse")}
                      </Badge>
                    )}
                    {entry.shadowed && (
                      <Badge variant="secondary" className="shrink-0 text-2xs">
                        {t("settings.designThemes.shadowedBadge")}
                      </Badge>
                    )}
                  </div>
                  {/* 预留两行高度：描述长短不一，但不让不同行的卡片高度参差
                      （不写死整卡高度——内容再变也不会溢出） */}
                  <p className="text-muted-foreground line-clamp-2 min-h-8 text-ui leading-5">
                    {entry.desc || entry.id}
                  </p>
                </div>

                <div className="mt-auto flex items-center justify-between gap-2">
                  <span className="text-muted-foreground min-w-0 truncate text-3xs">
                    {entry.scope === "user" && entry.sizeBytes !== undefined
                      ? formatBytes(entry.sizeBytes)
                      : ""}
                  </span>
                  {entry.scope === "builtin" ? (
                    <div className="flex shrink-0 items-center gap-1">
                      {threadId && (
                        <UseThemeButton
                          current={isCurrent(entry)}
                          onUse={() => applyToCurrentThread(entry)}
                        />
                      )}
                      <DropdownMenu>
                        <DropdownMenuTrigger
                          render={
                            <Button
                              variant="ghost"
                              size="icon"
                              className="size-7 shrink-0"
                              aria-label={t("settings.designThemes.moreActions")}
                            />
                          }
                        >
                          <MoreHorizontalIcon className="size-4" />
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="min-w-44">
                          <DropdownMenuItem onClick={() => void openDoc(entry)}>
                            <EyeIcon className="size-4" />
                            {t("settings.designThemes.preview")}
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={() => void openFork(entry)}>
                            <CopyIcon className="size-4" />
                            {t("settings.designThemes.fork")}
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  ) : confirmDelete === entry.id ? (
                    <div className="flex shrink-0 items-center gap-1">
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7 text-ui leading-5"
                        onClick={() => setConfirmDelete(null)}
                      >
                        {t("settings.designThemes.cancel")}
                      </Button>
                      <Button
                        variant="destructive"
                        size="sm"
                        className="h-7 text-ui leading-5"
                        onClick={() => remove(entry)}
                      >
                        {t("settings.designThemes.confirmDelete")}
                      </Button>
                    </div>
                  ) : (
                    <div className="flex shrink-0 items-center gap-1">
                      {threadId && (
                        <UseThemeButton
                          current={isCurrent(entry)}
                          onUse={() => applyToCurrentThread(entry)}
                        />
                      )}
                      <DropdownMenu>
                        <DropdownMenuTrigger
                          render={
                            <Button
                              variant="ghost"
                              size="icon"
                              className="size-7 shrink-0"
                              aria-label={t("settings.designThemes.moreActions")}
                            />
                          }
                        >
                          <MoreHorizontalIcon className="size-4" />
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="min-w-44">
                          <DropdownMenuItem onClick={() => void openFormEdit(entry)}>
                            <SquarePenIcon className="size-4" />
                            {t("settings.designThemes.edit")}
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={() => void openMarkdownEdit(entry)}>
                            <PencilIcon className="size-4" />
                            {t("settings.designThemes.editMarkdown")}
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            variant="destructive"
                            onClick={() => setConfirmDelete(entry.id)}
                          >
                            <Trash2Icon className="size-4" />
                            {t("settings.designThemes.delete")}
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  )}
                </div>
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
            title={t("settings.designThemes.markdownTitle", { name: editor.entry.name })}
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
                .catch((err) => {
                  toast.error(t("settings.designThemes.saveFailed", { error: errMsg(err) }));
                });
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
  const t = useT();
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
                "flex items-end justify-center pb-1 font-mono text-3xs",
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
                  className={cn("min-w-0 truncate", i === 0 ? "text-xl font-semibold" : "text-sm", mono && "font-mono text-ui leading-5")}
                  style={{
                    fontFamily: mono
                      ? `'${f.name}', ui-monospace, SFMono-Regular, monospace`
                      : `'${f.name}', ui-sans-serif, system-ui, sans-serif`,
                  }}
                >
                  {i === 0 ? t("settings.designThemes.sampleTextFirst") : t("settings.designThemes.sampleTextRest")}
                </span>
                <span className="text-muted-foreground shrink-0 font-mono text-3xs">
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
              className="rounded-full px-3 py-1 text-ui leading-5 font-medium"
              style={{ backgroundColor: primary, color: readableTextOn(primary) }}
            >
              {t("settings.designThemes.primaryButton")}
            </span>
          )}
          {secondary && (
            <span className="text-foreground rounded-full border px-3 py-1 text-ui leading-5 font-medium" style={{ borderColor: secondary }}>
              {t("settings.designThemes.secondaryButton")}
            </span>
          )}
          <span className="text-muted-foreground ml-auto text-2xs">{t("settings.designThemes.approximateNote")}</span>
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
  const t = useT();
  if (!preview) return null;
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[calc(100dvh-3rem)] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {preview.entry.name}
            <Badge variant="secondary" className="ml-2 align-middle">
              {preview.entry.scope === "builtin"
                ? t("settings.designThemes.builtinReadonlyBadge")
                : t("settings.designThemes.userBadge")}
            </Badge>
          </DialogTitle>
          <DialogDescription>{preview.entry.desc || preview.entry.id}</DialogDescription>
        </DialogHeader>
        <ThemeSampleCard entry={preview.entry} doc={preview.doc} />
        <pre className="bg-muted/50 max-h-80 overflow-y-auto rounded-xl p-4 text-ui leading-5 whitespace-pre-wrap">
          {preview.doc}
        </pre>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t("settings.designThemes.close")}
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
  const t = useT();
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
            {target.mode === "import" ? t("settings.designThemes.importTitle") : target.title}
          </DialogTitle>
          <DialogDescription>
            {isImport
              ? t("settings.designThemes.importDesc")
              : t("settings.designThemes.formDesc")}
          </DialogDescription>
        </DialogHeader>
        {isImport ? (
          <div className="flex flex-col gap-3">
            <Label className="flex flex-col items-start gap-1 text-sm">
              <span className="text-muted-foreground text-ui leading-5">{t("settings.designThemes.rawLabel")}</span>
              <Textarea
                value={raw}
                onChange={(e) => setRaw(e.target.value)}
                rows={14}
                className="font-mono text-ui leading-5"
                spellCheck={false}
                placeholder={t("settings.designThemes.importPlaceholder")}
              />
            </Label>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            <Label className="flex flex-col items-start gap-1 text-sm">
              <span className="text-muted-foreground text-ui leading-5">{t("settings.designThemes.nameLabel")}</span>
              <Input
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                placeholder={t("settings.designThemes.namePlaceholder")}
              />
            </Label>
            <Label className="flex flex-col items-start gap-1 text-sm">
              <span className="text-muted-foreground text-ui leading-5">{t("settings.designThemes.descLabel")}</span>
              <Input
                value={form.description}
                onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
                placeholder={t("settings.designThemes.descPlaceholder")}
              />
            </Label>
            <Label className="flex flex-col items-start gap-1 text-sm">
              <span className="text-muted-foreground flex w-full items-center justify-between text-ui leading-5">
                <span>{t("settings.designThemes.accentsLabel")}</span>
                <Swatches accents={parseAccents(form.accents)} className="scale-75" />
              </span>
              <Input
                value={form.accents}
                onChange={(e) => setForm((f) => ({ ...f, accents: e.target.value }))}
                placeholder="#ff6b35, #0f1117"
              />
            </Label>
            <Label className="flex flex-col items-start gap-1 text-sm">
              <span className="text-muted-foreground flex w-full items-center justify-between text-ui leading-5">
                <span>{t("settings.designThemes.contentLabel")}</span>
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
                className="font-mono text-ui leading-5"
                spellCheck={false}
              />
            </Label>
          </div>
        )}
        {error && (
          <p className="text-destructive text-ui leading-5" role="alert">
            {error}
          </p>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t("settings.designThemes.cancel")}
          </Button>
          <Button
            onClick={save}
            disabled={
              busy ||
              docBytes > MAX_THEME_BYTES ||
              (isImport ? !raw.trim() : !form.name.trim() || !form.content.trim())
            }
          >
            {busy ? t("settings.designThemes.saving") : t("settings.designThemes.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
