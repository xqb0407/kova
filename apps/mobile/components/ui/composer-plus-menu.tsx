import { useMemo, useState, type ReactNode } from "react";
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from "react-native";
import {
  ActivityIcon,
  BookOpenIcon,
  BotIcon,
  CameraIcon,
  ChevronLeftIcon,
  ClipboardListIcon,
  ImageIcon,
  ListTodoIcon,
  MessageCircleQuestionIcon,
  SlashIcon,
  TargetIcon,
  ZapIcon,
} from "lucide-react-native";
import { useAuiState } from "@assistant-ui/react-native";
import { Sheet } from "./sheet";
import { radius, space, useTheme, withAlpha } from "./theme";
import {
  agentDirective,
  skillDirective,
  SLASH_COMMANDS,
  type SlashIconName,
} from "./composer-commands";
import { useSkills } from "@/lib/pi/pi-skills";
import { useSubagents } from "@/lib/pi/pi-subagents";
import { piSessionCwdMap, piSessionIdForThread } from "@/lib/pi/pi-thread-adapter";

/**
 * 输入区的「＋」菜单与 @ / 触发菜单（移动端版，对齐桌面端 composer 的
 * ＋ 菜单与 ComposerTriggerPopover）：
 *  - ＋：照片 / 拍照 / 技能 / 子智能体 / 命令 —— 技能与子智能体进二级列表，
 *    点选把 `:skill[...]{...}` / `:agent[...]{...}` 指令文本插到光标处；
 *  - 在输入框里打 `@` 或 `/` 直接唤起对应列表（@ 子智能体、/ 命令 + 技能），
 *    选中后把触发词替换成指令文本。
 *
 * 桌面端的芯片是输入框里的内联胶囊；移动端输入框是原生 TextInput，插入的是
 * 同一份序列化文本，芯片外观由输入框上方的芯片行承担（见 composer.tsx）。
 */

type MenuLeaf =
  | { kind: "action"; id: string; label: string; description?: string; icon: "photo" | "camera" }
  | { kind: "commands"; label: string; description?: string }
  | { kind: "skills"; label: string; description?: string }
  | { kind: "subagents"; label: string; description?: string };

const ROOT_ITEMS: readonly MenuLeaf[] = [
  { kind: "action", id: "photo", label: "照片", description: "从相册选择图片", icon: "photo" },
  { kind: "action", id: "camera", label: "拍照", description: "调用相机拍一张", icon: "camera" },
  { kind: "commands", label: "命令", description: "面板与工作模式（/ 唤起）" },
  { kind: "skills", label: "技能", description: "把技能作为指令附在消息上" },
  { kind: "subagents", label: "子智能体", description: "委派给指定子智能体（@ 唤起）" },
];

const SLASH_ICONS: Record<SlashIconName, typeof ZapIcon> = {
  Activity: ActivityIcon,
  ListTodo: ListTodoIcon,
  ClipboardList: ClipboardListIcon,
  MessageCircleQuestion: MessageCircleQuestionIcon,
  Target: TargetIcon,
  Zap: ZapIcon,
};

export type ComposerPlusMenuProps = {
  onClose: () => void;
  /** 插入指令文本（技能/子智能体；触发菜单还会带上要替换的触发词区间） */
  onInsertDirective: (directive: string, replaceFrom?: number) => void;
  onPickImage: (source: "library" | "camera") => void;
  /** 触发菜单：由输入框的 @ / 决定初始打开哪一页 */
  initialPage?: "root" | "commands" | "skills" | "subagents";
  /** 过滤词（触发词后已输入的内容） */
  query?: string;
  /** 触发词在草稿里的下标：给定时，选中项替换这段触发文本而不是追加 */
  triggerIndex?: number;
};

export function ComposerPlusMenu({
  onClose,
  onInsertDirective,
  onPickImage,
  initialPage = "root",
  query = "",
  triggerIndex,
}: ComposerPlusMenuProps) {
  const threadId = useAuiState((s) => s.threads.mainThreadId);
  const { colors, fontWeight } = useTheme();
  const { height } = useWindowDimensions();
  const maxH = Math.round(height * 0.72);
  const [page, setPage] = useState<"root" | "commands" | "skills" | "subagents">(
    initialPage,
  );
  // 技能/子智能体的 workspace 层按会话 cwd 发现（桌面端同规）：本地线程 id →
  // pi sessionId → cwd 镜像（list_sessions 落下的那张表）
  const sessionId = threadId ? piSessionIdForThread(threadId) : undefined;
  const cwd = sessionId ? piSessionCwdMap.get(sessionId) : undefined;
  const skills = useSkills(cwd);
  const subagents = useSubagents(cwd);

  const needle = query.trim().toLowerCase();
  const filteredSkills = useMemo(
    () =>
      needle
        ? skills.filter(
            (s) =>
              s.name.toLowerCase().includes(needle) ||
              (s.description ?? "").toLowerCase().includes(needle),
          )
        : skills,
    [skills, needle],
  );
  const filteredAgents = useMemo(
    () =>
      needle
        ? subagents.filter(
            (a) =>
              a.name.toLowerCase().includes(needle) ||
              (a.description ?? "").toLowerCase().includes(needle),
          )
        : subagents,
    [subagents, needle],
  );
  const filteredCommands = useMemo(
    () =>
      needle
        ? SLASH_COMMANDS.filter(
            (c) =>
              c.label.toLowerCase().includes(needle) ||
              c.description.toLowerCase().includes(needle),
          )
        : SLASH_COMMANDS,
    [needle],
  );

  const title =
    page === "root"
      ? "添加到消息"
      : page === "commands"
        ? "命令"
        : page === "skills"
          ? "技能"
          : "子智能体";

  return (
    <Sheet
      onClose={onClose}
      travel={maxH + 120}
      showClose
      closeLabel="关闭菜单"
      sheetStyle={{ maxHeight: maxH }}
    >
      <View className="flex-row items-center pb-2.5 pl-4" style={{ gap: space(1) }}>
        {page !== "root" ? (
          <Pressable
            onPress={() => setPage("root")}
            hitSlop={10}
            accessibilityRole="button"
            accessibilityLabel="返回"
            className="active:bg-muted size-7 items-center justify-center rounded-md"
          >
            <ChevronLeftIcon size={16} strokeWidth={2.2} color={colors.mutedForeground} />
          </Pressable>
        ) : (
          <View className="size-7" />
        )}
        <Text
          style={[
            styles.sheetTitle,
            { color: colors.mutedForeground, fontWeight: fontWeight("600") },
          ]}
        >
          {title}
        </Text>
      </View>
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={{
          paddingHorizontal: space(5),
          paddingBottom: space(6),
        }}
        showsVerticalScrollIndicator={false}
      >
        {page === "root"
          ? ROOT_ITEMS.map((item) => (
              <MenuRow
                key={item.kind === "action" ? item.id : item.kind}
                leading={<RootIcon item={item} />}
                label={item.label}
                description={item.description}
                onPress={() => {
                  if (item.kind === "action") {
                    const source = item.icon === "photo" ? "library" : "camera";
                    // 相册/相机是原生模态：菜单（RN Modal）还在场时拉起会被顶掉，
                    // 表现为「点了没反应」。先关抽屉，等退场动画走完再拉起。
                    onClose();
                    setTimeout(() => onPickImage(source), 280);
                    return;
                  }
                  setPage(item.kind);
                }}
              />
            ))
          : null}

        {page === "commands"
          ? filteredCommands.map((cmd) => (
              <MenuRow
                key={cmd.id}
                leading={
                  <Leading
                    icon={SLASH_ICONS[cmd.icon] ?? SlashIcon}
                    color={colors.mutedForeground}
                  />
                }
                label={cmd.label}
                description={cmd.description}
                onPress={() => {
                  cmd.run({ threadId: threadId ?? undefined });
                  onClose();
                }}
              />
            ))
          : null}

        {page === "skills"
          ? filteredSkills.map((skill) => (
              <MenuRow
                key={skill.name}
                leading={<Leading icon={BookOpenIcon} color={colors.mutedForeground} />}
                label={skill.name}
                description={skill.description}
                onPress={() => {
                  onInsertDirective(skillDirective(skill.name), triggerIndex);
                  onClose();
                }}
              />
            ))
          : null}

        {page === "subagents"
          ? filteredAgents.map((agent) => (
              <MenuRow
                key={agent.name}
                leading={<Leading icon={BotIcon} color={colors.mutedForeground} />}
                label={agent.name}
                description={agent.description}
                onPress={() => {
                  onInsertDirective(agentDirective(agent.name), triggerIndex);
                  onClose();
                }}
              />
            ))
          : null}

        {page === "skills" && filteredSkills.length === 0 ? (
          <Text style={[styles.empty, { color: colors.mutedForeground }]}>
            {needle ? "没有匹配的技能" : "还没有技能（在桌面端「设置 → 技能」里添加）"}
          </Text>
        ) : null}
        {page === "subagents" && filteredAgents.length === 0 ? (
          <Text style={[styles.empty, { color: colors.mutedForeground }]}>
            {needle ? "没有匹配的子智能体" : "还没有子智能体（在桌面端「设置 → 子智能体」里添加）"}
          </Text>
        ) : null}
        {page === "commands" && filteredCommands.length === 0 ? (
          <Text style={[styles.empty, { color: colors.mutedForeground }]}>
            没有匹配的命令
          </Text>
        ) : null}
      </ScrollView>
    </Sheet>
  );
}

function RootIcon({ item }: { item: MenuLeaf }) {
  const { colors } = useTheme();
  if (item.kind === "action") {
    return <Leading icon={item.icon === "photo" ? ImageIcon : CameraIcon} color={colors.mutedForeground} />;
  }
  if (item.kind === "commands") return <Leading icon={SlashIcon} color={colors.mutedForeground} />;
  if (item.kind === "skills") return <Leading icon={BookOpenIcon} color={colors.mutedForeground} />;
  return <Leading icon={BotIcon} color={colors.mutedForeground} />;
}

function Leading({
  icon: Icon,
  color,
}: {
  icon: typeof ZapIcon;
  color: string;
}) {
  return (
    <View style={styles.leading}>
      <Icon size={17} strokeWidth={2} color={color} />
    </View>
  );
}

function MenuRow({
  leading,
  label,
  description,
  onPress,
}: {
  leading: ReactNode;
  label: string;
  description?: string;
  onPress: () => void;
}) {
  const { colors, fontWeight } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={({ pressed }) => [
        styles.row,
        pressed && { backgroundColor: withAlpha(colors.foreground, 0.05) },
      ]}
    >
      {leading}
      <View style={styles.rowBody}>
        <Text
          style={[
            styles.rowTitle,
            { color: colors.foreground, fontWeight: fontWeight("500") },
          ]}
        >
          {label}
        </Text>
        {description ? (
          <Text numberOfLines={2} style={[styles.rowDesc, { color: colors.mutedForeground }]}>
            {description}
          </Text>
        ) : null}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  scroll: { flexShrink: 1 },
  sheetTitle: { fontSize: 13, letterSpacing: 0.4 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingVertical: 10,
    paddingHorizontal: 6,
    borderRadius: radius.md,
  },
  leading: { width: 24, alignItems: "center" },
  rowBody: { flex: 1, minWidth: 0, gap: 1 },
  rowTitle: { fontSize: 15, lineHeight: 20 },
  rowDesc: { fontSize: 12.5, lineHeight: 17 },
  empty: { fontSize: 13, paddingVertical: 12 },
});
