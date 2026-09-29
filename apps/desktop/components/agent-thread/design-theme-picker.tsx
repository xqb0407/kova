"use client";

import { useEffect, useState, type FC } from "react";
import { useAuiState } from "@assistant-ui/react";
import {
  CheckIcon,
  CircleSlash2Icon,
  Loader2Icon,
  PaletteIcon,
  SettingsIcon,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { toast } from "@/components/ui/toast";
import { useAppMode } from "@/lib/pi/app-mode";
import {
  ensureDesignThemePush,
  findThemeEntry,
  hydrateSessionTheme,
  setSessionDesignTheme,
  useDesignThemes,
  useSessionDesignTheme,
  type ThemeRef,
} from "@/lib/design-themes/design-themes";

/**
 * 设计主题胶囊（composer 区，仅 design 工作模式显示）：按会话选一套设计主题
 * （内置主题包 + 我的主题），选中即时 set_design_theme——sidecar 热重排该会话
 * 系统提示词（design 段追加主题句），下一轮起动笔前先经 use_design_theme 加载全文。
 * 快照与模式胶囊同纪律：挂载/换线程先用水合（偏好列播种 + sidecar 活动真值）。
 * 选中态三态纪律：undefined = 未水合，UI 不宣称任何当前值（通用风格不打勾、
 * 点击不吞）；null = 显式不使用；ref = 选中。回退语义（sidecar resolve 链）：
 * 偏好列从未设置的新会话/恢复会话生效主题 = 最近使用 kv，水合应答回的就是
 * 这个生效真值，胶囊不本地猜回退、只跟水合结果。
 * 底部「管理设计主题…」跳设置页设计主题分区（CustomEvent，宿主见 base.tsx）。
 */
export const DesignThemePicker: FC = () => {
  const appMode = useAppMode();
  const threadId = useAuiState((s) => s.threads.mainThreadId);
  const snap = useDesignThemes();
  const active = useSessionDesignTheme(threadId);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!threadId || appMode !== "design") return;
    // 推送订阅注册一次（惰性幂等）：他窗 save/delete/set 的清单/胶囊直更
    ensureDesignThemePush();
    void hydrateSessionTheme(threadId);
  }, [threadId, appMode]);

  // 只在设计工作模式出现：work/code 档没有"设计草稿"语境，胶囊是噪音
  if (appMode !== "design" || !threadId) return null;

  const current = findThemeEntry(active);
  // 未水合（undefined）显示中性占位「选择主题」，不冒充已确认的「通用风格」；
  // 水合后确认为显式不使用才显示「通用风格」
  const label = active ? (current?.name ?? active.id) : active === null ? "通用风格" : "选择主题";
  const firstAccent = current?.accents[0];
  const builtinEntries = snap.entries.filter((e) => e.scope === "builtin");
  const userEntries = snap.entries.filter((e) => e.scope === "user");

  const pick = (ref: ThemeRef | null) => {
    setOpen(false);
    // 同值只在水合真值已知的面上判定：undefined（未水合）时点「通用风格」
    // 不能当 no-op 吞掉（真实生效值可能是最近使用回退的主题）
    const same =
      (ref === null && active === null) ||
      (ref !== null && active && ref.scope === active.scope && ref.id === active.id);
    if (same) return;
    setBusy(true);
    // 失败可见（修复 8）：set 失败不提前乐观写入，胶囊仍显示原真值；
    // 把 sidecar 的拒绝原因（主题不存在等）toast 给用户，不再只进 console
    setSessionDesignTheme(threadId, ref)
      .catch((err) =>
        toast.error(`切换设计主题失败：${err instanceof Error ? err.message : String(err)}`),
      )
      .finally(() => setBusy(false));
  };

  const openManager = () => {
    setOpen(false);
    window.dispatchEvent(new CustomEvent("kova:open-settings-section", { detail: "design-themes" }));
  };

  const isSelected = (ref: ThemeRef) =>
    active !== undefined && active !== null && active.scope === ref.scope && active.id === ref.id;

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger
        render={
          <button
            type="button"
            data-slot="aui-composer-design-theme"
            aria-label="Design theme"
            title="本会话的设计主题"
            className={cn(
              "hover:bg-muted inline-flex h-7 max-w-44 items-center gap-1.5 rounded-full px-2.5 text-sm transition-colors",
              active
                ? "bg-muted text-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {busy ? (
              <Loader2Icon className="size-3.5 shrink-0 animate-spin" />
            ) : (
              <span className="relative inline-flex size-3.5 shrink-0 items-center justify-center">
                <PaletteIcon className="size-3.5" />
                {/* 选中主题时以代表色点轻覆盖图标右下角，未选保持纯图标 */}
                {firstAccent && (
                  <span
                    className="absolute -right-0.5 -bottom-0.5 size-1.5 rounded-full ring-1 ring-background"
                    style={{ backgroundColor: firstAccent }}
                  />
                )}
              </span>
            )}
            <span className="truncate">{label}</span>
          </button>
        }
      />
      <DropdownMenuContent align="start" className="max-h-96 w-64 overflow-y-auto">
        {/* Base UI：DropdownMenuLabel 必须处于 DropdownMenuGroup 内（同 git-view 菜单） */}
        <DropdownMenuGroup>
          <DropdownMenuLabel className="text-muted-foreground text-xs font-normal">
            不使用主题
          </DropdownMenuLabel>
          <DropdownMenuItem onClick={() => pick(null)} className="gap-2.5 py-2">
            <CircleSlash2Icon className="text-muted-foreground size-4 shrink-0" />
            <span className="text-sm font-medium">通用风格</span>
            {/* 只有水合真值确认为「不使用」才打勾；未水合（undefined）不宣称 */}
            {active === null && <CheckIcon className="ml-auto size-4 shrink-0" />}
          </DropdownMenuItem>
        </DropdownMenuGroup>
        {userEntries.length > 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuLabel className="text-muted-foreground text-xs font-normal">
                我的主题
              </DropdownMenuLabel>
              {userEntries.map((e) => (
                <ThemeItem key={`u-${e.id}`} entry={e} selected={isSelected(e)} onPick={pick} />
              ))}
            </DropdownMenuGroup>
          </>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuLabel className="text-muted-foreground text-xs font-normal">
            内置主题包{snap.version ? ` · v${snap.version}` : ""}
            {snap.error && "（装载失败）"}
          </DropdownMenuLabel>
          {builtinEntries.length === 0 && !snap.error && (
            <div className="text-muted-foreground px-2 py-1.5 text-xs">清单尚未就绪</div>
          )}
          {builtinEntries.map((e) => (
            <ThemeItem key={`b-${e.id}`} entry={e} selected={isSelected(e)} onPick={pick} />
          ))}
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={openManager} className="gap-2.5 py-2">
          <SettingsIcon className="text-muted-foreground size-4 shrink-0" />
          <span className="text-sm">管理设计主题…</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

const ThemeItem: FC<{
  entry: { scope: "builtin" | "user"; id: string; name: string; desc: string; accents: string[]; shadowed?: boolean };
  selected: boolean;
  onPick: (ref: ThemeRef) => void;
}> = ({ entry, selected, onPick }) => (
  <DropdownMenuItem
    onClick={() => onPick({ scope: entry.scope, id: entry.id })}
    className="gap-2.5 py-2"
  >
    {/* 代表色板点（最多 4）：主题卡片的微缩预览 */}
    <span className="flex shrink-0 items-center -space-x-1">
      {(entry.accents.length ? entry.accents : ["#94a3b8"]).slice(0, 4).map((c, i) => (
        <span
          key={i}
          className="size-2.5 rounded-full ring-1 ring-background"
          style={{ backgroundColor: c }}
        />
      ))}
    </span>
    <div className="flex min-w-0 flex-col">
      <span className="truncate text-sm font-medium">{entry.name}</span>
      {entry.desc && (
        <span className="text-muted-foreground truncate text-xs">
          {entry.shadowed ? `${entry.desc}（已被我的同名主题覆盖）` : entry.desc}
        </span>
      )}
    </div>
    {selected && <CheckIcon className="ml-auto size-4 shrink-0" />}
  </DropdownMenuItem>
);
