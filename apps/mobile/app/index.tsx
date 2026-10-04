import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Alert,
  Animated,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
// 列表必须用 gesture-handler 这份，不能用 RN 核心的 FlatList。行里挂了
// GestureDetector 的横向 Pan 手势，而 RN 核心的 ScrollView 不认识 RNGH 的手势，
// 两边的原生识别器各判各的：手指按在行中间时，滑动会被行的手势先按住，纵向
// 滚动起不来（只剩行与行之间的缝隙能滚，看起来就是「只有边边能滚」）。
// RNGH 的 FlatList 内部包了一层 NativeViewGestureHandler，纵横两边这才在同一套
// 仲裁里比优先级：纵向超过阈值就把横向手势判负，滚动照常。
// web 端这份只是转发 RN 的原版，行为不变。
import { FlatList } from "react-native-gesture-handler";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { useFocusEffect, useRouter } from "expo-router";
import { useAui, useAuiState } from "@assistant-ui/react-native";
import {
  ArchiveIcon,
  ChevronDownIcon,
  FolderIcon,
  MessageSquareIcon,
  MessagesSquareIcon,
  PencilIcon,
  PinIcon,
  PinOffIcon,
  PlusIcon,
  TrashIcon,
} from "lucide-react-native";
import * as Haptics from "expo-haptics";

import { HomeHeader } from "@/components/ui/home-header";
import { ContextMenu } from "@/components/ui/context-menu";
import { OptionSheet } from "@/components/ui/option-sheet";
import { RenameDialog } from "@/components/ui/rename-dialog";
import { SettingsSheet } from "@/components/ui/settings-sheet";
import { SwipeableRow } from "@/components/ui/swipeable-row";
import { useTheme, withAlpha } from "@/components/ui/theme";
import { NATIVE } from "@/components/ui/motion";
import {
  pathBasename,
  setWorkspace,
  useWorkspace,
} from "@/lib/workspace/workspace-store";
import { togglePinned, usePinnedThreadIds } from "@/lib/mobile/pinned-threads";

/**
 * 首页 = 会话列表。
 *
 * 列表自己读 `threads.threadItems` 而不是复用官方 ThreadList 组件：官方那个把
 * 数据源写死在 ThreadListPrimitive.Items 内部（整个 threadIds 直接喂 FlatList），
 * 没有过滤口子，搜索框就没法把结果收窄。数据同源、同一个 store，只是渲染握在
 * 自己手里。
 *
 * 行布局照「任务列表」那种形态：圆形图标 + 标题 + 副标题（工作目录）+ 右侧时间，
 * 新对话收进右下角的悬浮按钮，不再占列表里的一行。
 *
 * 顶部那个「任务 / 项目」是**同一批会话的两种排布**，不是两份数据：
 * - 任务：按最后一条消息排的平铺列表，跟桌面端侧边栏的默认形态一致；
 * - 项目：按会话自己的工作目录（sidecar list_sessions 带回来的 cwd，落在列表项
 *   的 custom.workspacePath 上）分组，一个目录一段；段头点按可展开/折叠该段
 *   的会话行，没有工作目录的会话不进这个视图。
 * 目录是会话自己的属性、且每个会话都可能不同，所以项目视图只分组、不提供
 * "切到这个项目"——真要改工作目录得走聊天页的胶囊，点标题就换目录会让用户
 * 以为换掉了其实只换了排布。
 *
 * 删除沿用官方列表的语义：长按 + 二次确认（delete_thread 会连桌面端的 .jsonl
 * 一起删，不可逆）。
 */

/** 列表的两种排布。值直接当 OptionSheet 的 value 用 */
type ListView = "tasks" | "projects";

export default function HomeScreen() {
  const s = useStyles();
  const router = useRouter();
  const aui = useAui();
  const insets = useSafeAreaInsets();

  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [view, setView] = useState<ListView>("tasks");
  const [viewSheetOpen, setViewSheetOpen] = useState(false);
  // 左滑开着的行（同一时刻最多一行）与重命名目标
  const [openRowId, setOpenRowId] = useState<string | null>(null);
  // 项目分组的折叠状态：集合里存「已折叠」的目录路径，不在集合里 = 展开。
  // 缺席即展开，新出现的项目也自然落在展开态，不用跟着数据初始化
  const [collapsedProjects, setCollapsedProjects] = useState<Set<string>>(
    () => new Set(),
  );
  const [renameTarget, setRenameTarget] = useState<{
    id: string;
    title: string;
  } | null>(null);
  // 长按弹出的上下文菜单：带上触点在屏幕上的位置，菜单贴着手指长出来
  const [menuAnchor, setMenuAnchor] = useState<{
    id: string;
    title: string;
    x: number;
    y: number;
  } | null>(null);

  const items = useAuiState((st) => st.threads.threadItems);
  const mainThreadId = useAuiState((st) => st.threads.mainThreadId);
  const workspace = useWorkspace();
  const pinnedIds = usePinnedThreadIds();

  // 每次获得焦点都重拉会话清单：threadItems 是 runtime 启动时 list() 一次的快照，
  // 没人推新——聊天页首发消息才绑定的新会话、智能标题、桌面端增删的会话，全靠
  // 返回首页这一下追上。不省「首焦跳过」那次：聊天页返回走 router.replace("/")，
  // 本屏可能整棵重挂，实例 ref 会把重挂后的首焦误判成冷启动而漏刷；冷启动多的
  // 这一轮 list_sessions 是几 KB 的小帧，换正确性划算。
  useFocusEffect(
    useCallback(() => {
      void aui.threads.reload().catch(() => {});
    }, [aui]),
  );

  type ThreadItem = (typeof items)[number];
  type HomeRow =
    | { kind: "thread"; key: string; item: ThreadItem }
    | {
        kind: "project";
        key: string;
        name: string;
        path: string;
        count: number;
      };

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const sorted = [...items].sort((a, b) => {
      // 置顶最前（用户显式钉的，压过一切），其次正在跑的，再按时间
      const aPin = pinnedIds.includes(a.id) ? 1 : 0;
      const bPin = pinnedIds.includes(b.id) ? 1 : 0;
      if (aPin !== bPin) return bPin - aPin;
      const aRun = a.isRunning ? 1 : 0;
      const bRun = b.isRunning ? 1 : 0;
      if (aRun !== bRun) return bRun - aRun;
      return (b.lastMessageAt?.getTime() ?? 0) - (a.lastMessageAt?.getTime() ?? 0);
    });
    if (!q) return sorted;
    return sorted.filter((item) => (item.title ?? "").toLowerCase().includes(q));
  }, [items, query, pinnedIds]);

  const rows = useMemo<HomeRow[]>(() => {
    if (view === "tasks") {
      return visible.map((item) => ({ kind: "thread", key: item.id, item }));
    }

    // 项目视图：按会话自己的 cwd 归堆，没有工作目录的会话不出现——项目视图
    // 只看项目，没归到项目的会话留在任务视图里。分组顺序和组内顺序都跟着
    // 「最近活动」走——切到项目视图想知道的是哪个项目最近在动，不是按目录名
    // 排字母。
    const groups = new Map<string, { list: ThreadItem[] }>();
    for (const item of visible) {
      const raw = item.custom?.workspacePath;
      if (typeof raw !== "string" || raw.length === 0) continue;
      const bucket = groups.get(raw);
      if (bucket) bucket.list.push(item);
      else groups.set(raw, { list: [item] });
    }

    const newest = (list: ThreadItem[]) =>
      list.reduce((max, item) => Math.max(max, item.lastMessageAt?.getTime() ?? 0), 0);
    const sections = [...groups.entries()].sort(
      (a, b) => newest(b[1].list) - newest(a[1].list),
    );

    const out: HomeRow[] = [];
    for (const [path, bucket] of sections) {
      out.push({
        kind: "project",
        key: `p:${path}`,
        name: pathBasename(path),
        path,
        count: bucket.list.length,
      });
      // 折叠的组只留段头，组内会话行不进列表
      if (collapsedProjects.has(path)) continue;
      for (const item of bucket.list) {
        out.push({ kind: "thread", key: item.id, item });
      }
    }
    return out;
  }, [view, visible, collapsedProjects]);

  const toggleProject = useCallback((path: string) => {
    setCollapsedProjects((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  const openThread = (id: string) => {
    aui.threads.switchToThread(id);
    router.push("/chat");
  };

  const startNew = () => {
    aui.threads.switchToNewThread();
    router.push("/chat");
  };

  /** 在指定工作区开新对话：落工作区 → 切到新线程 → 进聊天页。
   *  会话 cwd 由运行时在首次发送时取 getWorkspace()（见 pi-client-base），
   *  所以这里只要把工作区设对即可。 */
  const startNewInWorkspace = (dir: string) => {
    setWorkspace(dir);
    aui.threads.switchToNewThread();
    router.push("/chat");
  };

  const closeSearch = () => {
    setSearching(false);
    setQuery("");
  };

  const confirmDelete = (id: string, title?: string) => {
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
    if (Platform.OS === "web") {
      // RN Web 上 Alert.alert 只落到 console，网页端没有对话框
      const ok =
        typeof window !== "undefined"
          ? window.confirm(
              `删除「${title?.trim() || "未命名对话"}」？\n转录文件会一并删除，无法恢复。`,
            )
          : false;
      if (ok) void aui.threads.item({ id }).delete();
      return;
    }
    Alert.alert(
      "删除这个对话？",
      "转录文件会一并删除，无法恢复。桌面端的这个对话也会消失。",
      [
        { text: "取消", style: "cancel" },
        {
          text: "删除",
          style: "destructive",
          onPress: () => void aui.threads.item({ id }).delete(),
        },
      ],
    );
  };

  return (
    // 首页不用 AppBackground：磨砂底的光晕是给聊天页那种沉浸内容当"壁纸"的，
    // 列表页是大片留白的阅读界面，色晕透上来只会把白底染脏，反而抢内容的注意力。
    <View style={[s.root, { backgroundColor: s.background }]}>
      <SafeAreaView style={s.root} edges={["top", "left", "right"]}>
        <HomeHeader
          searching={searching}
          query={query}
          onQueryChange={setQuery}
          onOpenSearch={() => setSearching(true)}
          onCloseSearch={closeSearch}
          onOpenSettings={() => setSettingsOpen(true)}
        />

        <FlatList
          data={rows}
          keyExtractor={(row) => row.key}
          contentContainerStyle={[
            s.listContent,
            { paddingBottom: insets.bottom + 96 },
          ]}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
          ItemSeparatorComponent={RowSeparator}
          ListHeaderComponent={
            <ListViewSwitcher
              label={view === "tasks" ? "任务" : "项目"}
              open={viewSheetOpen}
              onPress={() => setViewSheetOpen(true)}
            />
          }
          ListEmptyComponent={
            <View style={s.empty}>
              <MessagesSquareIcon size={26} strokeWidth={1.6} color={s.mutedFaint} />
              <Text style={s.emptyText}>
                {query.trim()
                  ? "没有匹配的对话"
                  : view === "tasks"
                    ? "还没有对话"
                    : "还没有项目"}
              </Text>
            </View>
          }
          renderItem={({ item: row }) =>
            // 项目视图下这一段自己的目录就是副标题，跟任务视图复用同一个
            // workspace 变量会把所有行都标成同一个目录，等于没分组
            row.kind === "project" ? (
              <ProjectHeader
                name={row.name}
                path={row.path}
                count={row.count}
                open={!collapsedProjects.has(row.path)}
                onToggle={() => toggleProject(row.path)}
                // 工作区此前只是只读分组（段头只能折叠）。「＋」把它变成入口：
                // 先落工作区再开新对话，首次发送时 runtime 用 getWorkspace()
                // 作为会话 cwd（与桌面端 WorkspacePill 同一条链）
                onNewThread={() => startNewInWorkspace(row.path)}
              />
            ) : (
              <SwipeableRow
                open={openRowId === row.item.id}
                onOpenChange={(next) =>
                  setOpenRowId(next ? row.item.id : null)
                }
                actionWidth={ROW_ACTION_WIDTH}
                actions={
                  <RowActions
                    pinned={pinnedIds.includes(row.item.id)}
                    onPin={() => {
                      togglePinned(row.item.id);
                      void Haptics.impactAsync(
                        Haptics.ImpactFeedbackStyle.Light,
                      );
                      setOpenRowId(null);
                    }}
                    onArchive={() => {
                      void aui.threads.item({ id: row.item.id }).archive();
                      void Haptics.impactAsync(
                        Haptics.ImpactFeedbackStyle.Medium,
                      );
                      setOpenRowId(null);
                    }}
                    onRename={() => {
                      setRenameTarget({
                        id: row.item.id,
                        title: row.item.title ?? "",
                      });
                      setOpenRowId(null);
                    }}
                  />
                }
              >
                <ThreadRow
                  title={row.item.title}
                  subtitle={
                    view === "projects"
                      ? undefined
                      : workspace
                        ? pathBasename(workspace)
                        : undefined
                  }
                  time={formatWhen(row.item.lastMessageAt)}
                  running={row.item.isRunning}
                  pinned={pinnedIds.includes(row.item.id)}
                  onPress={() => openThread(row.item.id)}
                  onLongPress={(x, y) =>
                    setMenuAnchor({
                      id: row.item.id,
                      title: row.item.title ?? "",
                      x,
                      y,
                    })
                  }
                />
              </SwipeableRow>
            )
          }
        />

        {/* 悬浮的新对话按钮：列表里不再单占一行 */}
        <FloatingButton
          label="新对话"
          bottom={insets.bottom + 24}
          background={s.primary}
          foreground={s.primaryForeground}
          onPress={startNew}
        >
          <PlusIcon size={24} strokeWidth={2.4} color={s.primaryForeground} />
        </FloatingButton>
      </SafeAreaView>

      {viewSheetOpen ? (
        <OptionSheet
          title="列表视图"
          value={view}
          onSelect={(next) => setView(next as ListView)}
          onClose={() => setViewSheetOpen(false)}
          items={[
            {
              value: "tasks",
              label: "任务",
              detail: "按最后一条消息排的会话",
              icon: (
                <MessagesSquareIcon size={17} strokeWidth={1.8} color={s.muted} />
              ),
            },
            {
              value: "projects",
              label: "项目",
              detail: "按工作目录归类",
              icon: <FolderIcon size={17} strokeWidth={1.8} color={s.muted} />,
            },
          ]}
        />
      ) : null}

      {settingsOpen ? <SettingsSheet onClose={() => setSettingsOpen(false)} /> : null}

      {renameTarget ? (
        <RenameDialog
          initialTitle={renameTarget.title}
          onCancel={() => setRenameTarget(null)}
          onSubmit={(next) => {
            aui.threads.item({ id: renameTarget.id }).rename(next);
            setRenameTarget(null);
          }}
        />
      ) : null}

      {/* 长按菜单：左滑那三个动作的完整版（多了删除），两处共用同样的动作语义。
          row 从 anchor 里取，所以菜单项是在渲染时按当前行现算的，不存快照。 */}
      <ContextMenu
        anchor={menuAnchor}
        onClose={() => setMenuAnchor(null)}
        items={
          menuAnchor
            ? [
                {
                  label: pinnedIds.includes(menuAnchor.id) ? "取消置顶" : "置顶",
                  icon: pinnedIds.includes(menuAnchor.id) ? (
                    <PinOffIcon size={18} strokeWidth={1.8} color={s.foreground} />
                  ) : (
                    <PinIcon size={18} strokeWidth={1.8} color={s.foreground} />
                  ),
                  onPress: () => togglePinned(menuAnchor.id),
                },
                {
                  label: "归档",
                  icon: <ArchiveIcon size={18} strokeWidth={1.8} color={s.foreground} />,
                  onPress: () => void aui.threads.item({ id: menuAnchor.id }).archive(),
                },
                {
                  label: "重命名",
                  icon: <PencilIcon size={18} strokeWidth={1.8} color={s.foreground} />,
                  onPress: () =>
                    setRenameTarget({
                      id: menuAnchor.id,
                      title: menuAnchor.title,
                    }),
                },
                {
                  label: "删除",
                  icon: <TrashIcon size={18} strokeWidth={1.8} color={s.destructive} />,
                  destructive: true,
                  onPress: () => confirmDelete(menuAnchor.id, menuAnchor.title),
                },
              ]
            : []
        }
      />
    </View>
  );
}

/** 顶部那个「任务 / 项目」标题：点一下弹抽屉选另一种排布。
 *  箭头跟着抽屉的开合转半圈——不然它只是个装饰，看不出这是个能点的开关 */
function ListViewSwitcher({
  label,
  open,
  onPress,
}: {
  label: string;
  open: boolean;
  onPress: () => void;
}) {
  const s = useStyles();
  const spin = useRef(new Animated.Value(open ? 1 : 0)).current;

  useEffect(() => {
    Animated.spring(spin, {
      toValue: open ? 1 : 0,
      damping: 20,
      stiffness: 260,
      mass: 0.7,
      useNativeDriver: NATIVE,
    }).start();
  }, [open, spin]);

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`列表视图，当前${label}`}
      accessibilityHint="点击切换"
      onPress={onPress}
      // 负 margin 把标题这块的内边距吃回去：可点区域要含标题上下留白，
      // 但视觉上标题仍然贴着下面第一行
      style={s.switcher}
    >
      <Text style={s.switcherText}>{label}</Text>
      <Animated.View
        style={{
          transform: [
            { rotate: spin.interpolate({ inputRange: [0, 1], outputRange: ["0deg", "180deg"] }) },
          ],
        }}
      >
        <ChevronDownIcon size={17} strokeWidth={2.2} color={s.muted} />
      </Animated.View>
    </Pressable>
  );
}

/** 项目视图里的一段标题：目录名 + 会话数 + 完整路径（路径才是区分同名项目的关键）。
 *  整行可点，展开/折叠该组的会话行；折叠时组内行不渲染，段头保留计数 */
function ProjectHeader({
  name,
  path,
  count,
  open,
  onToggle,
  onNewThread,
}: {
  name: string;
  path: string;
  count: number;
  open: boolean;
  onToggle: () => void;
  /** 在该工作区开新对话（段头右侧「＋」） */
  onNewThread: () => void;
}) {
  const s = useStyles();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={name}
      accessibilityHint={open ? "点击折叠" : "点击展开"}
      aria-expanded={open}
      onPress={onToggle}
      style={s.projectHeader}
    >
      <View style={[s.projectIcon, { backgroundColor: s.iconBg }]}>
        <FolderIcon size={15} strokeWidth={1.8} color={s.muted} />
      </View>
      <View style={s.projectBody}>
        <View style={s.projectTitleRow}>
          <Text numberOfLines={1} style={s.projectName}>
            {name}
          </Text>
          <Text style={s.projectCount}>{count}</Text>
        </View>
        <Text numberOfLines={1} style={s.projectPath}>
          {path}
        </Text>
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`在 ${name} 新建对话`}
        hitSlop={10}
        onPress={(event) => {
          // 段头整体是折叠开关，这一枚必须吞掉冒泡——否则新对话和折叠一起发生
          event.stopPropagation?.();
          onNewThread();
        }}
        style={({ pressed }) => [s.projectNew, pressed && { opacity: 0.6 }]}
      >
        <PlusIcon size={16} strokeWidth={2.2} color={s.muted} />
      </Pressable>
      <ProjectChevron open={open} />
    </Pressable>
  );
}

/** 段头右侧的开合指示：展开朝下、折叠朝右，弹簧旋转（顶部视图切换器同款动效） */
function ProjectChevron({ open }: { open: boolean }) {
  const s = useStyles();
  const spin = useRef(new Animated.Value(open ? 1 : 0)).current;

  useEffect(() => {
    Animated.spring(spin, {
      toValue: open ? 1 : 0,
      damping: 20,
      stiffness: 260,
      mass: 0.7,
      useNativeDriver: NATIVE,
    }).start();
  }, [open, spin]);

  return (
    <Animated.View
      style={{
        transform: [
          {
            rotate: spin.interpolate({
              inputRange: [0, 1],
              outputRange: ["-90deg", "0deg"],
            }),
          },
        ],
      }}
    >
      <ChevronDownIcon size={15} strokeWidth={2.2} color={s.muted} />
    </Animated.View>
  );
}

/** 圆形浮动按钮。缩放而不是只变淡：FAB 是这个页面上唯一的主动作，
 *  按下去要能看出「按到了」 */
function FloatingButton({
  label,
  bottom,
  background,
  foreground,
  onPress,
  children,
}: {
  label: string;
  bottom: number;
  background: string;
  foreground: string;
  onPress: () => void;
  children: React.ReactNode;
}) {
  const s = useStyles();
  const { space } = useTheme();
  const press = useRef(new Animated.Value(0)).current;

  return (
    <Animated.View
      style={{
        position: "absolute",
        right: space(5),
        bottom,
        transform: [{ scale: press.interpolate({ inputRange: [0, 1], outputRange: [1, 0.9] }) }],
      }}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={label}
        onPress={onPress}
        onPressIn={() =>
          Animated.spring(press, {
            toValue: 1,
            damping: 18,
            stiffness: 420,
            mass: 0.5,
            useNativeDriver: NATIVE,
          }).start()
        }
        onPressOut={() =>
          Animated.spring(press, {
            toValue: 0,
            damping: 14,
            stiffness: 240,
            mass: 0.7,
            useNativeDriver: NATIVE,
          }).start()
        }
        style={[s.fab, { backgroundColor: background }]}
      >
        {children}
      </Pressable>
    </Animated.View>
  );
}

function RowSeparator({
  leadingItem,
  trailingItem,
}: {
  leadingItem?: { kind?: string };
  trailingItem?: { kind?: string };
}) {
  const s = useStyles();
  // 项目标题自带上边距和分组留白，它前后都不要再插线：标题下面那条线会把
  // 标题和它自己的组切开，看着像标题属于上一个项目
  if (leadingItem?.kind === "project" || trailingItem?.kind === "project") return null;
  return <View style={[s.separator, { backgroundColor: s.border }]} />;
}

/** 左滑露出的动作区宽度：三枚 60 宽的动作块 + 两道 8 的缝 + 右缘 10 的留白。
 *  这个数同时是最大滑出距离，改小按钮就必须一起改——否则内容层会滑过头，
 *  在动作区左边空出一块。 */
const ROW_ACTION_WIDTH = 60 * 3 + 8 * 2 + 10;

/** 行动作区：置顶 / 归档 / 重命名。
 *
 *  三块各住各的圆角里、彼此留缝，不再是一条顶满行高的实心色带：色带那版滑开
 *  时整行右半被切成三块纯色，比标题还重，看着像界面被划开了一道；分开之后
 *  它们读起来是「三个按钮浮在行上」，和站点里其它玻璃件一个语气。
 *
 *  底色仍用 iOS 动作色的固定值而不是主题令牌——动作按钮只在滑开的一瞬间可见，
 *  跟系统邮件/提醒保持一致的辨识度比跟主题一致更重要；深色模式下也不会因为
 *  primary 变浅底而糊掉白字。 */
function RowActions({
  pinned,
  onPin,
  onArchive,
  onRename,
}: {
  pinned: boolean;
  onPin: () => void;
  onArchive: () => void;
  onRename: () => void;
}) {
  const s = useStyles();
  return (
    <View style={s.actionRow}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={pinned ? "取消置顶" : "置顶"}
        onPress={onPin}
        style={({ pressed }) => [s.actionBtn, { backgroundColor: "#D97706" }, pressed && s.actionPressed]}
      >
        {pinned ? (
          <PinOffIcon size={17} strokeWidth={1.9} color="#fff" />
        ) : (
          <PinIcon size={17} strokeWidth={1.9} color="#fff" />
        )}
        <Text style={s.actionText}>{pinned ? "取消" : "置顶"}</Text>
      </Pressable>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="归档"
        onPress={onArchive}
        style={({ pressed }) => [s.actionBtn, { backgroundColor: "#3B82F6" }, pressed && s.actionPressed]}
      >
        <ArchiveIcon size={17} strokeWidth={1.9} color="#fff" />
        <Text style={s.actionText}>归档</Text>
      </Pressable>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="重命名"
        onPress={onRename}
        style={({ pressed }) => [s.actionBtn, { backgroundColor: "#8E8E93" }, pressed && s.actionPressed]}
      >
        <PencilIcon size={17} strokeWidth={1.9} color="#fff" />
        <Text style={s.actionText}>重命名</Text>
      </Pressable>
    </View>
  );
}

function ThreadRow({
  title,
  subtitle,
  time,
  running,
  pinned,
  onPress,
  onLongPress,
}: {
  title?: string | undefined;
  subtitle?: string | undefined;
  time?: string | undefined;
  running: boolean;
  pinned: boolean;
  onPress: () => void;
  /** 长按给出触点坐标：菜单要贴着手指长出来，位置只有这一层知道 */
  onLongPress: (x: number, y: number) => void;
}) {
  const s = useStyles();
  // 按下时整行轻轻缩一点再回弹。列表行是全 app 点得最多的东西，
  // 只换背景色的话按下去几乎没有反馈，手感发木
  const press = useRef(new Animated.Value(0)).current;
  const to = (v: number, stiffness: number) =>
    Animated.spring(press, {
      toValue: v,
      damping: 20,
      stiffness,
      mass: 0.6,
      useNativeDriver: NATIVE,
    }).start();

  return (
    <Animated.View
      style={{
        transform: [
          { scale: press.interpolate({ inputRange: [0, 1], outputRange: [1, 0.975] }) },
        ],
      }}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={title?.trim() || "未命名对话"}
        accessibilityHint="长按显示更多操作"
        onPress={onPress}
        onLongPress={(e) =>
          onLongPress(e.nativeEvent.pageX, e.nativeEvent.pageY)
        }
        onPressIn={() => to(1, 400)}
        onPressOut={() => to(0, 260)}
        delayLongPress={350}
        style={s.row}
      >
        <View style={[s.rowIcon, { backgroundColor: s.iconBg }]}>
          {running ? (
            <View style={s.rowIconRun} />
          ) : pinned ? (
            <PinIcon size={17} strokeWidth={1.9} color={s.muted} />
          ) : (
            <MessageSquareIcon size={18} strokeWidth={1.7} color={s.muted} />
          )}
        </View>
        <View style={s.rowBody}>
          <Text numberOfLines={1} style={s.rowTitle}>
            {title?.trim() || "未命名对话"}
          </Text>
          {subtitle ? (
            <View style={s.rowSub}>
              <FolderIcon size={11} strokeWidth={2} color={s.muted} />
              <Text numberOfLines={1} style={s.rowSubText}>
                {subtitle}
              </Text>
            </View>
          ) : null}
        </View>
        {time ? <Text style={s.rowTime}>{time}</Text> : null}
      </Pressable>
    </Animated.View>
  );
}

/** 列表右侧的时间：今天的只给时分，更早的带日期；没有时间戳就不显示 */
function formatWhen(at?: Date | undefined): string | undefined {
  if (!at) return undefined;
  const now = new Date();
  const sameDay =
    at.getFullYear() === now.getFullYear() &&
    at.getMonth() === now.getMonth() &&
    at.getDate() === now.getDate();
  const hm = `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;
  if (sameDay) return hm;

  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  const isYesterday =
    at.getFullYear() === yesterday.getFullYear() &&
    at.getMonth() === yesterday.getMonth() &&
    at.getDate() === yesterday.getDate();
  if (isYesterday) return `昨天 ${hm}`;

  const sameYear = at.getFullYear() === now.getFullYear();
  const md = `${at.getMonth() + 1}/${at.getDate()}`;
  return sameYear ? `${md} ${hm}` : `${at.getFullYear()}/${md}`;
}

/** 样式全部在组件里算：令牌随系统深浅色变，模块级 StyleSheet 切不了 */
function useStyles() {
  const { colors, radius, space, fontWeight } = useTheme();

  return useMemo(() => {
    const s = StyleSheet.create({
      root: { flex: 1 },
      listContent: { paddingHorizontal: space(4) },
      switcher: {
        flexDirection: "row",
        alignItems: "center",
        gap: 5,
        // 负 margin 抵消自身 padding：手指点得到标题上下的留白，视觉上标题仍
        // 紧贴第一行——这行列表头本来就是标题，不该看起来像一块可点的按钮
        marginTop: space(3),
        marginBottom: space(1),
        paddingVertical: space(2),
        paddingRight: space(2),
        alignSelf: "flex-start",
      },
      switcherText: {
        color: colors.foreground,
        fontSize: 16,
        fontWeight: fontWeight("700"),
        letterSpacing: -0.2,
      },
      projectHeader: {
        flexDirection: "row",
        alignItems: "center",
        gap: space(2),
        paddingTop: space(3),
        paddingBottom: space(1.5),
      },
      projectIcon: {
        width: 26,
        height: 26,
        borderRadius: 8,
        alignItems: "center",
        justifyContent: "center",
      },
      projectBody: { flex: 1, minWidth: 0, gap: 2 },
      projectTitleRow: { flexDirection: "row", alignItems: "center", gap: space(1.5) },
      projectNew: {
    width: 28,
    height: 28,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 14,
  },
  projectName: {
        color: colors.foreground,
        fontSize: 13.5,
        fontWeight: fontWeight("600"),
        flexShrink: 1,
      },
      projectCount: { color: colors.mutedForeground, fontSize: 12 },
      projectPath: { color: colors.mutedForegroundFaint, fontSize: 11 },
      // 分隔线通栏：从列表左缘一直拉到右缘，图标底下也要有线压着
      separator: { height: StyleSheet.hairlineWidth },
      // 左滑动作格：撑满行高、图标+小字竖排
      // 动作区的外框：竖向留白让三块不贴行边，右缘留白跟列表的左右 16 对齐个大概，
      // 彼此 8 的缝。padding 汇总进 ROW_ACTION_WIDTH，两处必须一起改。
      actionRow: {
        flexDirection: "row",
        alignItems: "stretch",
        gap: 8,
        paddingVertical: 7,
        paddingRight: 10,
      },
      actionBtn: {
        width: 60,
        alignItems: "center",
        justifyContent: "center",
        gap: 2,
        // 圆角矩形而不是胶囊：60 宽 40 高的块用 20 半径会切掉太多直角，
        // 图标只剩一条窄缝。14 是 iOS 26 动作块的量级
        borderRadius: 14,
      },
      actionText: { color: "#fff", fontSize: 11, fontWeight: fontWeight("500") },
      actionPressed: { opacity: 0.75 },
      row: {
        flexDirection: "row",
        alignItems: "center",
        gap: space(3),
        paddingVertical: space(2.5),
        paddingHorizontal: space(1),
        // 这一层必须自己是不透明的：SwipeableRow 的动作区绝对定位在右缘、
        // 靠内容层盖住，行一透明，三个动作格就直接印在标题上（滑都没滑就
        // 全露出来）。取页面底色而不是写死白 —— 底色变成浅灰后，写死的白
        // 会让每一行在列表里浮出一条白带。
        backgroundColor: colors.background,
      },
      rowIcon: {
        width: 38,
        height: 38,
        borderRadius: 19,
        alignItems: "center",
        justifyContent: "center",
      },
      rowIconRun: {
        width: 9,
        height: 9,
        borderRadius: 5,
        backgroundColor: colors.success,
      },
      rowBody: { flex: 1, minWidth: 0, gap: 3 },
      rowTitle: { color: colors.foreground, fontSize: 15.5, fontWeight: fontWeight("600") },
      rowSub: { flexDirection: "row", alignItems: "center", gap: 5 },
      rowSubText: { color: colors.mutedForeground, fontSize: 12.5, flexShrink: 1 },
      rowTime: { color: colors.mutedForeground, fontSize: 13 },
      empty: { alignItems: "center", gap: space(2), paddingTop: space(14) },
      emptyText: { color: colors.mutedForeground, fontSize: 14 },
      fab: {
        // 定位搬到了 FloatingButton 外层那个 Animated.View 上：缩放要作用在整颗
        // 按钮上，按钮自己再 position:absolute 就改成相对包装层定位，
        // 结果整颗按钮会歪到屏幕右下角外头去
        width: 56,
        height: 56,
        borderRadius: 28,
        alignItems: "center",
        justifyContent: "center",
        // 阴影自成一体、不靠调用方传色：之前走玻璃系统那套「shadowOpacity 固定
        // 1、alpha 由 shadowColor 携带」的约定，调用方没传色时落到 iOS 默认
        // 纯黑，opacity 1 + 半径 16 就是一坨不透明大黑影
        shadowColor: "#000000",
        shadowOpacity: 0.25,
        shadowRadius: 12,
        shadowOffset: { width: 0, height: 6 },
        elevation: 8,
      },
    });

    return {
      ...s,
      background: colors.background,
      foreground: colors.foreground,
      muted: colors.mutedForeground,
      mutedFaint: colors.mutedForegroundFaint,
      border: colors.border,
      destructive: colors.destructive,
      hover: colors.hover,
      iconBg: withAlpha(colors.foreground, 0.05),
      primary: colors.primary,
      primaryForeground: colors.primaryForeground,
    };
  }, [colors, radius, space, fontWeight]);
}