"use client";

import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { useAui, useAuiState } from "@assistant-ui/react";
import { unstable_defaultDirectiveFormatter } from "@assistant-ui/core";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type ComponentPropsWithoutRef,
  type FC,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from "react";
import {
  BookOpenIcon,
  BotIcon,
  ChevronRightIcon,
  Link2Icon,
  MessageSquareIcon,
  PaperclipIcon,
  PlugIcon,
  PlusIcon,
  SearchIcon,
  SettingsIcon,
  SlidersHorizontalIcon,
  type LucideIcon,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
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
// 两个维度各自成组（权限 4 / 能力 3）——它们正交，混成一张单选表就分不清
// "问不问"和"能不能干"；底栏下拉只列权限，能力在那里由胶囊显示
import {
  CAPABILITY_OPTIONS,
  PERMISSION_OPTIONS,
  capabilityOption,
  permissionOption,
} from "@/components/agent-thread/mode-picker";
import { requestConnectorManage } from "@/lib/connector-nav";
import { insertIntoComposer } from "@/components/agent-thread/cm-composer-input";
import { useHtmlDark } from "@/lib/settings/use-html-dark";

/**
 * composer 的「+」菜单，取代原先只有一个「添加附件」的单按钮。一个下拉，
 * 五项分类：附件是直选动作，模式/专家/技能/连接器各自下钻一层。
 *
 * 三类可选项各自落到既有事实源：
 *
 * - 附件：Tauri dialog 拿绝对路径 → composer 附件（零落盘，见 useAddAttachments）；
 * - 模式：set_session_mode，按维度分两组（权限 = 问不问；能力 = 能不能干）。
 *   两组各是一个独立单选组（两个维度各存各的值），能力组另给一个「常规」
 *   用于退回到不带特殊能力的形态——单选项点自己不会取消，没有它就没法退出；
 * - 专家/技能/连接器：插指令芯片（:agent/:skill/:tool），模型端凭芯片里的
 *   id 定位——与输入框里 `@`/`/` 弹层插的是同一种芯片（序列化同走
 *   unstable_defaultDirectiveFormatter，id 拼接口径同 composer-commands，不另立格式）。
 *   区别只在插入时机：弹层走库的 selectItemOverride（要剥离触发字符），这里是弹层
 *   之外的入口，走 cm-composer-input 暴露的插入桥（落在光标处，见 insertIntoComposer）。
 *
 * 连接器 = MCP 服务器清单（含插件层）：就绪且有工具的服务器再下钻一层列工具，
 * 未启用/未连/无工具的只读展示状态；启停归「管理连接器」（插件市场的 MCP 页）。
 *
 * 三个分类面板（专家/技能/连接器）都是「悬浮展开 + 定高 + 带搜索框」
 * （SearchableCategorySub），与「模式」子菜单同一套展开手感：
 *
 * - 为什么定高：技能动辄几十条，面板贴着 --available-height 会长成一整屏，
 *   底部的「管理技能」还得滚到最后才够得着；三级（工具）同理。高度上限
 *   PANEL_MAX_H，超出的在面板内的条目区滚，搜索头与页脚常驻。
 * - 为什么是 Popover 而不是 Menu 子菜单：实测 Menu 浮层里放任何可输入元素都
 *   收不到键盘字符（连临时塞进去的裸 input 也一样，输入法自然也弹不出来），
 *   Popover 没这个问题，焦点/输入/方向键/回车全正常。行组件随之换成普通按钮
 *   （PanelRow），菜单项语义由触发行自己带（role="menuitem"）。
 * - 交互细节（悬浮开合、钉住、互斥、瞬时切换）都在 SearchableCategorySub，那里
 *   逐条写了为什么。
 */

/** dialog 文件类型过滤（与 prompt-attachments 白名单同源） */
const ATTACHMENT_DIALOG_EXTENSIONS = [
  "png", "jpg", "jpeg", "gif", "webp",
  "pdf", "doc", "docx", "ppt", "pptx", "xls", "xlsx", "csv", "txt", "md", "rtf",
];

/** 关闭整个「+」菜单。面板（Popover）只知道自己那一层，选中条目 / 点管理
 *  入口后要连菜单一起收掉，开关在 ComposerPlusMenu 手上，经 context 递下来 */
const MenuCloseContext = createContext<() => void>(() => {});

/**
 * 分类面板的互斥登记：同一时间只允许一个面板开着。没有它就会出现
 * 「点了技能把面板钉住，再悬浮专家又开一个」——两个面板同屏重叠。
 *
 * 刻意不走 React state：悬浮切换若 setState，登记值经 context 一变，几个面板
 * 连同各自几十行条目会整体重渲染——而切换本该只动「被抢的」和「新开的」两个。
 * 这里用订阅式的小登记表，抢占时只通知被抢的那个自收。null = 没挂登记
 * （单挂一个面板的场景），不做互斥。
 */
type PanelGroup = {
  claim: (key: string) => void;
  release: (key: string) => void;
  subscribe: (listener: (current: string | null) => void) => () => void;
  reset: () => void;
};

function createPanelGroup(): PanelGroup {
  let current: string | null = null;
  const listeners = new Set<(current: string | null) => void>();
  const emit = () => {
    for (const listener of listeners) listener(current);
  };
  return {
    claim(key) {
      current = key;
      emit();
    },
    release(key) {
      if (current === key) current = null;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    reset() {
      current = null;
    },
  };
}

const PanelGroupContext = createContext<PanelGroup | null>(null);

/** 面板内嵌套子面板时，父面板是否开着。父面板一关（display:none），锚点矩形
 *  会塌成 0×0，而子面板自己还开着的话会被定位到 (0,0)——屏幕上就是左上角一闪。
 *  所以子面板的可见性要跟着父面板走。菜单层级没有父面板，默认 true。 */
const PanelParentOpenContext = createContext(true);

export const ComposerPlusMenu: FC = () => {
  const threadId = useAuiState((s) => s.threads.mainThreadId);
  // 左栏「模式」行透出当前档位：快照是按 threadId 存的全局 store（ModePicker
  // 也在订阅同一份），这里多读一次无副作用，只为不点进子菜单就知道当前档位
  const modeSnap = useSessionMode(threadId);
  const { pick, fileInput } = useAddAttachments();
  // 菜单开关上提到这里：搜索面板选中条目后要能反手把整个菜单关掉
  const [menuOpen, setMenuOpen] = useState(false);
  const closeMenu = useCallback(() => setMenuOpen(false), []);
  // 分类面板的互斥登记（见 PanelGroupContext）
  const panelGroup = useMemo(createPanelGroup, []);
  // 菜单一关就把登记清掉，否则下次打开会认为自己还占着位
  useEffect(() => {
    if (!menuOpen) panelGroup.reset();
  }, [menuOpen, panelGroup]);

  return (
    <>
      {fileInput}
      <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
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
          <MenuCloseContext.Provider value={closeMenu}>
            <PanelGroupContext.Provider value={panelGroup}>
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
                {/* 分隔线把「直选动作」和「下钻分类」分成两段：添加文件点下去就执行，
                    其余四行都要再展开一层。线的样式跟面板页脚一致（浅色 + 两侧内收），
                    免得在五行短菜单里读成硬边框 */}
                <DropdownMenuSeparator className="bg-foreground/5 mx-2 my-1" />
                <ModeSub />
                <AgentSub />
                <SkillSub />
                <ConnectorSub />
              </DropdownMenuGroup>
            </PanelGroupContext.Provider>
          </MenuCloseContext.Provider>
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );
};

/** 分类面板的高度上限：搜索头 + 约 8 行条目 + 管理行。留 min() 是为了贴着
 *  窗口边缘时先让位给 --available-height，不至于顶出可视区。 */
const PANEL_MAX_H = "max-h-[min(var(--available-height),22rem)]";

/** 一个分类的下钻行：主菜单里的触发项 + 右飞的内容面板（模式用，无搜索） */
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
    <DropdownMenuSubContent className={cn(width, "border-0", PANEL_MAX_H)}>
      {children}
    </DropdownMenuSubContent>
  </DropdownMenuSub>
);

const MenuEmpty: FC<{ children: ReactNode }> = ({ children }) => (
  <div className="text-muted-foreground px-2 py-3 text-center text-xs">{children}</div>
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

/** 「常规」：不带特殊能力（agent 档）。能力组必须留它一条退路——单选组里
 *  点自己不会取消，没有这一项就问不出"怎么回到不带能力的形态"，只能去点权限组。
 *  approvalLevel 不传 = 保留当前权限档（两个维度各改各的）。 */
const PLAIN_CAPABILITY = {
  key: "plain",
  label: "常规",
  description: "完整工具集，正常执行。",
  icon: MessageSquareIcon,
} as const;

const ModeSub: FC = () => {
  const threadId = useAuiState((s) => s.threads.mainThreadId);
  const snap = useSessionMode(threadId);
  const [busy, setBusy] = useState(false);

  const perm = permissionOption(snap);
  const cap = capabilityOption(snap);

  const apply = (
    key: string,
    mode: "agent" | "ask" | "plan" | "goal",
    approvalLevel?: "ask" | "workspace-write" | "auto-edit" | "auto",
  ) => {
    if (!threadId) return;
    setBusy(true);
    setSessionMode(threadId, mode, approvalLevel)
      .catch((err) =>
        toast.error(`切换失败：${err instanceof Error ? err.message : String(err)}`),
      )
      .finally(() => setBusy(false));
  };

  return (
    <CategorySub
      icon={SlidersHorizontalIcon}
      label="模式"
      // 两个维度各显示一格：权限 + 能力（后者不在能力档时不占位）
      shortcut={cap ? `${perm.label} · ${cap.label}` : perm.label}
    >
      {threadId ? (
        <>
          <DropdownMenuGroup>
            <DropdownMenuLabel className="text-muted-foreground text-xs font-normal">
              权限
            </DropdownMenuLabel>
            {/* 两个组各是一个独立单选组：权限与能力各存各的值，互不覆盖 */}
            <DropdownMenuRadioGroup
              value={perm.key}
              onValueChange={(key) => {
                const o = PERMISSION_OPTIONS.find((x) => x.key === key);
                // 权限项不带 mode（见 mode-picker 的类型说明）：切成「当前档位 + 新权限」，
                // 不能顺手把会话踢出问答/计划/目标档
                if (o) apply(o.key, snap.mode, o.approvalLevel);
              }}
            >
              {PERMISSION_OPTIONS.map((o) => (
                <DropdownMenuRadioItem
                  key={o.key}
                  value={o.key}
                  disabled={busy}
                  title={o.description}
                >
                  <o.icon className="text-muted-foreground size-3.5 shrink-0" />
                  <span className="truncate">{o.label}</span>
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuGroup>
            <DropdownMenuLabel className="text-muted-foreground text-xs font-normal">
              能力
            </DropdownMenuLabel>
            <DropdownMenuRadioGroup
              value={cap?.key ?? PLAIN_CAPABILITY.key}
              onValueChange={(key) => {
                if (key === PLAIN_CAPABILITY.key) return apply(key, "agent");
                const o = CAPABILITY_OPTIONS.find((x) => x.key === key);
                if (o) apply(o.key, o.mode);
              }}
            >
              {[PLAIN_CAPABILITY, ...CAPABILITY_OPTIONS].map((o) => (
                <DropdownMenuRadioItem
                  key={o.key}
                  value={o.key}
                  disabled={busy}
                  title={o.description}
                >
                  <o.icon className="text-muted-foreground size-3.5 shrink-0" />
                  <span className="truncate">{o.label}</span>
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuGroup>
        </>
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

/** 面板里能被搜索命中的条目最小形状：技能 / 专家 / 连接器都满足 */
type PanelItem = { key: string; name: string; description?: string };

/** 面板里的一行。面板是 Popover，行就是普通按钮，不再有 menu 上下文——
 *  也就不吃菜单的焦点/typeahead 管理，这是搜索框能打字的根源。也用作下级
 *  菜单的触发元素（render 进 DropdownMenuTrigger）。data-row 让回车激活
 *  「高亮行」时能按 DOM 顺序找到它。 */
const PanelRow: FC<
  ComponentPropsWithoutRef<"button"> & {
    /** 行首图标 */
    leading?: ReactNode;
    /** 行尾内容（计数/状态） */
    trailing?: ReactNode;
    /** 行尾 chevron（还有下级面板） */
    chevron?: boolean;
    /** 键盘高亮（回车要点的行） */
    active?: boolean;
  }
> = ({ leading, trailing, chevron, active, className, children, ...rest }) => (
  <button
    type="button"
    data-row=""
    data-active={active || undefined}
    className={cn(
      "hover:bg-foreground/[0.06] focus-visible:bg-foreground/[0.06] data-active:bg-foreground/[0.06]",
      "flex w-full cursor-default items-center gap-2 rounded-lg px-2 py-1.5 text-start text-sm outline-hidden select-none",
      "disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
      className,
    )}
    {...rest}
  >
    {leading}
    {children}
    {trailing}
    {chevron && (
      <ChevronRightIcon className="text-muted-foreground ms-auto size-3.5 shrink-0 rtl:rotate-180" />
    )}
  </button>
);

type SearchPanelProps<T extends PanelItem> = {
  placeholder: string;
  /** 一个条目都没有：未加载或确实为空 */
  emptyLabel: string;
  /** 有条目，但全被搜索词滤掉了 */
  noMatchLabel: string;
  items: readonly T[];
  /** 渲染单行；key 由条目自己带（item.key），点击后要自己调 close() 收起面板 */
  renderRow: (item: T, ctx: PanelRowContext) => ReactNode;
  /** 页脚的管理入口；工具面板没有，不传就不渲染页脚 */
  manage?: { label: string; onClick: () => void };
  close: () => void;
  /** 把面板钉住（下钻出下一级时用，见 PanelRowContext） */
  pin: () => void;
  /** 面板是否开着：常驻挂载（keepMounted）之后，焦点与搜索词都得跟着开合走 */
  open: boolean;
  /** 挂载时是否把焦点交给搜索框：悬浮展开为 false（别抢走 composer 的光标），
   *  点击展开为 true */
  autoFocus: boolean;
};

/** 面板行拿到的上下文：close = 选中后收面板（+ 菜单），pin = 把面板钉住
 *  （下钻出下一级面板时用，免得鼠标一离开这一层就被悬浮逻辑收走） */
type PanelRowContext = { active: boolean; close: () => void; pin: () => void };

/**
 * 面板层级的全部开合逻辑，两级面板（分类 / 工具）共用：
 *
 * - 悬浮展开（延迟压到 20ms，行进到面板的斜线由 safePolygon 兜着）；
 * - 面板内按过鼠标就钉住，不再随 mouseleave 收——不然刚点进搜索框打字，
 *   鼠标一挪面板就没了。base-ui 只在「打开那一下是不是点击」上判这个，
 *   悬浮打开的照样会随 mouseleave 关，所以这里自己用 openOnHover 钉；
 * - 悬浮展开不抢焦点，点击展开才把焦点交给搜索框；
 * - 互斥登记：同一时间只允许一个面板开着；谁打开谁登记，被抢的那个在对方
 *   打开的那一帧自收（不是鼠标压上去就收，理由见下面那段注释）。
 */
function usePanelFlyout(panelKey: string) {
  const [open, setOpen] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [autoFocus, setAutoFocus] = useState(true);
  const group = useContext(PanelGroupContext);
  const closeMenu = useContext(MenuCloseContext);
  // 父面板（二级）关了就跟着关：见 PanelParentOpenContext 的说明
  const parentOpen = useContext(PanelParentOpenContext);
  useEffect(() => {
    if (parentOpen) return;
    setOpen(false);
    setPinned(false);
  }, [parentOpen]);

  // 选中条目 / 点管理入口后连整个菜单一起收（与旧菜单项点击的行为一致）；
  // Esc / 点面板外只收面板这一层，菜单留着
  const close = useCallback(() => {
    setOpen(false);
    closeMenu();
  }, [closeMenu]);
  const pin = useCallback(() => setPinned(true), []);

  // 【收在「别人真的开了」那一刻，而不是「鼠标压在别的行上」那一刻】：
  // 悬浮切换的手感全在这。若鼠标一压到别的行就自收，会先空一段时间（新面板
  // 的展开延迟）才见到下一个面板，看起来就是一闪一卡的；等到对方 setOpen
  // 提交时再收，两个面板的显隐落在同一批更新里，切换就是一帧内的替换。
  // 走订阅而不是 context 值：这里的收合不该引发其它面板重渲染。
  useEffect(() => {
    if (!group) return;
    return group.subscribe((current) => {
      if (current === null || current === panelKey) return;
      setOpen(false);
      setPinned(false);
    });
  }, [group, panelKey]);

  const onOpenChange = (next: boolean, details: { reason?: string }) => {
    setOpen(next);
    if (next) {
      setAutoFocus(details.reason !== "trigger-hover");
      group?.claim(panelKey);
      return;
    }
    setPinned(false);
    group?.release(panelKey);
  };

  const triggerProps = {
    openOnHover: !pinned,
    delay: 20,
    closeDelay: 40,
  };

  const contentProps = {
    onPointerDown: (event: PointerEvent<HTMLDivElement>) => {
      pin();
      const target = event.target as HTMLElement | null;
      // 点非可聚焦的空白（行间留白、滚动条、内边距）时焦点会掉到 body，
      // base-ui 的浮层焦点一出去就把面板收掉——挡掉默认的焦点转移，
      // 光标始终留在搜索框里，接着打字不丢
      if (!target?.closest("button,a,input,textarea,select,[tabindex]")) {
        event.preventDefault();
      }
    },
  };

  return {
    // 交给调用方的是「实际可见」的开合：父面板一关，哪怕自己的 open 还是 true，
    // 渲染出去也得是关的，否则就是上面说的左上角一闪
    open: open && parentOpen,
    pinned,
    autoFocus,
    onOpenChange,
    triggerProps,
    contentProps,
    close,
    pin,
  };
}

/** 面板本体：搜索框常驻顶部，条目区在固定高度里滚，管理行常驻底部。
 *  搜索词/高亮行都活在组件 state 里——面板关闭即随 PopoverContent 卸载，
 *  下次打开是干净的。键盘：↑/↓ 在行间挪高亮，回车点高亮行（没有就点第一行），
 *  Esc 交给 Popover 自己的 dismiss 关面板。 */
function SearchPanel<T extends PanelItem>({
  placeholder,
  emptyLabel,
  noMatchLabel,
  items,
  renderRow,
  manage,
  close,
  pin,
  open,
  autoFocus,
}: SearchPanelProps<T>) {
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(-1);
  // 面板内部再开一层互斥登记域：这一层里下钻出来的面板（三级）只在同级之间
  // 互斥，不跟外层分类面板争同一个名额——不然一打开三级就会把父面板顶掉
  const childPanels = useMemo(createPanelGroup, []);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // 点击展开时 Popover 的焦点管理会自己给浮层里第一个可聚焦元素（就是这
  // 输入框）；这里兜个底，并且把「悬浮展开不抢焦点」这条说死在这里。
  // keepMounted 下面板常驻，只有真打开才落焦点——否则菜单一开，几个隐藏
  // 面板的输入框会轮流抢 composer 的光标
  useEffect(() => {
    if (open && autoFocus) inputRef.current?.focus();
  }, [open, autoFocus]);

  // 常驻挂载让搜索词活过了关闭：收面板时清干净，下次打开是新的
  useEffect(() => {
    if (open) return;
    setQuery("");
    setActiveIndex(-1);
  }, [open]);

  const needle = query.trim().toLowerCase();
  /** 名称或描述的子串命中即保留——技能名多是 kebab-case，描述里常是中文关键词 */
  const shown = useMemo(
    () =>
      needle === ""
        ? [...items]
        : items.filter(
            (item) =>
              item.name.toLowerCase().includes(needle) ||
              (item.description ?? "").toLowerCase().includes(needle),
          ),
    [items, needle],
  );

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    // 【必须自己断冒泡】菜单的 typeahead 挂在菜单浮层上，而 Portal 只挪 DOM
    // 不挪 React 树：按键照样沿组件树冒到菜单那层，被它 preventDefault 掉——
    // 字符进不了输入框，表现就是「打字没反应、输入法也不弹」。字符键在这里
    // 只 stopPropagation、不 preventDefault，浏览器照常把字落进来，中文输入法
    // 也照常组字。组字期间（含回车确认候选）同样只断冒泡，不动默认行为。
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) {
      event.stopPropagation();
      return;
    }
    if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.stopPropagation();
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      event.stopPropagation();
      if (shown.length > 0) {
        const delta = event.key === "ArrowDown" ? 1 : -1;
        setActiveIndex((index) => (index + delta + shown.length) % shown.length);
      }
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      event.stopPropagation();
      const rows = listRef.current?.querySelectorAll<HTMLButtonElement>("[data-row]");
      rows?.[activeIndex >= 0 ? activeIndex : 0]?.click();
    }
  };

  // 高亮行滚进视野（搜索后列表变短，高亮可能落在滚动容器外）
  useEffect(() => {
    if (activeIndex < 0) return;
    listRef.current
      ?.querySelectorAll<HTMLButtonElement>("[data-row]")
      [activeIndex]?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  return (
    <>
      <div className="px-1.5 pt-1.5">
        {/* 图标压在输入框自己的相对容器里：容器带 pt 时按 50% 定位会偏 */}
        <div className="relative">
          <SearchIcon className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActiveIndex(-1);
            }}
            onKeyDown={onKeyDown}
            placeholder={placeholder}
            aria-label={placeholder}
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            className="placeholder:text-muted-foreground/70 bg-foreground/[0.04] h-8 w-full rounded-lg ps-8 pe-2 text-sm outline-none"
          />
        </div>
      </div>
      <PanelParentOpenContext.Provider value={open}>
      <PanelGroupContext.Provider value={childPanels}>
        <div
          ref={listRef}
          className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-1.5"
        >
          {shown.length === 0 ? (
            <MenuEmpty>{items.length === 0 ? emptyLabel : noMatchLabel}</MenuEmpty>
          ) : (
            shown.map((item, index) =>
              renderRow(item, { active: index === activeIndex, close, pin }),
            )
          )}
        </div>
        {manage && (
          <div className="p-1.5 pt-0">
            <DropdownMenuSeparator className="bg-foreground/5 mx-2 my-1" />
            <PanelRow
              onClick={() => {
                close();
                manage.onClick();
              }}
            >
              <SettingsIcon className="text-muted-foreground size-3.5 shrink-0" />
              <span className="truncate">{manage.label}</span>
            </PanelRow>
          </div>
        )}
      </PanelGroupContext.Provider>
      </PanelParentOpenContext.Provider>
    </>
  );
}

type SearchableCategorySubProps<T extends PanelItem> = {
  icon: LucideIcon;
  label: string;
  /** 搜索框占位文案 */
  placeholder: string;
  emptyLabel: string;
  noMatchLabel: string;
  width?: string;
  items: readonly T[];
  renderRow: (item: T, ctx: PanelRowContext) => ReactNode;
  manage: { label: string; onClick: () => void };
};

/** 面板外壳（两级共用）：右飞、定高、搜索头/页脚常驻、只有条目区滚。
 *  过渡全部瞬时化：animate-none 压掉淡入淡出/位移/缩放，data-closed:hidden
 *  让退场那一帧直接消失——base-ui 要等「退场动画结束」才卸载，动画关掉后仍会
 *  多留 ~100ms，正好和刚打开的下一个面板同屏，看起来就是两块面板叠着。
 *  border-0 + ring：SubContent/Popup 默认在 ring 之外还有一圈 border，
 *  两层描边在浅色主题下发灰加重（理由同 CategorySub）。 */
const PanelSurface: FC<{
  width: string;
  /** usePanelFlyout 给的浮层事件（点空白钉住 + 挡焦点转移） */
  contentProps: ComponentPropsWithoutRef<typeof PopoverContent>;
  children: ReactNode;
}> = ({ width, contentProps, children }) => (
  <PopoverContent
    side="right"
    align="start"
    alignOffset={-3}
    sideOffset={0}
    // 面板关掉也不卸载：悬浮划过几行就是几套 portal + 焦点管理 + 列表的建与拆，
    // 每切一次卡一次；常驻之后切换只是显隐（配合 data-closed:hidden）
    keepMounted
    {...contentProps}
    className={cn(
      width,
      "gap-0 overflow-hidden border-0 p-0 ring-1 ring-foreground/10",
      "data-open:animate-none data-closed:animate-none data-closed:hidden",
      PANEL_MAX_H,
    )}
  >
    {children}
  </PopoverContent>
);

/** 带搜索的分类面板（见文件头为什么是 Popover 而不是 Menu 子菜单）。触发行
 *  仍是菜单项：closeOnClick={false} 让点它不关整个菜单，面板右飞，交互上
 *  还是「下钻一层」的样子。开合逻辑见 usePanelFlyout。 */
function SearchableCategorySub<T extends PanelItem>({
  icon: Icon,
  label,
  placeholder,
  emptyLabel,
  noMatchLabel,
  width = "w-72",
  items,
  renderRow,
  manage,
}: SearchableCategorySubProps<T>) {
  const flyout = usePanelFlyout(`cat:${label}`);

  return (
    <Popover open={flyout.open} onOpenChange={flyout.onOpenChange}>
      <PopoverTrigger
        nativeButton={false}
        role="menuitem"
        {...flyout.triggerProps}
        render={
          <DropdownMenuItem
            closeOnClick={false}
            className="hover:bg-foreground/[0.06] data-popup-open:bg-foreground/[0.06]"
          >
            <Icon className="text-muted-foreground size-3.5 shrink-0" />
            <span className="min-w-0 flex-1 truncate">{label}</span>
            <ChevronRightIcon className="text-muted-foreground ms-auto size-3.5 shrink-0 rtl:rotate-180" />
          </DropdownMenuItem>
        }
      />
      <PanelSurface
        width={width}
        contentProps={flyout.contentProps}
      >
        <SearchPanel
          placeholder={placeholder}
          emptyLabel={emptyLabel}
          noMatchLabel={noMatchLabel}
          items={items}
          renderRow={renderRow}
          manage={manage}
          close={flyout.close}
          pin={flyout.pin}
          open={flyout.open}
          autoFocus={flyout.autoFocus}
        />
      </PanelSurface>
    </Popover>
  );
}


const AgentSub: FC = () => {
  const workspace = useWorkspace();
  const { agents, pluginAgents, loading } = useSubagents(workspace);
  const insert = useChipInserter();

  const items = useMemo(
    () =>
      [...agents, ...pluginAgents]
        .filter((a) => a.enabled)
        .map((a) => ({ key: `${a.scope}-${a.name}`, name: a.name, description: a.description })),
    [agents, pluginAgents],
  );

  return (
    <SearchableCategorySub
      icon={BotIcon}
      label="专家"
      placeholder="搜索专家"
      emptyLabel={loading ? "加载中…" : "暂无子智能体"}
      noMatchLabel="没有匹配的专家"
      items={items}
      renderRow={(item, { active, close }) => (
        <PanelRow
          key={item.key}
          title={item.description}
          active={active}
          onClick={() => {
            insert("agent", item.name, `agent:${item.name}`);
            close();
          }}
        >
          <BotIcon className="text-muted-foreground size-3.5 shrink-0" />
          <span className="truncate">{item.name}</span>
        </PanelRow>
      )}
      manage={{
        label: "管理子智能体",
        onClick: () => requestConnectorManage("subagents"),
      }}
    />
  );
};

const SkillSub: FC = () => {
  const workspace = useWorkspace();
  const { skills, pluginSkills, loading } = useSkills(workspace);
  const insert = useChipInserter();

  const items = useMemo(
    () =>
      [...skills, ...pluginSkills]
        .filter((s) => s.enabled && !s.shadowed)
        .map((s) => ({ key: `${s.scope}-${s.name}`, name: s.name, description: s.description })),
    [skills, pluginSkills],
  );

  return (
    <SearchableCategorySub
      icon={BookOpenIcon}
      label="技能"
      placeholder="搜索技能"
      emptyLabel={loading ? "加载中…" : "暂无技能"}
      noMatchLabel="没有匹配的技能"
      items={items}
      renderRow={(item, { active, close }) => (
        <PanelRow
          key={item.key}
          title={item.description}
          active={active}
          onClick={() => {
            insert("skill", item.name, `skill:${item.name}`);
            close();
          }}
        >
          <BookOpenIcon className="text-muted-foreground size-3.5 shrink-0" />
          <span className="truncate">{item.name}</span>
        </PanelRow>
      )}
      manage={{ label: "管理技能", onClick: () => requestConnectorManage("skills") }}
    />
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

  const items = useMemo(
    () =>
      [...mcp.servers, ...mcp.pluginServers].map((entry) => ({
        key: `${entry.layer}-${entry.name}`,
        name: entry.name,
        description: entry.description,
        entry,
      })),
    [mcp.servers, mcp.pluginServers],
  );

  return (
    <SearchableCategorySub
      icon={Link2Icon}
      label="连接器"
      placeholder="搜索连接器"
      emptyLabel={mcp.loading ? "加载中…" : "暂无连接器"}
      noMatchLabel="没有匹配的连接器"
      items={items}
      renderRow={(item, { active, close, pin }) => {
        const { entry } = item;
        const tools = toolsByServer[entry.name] ?? [];
        const ready = entry.enabled && entry.status.state === "ready";
        // 只有「就绪且有工具」才值得再下钻一层；其余把状态摊在这一行上，
        // 启停/修复都在「管理连接器」里做，面板不复制那些表单
        if (!ready || tools.length === 0) {
          return (
            <PanelRow
              key={item.key}
              disabled
              active={active}
              title={item.description}
              trailing={
                <span className="text-muted-foreground shrink-0 whitespace-nowrap font-mono text-[11px] tracking-wider">
                  {!entry.enabled
                    ? "未启用"
                    : ready
                      ? "无工具"
                      : STATUS_TEXT[entry.status.state] ?? entry.status.state}
                </span>
              }
            >
              <ServerIcon entry={entry} />
              <span className="min-w-0 flex-1 truncate">{entry.name}</span>
            </PanelRow>
          );
        }
        // 三级同样是带搜索的 Popover 面板（工具动辄几十个，菜单那种长条既没
        // 搜索也吃不到定高）；触发行是面板里的普通按钮，悬浮即展开
        return (
          <ToolFlyout
            key={item.key}
            entry={entry}
            tools={tools}
            active={active}
            title={item.description}
            pinParent={pin}
            onPick={(toolName) => {
              insert("tool", toolName, `tool:${entry.name}:${toolName}`);
              close();
            }}
          />
        );
      }}
      manage={{ label: "管理连接器", onClick: () => requestConnectorManage("plugins") }}
    />
  );
};

/** 连接器某一行的工具下钻面板（三级）。悬浮展开、带搜索、定高，与二级同一套
 *  壳；pinParent = 展开时把二级钉住——鼠标从二级面板移到三级浮层，二级会收到
 *  mouseleave，不钉住就连着三级一起被收走 */
const ToolFlyout: FC<{
  entry: McpServerEntry;
  tools: { name: string; description?: string }[];
  active: boolean;
  title?: string;
  pinParent: () => void;
  onPick: (toolName: string) => void;
}> = ({ entry, tools, active, title, pinParent, onPick }) => {
  const flyout = usePanelFlyout(`tool:${entry.layer}-${entry.name}`);
  const items = useMemo(
    () => tools.map((t) => ({ key: t.name, name: t.name, description: t.description })),
    [tools],
  );

  return (
    <Popover
      open={flyout.open}
      onOpenChange={(next, details) => {
        // 三级真的打开时才钉住父面板：鼠标从二级面板移进三级浮层会先触发
        // 二级的 mouseleave，不钉住就会连带三级一起被悬浮逻辑收走；而只是
        // 扫过这一行（三级没开）就别钉，免得父面板变得过度粘滞
        if (next) pinParent();
        flyout.onOpenChange(next, details);
      }}
    >
      {/* 触发行是真 <button>（PanelRow），nativeButton 保持默认 true；分类那边
          的触发行是菜单项 div，才要显式 false */}
      <PopoverTrigger
        {...flyout.triggerProps}
        render={
          <PanelRow active={active} title={title} chevron>
            <ServerIcon entry={entry} />
            <span className="min-w-0 flex-1 truncate">{entry.name}</span>
            <span className="text-muted-foreground me-1 shrink-0 font-mono text-[11px] tracking-wider whitespace-nowrap">
              {tools.length}
            </span>
          </PanelRow>
        }
      />
      <PanelSurface width="w-72" contentProps={flyout.contentProps}>
        <SearchPanel
          placeholder="搜索工具"
          emptyLabel="该连接器暂无工具"
          noMatchLabel="没有匹配的工具"
          items={items}
          renderRow={(item, ctx) => (
            <PanelRow
              key={item.key}
              title={item.description}
              active={ctx.active}
              onClick={() => onPick(item.name)}
            >
              <PlugIcon className="text-muted-foreground size-3.5 shrink-0" />
              <span className="truncate">{item.name}</span>
            </PanelRow>
          )}
          close={flyout.close}
          pin={flyout.pin}
          open={flyout.open}
          autoFocus={flyout.autoFocus}
        />
      </PanelSurface>
    </Popover>
  );
};
