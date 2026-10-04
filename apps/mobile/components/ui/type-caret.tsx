import { useEffect, useState } from "react";
import { StyleSheet, View } from "react-native";

/**
 * 打字机光标 + 出字节奏，配对页品牌区与聊天页空态共用一份。
 *
 * 两处各写一套的时候，光标一个是不闪的字形「▍」、一个是会闪的竖条，出字
 * 间隔也差了十几毫秒——同屏切换时那种「不是同一个东西」的割裂感比单个
 * 页面不好看更明显。所以间隔、闪动周期、竖条尺寸都定在这里。
 */

/** 每字间隔。配对页与聊天页共用，谁改了另一边跟着走 */
export const TYPE_INTERVAL_MS = 110;

/** 亮/灭各占的时间 */
const BLINK_MS = 380;

export function TypeCaret({
  color,
  height,
  on = true,
}: {
  color: string;
  height: number;
  /** false = 收笔（打完字就不再闪）。竖条仍占位，只是不亮，行宽不会跳 */
  on?: boolean;
}) {
  const [lit, setLit] = useState(true);

  useEffect(() => {
    if (!on) return;
    setLit(true);
    const timer = setInterval(() => setLit((v) => !v), BLINK_MS);
    return () => clearInterval(timer);
  }, [on]);

  return (
    <View
      style={[
        styles.caret,
        { height, backgroundColor: color, opacity: on && lit ? 1 : 0 },
      ]}
    />
  );
}

const styles = StyleSheet.create({
  caret: {
    width: 2,
    marginLeft: 3,
    borderRadius: 1,
  },
});