"use client";

/**
 * 七种结果行。每个都 memo 过，props 只有 `index / active / hit / query`
 * 与两个稳定回调——键盘上下移动时只有"变高亮"的那两行重渲染，其余跳过。
 * 行内不做数据加工（时间/项目名等在格式化层算好），保持渲染函数廉价。
 */
import { memo, type FC } from "react";
import {
  ChevronRightIcon,
  HistoryIcon,
  SparklesIcon,
  UserIcon,
  WrenchIcon,
} from "lucide-react";
import type {
  PiSearchArtifactHit,
  PiSearchMessageHit,
  PiSearchSessionHit,
} from "@/lib/pi/pi-bridge";
import { FileTypeIcon } from "@/components/agent-thread/agent-panel/file-type-icon";
import { APP_MODE_META } from "@/lib/pi/app-mode-meta";
import { useSessionAppMode } from "@/lib/pi/pi-session-app-mode";
import { formatRelativeTime, projectNameOf } from "@/lib/search/search-format";
import { LIBRARY_OWNER_KEY, type ActionCommand } from "@/lib/search/search-models";
import {
  ArchivedBadge,
  Highlight,
  iconClassName,
  RowSlot,
  rowClassName,
  type RowProps,
} from "./search-primitives";

const onMouseDown = (event: React.MouseEvent) => event.preventDefault();

/** 会话行首档位图标（与侧栏行首同源 APP_MODE_META）。hook 收在行级组件里，
 *  偏好镜像到达只重渲染该行。 */
const SessionModeIcon: FC<{ sessionId: string; active: boolean }> = ({
  sessionId,
  active,
}) => {
  const appMode = useSessionAppMode(sessionId);
  const ModeIcon = APP_MODE_META[appMode].icon;
  return (
    <ModeIcon
      aria-label={`工作模式：${APP_MODE_META[appMode].label}`}
      className={iconClassName(active)}
    />
  );
};

export const SessionRow = memo(function SessionRow({
  index,
  active,
  hit,
  query,
  onActivate,
  onOpen,
}: RowProps & { hit: PiSearchSessionHit; query: string }) {
  const title = hit.title || hit.firstMessage || "新对话";
  return (
    <button
      type="button"
      data-hit-index={index}
      role="option"
      aria-selected={active}
      onMouseDown={onMouseDown}
      onMouseMove={() => onActivate(index)}
      onClick={() => onOpen(index)}
      className={rowClassName(active)}
    >
      <SessionModeIcon sessionId={hit.sessionId} active={active} />
      <span className="min-w-0 flex-1 truncate">
        {query ? <Highlight text={title} query={query} /> : title}
      </span>
      {hit.archived ? <ArchivedBadge /> : null}
      <RowSlot
        time={formatRelativeTime(hit.updatedAt)}
        meta={projectNameOf(hit.cwd)}
        active={active}
      />
    </button>
  );
});

/** 消息行：按角色换图标（用户 / 工具 / agent 回复） */
export const MessageRow = memo(function MessageRow({
  index,
  active,
  hit,
  query,
  onActivate,
  onOpen,
}: RowProps & { hit: PiSearchMessageHit; query: string }) {
  const Icon =
    hit.role === "user"
      ? UserIcon
      : hit.role === "tool"
        ? WrenchIcon
        : SparklesIcon;
  return (
    <button
      type="button"
      data-hit-index={index}
      role="option"
      aria-selected={active}
      onMouseDown={onMouseDown}
      onMouseMove={() => onActivate(index)}
      onClick={() => onOpen(index)}
      className={rowClassName(active)}
    >
      <Icon className={iconClassName(active)} />
      <span className="min-w-0 flex-1 truncate">
        <Highlight text={hit.preview} query={query} />
      </span>
      {hit.archived ? <ArchivedBadge /> : null}
      <RowSlot
        time={formatRelativeTime(hit.updatedAt)}
        meta={hit.title || projectNameOf(hit.cwd)}
        active={active}
      />
    </button>
  );
});

/** 产物 / 资料库文件行：彩色文件类型图标，副行给相对路径 */
export const ArtifactRow = memo(function ArtifactRow({
  index,
  active,
  hit,
  query = "",
  onActivate,
  onOpen,
}: RowProps & { hit: PiSearchArtifactHit; query?: string }) {
  const isLibrary = hit.sessionId === LIBRARY_OWNER_KEY;
  return (
    <button
      type="button"
      data-hit-index={index}
      role="option"
      aria-selected={active}
      onMouseDown={onMouseDown}
      onMouseMove={() => onActivate(index)}
      onClick={() => onOpen(index)}
      className={rowClassName(active)}
    >
      <FileTypeIcon path={hit.rel} className="size-4 shrink-0" />
      <span className="min-w-0 flex-1 truncate">
        {query ? <Highlight text={hit.name} query={query} /> : hit.name}
        <span className="ms-2 text-xs text-muted-foreground/70">{hit.rel}</span>
      </span>
      <RowSlot
        time={null}
        meta={isLibrary ? "资料库" : hit.title || "任务产物"}
        active={active}
      />
    </button>
  );
});

export const ProjectFileRow = memo(function ProjectFileRow({
  index,
  active,
  hit,
  onActivate,
  onOpen,
}: RowProps & { hit: { rel: string; name: string } }) {
  return (
    <button
      type="button"
      data-hit-index={index}
      role="option"
      aria-selected={active}
      onMouseDown={onMouseDown}
      onMouseMove={() => onActivate(index)}
      onClick={() => onOpen(index)}
      className={rowClassName(active)}
    >
      <FileTypeIcon path={hit.rel} className="size-4 shrink-0" />
      <span className="min-w-0 flex-1 truncate">{hit.name}</span>
      <RowSlot time={null} meta={hit.rel} active={active} />
    </button>
  );
});

export const ProjectContentRow = memo(function ProjectContentRow({
  index,
  active,
  hit,
  query,
  onActivate,
  onOpen,
}: RowProps & {
  hit: { rel: string; name: string; line: number; preview: string };
  query: string;
}) {
  return (
    <button
      type="button"
      data-hit-index={index}
      role="option"
      aria-selected={active}
      onMouseDown={onMouseDown}
      onMouseMove={() => onActivate(index)}
      onClick={() => onOpen(index)}
      className={rowClassName(active)}
    >
      <FileTypeIcon path={hit.rel} className="size-4 shrink-0" />
      <span className="min-w-0 flex-1 truncate">
        <Highlight text={hit.preview} query={query} />
      </span>
      <span className="shrink-0 font-mono text-xs text-muted-foreground">
        {hit.rel}:{hit.line}
      </span>
    </button>
  );
});

export const HistoryRow = memo(function HistoryRow({
  index,
  active,
  query,
  onActivate,
  onOpen,
}: RowProps & { query: string }) {
  return (
    <button
      type="button"
      data-hit-index={index}
      role="option"
      aria-selected={active}
      onMouseDown={onMouseDown}
      onMouseMove={() => onActivate(index)}
      onClick={() => onOpen(index)}
      className={rowClassName(active, true)}
    >
      <HistoryIcon className={iconClassName(active)} />
      <span className="min-w-0 flex-1 truncate">{query}</span>
      <ChevronRightIcon className="size-3 shrink-0 text-muted-foreground/60" />
    </button>
  );
});

export const ActionRow = memo(function ActionRow({
  index,
  active,
  command,
  onActivate,
  onOpen,
}: RowProps & { command: ActionCommand }) {
  const Icon = command.icon;
  return (
    <button
      type="button"
      data-hit-index={index}
      role="option"
      aria-selected={active}
      onMouseDown={onMouseDown}
      onMouseMove={() => onActivate(index)}
      onClick={() => onOpen(index)}
      className={rowClassName(active)}
    >
      <Icon className={iconClassName(active)} />
      <span className="min-w-0 flex-1 truncate">{command.label}</span>
      <span className="shrink-0 text-xs text-muted-foreground">
        {command.hint}
      </span>
    </button>
  );
});
