"use client";

import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { useAui, useAuiState } from "@assistant-ui/react";
import { unstable_defaultDirectiveFormatter } from "@assistant-ui/core";
import { useMemo, useRef, useState, type ChangeEvent, type FC, type ReactNode } from "react";
import {
  BookOpenIcon,
  BotIcon,
  Link2Icon,
  PaperclipIcon,
  PlugIcon,
  PlusIcon,
  SettingsIcon,
  SlidersHorizontalIcon,
  type LucideIcon,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { toast } from "@/components/ui/toast";
import { cn } from "@/lib/utils";
import { isTauri } from "@/lib/tauri";
import {
  docMimeFromName,
  imageMimeFromName,
  promptFileKind,
  promptFileKindFromName,
  PROMPT_IMAGE_MAX_BYTES,
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
 * composer 的「+」菜单，取代原先只有一个「添加附件」的单按钮。一个下拉，
 * 五项分类：附件是直选动作，模式/专家/技能/连接器各自下钻一层。
 *
 * 三类可选项各自落到既有事实源：
 *
 * - 附件：Tauri dialog 拿绝对路径 → composer 附件（零落盘，见 useAddAttachments）；
 * - 模式：set_session_mode，与底栏 ModePicker 同一份 OPTIONS；
 * - 专家/技能/连接器：插指令芯片（:agent/:skill/:tool），模型端凭芯片里的
 *   id 定位——与输入框里 `@`/`/` 弹层插的是同一种芯片（序列化同走
 *   unstable_defaultDirectiveFormatter，id 拼接口径同 composer-commands，不另立格式）。
 *   区别只在插入时机：弹层走库的 selectItemOverride（要剥离触发字符），这里是弹层
 *   之外的入口，走 cm-composer-input 暴露的插入桥（落在光标处，见 insertIntoComposer）。
 *
 * 连接器 = MCP 服务器清单（含插件层）：就绪且有工具的服务器再下钻一层列工具，
 * 未启用/未连/无工具的只读展示状态；启停归「管理连接器」（插件市场的 MCP 页）。
 *
 * 为什么没有搜索框：base-ui 菜单的 typeahead 对 popup 上的任意字符键
 * stopEvent（不看 event.target），嵌在菜单里的文本框会被吃掉按键。分类列表
 * 靠 popup 自身的 max-h + 滚动即可，故一律不做行内搜索。
 */

/** dialog 文件类型过滤（与 prompt-attachments 白名单同源） */
const ATTACHMENT_DIALOG_EXTENSIONS = [
  "png", "jpg", "jpeg", "gif", "webp",
  "pdf", "doc", "docx", "ppt", "pptx", "xls", "xlsx", "csv", "txt", "md", "rtf",
];

export const ComposerPlusMenu: FC = () => {
  const threadId = useAuiState((s) => s.threads.mainThreadId);
  // 左栏「模式」行透出当前档位：快照是按 threadId 存的全局 store（ModePicker
  // 也在订阅同一份），这里多读一次无副作用，只为不点进子菜单就知道当前档位
  const modeSnap = useSessionMode(threadId);
  const currentMode = threadId ? currentOption(modeSnap) : null;
  const { pick, fileInput } = useAddAttachments();

  return (
    <>
      {fileInput}
      <DropdownMenu>
        <DropdownMenuTrigger
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
        {/*  composer 贴在窗口下沿，菜单必须朝上开  */}
        <DropdownMenuContent align="start" side="top" sideOffset={6} className="w-48">
          <DropdownMenuGroup className="p-0">
            <DropdownMenuItem
              onClick={() => {
                // 桌面端 dialog 是模态的原生窗，等菜单退场动画走完再开，免得被浮层压住
                setTimeout(pick, 120);
              }}
            >
              <PaperclipIcon className="text-muted-foreground size-3.5 shrink-0" />
              添加文件
            </DropdownMenuItem>
            {/* 不放分隔线：直选动作与下钻分类靠有无 chevron 已足够区分，
                通栏横线只会把五行的短菜单劈成两截，边框感更重 */}
            <ModeSub currentKey={currentMode?.key} />
            <AgentSub />
            <SkillSub />
            <ConnectorSub />
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );
};

/** 一个分类的下钻行：主菜单里的触发项 + 右飞的内容面板 */
const CategorySub: FC<{
  icon: LucideIcon;
  label: string;
  /** 触发项右侧的当前值/计数 */
  shortcut?: string;
  width?: string;
  children: ReactNode;
}> = ({ icon: Icon, label, shortcut, width = "w-60", children }) => (
  <DropdownMenuSub>
    <DropdownMenuSubTrigger>
      <Icon className="text-muted-foreground size-3.5 shrink-0" />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {shortcut && (
        <DropdownMenuShortcut className="me-1 shrink-0 whitespace-nowrap">
          {shortcut}
        </DropdownMenuShortcut>
      )}
    </DropdownMenuSubTrigger>
    {/*  popup 自带 max-h-(--available-height) + overflow-y-auto，长列表就地滚。
        border-0：SubContent 默认在 ring-1 之外又叠一圈 1px border，两层描边
        在浅色主题下发灰加重，浮层边缘由 ring 单独承担即可  */}
    <DropdownMenuSubContent className={cn(width, "border-0")}>
      {children}
    </DropdownMenuSubContent>
  </DropdownMenuSub>
);

const MenuEmpty: FC<{ children: ReactNode }> = ({ children }) => (
  <div className="text-muted-foreground px-2 py-3 text-center text-xs">{children}</div>
);

/** 子菜单页脚：跳管理页（各分类的管理入口都在插件市场/设置，菜单内不重复那些表单） */
const ManageItem: FC<{ label: string; onClick: () => void }> = ({ label, onClick }) => (
  <>
    <DropdownMenuSeparator className="bg-foreground/5 mx-2 my-1" />
    <DropdownMenuItem onClick={onClick}>
      <SettingsIcon className="text-muted-foreground size-3.5 shrink-0" />
      {label}
    </DropdownMenuItem>
  </>
);

/* ------------------------------------------------------------------ 附件 */

/** base64 → Uint8Array（逐字符填环避免超长调用栈），attachment_read_base64 回程解码用。
 *  显式 ArrayBuffer 泛型满足 BlobPart（同 plugin-panel-host 的先例） */
function b64ToBytes(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** 附件添加。桌面端 Tauri dialog 拿绝对路径后分两类：
 *  - 图片：读盘成字节（Rust attachment_read_base64，2MiB 上限超限即 toast）
 *    合成 File 走与粘贴同一条 adapter 管线——草稿缩略图、发送 data URL 内联、
 *    转录 image 块与粘贴图片完全同构。早前用 file:// 路径对象添加的图片
 *    没有可渲染的预览（附件条拿不到 image part/File），超限图又只在发送后
 *    被 sidecar 静默省略成一行「[已省略]」，看起来就是「附件没进对话」；
 *  - 文档：仍走 file:// 路径的 file part——零落盘零复制，sidecar 原位引用。
 *  网页端退回 <input type=file>（File 直进 adapter），粘贴场景见
 *  cm-composer-input。图片沿用单条 4 张的添加时闸门；文档不拦添加
 *  （数量由 sidecar 裁决折算说明行）。
 *  不按模型能力隐藏——纯文本模型发图由 sidecar 硬门折算占位说明，UI 恒可用。 */
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
      // dialog 只给路径、不给 MIME，判类必须走 FromName 那条（见其注释）
      const kind = promptFileKindFromName(name);
      if (!kind) {
        toast.error(
          `「${name}」不是支持的附件（图片 PNG/JPEG/GIF/WebP，或文档 PDF/Word/Excel/PPT/TXT/MD/CSV）`,
        );
        continue;
      }
      const isImage = kind === "image";
      if (isImage && !allowImage(imageCount + imageTaken)) continue;
      const mime = isImage ? imageMimeFromName(name) : docMimeFromName(name);

      if (isImage) {
        // 图片读盘合成 File，与粘贴同一条 adapter 管线（有缩略图预览、
        // 发送内联 data URL、超限在添加时就 toast 而非发送后被静默省略）
        try {
          const res = await invoke<{ base64: string; size: number }>(
            "attachment_read_base64",
            { path: p },
          );
          imageTaken += 1;
          await aui.composer
            .addAttachment(new File([b64ToBytes(res.base64)], name, { type: mime ?? "image/png" }))
            .catch(() => {});
        } catch (err) {
          toast.error(
            err === "too-large"
              ? `「${name}」超过 ${(PROMPT_IMAGE_MAX_BYTES / (1024 * 1024)).toFixed(0)}MiB 上限`
              : `「${name}」读取失败`,
          );
        }
        continue;
      }

      // 文档保持原路径载荷：原路径编码成 file:// URL 进 content（裸绝对路径
      // 会被 runtime 的 toMediaWireUrl 误包成 base64 data URL；file:// 可原样
      // 通过），发送时 extractPromptAttachments 再解回本地路径进 path 载荷
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

/* ------------------------------------------------------------------ 模式 */

const ModeSub: FC<{ currentKey?: string }> = ({ currentKey }) => {
  const threadId = useAuiState((s) => s.threads.mainThreadId);
  const [busy, setBusy] = useState(false);

  const apply = (key: string) => {
    const o = MODE_OPTIONS.find((x) => x.key === key);
    if (!o || !threadId || key === currentKey) return;
    setBusy(true);
    setSessionMode(threadId, o.mode, o.approvalLevel)
      .catch((err) =>
        toast.error(`切换失败：${err instanceof Error ? err.message : String(err)}`),
      )
      .finally(() => setBusy(false));
  };

  return (
    <CategorySub
      icon={SlidersHorizontalIcon}
      label="模式"
      shortcut={MODE_OPTIONS.find((o) => o.key === currentKey)?.label}
    >
      {threadId ? (
        <DropdownMenuRadioGroup value={currentKey ?? ""} onValueChange={apply}>
          {MODE_OPTIONS.map((o) => (
            <DropdownMenuRadioItem key={o.key} value={o.key} disabled={busy} title={o.description}>
              <o.icon className="text-muted-foreground size-3.5 shrink-0" />
              <span className="truncate">{o.label}</span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      ) : (
        <MenuEmpty>会话未就绪</MenuEmpty>
      )}
    </CategorySub>
  );
};

/* --------------------------------------------------- 专家 / 技能 / 连接器 */

/** 插一枚指令芯片。菜单关闭会把焦点还给 + 按钮，故插到那之后：桥里插完会
 *  显式 focus 编辑器并把光标停在芯片之后。芯片序列化与 `/`、`@` 弹层同源，
 *  区别只在插入通道（弹层外走 cm-composer-input 的插入桥）。 */
function useChipInserter() {
  return (type: string, label: string, id: string) => {
    const text = unstable_defaultDirectiveFormatter.serialize({ type, label, id });
    setTimeout(() => {
      if (!insertIntoComposer(text)) {
        toast.error("输入框未就绪，未能插入");
      }
    }, 0);
  };
}

const AgentSub: FC = () => {
  const workspace = useWorkspace();
  const { agents, pluginAgents, loading } = useSubagents(workspace);
  const insert = useChipInserter();

  const list = useMemo(
    () => [...agents, ...pluginAgents].filter((a) => a.enabled),
    [agents, pluginAgents],
  );

  return (
    <CategorySub icon={BotIcon} label="专家">
      {list.length === 0 ? (
        <MenuEmpty>{loading ? "加载中…" : "暂无子智能体"}</MenuEmpty>
      ) : (
        list.map((a) => (
          <DropdownMenuItem
            key={`${a.scope}-${a.name}`}
            title={a.description}
            onClick={() => insert("agent", a.name, `agent:${a.name}`)}
          >
            <BotIcon className="text-muted-foreground size-3.5 shrink-0" />
            <span className="truncate">{a.name}</span>
          </DropdownMenuItem>
        ))
      )}
      <ManageItem
        label="管理子智能体"
        onClick={() => requestSettingsSection("subagents")}
      />
    </CategorySub>
  );
};

const SkillSub: FC = () => {
  const workspace = useWorkspace();
  const { skills, pluginSkills, loading } = useSkills(workspace);
  const insert = useChipInserter();

  const list = useMemo(
    () => [...skills, ...pluginSkills].filter((s) => s.enabled && !s.shadowed),
    [skills, pluginSkills],
  );

  return (
    <CategorySub icon={BookOpenIcon} label="技能">
      {list.length === 0 ? (
        <MenuEmpty>{loading ? "加载中…" : "暂无技能"}</MenuEmpty>
      ) : (
        list.map((s) => (
          <DropdownMenuItem
            key={`${s.scope}-${s.name}`}
            title={s.description}
            onClick={() => insert("skill", s.name, `skill:${s.name}`)}
          >
            <BookOpenIcon className="text-muted-foreground size-3.5 shrink-0" />
            <span className="truncate">{s.name}</span>
          </DropdownMenuItem>
        ))
      )}
      <ManageItem label="管理技能" onClick={() => requestConnectorManage("skills")} />
    </CategorySub>
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
  connecting: "连接中",
  backoff: "连接失败",
  idle: "未连接",
};

const ConnectorSub: FC = () => {
  const workspace = useWorkspace();
  const mcp = useMcpServers(workspace);
  const toolsByServer = useMcpToolsByServer(workspace);
  const insert = useChipInserter();

  const servers = useMemo(
    () => [...mcp.servers, ...mcp.pluginServers],
    [mcp.servers, mcp.pluginServers],
  );

  return (
    <CategorySub icon={Link2Icon} label="连接器">
      {servers.length === 0 ? (
        <MenuEmpty>{mcp.loading ? "加载中…" : "暂无连接器"}</MenuEmpty>
      ) : (
        servers.map((entry) => {
          const tools = toolsByServer[entry.name] ?? [];
          const ready = entry.enabled && entry.status.state === "ready";
          const key = `${entry.layer}-${entry.name}`;
          // 只有「就绪且有工具」才值得再下钻一层；其余把状态摊在这一行上，
          // 启停/修复都在「管理连接器」里做，菜单不复制那些表单
          if (!ready || tools.length === 0) {
            return (
              <DropdownMenuItem disabled key={key} title={entry.description}>
                <ServerIcon entry={entry} />
                <span className="min-w-0 flex-1 truncate">{entry.name}</span>
                <DropdownMenuShortcut className="shrink-0 whitespace-nowrap">
                  {!entry.enabled
                    ? "未启用"
                    : ready
                      ? "无工具"
                      : STATUS_TEXT[entry.status.state] ?? entry.status.state}
                </DropdownMenuShortcut>
              </DropdownMenuItem>
            );
          }
          return (
            <DropdownMenuSub key={key}>
              <DropdownMenuSubTrigger>
                <ServerIcon entry={entry} />
                <span className="min-w-0 flex-1 truncate">{entry.name}</span>
                <DropdownMenuShortcut className="me-1 shrink-0 whitespace-nowrap">{tools.length}</DropdownMenuShortcut>
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="w-64 border-0">
                {tools.map((tool) => (
                  <DropdownMenuItem
                    key={tool.name}
                    title={tool.description}
                    onClick={() =>
                      insert("tool", tool.name, `tool:${entry.name}:${tool.name}`)
                    }
                  >
                    <PlugIcon className="text-muted-foreground size-3.5 shrink-0" />
                    <span className="truncate">{tool.name}</span>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          );
        })
      )}
      <ManageItem
        label="管理连接器"
        onClick={() => requestConnectorManage("plugins")}
      />
    </CategorySub>
  );
};
