import { useCallback, useEffect, useRef, type ReactNode } from "react";
import {
  Animated,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from "react-native";
import { CheckIcon, EllipsisIcon } from "lucide-react-native";

import { useTheme, withAlpha } from "@/components/ui/theme";
import { ENTER_MS, IOS_EASE, NATIVE } from "@/components/ui/motion";
import { Sheet } from "@/components/ui/sheet";

/**
 * 通用选项抽屉：底部弹起一列可选项，选中打勾。
 *
 * 外壳（遮罩、面板升起、抓手、下拉手势）全在 Sheet 里，这里只管内容。
 * 每一行按序号错开 24ms 淡入上移——整块一次性出现的话会「啪」地拍上来，
 * 正是要避免的那种生硬。
 */

export type OptionItem = {
  value: string;
  label: string;
  /** 选中态右侧的补充说明（副标题） */
  detail?: string;
  /** 副标题之前的图标 */
  icon?: ReactNode;
  disabled?: boolean;
  /** 分组标题。与上一项不同时才画一条，用来把两组单选（模型 / 思考档位）
   *  放进同一个抽屉里而不至于混成一列分不清 */
  section?: string;
  /** 行尾放一个「更多」按钮：点开二级抽屉（如某模型的思考档位），不触发本行选中。
   *  需配 OptionSheet 的 onMore。 */
  more?: boolean;
};

export function OptionSheet({
  title,
  items,
  value,
  values,
  onSelect,
  onClose,
  onMore,
}: {
  title: string;
  items: readonly OptionItem[];
  value: string | undefined;
  /** 多组共用一个抽屉时用这个：每组的当前值各给一个，勾会分别落在各自组里。
   *  单组场景继续用 value。 */
  values?: readonly string[] | undefined;
  onSelect: (value: string) => void;
  onClose: () => void;
  /** 行尾 more 按钮的回调（item.more 为真时才画按钮）。点它不关本抽屉，交由调用方叠二级。 */
  onMore?: (value: string) => void;
}) {
  const { colors, space } = useTheme();
  const { height } = useWindowDimensions();

  // 面板高度跟着内容走（模型列表那种长内容用 maxHeight 兜住并内部滚动）：
  // 固定高度的话三项权限也要撑出一大片空白，看着像没加载完
  const maxH = Math.round(height * 0.7);

  return (
    <Sheet
      onClose={onClose}
      travel={maxH + 120}
      sheetStyle={{ maxHeight: maxH }}
    >
      {({ close }) => (
        <>
          <Text
            style={[
              styles.title,
              { color: colors.mutedForeground, paddingHorizontal: space(5) },
            ]}
          >
            {title}
          </Text>

          <ScrollView
            contentContainerStyle={{
              paddingHorizontal: space(3),
              paddingBottom: space(4),
              gap: 2,
            }}
            showsVerticalScrollIndicator={false}
          >
            {items.map((item, index) => {
              // 分组标题只在换组时出现一次，所以跟上一项比而不是每项都带
              const newSection =
                item.section && item.section !== items[index - 1]?.section;
              return (
                <View key={item.value}>
                  {newSection ? (
                    <Text
                      style={[
                        styles.section,
                        {
                          color: colors.mutedForeground,
                          paddingHorizontal: space(2),
                        },
                      ]}
                    >
                      {item.section}
                    </Text>
                  ) : null}
                  <OptionRow
                    item={item}
                    active={values ? values.includes(item.value) : item.value === value}
                    index={index}
                    onMore={onMore}
                    onPress={() => {
                      onSelect(item.value);
                      // 走带退场动画的那条路：直接调 onClose 等于立刻卸载，
                      // 抽屉会「啪」地消失，手指抬起来的东西就没了
                      close();
                    }}
                  />
                </View>
              );
            })}
          </ScrollView>
        </>
      )}
    </Sheet>
  );
}

/** 一行选项。逐行错开 24ms 淡入上移：整块一次性动画看着像 PPT，
 *   逐行就位才有「陆续摆上来」的节奏，也不至于慢到烦人。 */
function OptionRow({
  item,
  active,
  index,
  onPress,
  onMore,
}: {
  item: OptionItem;
  active: boolean;
  index: number;
  onPress: () => void;
  onMore?: (value: string) => void;
}) {
  const { colors, fontWeight } = useTheme();
  const anim = useRef(new Animated.Value(0)).current;
  // 按下时轻微缩一点：只有变色的话手指按下去像没反应，缩放才有「按到了」
  const press = useRef(new Animated.Value(0)).current;

  const onPressIn = useCallback(() => {
    Animated.spring(press, { toValue: 1, damping: 22, stiffness: 380, mass: 0.6, useNativeDriver: NATIVE }).start();
  }, [press]);
  const onPressOut = useCallback(() => {
    Animated.spring(press, { toValue: 0, damping: 18, stiffness: 260, mass: 0.7, useNativeDriver: NATIVE }).start();
  }, [press]);

  useEffect(() => {
    const timer = setTimeout(() => {
      Animated.timing(anim, {
        toValue: 1,
        duration: ENTER_MS,
        easing: IOS_EASE,
        useNativeDriver: NATIVE,
      }).start();
    }, Math.min(index, 8) * 24);
    return () => clearTimeout(timer);
  }, [anim, index]);

  return (
    <Animated.View
      style={{
        opacity: anim,
        transform: [
          { translateY: anim.interpolate({ inputRange: [0, 1], outputRange: [10, 0] }) },
          { scale: press.interpolate({ inputRange: [0, 1], outputRange: [1, 0.975] }) },
        ],
      }}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ selected: active, disabled: item.disabled }}
        disabled={item.disabled}
        onPress={onPress}
        onPressIn={onPressIn}
        onPressOut={onPressOut}
        style={[
          styles.row,
          active && { backgroundColor: withAlpha(colors.foreground, 0.07) },
          item.disabled && { opacity: 0.4 },
        ]}
      >
        {item.icon ? <View style={styles.icon}>{item.icon}</View> : null}
        <View style={styles.labels}>
          <Text
            style={[
              styles.label,
              {
                color: colors.foreground,
                fontWeight: fontWeight(active ? "600" : "500"),
              },
            ]}
          >
            {item.label}
          </Text>
          {item.detail ? (
            <Text style={[styles.detail, { color: colors.mutedForeground }]}>
              {item.detail}
            </Text>
          ) : null}
        </View>
        {/* 行尾「更多」：嵌套 Pressable 在 RN 里自己吃命中，点它不会触发整行选中 */}
        {item.more && onMore ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`${item.label} 的更多选项`}
            hitSlop={10}
            onPress={() => onMore(item.value)}
            style={({ pressed }) => [
              styles.moreBtn,
              // { backgroundC  olor: withAlpha(colors.foreground, pressed ? 0.12 : 0.06) },
            ]}
          >
            <EllipsisIcon size={15} strokeWidth={2.2} color={colors.mutedForeground} />
          </Pressable>
        ) : null}
        {active ? (
          <CheckIcon size={18} strokeWidth={2.4} color={colors.foreground} />
        ) : null}
      </Pressable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  title: { fontSize: 13, fontWeight: "600", letterSpacing: 0.4, paddingBottom: 8 },
  // 组间标题：比 title 再小一档、低对比，它是组内的分隔而不是新的一层
  section: { fontSize: 12, fontWeight: "600", letterSpacing: 0.3, paddingTop: 14, paddingBottom: 4 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 14,
    paddingVertical: 13,
    borderRadius: 14,
  },
  icon: { width: 22, alignItems: "center" },
  labels: { flex: 1, minWidth: 0, gap: 2 },
  // 行尾 more 圆钮：26 见方、正圆，视觉重量压在勾选之下（它是入口不是状态）
  moreBtn: {
    width: 26,
    height: 26,
    borderRadius: 13,
    alignItems: "center",
    justifyContent: "center",
    marginLeft: 2,
  },
  label: { fontSize: 16 },
  detail: { fontSize: 13, lineHeight: 18 },
});