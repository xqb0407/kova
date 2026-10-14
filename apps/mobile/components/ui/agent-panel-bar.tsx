import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useAuiState } from "@assistant-ui/react-native";
import {
  ActivityIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  FileCodeIcon,
  FileTextIcon,
  GitBranchIcon,
  GlobeIcon,
  ListTodoIcon,
  LoaderCircleIcon,
  RefreshCwIcon,
  SquareTerminalIcon,
  XIcon,
} from "lucide-react-native";
import { MarkdownText } from "@/components/assistant-ui/elements/markdown-text";
import { Sheet } from "./sheet";
import { monoStyle } from "@/components/assistant-ui/elements/surfaces";
import { FileTypeIcon } from "./file-type-icon";
import { useTheme, withAlpha } from "./theme";
import { useAgentPanelOpen, closeAgentPanel, openAgentPanel } from "@/lib/panels/agent-panel-sheet";
import {
  formatBytes,
  threadArtifacts,
  type MessageArtifact,
} from "@/lib/panels/artifacts";
import {
  usePanelActivity,
  type CitationEntry,
  type FileChangeGroup,
  type TerminalEntry,
} from "@/lib/panels/panel-activity";
import { asDiffLines, DiffView, UnifiedDiffView } from "./diff-view";
import {
  fetchGitDiff,
  refreshGitStatus,
  useGitStatus,
  type GitFileStatus,
} from "@/lib/pi/pi-git";
import { piSessionIdForThread } from "@/lib/pi/pi-thread-adapter";
import {
  fetchTodoState,
  useThreadTodos,
  type TodoSnapshot,
  type TodoTask,
} from "@/lib/pi/pi-todo";

/**
 * 面板入口（桌面端右侧 agent-panel 的移动端对应物）：
 * 桌面端把一轮轮的 agent 工作汇总在右侧面板的「活动」标签里（计划 / 文件变更 /
 * 终端流水 / 引用资料），手机没有侧栏，收敛成输入条上方的一枚药丸 + 一层底部
 * pop——药丸给一眼可见的进度（有清单时显示计划进度与当前任务，否则显示活动
 * 计数），pop 里按节陈列全部内容。
 *
 * 数据源与桌面同构：计划走 pi-todo store，文件/终端/引用全部从消息流的
 * tool-call parts 派生（lib/panels/panel-activity，与桌面端同一份实现），
 * 实时流与历史重建同形，无 sidecar 改动。
 */

const visibleTasks = (snap: TodoSnapshot): TodoTask[] =>
  snap.tasks.filter((t) => t.status !== "deleted");

export function AgentPanelBar() {
  const threadId = useAuiState((s) => s.threads.mainThreadId);
  const snap = useThreadTodos(threadId ?? undefined);
  const activity = usePanelActivity();
  // 开关放模块 store：药丸是一路入口，`/activity`、`/plan-panel` 指令是另一路
  const open = useAgentPanelOpen();
  const { colors, space, fontWeight } = useTheme();

  // 切线程/冷读时水合（失败静默：没有清单就只有活动计数）
  useEffect(() => {
    if (threadId) fetchTodoState(threadId);
  }, [threadId]);

  const tasks = useMemo(() => visibleTasks(snap), [snap]);
  const done = tasks.filter((t) => t.status === "completed").length;
  const current = tasks.find((t) => t.status === "in_progress");
  const fileCount = activity.files.length;
  const terminalCount = activity.terminal.length;
  const citationCount = activity.citations.length;
  const hasPlan = tasks.length > 0;
  const hasActivity = fileCount + terminalCount + citationCount > 0;
  if (!hasPlan && !hasActivity) return null;

  const summary = [
    hasPlan ? `计划 ${done}/${tasks.length}` : null,
    fileCount > 0 ? `${fileCount} 文件` : null,
    terminalCount > 0 ? `${terminalCount} 命令` : null,
    citationCount > 0 ? `${citationCount} 引用` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  // 有清单时药丸仍然优先给计划（当前任务一句话），没有清单才退成活动计数
  const currentLabel = current
    ? current.activeForm || current.subject
    : hasPlan
      ? "已全部完成"
      : summary;

  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${hasPlan ? `计划 ${done}/${tasks.length}，${currentLabel}` : "活动"}，展开查看`}
        onPress={openAgentPanel}
        style={({ pressed }) => [
          styles.pill,
          {
            backgroundColor: colors.card,
            borderColor: colors.border,
            paddingHorizontal: space(3),
            paddingVertical: space(1.5),
          },
          pressed && { opacity: 0.7 },
        ]}
      >
        {hasPlan ? (
          <ListTodoIcon size={14} strokeWidth={2} color={colors.mutedForeground} />
        ) : (
          <ActivityIcon size={14} strokeWidth={2} color={colors.mutedForeground} />
        )}
        <Text
          style={[
            styles.pillTitle,
            { color: colors.foreground, fontWeight: fontWeight("600") },
          ]}
        >
          {hasPlan ? "计划" : "活动"}
        </Text>
        {hasPlan ? (
          <Text
            style={[
              styles.pillProgress,
              { color: colors.mutedForeground, fontWeight: fontWeight("500") },
            ]}
          >
            {done}/{tasks.length}
          </Text>
        ) : null}
        <Text
          numberOfLines={1}
          style={[styles.pillCurrent, { color: colors.mutedForeground }]}
        >
          {currentLabel}
        </Text>
        <ChevronUpIcon
          size={14}
          strokeWidth={2.2}
          color={colors.mutedForegroundFaint}
        />
      </Pressable>

      {open ? (
        <PanelSheet
          summary={summary}
          tasks={tasks}
          done={done}
          files={activity.files}
          terminal={activity.terminal}
          citations={activity.citations}
          onClose={closeAgentPanel}
        />
      ) : null}
    </>
  );
}

/**
 * 底部抽屉：桌面端「活动」标签的移动端版（计划 / 文件变更 / 终端 / 引用），
 * 有内容的节才出现。用 Modal 承载，脱离药丸所在输入条的坐标空间铺满整屏。
 */
function PanelSheet({
  summary,
  tasks,
  done,
  files,
  terminal,
  citations,
  onClose,
}: {
  summary: string;
  tasks: TodoTask[];
  done: number;
  files: FileChangeGroup[];
  terminal: TerminalEntry[];
  citations: CitationEntry[];
  onClose: () => void;
}) {
  const { colors, space, fontWeight } = useTheme();
  const { height } = useWindowDimensions();
  const maxH = Math.round(height * 0.88);
  // 产物 = write 产出的交付文件（白名单），与桌面端「产物」标签同一份派生
  const artifacts = useMemo(() => threadArtifacts(files), [files]);

  return (
    // Modal 承载：药丸长在输入条里，抽屉必须脱离它的坐标空间才能贴着屏幕底
    // 铺满整屏（否则面板以输入条容器为参照，顶到屏幕外）
    <Modal transparent visible animationType="none" onRequestClose={onClose}>
      <Sheet
        onClose={onClose}
        travel={maxH + 120}
        showClose
        closeLabel="关闭面板"
        sheetStyle={{ maxHeight: maxH }}
      >
      <View className="flex-row items-baseline justify-between pb-2.5 pl-5">
        <Text
          style={[
            styles.sheetTitle,
            { color: colors.mutedForeground, fontWeight: fontWeight("600") },
          ]}
        >
          面板
        </Text>
        {summary ? (
          <Text
            numberOfLines={1}
            className="text-muted-foreground max-w-[60%] pr-14 text-[12px] opacity-70"
          >
            {summary}
          </Text>
        ) : null}
      </View>
      <ScrollView
        // flexShrink：面板是 maxHeight 约束而非定高，不收缩的话内容会顶出
        // 抽屉边界（RN 的 flexShrink 默认 0，长面板表现为"溢出屏幕"）
        style={styles.sheetScroll}
        contentContainerStyle={{
          paddingHorizontal: space(5),
          paddingBottom: space(6),
          gap: space(5),
        }}
        showsVerticalScrollIndicator={false}
      >
        {tasks.length > 0 ? (
          <Section
            icon={<ListTodoIcon size={15} strokeWidth={2} color={colors.mutedForeground} />}
            title="计划"
            meta={`${done}/${tasks.length}`}
          >
            <PlanSection tasks={tasks} />
          </Section>
        ) : null}
        {artifacts.length > 0 ? (
          <Section
            icon={<FileTextIcon size={15} strokeWidth={2} color={colors.mutedForeground} />}
            title="产物"
            meta={`${artifacts.length} 个交付文件`}
          >
            <ArtifactsSection artifacts={artifacts} files={files} />
          </Section>
        ) : null}
        <GitSection />
        {files.length > 0 ? (
          <Section
            icon={<FileCodeIcon size={15} strokeWidth={2} color={colors.mutedForeground} />}
            title="文件变更"
            meta={`${files.length} 个文件`}
          >
            <FilesSection files={files} />
          </Section>
        ) : null}
        {terminal.length > 0 ? (
          <Section
            icon={
              <SquareTerminalIcon size={15} strokeWidth={2} color={colors.mutedForeground} />
            }
            title="终端"
            meta={`${terminal.length} 条命令`}
          >
            <TerminalSection entries={terminal} />
          </Section>
        ) : null}
        {citations.length > 0 ? (
          <Section
            icon={<GlobeIcon size={15} strokeWidth={2} color={colors.mutedForeground} />}
            title="引用"
            meta={`${citations.length} 条`}
          >
            <CitationsSection items={citations} />
          </Section>
        ) : null}
      </ScrollView>
      </Sheet>
    </Modal>
  );
}


/**
 * Git 变更（只读）：会话工作目录的仓库状态与单文件 diff，数据来自 sidecar 的
 * git_status / git_diff（远程端没有 Tauri 本地 git，故由 sidecar 代跑只读命令）。
 * 桌面端对应的是「审查」标签（真 git diff）；这里给同一件事的移动端读法。
 */
function GitSection() {
  const { colors, space, fontWeight, radius } = useTheme();
  const threadId = useAuiState((s) => s.threads.mainThreadId);
  const sessionId = threadId ? piSessionIdForThread(threadId) : undefined;
  const status = useGitStatus(sessionId);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [diff, setDiffResult] = useState<{
    path: string;
    text: string;
    untracked: boolean;
    truncated: boolean;
    loading: boolean;
  } | null>(null);

  if (!sessionId) return null;

  const openDiff = (file: GitFileStatus) => {
    if (expanded === file.path) {
      setExpanded(null);
      setDiffResult(null);
      return;
    }
    setExpanded(file.path);
    setDiffResult({ path: file.path, text: "", untracked: file.untracked, truncated: false, loading: true });
    void fetchGitDiff(sessionId, file.path).then((res) => {
      setDiffResult(
        res
          ? { path: file.path, text: res.diff, untracked: res.untracked, truncated: res.truncated, loading: false }
          : { path: file.path, text: "", untracked: false, truncated: false, loading: false },
      );
    });
  };

  // 不是仓库 / 读取失败：整节不出现（面板不因 git 缺失而多一块空壳）
  if (!status.loading && !status.repo) return null;

  return (
    <Section
      icon={<GitBranchIcon size={15} strokeWidth={2} color={colors.mutedForeground} />}
      title="Git 变更"
      meta={
        status.loading && status.files.length === 0
          ? "读取中…"
          : `${status.branch ?? "HEAD"} · ${status.files.length} 个文件${status.truncated ? "（截断）" : ""}`
      }
      action={
        <Pressable
          onPress={() => void refreshGitStatus(sessionId)}
          hitSlop={10}
          accessibilityRole="button"
          accessibilityLabel="刷新 Git 状态"
          className="active:bg-muted size-6 items-center justify-center rounded-md"
        >
          {status.loading ? (
            <ActivityIndicator size="small" />
          ) : (
            <RefreshCwIcon size={13} strokeWidth={2.2} color={colors.mutedForeground} />
          )}
        </Pressable>
      }
    >
      {status.error ? (
        <Text style={[styles.empty, { color: colors.destructive }]}>{status.error}</Text>
      ) : null}
      {status.files.length === 0 && !status.loading ? (
        <Text style={[styles.empty, { color: colors.mutedForeground }]}>
          工作区干净，没有未提交的改动
        </Text>
      ) : null}
      {status.files.map((file) => {
        const isOpen = expanded === file.path;
        const norm = file.path.replace(/\\/g, "/");
        const base = norm.slice(norm.lastIndexOf("/") + 1);
        const dir = norm.slice(0, Math.max(0, norm.length - base.length - 1));
        return (
          <View key={file.path}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`${base}，${isOpen ? "收起" : "展开"} diff`}
              onPress={() => openDiff(file)}
              style={({ pressed }) => [
                styles.fileRow,
                { paddingVertical: space(2.5) },
                pressed && { opacity: 0.7 },
              ]}
            >
              <FileTypeIcon path={file.path} size={18} />
              <View
                style={[
                  styles.gitBadge,
                  {
                    borderColor: colors.border,
                    borderRadius: radius.sm,
                    backgroundColor: withAlpha(colors.foreground, 0.04),
                  },
                ]}
              >
                <Text
                  style={[
                    styles.gitBadgeText,
                    {
                      color:
                        file.status === "A"
                          ? colors.success
                          : file.status === "D"
                            ? colors.destructive
                            : colors.mutedForeground,
                    },
                  ]}
                >
                  {file.status}
                </Text>
              </View>
              <View className="min-w-0 flex-1">
                <Text
                  numberOfLines={1}
                  style={[
                    styles.fileName,
                    { color: colors.foreground, fontWeight: fontWeight("500") },
                  ]}
                >
                  {base}
                </Text>
                {dir ? (
                  <Text
                    numberOfLines={1}
                    style={[styles.fileDir, { color: colors.mutedForegroundFaint }]}
                  >
                    {dir}
                  </Text>
                ) : null}
              </View>
              <View style={styles.fileStats}>
                {file.added > 0 ? (
                  <Text style={[styles.fileStat, { color: colors.success }]}>
                    +{file.added}
                  </Text>
                ) : null}
                {file.removed > 0 ? (
                  <Text style={[styles.fileStat, { color: colors.destructive }]}>
                    −{file.removed}
                  </Text>
                ) : null}
                <ChevronDownIcon
                  size={14}
                  strokeWidth={2.2}
                  color={colors.mutedForegroundFaint}
                  className={isOpen ? undefined : "-rotate-90"}
                />
              </View>
            </Pressable>
            {isOpen && diff && diff.path === file.path ? (
              <View
                style={[
                  styles.entryBox,
                  {
                    backgroundColor: colors.muted,
                    borderRadius: radius.md,
                    marginBottom: space(2),
                  },
                ]}
              >
                {diff.loading ? (
                  <ActivityIndicator size="small" />
                ) : file.untracked && !diff.text ? (
                  <Text style={[styles.empty, { color: colors.mutedForeground }]}>
                    未跟踪文件（内容过大或为空）
                  </Text>
                ) : diff.untracked ? (
                  // 未跟踪：整文件新增（git diff 看不见它，sidecar 回的是正文）
                  <DiffView lines={asDiffLines(null, diff.text)} />
                ) : (
                  <UnifiedDiffView text={diff.text} />
                )}
                {diff.truncated ? (
                  <Text style={[styles.empty, { color: colors.mutedForegroundFaint }]}>
                    差异过大，已截断
                  </Text>
                ) : null}
              </View>
            ) : null}
          </View>
        );
      })}
    </Section>
  );
}

/** 一节：小标题（图标 + 名称 + 计数）+ 内容 */
function Section({
  icon,
  title,
  meta,
  action,
  children,
}: {
  icon: ReactNode;
  title: string;
  meta?: string;
  /** 标题行右侧的动作位（如「刷新 Git 状态」） */
  action?: ReactNode;
  children: ReactNode;
}) {
  const { colors, space, fontWeight } = useTheme();
  return (
    <View style={{ gap: space(2) }}>
      <View style={styles.sectionHead}>
        {icon}
        <Text
          style={[
            styles.sectionTitle,
            { color: colors.foreground, fontWeight: fontWeight("600") },
          ]}
        >
          {title}
        </Text>
        {meta ? (
          <Text style={[styles.sectionMeta, { color: colors.mutedForeground }]}>
            {meta}
          </Text>
        ) : null}
        <View className="flex-1" />
        {action ?? null}
      </View>
      {children}
    </View>
  );
}

/** 计划：in_progress 显示现在进行时（activeForm），completed 划线置灰，
 *  blockedBy 里仍未完成的前置标 `⛓ #id`（同桌面 PlanSection 口径）。 */
function PlanSection({ tasks }: { tasks: TodoTask[] }) {
  const { colors, space, fontWeight, radius } = useTheme();
  const openIds = useMemo(
    () => new Set(tasks.filter((t) => t.status !== "completed").map((t) => t.id)),
    [tasks],
  );
  return (
    <View>
      {tasks.map((task) => {
        const completed = task.status === "completed";
        const title =
          task.status === "in_progress" && task.activeForm
            ? task.activeForm
            : task.subject;
        const blockers = (task.blockedBy ?? []).filter(
          (id) => id !== task.id && openIds.has(id),
        );
        return (
          <View
            key={task.id}
            style={[styles.taskRow, { paddingVertical: space(2.5) }]}
          >
            <TaskStatusIcon status={task.status} />
            <View style={styles.taskBody}>
              <Text
                style={[
                  styles.taskTitle,
                  {
                    color: completed ? colors.mutedForeground : colors.foreground,
                    fontWeight: fontWeight(
                      task.status === "in_progress" ? "600" : "400",
                    ),
                  },
                  completed && styles.taskDone,
                ]}
              >
                {title}
              </Text>
              {blockers.length > 0 ? (
                <Text style={[styles.taskDetail, { color: colors.mutedForeground }]}>
                  {`⛓ ${blockers.map((id) => `#${id}`).join(",")}`}
                </Text>
              ) : null}
            </View>
            <Text
              style={[
                styles.taskId,
                {
                  color: colors.mutedForegroundFaint,
                  borderRadius: radius.sm,
                  paddingHorizontal: space(1.5),
                },
              ]}
            >
              {`#${task.id}`}
            </Text>
          </View>
        );
      })}
    </View>
  );
}

/**
 * 产物：write 产出的交付文件（html/md/csv… 白名单，同桌面端「产物」标签）。
 * 点开是全屏内容查看器——手机上就是"文件预览"：内容取自 write 的 args
 * （会话内快照，非磁盘实时读取），桌面端网页/远程模式同样没有本地文件读取。
 */
function ArtifactsSection({
  artifacts,
  files,
}: {
  artifacts: MessageArtifact[];
  files: FileChangeGroup[];
}) {
  const { colors, space, fontWeight } = useTheme();
  const [opened, setOpened] = useState<MessageArtifact | null>(null);

  return (
    <View>
      {artifacts.map((artifact) => {
        const norm = artifact.path.replace(/\\/g, "/");
        const dir = norm.slice(0, Math.max(0, norm.length - artifact.base.length - 1));
        return (
          <Pressable
            key={artifact.toolCallId}
            accessibilityRole="button"
            accessibilityLabel={`预览 ${artifact.base}`}
            onPress={() => setOpened(artifact)}
            style={({ pressed }) => [
              styles.fileRow,
              { paddingVertical: space(2.5) },
              pressed && { opacity: 0.7 },
            ]}
          >
            <FileTypeIcon path={artifact.path} size={18} />
            <View className="min-w-0 flex-1">
              <Text
                numberOfLines={1}
                style={[
                  styles.fileName,
                  { color: colors.foreground, fontWeight: fontWeight("500") },
                ]}
              >
                {artifact.base}
              </Text>
              {dir ? (
                <Text
                  numberOfLines={1}
                  style={[styles.fileDir, { color: colors.mutedForegroundFaint }]}
                >
                  {dir}
                </Text>
              ) : null}
            </View>
            <Text style={[styles.fileStat, { color: colors.mutedForeground }]}>
              {formatBytes(artifact.size)}
            </Text>
            <ChevronUpIcon
              size={14}
              strokeWidth={2.2}
              color={colors.mutedForegroundFaint}
              className="rotate-90"
            />
          </Pressable>
        );
      })}
      {opened ? (
        <ArtifactViewer
          artifact={opened}
          content={contentOfArtifact(opened, files)}
          onClose={() => setOpened(null)}
        />
      ) : null}
    </View>
  );
}

/** 产物内容：取该 toolCallId 那次 write 的全文（最新一次 write 即当前版本） */
function contentOfArtifact(
  artifact: MessageArtifact,
  files: FileChangeGroup[],
): string {
  for (const group of files) {
    for (const entry of group.entries) {
      if (entry.toolCallId === artifact.toolCallId) return entry.newText;
    }
  }
  return "";
}

/** Markdown 家族（可预览）：与桌面端「文件」标签的预览口径一致 */
const MARKDOWN_EXT = new Set(["md", "markdown", "mdx"]);
const isMarkdownArtifact = (artifact: MessageArtifact): boolean => {
  const base = artifact.base.toLowerCase();
  const dot = base.lastIndexOf(".");
  return dot > 0 && MARKDOWN_EXT.has(base.slice(dot + 1));
};

const MAX_VIEW_LINES = 2000;
const MAX_VIEW_CHARS = 400_000;

/** 全屏内容查看器：等宽 + 双向滚动（长行不折），超出上限截断并提示 */
function ArtifactViewer({
  artifact,
  content,
  onClose,
}: {
  artifact: MessageArtifact;
  content: string;
  onClose: () => void;
}) {
  const { colors, space, fontWeight } = useTheme();
  const insets = useSafeAreaInsets();
  // Markdown 家族给「预览 / 源码」双态（桌面端「文件」标签同规：预览走消息区
  // 同一份 MarkdownText，源码给等宽原文）；其余类型只有源码一态
  const [mode, setMode] = useState<"preview" | "source">(
    isMarkdownArtifact(artifact) ? "preview" : "source",
  );
  const lines = content.split("\n");
  const lineCapped = lines.length > MAX_VIEW_LINES;
  const charCapped = content.length > MAX_VIEW_CHARS;
  const text = charCapped
    ? content.slice(0, MAX_VIEW_CHARS)
    : lineCapped
      ? lines.slice(0, MAX_VIEW_LINES).join("\n")
      : content;

  return (
    <Modal transparent visible animationType="fade" onRequestClose={onClose}>
      {/* 全屏预览（不是浮层卡片）：文件预览就该占满屏，只给头部让出状态栏高度，
          底部让出手势条；左右不留边距，长文件才有最大可视面积 */}
      <View className="bg-background flex-1">
        <View style={{ height: insets.top, backgroundColor: colors.background }} />
        <View
          className="border-border/50 flex-row items-center justify-between border-b py-1 pr-1 pl-4"
          style={{ gap: 8 }}
        >
            <View className="min-w-0 flex-1 flex-row items-baseline" style={{ gap: 8 }}>
              <Text
                numberOfLines={1}
                style={[
                  styles.fileName,
                  { color: colors.foreground, fontWeight: fontWeight("600") },
                ]}
              >
                {artifact.base}
              </Text>
              <Text
                numberOfLines={1}
                className="text-muted-foreground min-w-0 flex-1 text-[11px] opacity-70"
              >
                {`${formatBytes(artifact.size)} · 会话内快照`}
              </Text>
            </View>
            {isMarkdownArtifact(artifact) ? (
              <Pressable
                onPress={() =>
                  setMode((m) => (m === "preview" ? "source" : "preview"))
                }
                className="active:bg-muted flex-row items-center rounded-full px-2.5 py-1"
                accessibilityRole="button"
                accessibilityLabel={mode === "preview" ? "看源码" : "看预览"}
              >
                {mode === "preview" ? (
                  <FileCodeIcon size={14} strokeWidth={2.2} color={colors.mutedForeground} />
                ) : (
                  <FileTextIcon size={14} strokeWidth={2.2} color={colors.mutedForeground} />
                )}
                <Text className="text-muted-foreground text-[12px]">
                  {mode === "preview" ? "源码" : "预览"}
                </Text>
              </Pressable>
            ) : null}
            <Pressable
              onPress={onClose}
              className="active:bg-muted size-8 items-center justify-center rounded-md"
              accessibilityRole="button"
              accessibilityLabel="关闭预览"
            >
              <XIcon size={16} strokeWidth={2.2} color={colors.foreground} />
            </Pressable>
          </View>
          {mode === "preview" ? (
            <ScrollView
              style={{ flex: 1 }}
              contentContainerStyle={{ padding: space(3) }}
            >
              {/* 会话内快照文本直接按消息区同款渲染（自带代码块/表格样式） */}
              <MarkdownText
                type="text"
                text={text}
                status={{ type: "complete" } as never}
              />
            </ScrollView>
        ) : (
          <ScrollView
            style={{ flex: 1 }}
            contentContainerStyle={{ padding: space(3) }}
          >
            <ScrollView horizontal showsHorizontalScrollIndicator={false}>
              <Text
                style={[
                  styles.diffLine,
                  { color: colors.foreground, fontSize: 12, lineHeight: 17 },
                ]}
              >
                {text}
              </Text>
            </ScrollView>
            {lineCapped || charCapped ? (
              <Text
                style={[
                  styles.diffLine,
                  { color: colors.mutedForegroundFaint, marginTop: space(2) },
                ]}
              >
                {`…内容过大，仅显示前 ${charCapped ? `${MAX_VIEW_CHARS} 字符` : `${MAX_VIEW_LINES} 行`}`}
              </Text>
            ) : null}
          </ScrollView>
        )}
        <View style={{ height: insets.bottom, backgroundColor: colors.background }} />
      </View>
    </Modal>
  );
}

/** 文件变更：按文件聚合，点开看逐次 edit/write 的行级 diff（同桌面 FilesSection） */
function FilesSection({ files }: { files: FileChangeGroup[] }) {
  const { colors, space, fontWeight, radius } = useTheme();
  const [expanded, setExpanded] = useState<string | null>(null);

  return (
    <View>
      {files.map((group) => {
        const isOpen = expanded === group.path;
        const base = group.path.split("/").pop() ?? group.path;
        const dir = group.path.slice(0, Math.max(0, group.path.length - base.length - 1));
        return (
          <View key={group.path}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`${base}，${isOpen ? "收起" : "展开"}变更`}
              onPress={() => setExpanded(isOpen ? null : group.path)}
              style={({ pressed }) => [
                styles.fileRow,
                { paddingVertical: space(2.5) },
                pressed && { opacity: 0.7 },
              ]}
            >
              <FileTypeIcon path={group.path} size={18} />
              <View className="min-w-0 flex-1">
                <Text
                  numberOfLines={1}
                  style={[
                    styles.fileName,
                    { color: colors.foreground, fontWeight: fontWeight("500") },
                  ]}
                >
                  {base}
                </Text>
                {dir ? (
                  <Text
                    numberOfLines={1}
                    style={[styles.fileDir, { color: colors.mutedForegroundFaint }]}
                  >
                    {dir}
                  </Text>
                ) : null}
              </View>
              <View style={styles.fileStats}>
                {group.added > 0 ? (
                  <Text style={[styles.fileStat, { color: colors.success }]}>
                    +{group.added}
                  </Text>
                ) : null}
                {group.removed > 0 ? (
                  <Text style={[styles.fileStat, { color: colors.destructive }]}>
                    −{group.removed}
                  </Text>
                ) : null}
                {group.running ? (
                  <ActivityIndicator size="small" />
                ) : (
                  <ChevronDownIcon
                    size={14}
                    strokeWidth={2.2}
                    color={colors.mutedForegroundFaint}
                    className={isOpen ? undefined : "-rotate-90"}
                  />
                )}
              </View>
            </Pressable>
            {isOpen
              ? group.entries.map((entry) => (
                  <View
                    key={entry.toolCallId}
                    style={[
                      styles.entryBox,
                      {
                        backgroundColor: colors.muted,
                        borderRadius: radius.md,
                        marginBottom: space(2),
                      },
                    ]}
                  >
                    <Text
                      style={[
                        styles.entryMeta,
                        { color: colors.mutedForeground, fontWeight: fontWeight("500") },
                      ]}
                    >
                      {`${entry.op === "write" ? "写入" : "编辑"} · +${entry.added} −${entry.removed}${
                        entry.running ? " · 运行中" : entry.failed ? " · 失败" : ""
                      }`}
                    </Text>
                    {entry.failed && entry.output ? (
                      <Text
                        style={[styles.diffLine, { color: colors.destructive }]}
                      >
                        {entry.output.split("\n").slice(0, 20).join("\n")}
                      </Text>
                    ) : (
                      <DiffView
                        lines={asDiffLines(
                          entry.op === "edit" ? entry.oldText : null,
                          entry.newText,
                        )}
                      />
                    )}
                  </View>
                ))
              : null}
          </View>
        );
      })}
    </View>
  );
}

/** 终端：bash 命令流水，点开看输出（同桌面 TerminalSection） */
function TerminalSection({ entries }: { entries: TerminalEntry[] }) {
  const { colors, space, fontWeight, radius } = useTheme();
  const [expanded, setExpanded] = useState<string | null>(null);

  return (
    <View>
      {entries.map((entry) => {
        const isOpen = expanded === entry.toolCallId;
        return (
          <View key={entry.toolCallId}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`命令，${isOpen ? "收起" : "展开"}输出`}
              onPress={() => setExpanded(isOpen ? null : entry.toolCallId)}
              style={({ pressed }) => [
                styles.termRow,
                { paddingVertical: space(2.5) },
                pressed && { opacity: 0.7 },
              ]}
            >
              {entry.running ? (
                <LoaderCircleIcon
                  size={14}
                  strokeWidth={2.2}
                  color={colors.mutedForeground}
                />
              ) : entry.failed ? (
                <View style={styles.failedDot} />
              ) : (
                <CheckIcon size={14} strokeWidth={2.4} color={colors.success} />
              )}
              <Text
                numberOfLines={2}
                style={[
                  styles.termCommand,
                  { color: colors.foreground, fontWeight: fontWeight("500") },
                ]}
              >
                {`$ ${entry.command}`}
              </Text>
              {entry.output ? (
                <ChevronDownIcon
                  size={14}
                  strokeWidth={2.2}
                  color={colors.mutedForegroundFaint}
                  className={isOpen ? undefined : "-rotate-90"}
                />
              ) : null}
            </Pressable>
            {isOpen && entry.output ? (
              <ScrollView
                nestedScrollEnabled
                style={{
                  maxHeight: 240,
                  backgroundColor: colors.muted,
                  borderRadius: radius.md,
                  marginBottom: space(2),
                }}
                contentContainerStyle={{ padding: space(3) }}
              >
                <Text
                  style={[
                    styles.diffLine,
                    {
                      color: entry.failed
                        ? colors.destructive
                        : colors.mutedForeground,
                    },
                  ]}
                >
                  {entry.output}
                </Text>
              </ScrollView>
            ) : null}
          </View>
        );
      })}
    </View>
  );
}

/** 引用：WebSearch 结果解析出的资料条目（按 url 全线程去重，同桌面口径） */
function CitationsSection({ items }: { items: CitationEntry[] }) {
  const { colors, space } = useTheme();
  return (
    <View>
      {items.map((item, i) => (
        <View
          key={`${item.toolCallId}-${i}`}
          style={[styles.citeRow, { paddingVertical: space(2.5) }]}
        >
          <Text
            numberOfLines={2}
            style={[styles.citeTitle, { color: colors.foreground }]}
          >
            {item.title}
          </Text>
          {item.url ? (
            <Text
              numberOfLines={1}
              style={[styles.citeUrl, { color: colors.mutedForeground }]}
            >
              {item.url}
            </Text>
          ) : null}
          {item.snippet ? (
            <Text
              numberOfLines={3}
              style={[styles.citeSnippet, { color: colors.mutedForeground }]}
            >
              {item.snippet}
            </Text>
          ) : null}
        </View>
      ))}
    </View>
  );
}

function TaskStatusIcon({ status }: { status: TodoTask["status"] }) {
  const { colors } = useTheme();
  if (status === "completed") {
    return <CheckIcon size={16} strokeWidth={2.4} color={colors.success} />;
  }
  if (status === "in_progress") {
    return (
      <LoaderCircleIcon size={15} strokeWidth={2.2} color={colors.foreground} />
    );
  }
  // pending：空心圆点（占位同宽，保证标题左缘对齐）
  return (
    <View style={styles.statusSlot}>
      <View
        style={[styles.pendingDot, { borderColor: colors.mutedForegroundFaint }]}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  sheetScroll: { flexShrink: 1 },
  pill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
    alignSelf: "flex-start",
    maxWidth: "100%",
  },
  pillTitle: { fontSize: 13 },
  pillProgress: { fontSize: 12, fontVariant: ["tabular-nums"] },
  pillCurrent: { flexShrink: 1, fontSize: 12.5 },
  sheetTitle: { fontSize: 13, letterSpacing: 0.4 },
  sectionHead: { flexDirection: "row", alignItems: "center", gap: 6 },
  sectionTitle: { fontSize: 14 },
  sectionMeta: { fontSize: 12, opacity: 0.7 },
  taskRow: { flexDirection: "row", alignItems: "flex-start", gap: 10 },
  statusSlot: {
    width: 16,
    height: 20,
    alignItems: "center",
    justifyContent: "center",
  },
  pendingDot: { width: 12, height: 12, borderRadius: 6, borderWidth: 1.5 },
  taskBody: { flex: 1, minWidth: 0, gap: 2 },
  taskTitle: { fontSize: 15, lineHeight: 20 },
  taskDone: { textDecorationLine: "line-through" },
  taskDetail: { fontSize: 12.5, lineHeight: 17 },
  taskId: { fontSize: 11, paddingTop: 2, fontVariant: ["tabular-nums"] },
  fileRow: { flexDirection: "row", alignItems: "center", gap: 10 },
  gitBadge: {
    width: 20,
    height: 20,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: "center",
    justifyContent: "center",
  },
  gitBadgeText: { fontSize: 11, lineHeight: 14, ...monoStyle },
  fileName: { fontSize: 14.5, lineHeight: 19 },
  fileDir: { fontSize: 11.5, lineHeight: 15 },
  fileStats: { flexDirection: "row", alignItems: "center", gap: 6 },
  fileStat: { fontSize: 12, fontVariant: ["tabular-nums"] },
  entryBox: { padding: 10 },
  entryMeta: { fontSize: 11.5, marginBottom: 6 },
  diffLine: { fontSize: 11.5, lineHeight: 16, ...monoStyle },
  termRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  termCommand: { flex: 1, minWidth: 0, fontSize: 12.5, ...monoStyle },
  failedDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: "#e5484d",
  },
  empty: { fontSize: 12.5, lineHeight: 17, paddingVertical: 4 },
  citeRow: { gap: 2 },
  citeTitle: { fontSize: 14, lineHeight: 19 },
  citeUrl: { fontSize: 11.5 },
  citeSnippet: { fontSize: 12.5, lineHeight: 17 },
});
