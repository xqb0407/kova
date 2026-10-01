"use client";

import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { useAui, useAuiState } from "@assistant-ui/react";
import { unstable_defaultDirectiveFormatter } from "@assistant-ui/core";
import { useEffect, useMemo, useRef, useState, type ChangeEvent, type FC } from "react";
import {
  BookOpenIcon,
  BotIcon,
  CheckIcon,
  ChevronRightIcon,
  Link2Icon,
  Loader2Icon,
  PaperclipIcon,
  PlugIcon,
  PlusIcon,
  SearchIcon,
  SettingsIcon,
  SlidersHorizontalIcon,
  SparklesIcon,
  type LucideIcon,
} from "lucide-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Input } from "@/components/ui/input";
import { TooltipIconButton } from "@/components/assistant-ui/elements/tooltip-icon-button";
import { toast } from "@/components/ui/toast";
import { cn } from "@/lib/utils";
import { isTauri } from "@/lib/tauri";
import {
  docMimeFromName,
  imageMimeFromName,
  promptFileKind,
  PROMPT_IMAGE_MAX_COUNT,
  validatePromptFile,
} from "@/lib/attachments/prompt-attachments";
import { pathBasename, useWorkspace } from "@/lib/workspace/workspace-store";
import { useSkills } from "@/lib/skills/skills";
import { useSubagents } from "@/lib/subagent/subagents";
import { useMcpServers, type McpServerEntry } from "@/lib/mcp/mcp";
import { useMcpToolsByServer } from "@/components/agent-thread/composer-commands";
import { setSessionMode, useSessionMode } from "@/lib/pi/pi-session-mode";
import { OPTIONS as MODE_OPTIONS, currentOption } from "@/components/agent-thread/mode-picker";
import {
  requestConnectorManage,
  requestSettingsSection,
} from "@/lib/connector-nav";
import { insertIntoComposer } from "@/components/agent-thread/cm-composer-input";
import { useHtmlDark } from "@/lib/settings/use-html-dark";

/**
 * composer 的「+」菜单：左栏功能分类、右栏该分类的条目（搜索 + 列表），
 * 取代原先只有一个「添加附件」的单按钮。三类条目各自落到既有事实源：
 *
 * - 附件：Tauri dialog 拿绝对路径 → composer 附件（零落盘，见 AddAttachments）；
 * - 模式：set_session_mode，与底栏 ModePicker 同一份 OPTIONS；
 * - 专家/技能/连接器：插指令芯片（:agent/:skill/:tool），模型端凭芯片里的
 *   id 定位——与输入框里 `@`/`/` 弹层插的是同一种芯片（序列化同走
 *   unstable_defaultDirectiveFormatter，不另立格式）。区别只在插入时机：
 *   弹层走库的 selectItemOverride（要剥离触发字符），这里是弹层之外的入口，
 *   走 cm-composer-input 暴露的插入桥（落在光标处，见 insertIntoComposer）。
 *
 * 「连接器」= MCP 服务器清单（含插件层）：服务器行展示连接状态并可就地启停，
 * 就绪的展开出工具列表、点工具插芯片；底部「管理连接器」跳插件市场的 MCP 管理页。
 */

/** dialog 文件类型过滤（与 prompt-attachments 白名单同源） */
const ATTACHMENT_DIALOG_EXTENSIONS = [
  "png", "jpg", "jpeg", "gif", "webp",
  "pdf", "doc", "docx", "ppt", "pptx", "xls", "xlsx", "csv", "txt", "md", "rtf",
];

type PaneKey = "file" | "mode" | "agent" | "skill" | "connector";

type NavItem = {
  key: PaneKey;
  label: string;
  icon: LucideIcon;
  /** 右栏副标题（未选中时在左栏行内透出，当前值一眼可见） */
  hint?: string;
};

export const ComposerPlusMenu: FC = () => {
  const [open, setOpen] = useState(false);
  const [pane, setPane] = useState<PaneKey>("file");
  const threadId = useAuiState((s) => s.threads.mainThreadId);
  const snap = useSessionMode(threadId);
  const modeBusy = pane === "mode" && threadId !== null;
  const currentMode = modeBusy ? currentOption(snap) : null;

  const NAV: NavItem[] = useMemo(
    () => [
      { key: "file", label: "添加文件", icon: PaperclipIcon },
      { key: "mode", label: "模式", icon: SlidersHorizontalIcon, hint: currentMode?.label },
      { key: "agent", label: "专家", icon: BotIcon },
      { key: "skill", label: "技能", icon: BookOpenIcon },
      { key: "connector", label: "连接器", icon: Link2Icon },
    ],
    [currentMode?.label],
  );

  // 每次打开回到「添加文件」：上一次停在哪个分类是上一次的事，带过来只会
  // 让「我刚要传文件」的人先多点一次去把分类切回来
  useEffect(() => {
    if (open) setPane("file");
  }, [open]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <button
            type="button"
            data-slot="aui-composer-plus"
            aria-label="添加内容"
            title="添加内容"
            className={cn(
              "text-muted-foreground hover:text-foreground hover:bg-muted-foreground/15 dark:hover:bg-muted-foreground/30",
              "inline-flex size-7 items-center justify-center rounded-full",
              "transition-colors active:scale-[0.96] motion-reduce:transition-none",
              "focus-visible:ring-ring/50 focus-visible:ring-[2px] focus-visible:outline-none",
            )}
          >
            <PlusIcon className="size-4" />
          </button>
        }
      />
      {/* finalFocus={false}：关闭时不把焦点还给 + 按钮——插入芯片后输入框才该
          持有焦点，让 base-ui 抢回焦点会把刚插入的光标位置冲掉 */}
      <PopoverContent
        side="top"
        align="start"
        sideOffset={8}
        initialFocus={false}
        finalFocus={false}
        className="flex-row gap-0 overflow-hidden p-0"
      >
        <PaneRail items={NAV} active={pane} onSelect={setPane} />
        <div className="w-72 border-l">
          {pane === "file" && <FilePane onDone={() => setOpen(false)} />}
          {pane === "mode" && <ModePane onDone={() => setOpen(false)} />}
          {pane === "agent" && <AgentPane onDone={() => setOpen(false)} />}
          {pane === "skill" && <SkillPane onDone={() => setOpen(false)} />}
          {pane === "connector" && <ConnectorPane onDone={() => setOpen(false)} />}
        </div>
      </PopoverContent>
    </Popover>
  );
};

/** 左栏功能分类。选中项以 bg-accent 常驻，不随鼠标进出闪动 */
const PaneRail: FC<{
  items: NavItem[];
  active: PaneKey;
  onSelect: (key: PaneKey) => void;
}> = ({ items, active, onSelect }) => (
  <nav className="flex w-40 shrink-0 flex-col gap-0.5 p-1.5" aria-label="添加内容">
    {items.map(({ key, label, icon: Icon, hint }) => (
      <button
        key={key}
        type="button"
        data-active={active === key}
        onClick={() => onSelect(key)}
        className={cn(
          "hover:bg-accent data-[active]:bg-accent flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-start text-sm transition-colors",
          "focus-visible:ring-ring/50 focus-visible:ring-[2px] focus-visible:outline-none",
        )}
      >
        <Icon className="text-muted-foreground size-4 shrink-0" />
        <span className="min-w-0 flex-1 truncate">{label}</span>
        {hint && (
          <span className="text-muted-foreground max-w-16 shrink-0 truncate text-xs">
            {hint}
          </span>
        )}
        {active === key && (
          <ChevronRightIcon className="text-muted-foreground size-3.5 shrink-0" />
        )}
      </button>
    ))}
  </nav>
);

/** 右栏通用外壳：标题 + 搜索框 + 滚动条目区（+ 可选底部动作） */
const PaneShell: FC<{
  title: string;
  query: string;
  onQuery: (v: string) => void;
  placeholder: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
}> = ({ title, query, onQuery, placeholder, children, footer }) => (
  <div className="flex min-h-0 flex-col">
    <div className="flex items-center justify-between gap-2 px-3 pt-2.5 pb-1.5">
      <span className="text-muted-foreground text-xs font-medium">{title}</span>
    </div>
    <div className="px-2.5 pb-2">
      <div className="relative">
        <SearchIcon className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2" />
        <Input
          value={query}
          onChange={(e) => onQuery(e.target.value)}
          placeholder={placeholder}
          className="h-8 pl-8 text-sm"
        />
      </div>
    </div>
    <div className="max-h-72 min-h-0 flex-1 overflow-y-auto overscroll-contain px-1.5 pb-1.5">
      {children}
    </div>
    {footer && <div className="bg-muted/40 border-t p-1.5">{footer}</div>}
  </div>
);

const Row: FC<{
  icon: React.ReactNode;
  title: string;
  description?: string;
  trailing?: React.ReactNode;
  onClick?: () => void;
  active?: boolean;
  disabled?: boolean;
}> = ({ icon, title, description, trailing, onClick, active, disabled }) => (
  <button
    type="button"
    onClick={onClick}
    disabled={disabled}
    data-active={active}
    className={cn(
      "hover:bg-accent data-[active]:bg-accent flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-start transition-colors",
      "disabled:pointer-events-none disabled:opacity-50",
      "focus-visible:ring-ring/50 focus-visible:ring-[2px] focus-visible:outline-none",
    )}
  >
    {icon}
    <span className="flex min-w-0 flex-1 flex-col">
      <span className="truncate text-sm font-medium">{title}</span>
      {description && (
        <span className="text-muted-foreground truncate text-xs" title={description}>
          {description}
        </span>
      )}
    </span>
    {trailing}
  </button>
);

const EmptyHint: FC<{ children: React.ReactNode }> = ({ children }) => (
  <div className="text-muted-foreground px-2 py-3 text-center text-xs">{children}</div>
);

/* ------------------------------------------------------------------ 附件 */

/** 附件添加：桌面端 Tauri dialog 拿绝对路径，构造带 file part（url=原路径）
 *  的附件——发送时载荷只带原路径，零落盘零复制；网页端退回 <input type=file>，
 *  粘贴场景见 cm-composer-input（无路径，走中转）。图片沿用单条 4 张的添加时
 *  闸门；文档不拦添加（数量由 sidecar 裁决折算说明行）。 */
const useAddAttachments = () => {
  const aui = useAui();
  const inputRef = useRef<HTMLInputElement>(null);

  /** 图片张数闸门（与草稿内已有图片合并计数）；返回是否放行 */
  const allowImage = (count: number): boolean => {
    if (count < PROMPT_IMAGE_MAX_COUNT) return true;
    toast.error(`单条消息最多 ${PROMPT_IMAGE_MAX_COUNT} 张图片`);
    return false;
  };

  const addPaths = async (paths: string[]) => {
    const imageCount = (aui.composer.getState().attachments ?? []).filter(
      (a) => a.type === "image",
    ).length;
    let imageTaken = 0;
    for (const p of paths) {
      const name = pathBasename(p);
      const kind = promptFileKind(name, undefined);
      if (!kind) {
        toast.error(
          `「${name}」不是支持的附件（图片 PNG/JPEG/GIF/WebP，或文档 PDF/Word/Excel/PPT/TXT/MD/CSV）`,
        );
        continue;
      }
      const isImage = kind === "image";
      if (isImage && !allowImage(imageCount + imageTaken)) continue;
      if (isImage) imageTaken += 1;
      const mime = isImage ? imageMimeFromName(name) : docMimeFromName(name);
      // 原路径编码成 file:// URL 进 content（裸绝对路径会被 runtime 的
      // toMediaWireUrl 误包成 base64 data URL；file:// 可原样通过），发送时
      // extractPromptAttachments 再解回本地路径进 path 载荷
      const fileUrl = `file://${p
        .replace(/\\/g, "/")
        .split("/")
        .map(encodeURIComponent)
        .join("/")}`;
      await aui.composer
        .addAttachment({
          type: kind,
          name,
          contentType: mime ?? "application/octet-stream",
          content: [
            {
              type: "file",
              data: fileUrl,
              mimeType: mime ?? "application/octet-stream",
              filename: name,
              sourceType: "url",
            },
          ],
        })
        .catch(() => {});
    }
  };

  const onPicked = (files: FileList | null) => {
    const list = Array.from(files ?? []);
    if (list.length === 0) return;
    const accepted: File[] = [];
    for (const file of list) {
      const err = validatePromptFile(file);
      if (err) toast.error(err);
      else accepted.push(file);
    }
    const imageCount = (aui.composer.getState().attachments ?? []).filter(
      (a) => a.type === "image",
    ).length;
    let imageTaken = 0;
    void (async () => {
      for (const file of accepted) {
        const isImage = promptFileKind(file.name, file.type) === "image";
        if (isImage) {
          if (!allowImage(imageCount + imageTaken)) continue;
          imageTaken += 1;
        }
        await aui.composer.addAttachment(file).catch(() => {});
      }
    })();
  };

  /** 打开系统文件选择器（网页端走隐藏 input） */
  const pick = () => {
    if (isTauri()) {
      void openDialog({
        multiple: true,
        filters: [{ name: "支持的附件", extensions: ATTACHMENT_DIALOG_EXTENSIONS }],
      }).then((picked) => {
        if (!picked) return;
        void addPaths(Array.isArray(picked) ? picked : [picked]);
      });
      return;
    }
    inputRef.current?.click();
  };

  const fileInput = (
    <input
      ref={inputRef}
      type="file"
      accept="image/png,image/jpeg,image/gif,image/webp,.pdf,.doc,.docx,.ppt,.pptx,.xls,.xlsx,.csv,.txt,.md,.rtf"
      multiple
      hidden
      onChange={(e: ChangeEvent<HTMLInputElement>) => {
        onPicked(e.target.files);
        e.target.value = "";
      }}
    />
  );

  return { pick, fileInput };
};

const FilePane: FC<{ onDone: () => void }> = ({ onDone }) => {
  const { pick, fileInput } = useAddAttachments();
  const aui = useAui();
  const attachments = aui.composer.getState().attachments ?? [];

  return (
    <div className="flex flex-col gap-2 p-3">
      {fileInput}
      <button
        type="button"
        onClick={() => {
          // 桌面端 dialog 是模态的原生窗，先收起菜单再弹，免得被浮层压住
          onDone();
          // 等 Popover 的退场动画走完再开原生窗
          setTimeout(pick, 120);
        }}
        className={cn(
          "hover:bg-accent focus-visible:ring-ring/50 flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-start transition-colors",
          "focus-visible:ring-[2px] focus-visible:outline-none",
        )}
      >
        <PaperclipIcon className="text-muted-foreground size-4 shrink-0" />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="text-sm font-medium">选择文件</span>
          <span className="text-muted-foreground text-xs">从本机挑选，可多选</span>
        </span>
      </button>
      <p className="text-muted-foreground px-1 text-xs leading-relaxed">
        图片 PNG / JPEG / GIF / WebP，文档 PDF / Word / Excel / PPT / TXT / MD / CSV；
        也可以直接把文件拖进输入框。
      </p>
      {attachments.length > 0 && (
        <p className="text-muted-foreground px-1 text-xs">
          已附 {attachments.length} 个文件
        </p>
      )}
    </div>
  );
};

/* ------------------------------------------------------------------ 模式 */

const ModePane: FC<{ onDone: () => void }> = ({ onDone }) => {
  const threadId = useAuiState((s) => s.threads.mainThreadId);
  const snap = useSessionMode(threadId);
  const [busy, setBusy] = useState(false);
  const current = currentOption(snap);

  if (!threadId) return <EmptyHint>会话未就绪</EmptyHint>;

  const pick = (key: string) => {
    const o = MODE_OPTIONS.find((x) => x.key === key);
    if (!o || o === current) return;
    onDone();
    setBusy(true);
    setSessionMode(threadId, o.mode, o.approvalLevel)
      .catch((err) => toast.error(`切换失败：${err instanceof Error ? err.message : String(err)}`))
      .finally(() => setBusy(false));
  };

  return (
    <div className="max-h-72 overflow-y-auto overscroll-contain p-1.5">
      {MODE_OPTIONS.map((o) => (
        <Row
          key={o.key}
          icon={<o.icon className="text-muted-foreground size-4 shrink-0" />}
          title={o.label}
          description={o.description}
          active={o === current}
          disabled={busy}
          onClick={() => pick(o.key)}
          trailing={
            o === current ? <CheckIcon className="size-4 shrink-0" /> : undefined
          }
        />
      ))}
    </div>
  );
};

/* --------------------------------------------------- 专家 / 技能 / 连接器 */

/** 插一枚指令芯片并收起菜单。芯片序列化与输入框内 `/`、`@` 弹层同源，
 *  区别只在插入通道（弹层外走 cm-composer-input 的插入桥）。 */
function useChipInserter(onDone: () => void) {
  return (type: string, label: string, id: string) => {
    onDone();
    // 关菜单（finalFocus={false}，焦点不被抢回）后再插，光标才停在芯片之后
    const text = unstable_defaultDirectiveFormatter.serialize({ type, label, id });
    setTimeout(() => {
      if (!insertIntoComposer(text)) {
        toast.error("输入框未就绪，未能插入");
      }
    }, 0);
  };
}

const AgentPane: FC<{ onDone: () => void }> = ({ onDone }) => {
  const workspace = useWorkspace();
  const { agents, pluginAgents, loading } = useSubagents(workspace);
  const [query, setQuery] = useState("");
  const insert = useChipInserter(onDone);

  const list = useMemo(() => {
    const q = query.trim().toLowerCase();
    return [...agents, ...pluginAgents]
      .filter((a) => a.enabled)
      .filter(
        (a) =>
          !q ||
          a.name.toLowerCase().includes(q) ||
          a.description.toLowerCase().includes(q),
      );
  }, [agents, pluginAgents, query]);

  return (
    <PaneShell
      title="专家"
      query={query}
      onQuery={setQuery}
      placeholder="搜索专家"
      footer={
        <button
          type="button"
          onClick={() => {
            onDone();
            requestSettingsSection("subagents");
          }}
          className="hover:bg-accent flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-sm transition-colors"
        >
          <SettingsIcon className="text-muted-foreground size-4 shrink-0" />
          管理子智能体
        </button>
      }
    >
      {list.length === 0 ? (
        <EmptyHint>{loading ? "加载中…" : query ? "无匹配专家" : "暂无子智能体"}</EmptyHint>
      ) : (
        list.map((a) => (
          <Row
            key={`${a.scope}-${a.name}`}
            icon={<BotIcon className="text-muted-foreground size-4 shrink-0" />}
            title={a.name}
            description={a.description}
            onClick={() => insert("agent", a.name, `agent:${a.name}`)}
          />
        ))
      )}
    </PaneShell>
  );
};

const SkillPane: FC<{ onDone: () => void }> = ({ onDone }) => {
  const workspace = useWorkspace();
  const { skills, pluginSkills, loading } = useSkills(workspace);
  const [query, setQuery] = useState("");
  const insert = useChipInserter(onDone);

  const list = useMemo(() => {
    const q = query.trim().toLowerCase();
    return [...skills, ...pluginSkills]
      .filter((s) => s.enabled && !s.shadowed)
      .filter(
        (s) =>
          !q ||
          s.name.toLowerCase().includes(q) ||
          s.description.toLowerCase().includes(q),
      );
  }, [skills, pluginSkills, query]);

  return (
    <PaneShell
      title="技能"
      query={query}
      onQuery={setQuery}
      placeholder="搜索技能"
      footer={
        <button
          type="button"
          onClick={() => {
            onDone();
            requestConnectorManage("skills");
          }}
          className="hover:bg-accent flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-sm transition-colors"
        >
          <SettingsIcon className="text-muted-foreground size-4 shrink-0" />
          管理技能
        </button>
      }
    >
      {list.length === 0 ? (
        <EmptyHint>{loading ? "加载中…" : query ? "无匹配技能" : "暂无技能"}</EmptyHint>
      ) : (
        list.map((s) => (
          <Row
            key={`${s.scope}-${s.name}`}
            icon={<BookOpenIcon className="text-muted-foreground size-4 shrink-0" />}
            title={s.name}
            description={s.description}
            onClick={() => insert("skill", s.name, `skill:${s.name}`)}
          />
        ))
      )}
    </PaneShell>
  );
};

/** MCP 服务器自报图标（serverInfo.icons）：按深浅色挑 theme 匹配的一张，
 *  其次通用、最后任意；外链图可能 404，onError 后回落默认图标。 */
const ServerIcon: FC<{ entry: McpServerEntry }> = ({ entry }) => {
  const dark = useHtmlDark();
  const icons = entry.status.icons;
  const icon = useMemo(() => {
    if (!icons?.length) return null;
    const want = dark ? "dark" : "light";
    return icons.find((i) => i.theme === want) ?? icons.find((i) => !i.theme) ?? icons[0];
  }, [icons, dark]);
  const [failedSrc, setFailedSrc] = useState<string | null>(null);

  if (!icon || failedSrc === icon.src) {
    return <PlugIcon className="text-muted-foreground size-4 shrink-0" />;
  }
  return (
    <img
      src={icon.src}
      alt=""
      draggable={false}
      className="size-4 shrink-0 object-contain"
      onError={() => setFailedSrc(icon.src)}
    />
  );
};

const STATUS_TEXT: Record<string, string> = {
  ready: "已连接",
  connecting: "连接中",
  backoff: "连接失败",
  idle: "未连接",
};

const ConnectorPane: FC<{ onDone: () => void }> = ({ onDone }) => {
  const workspace = useWorkspace();
  const mcp = useMcpServers(workspace);
  const toolsByServer = useMcpToolsByServer(workspace);
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const insert = useChipInserter(onDone);

  const list = useMemo(() => {
    const q = query.trim().toLowerCase();
    return [...mcp.servers, ...mcp.pluginServers].filter(
      (s) =>
        !q ||
        s.name.toLowerCase().includes(q) ||
        (s.description ?? "").toLowerCase().includes(q),
    );
  }, [mcp.servers, mcp.pluginServers, query]);

  const toggleServer = async (entry: McpServerEntry) => {
    setBusy(entry.name);
    const { setMcpServerEnabled } = await import("@/lib/mcp/mcp");
    try {
      await setMcpServerEnabled(entry.layer, entry.name, !entry.enabled, workspace, entry.pluginId);
    } catch (err) {
      toast.error(`切换失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(null);
    }
  };

  return (
    <PaneShell
      title="连接器"
      query={query}
      onQuery={setQuery}
      placeholder="搜索连接器"
      footer={
        <button
          type="button"
          onClick={() => {
            onDone();
            requestConnectorManage("plugins");
          }}
          className="hover:bg-accent flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-sm transition-colors"
        >
          <SettingsIcon className="text-muted-foreground size-4 shrink-0" />
          管理连接器
        </button>
      }
    >
      {list.length === 0 ? (
        <EmptyHint>
          {mcp.loading ? "加载中…" : query ? "无匹配连接器" : "暂无连接器"}
        </EmptyHint>
      ) : (
        list.map((entry) => {
          const tools = toolsByServer[entry.name] ?? [];
          const ready = entry.enabled && entry.status.state === "ready";
          const open = expanded === entry.name;
          return (
            <div key={`${entry.layer}-${entry.name}`}>
              <Row
                icon={<ServerIcon entry={entry} />}
                title={entry.name}
                description={
                  entry.description ||
                  (ready ? `${tools.length} 个工具` : STATUS_TEXT[entry.status.state] ?? entry.status.state)
                }
                onClick={() => setExpanded(open ? null : entry.name)}
                active={open}
                trailing={
                  <>
                    {busy === entry.name ? (
                      <Loader2Icon className="text-muted-foreground size-3.5 shrink-0 animate-spin" />
                    ) : (
                      <span
                        role="switch"
                        aria-checked={entry.enabled}
                        aria-label={`${entry.name} 启用`}
                        tabIndex={0}
                        onClick={(e) => {
                          e.stopPropagation();
                          void toggleServer(entry);
                        }}
                        onKeyDown={(e) => {
                          if (e.key !== "Enter" && e.key !== " ") return;
                          e.preventDefault();
                          e.stopPropagation();
                          void toggleServer(entry);
                        }}
                        className={cn(
                          "relative inline-flex h-4 w-7 shrink-0 items-center rounded-full transition-colors",
                          "focus-visible:ring-ring/50 focus-visible:ring-[2px] focus-visible:outline-none",
                          entry.enabled ? "bg-primary" : "bg-muted-foreground/30",
                        )}
                      >
                        <span
                          className={cn(
                            "bg-background block size-3 rounded-full shadow transition-transform",
                            entry.enabled ? "translate-x-3.5" : "translate-x-0.5",
                          )}
                        />
                      </span>
                    )}
                    <ChevronRightIcon
                      className={cn(
                        "text-muted-foreground size-3.5 shrink-0 transition-transform",
                        open && "rotate-90",
                      )}
                    />
                  </>
                }
              />
              {open && (
                <div className="border-muted/60 ms-4 border-l pl-2">
                  {!entry.enabled ? (
                    <EmptyHint>已停用</EmptyHint>
                  ) : tools.length === 0 ? (
                    <EmptyHint>
                      {entry.status.state === "ready" ? "无可用工具" : "连接后可用"}
                    </EmptyHint>
                  ) : (
                    tools.map((tool) => (
                      <Row
                        key={tool.name}
                        icon={<PlugIcon className="text-muted-foreground size-3.5 shrink-0" />}
                        title={tool.name}
                        description={tool.description}
                        onClick={() =>
                          insert("tool", tool.name, `tool:${entry.name}:${tool.name}`)
                        }
                      />
                    ))
                  )}
                </div>
              )}
            </div>
          );
        })
      )}
    </PaneShell>
  );
};
