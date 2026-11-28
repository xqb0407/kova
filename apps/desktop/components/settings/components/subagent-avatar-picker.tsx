"use client";

/**
 * 子智能体头像选择器：点头像弹出——内置 Clay 预设网格 + 「随机」生成一张
 * （Clay 全参数空间随机组合，存 data URL）+ 上传本地图片（按钮选文件或直接
 * 拖进来）+ 恢复默认。
 *
 * 选中即回调（与同行的启用开关/模型选择器同款"改即存"），浮层不自动关：
 * 背后那个头像实时换，用户可以连着试几个再点外面收起。
 *
 * 两种触发器外观：
 * - tile（默认）：列表行里的小方块，悬浮右下角冒一个小图标提示"能点"；
 * - profile：编辑器里的圆形头像位——与名称同行同高，悬浮压黑色遮罩 + 居中相机
 *   （个人资料头像的通行做法）。没有空态：未选时显示按名称分配的默认预设。
 *
 * 头像是 kv 覆盖项（见 lib/subagent/subagents.ts setSubagentAvatar），所以内置/
 * 插件这类只读定义同样能换头像；列表行直接落库，编辑器则暂存随保存一起提交。
 */
import * as React from "react";
import type { FC } from "react";
import { CameraIcon, CheckIcon, DicesIcon, ImagePlusIcon, RotateCcwIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { SubagentAvatar } from "@/components/custom-ui/subagent-avatar";
import {
  BUILTIN_AVATAR_PREFIX,
  BUILTIN_SUBAGENT_AVATARS,
  builtinAvatarSrc,
  defaultSubagentAvatar,
  randomSubagentAvatar,
} from "@/lib/subagent/avatar";
import { fileToSubagentAvatarDataUrl } from "@/lib/subagent/avatar-image";

const ACCEPT = "image/png,image/jpeg,image/webp,image/gif,image/svg+xml";

export const SubagentAvatarPicker: FC<{
  name: string;
  /** 当前头像值；空 = 默认图标 */
  avatar?: string;
  /** 新值；空串 = 恢复默认 */
  onChange: (avatar: string) => void;
  /** 触发按钮的尺寸/圆角覆盖（tile 默认由调用方给 size；profile 默认 size-24） */
  className?: string;
  variant?: "tile" | "profile";
}> = ({ name, avatar, onChange, className, variant = "tile" }) => {
  const t = useT();
  const inputRef = React.useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [dragOver, setDragOver] = React.useState(false);

  const importFile = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      onChange(await fileToSubagentAvatarDataUrl(file));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const selectedBuiltin = avatar?.startsWith(BUILTIN_AVATAR_PREFIX)
    ? avatar.slice(BUILTIN_AVATAR_PREFIX.length)
    : null;
  const isCustom = !!avatar && selectedBuiltin === null;
  // 没显式选时实际显示的是按名分配的默认预设：网格里也要把它标出来，
  // 否则用户看到头像位有脸、网格里却没有任何一项被选中，会以为状态坏了
  const defaultId = defaultSubagentAvatar(name).slice(BUILTIN_AVATAR_PREFIX.length);
  const effectiveBuiltin = selectedBuiltin ?? (isCustom ? null : defaultId);

  const trigger =
    variant === "profile" ? (
      <PopoverTrigger
        render={
          <button
            type="button"
            title={t("settings.subagents.avatar.change")}
            aria-label={t("settings.subagents.avatar.changeAria", { name })}
            className={cn(
              // 与输入框同高（h-9）、与名称同一行；整圆裁切——悬浮遮罩盖在圆内
              "group/avatar relative size-9 shrink-0 overflow-hidden rounded-full outline-none",
              "focus-visible:ring-2 focus-visible:ring-primary/60 focus-visible:ring-offset-2",
              className,
            )}
          />
        }
      >
        <SubagentAvatar
          name={name}
          avatar={avatar}
          fallback="plain"
          className="size-full rounded-[inherit]"
          iconClassName="text-muted-foreground/60 size-5"
        />
        {/* 悬浮遮罩 + 居中相机：个人资料头像的通行做法（GitHub/Twitter 同款） */}
        <span className="absolute inset-0 grid place-items-center bg-black/40 opacity-0 transition-opacity group-hover/avatar:opacity-100">
          <CameraIcon className="size-4 text-white" />
        </span>
      </PopoverTrigger>
    ) : (
      <PopoverTrigger
        render={
          <button
            type="button"
            title={t("settings.subagents.avatar.change")}
            aria-label={t("settings.subagents.avatar.changeAria", { name })}
            className={cn(
              "group/avatar relative shrink-0 overflow-hidden rounded-xl outline-none transition-shadow",
              "hover:ring-2 hover:ring-primary/40 focus-visible:ring-2 focus-visible:ring-primary/60",
              className,
            )}
          />
        }
      >
        <SubagentAvatar name={name} avatar={avatar} className="size-full rounded-[inherit]" />
        {/* 悬浮角标：提示"这里能点"——头像本身没有可点击的视觉线索 */}
        <span className="bg-background/90 text-foreground pointer-events-none absolute right-0.5 bottom-0.5 grid size-4 place-items-center rounded-full opacity-0 shadow-sm transition-opacity group-hover/avatar:opacity-100">
          <ImagePlusIcon className="size-2.5" />
        </span>
      </PopoverTrigger>
    );

  return (
    <Popover>
      {trigger}
      <PopoverContent
        align="start"
        sideOffset={6}
        className={cn("w-80 p-3", dragOver && "ring-primary/60 ring-2")}
        onDragOver={(event) => {
          event.preventDefault();
          if (!dragOver) setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragOver(false);
          void importFile(event.dataTransfer.files?.[0]);
        }}
      >
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-sm font-medium">{t("settings.subagents.avatar.label")}</span>
          <span className="text-muted-foreground text-ui leading-5">
            {isCustom
              ? t("settings.subagents.avatar.customImage")
              : selectedBuiltin
                ? t("settings.subagents.avatar.builtinPreset")
                : t("settings.subagents.avatar.defaultAuto")}
          </span>
        </div>

        {/* 内置预设：6 列网格。显式选中实心描边 + 角标；按名默认的那张用淡一档的描边标出 */}
        <div className="mt-2.5 grid grid-cols-6 gap-1.5">
          {BUILTIN_SUBAGENT_AVATARS.map((preset) => {
            const value = `${BUILTIN_AVATAR_PREFIX}${preset.id}`;
            const explicit = selectedBuiltin === preset.id;
            const isDefault = !explicit && effectiveBuiltin === preset.id;
            const presetLabel = t(preset.labelKey ?? preset.label);
            return (
              <button
                key={preset.id}
                type="button"
                title={isDefault
                  ? t("settings.subagents.avatar.defaultBadge", { label: presetLabel })
                  : presetLabel}
                aria-label={presetLabel}
                aria-pressed={explicit || isDefault}
                onClick={() => {
                  setError(null);
                  onChange(value);
                }}
                className={cn(
                  "relative aspect-square overflow-hidden rounded-full outline-none transition-[box-shadow,transform]",
                  "hover:scale-[1.06] focus-visible:ring-2 focus-visible:ring-primary/60",
                  explicit
                    ? "ring-primary ring-2"
                    : isDefault
                      ? "ring-primary/40 ring-2"
                      : "ring-border/60 ring-1",
                )}
              >
                <img
                  src={builtinAvatarSrc(preset.id)!}
                  alt=""
                  draggable={false}
                  loading="lazy"
                  className="size-full object-cover"
                />
                {explicit && (
                  <span className="bg-primary text-primary-foreground absolute right-0 bottom-0 grid size-3.5 place-items-center rounded-full">
                    <CheckIcon className="size-2.5" />
                  </span>
                )}
              </button>
            );
          })}
        </div>

        {/* 上传 / 恢复默认 */}
        <div className="mt-3 flex items-center gap-1.5">
          <input
            ref={inputRef}
            type="file"
            accept={ACCEPT}
            className="hidden"
            onChange={(event) => {
              void importFile(event.target.files?.[0]);
              // 清掉选择：同一文件再选一次也要触发 change
              event.target.value = "";
            }}
          />
          <Button
            variant="outline"
            size="sm"
            className="h-7 gap-1 text-ui leading-5"
            disabled={busy}
            onClick={() => {
              setError(null);
              try {
                onChange(randomSubagentAvatar());
              } catch (err) {
                // randomSubagentAvatar 生成失败理论上到不了（参数全在白名单枚举里），
                // 但兜底校验会 throw——接住给浮层报错，别让事件处理器裸抛
                setError(err instanceof Error ? err.message : String(err));
              }
            }}
          >
            <DicesIcon className="size-3.5" />
            {t("settings.subagents.avatar.random")}
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-7 gap-1 text-ui leading-5"
            disabled={busy}
            onClick={() => inputRef.current?.click()}
          >
            <ImagePlusIcon className="size-3.5" />
            {busy ? t("settings.subagents.avatar.processing") : t("settings.subagents.avatar.upload")}
          </Button>
          {avatar && (
            <Button
              variant="ghost"
              size="sm"
              className="text-muted-foreground h-7 gap-1 text-ui leading-5"
              disabled={busy}
              onClick={() => {
                setError(null);
                onChange("");
              }}
            >
              <RotateCcwIcon className="size-3.5" />
              {t("settings.subagents.avatar.restoreDefault")}
            </Button>
          )}
        </div>
        <p className={cn("mt-2 text-ui leading-5", error ? "text-destructive" : "text-muted-foreground")}>
          {error ?? t("settings.subagents.avatar.dragHint")}
        </p>
      </PopoverContent>
    </Popover>
  );
};
