import { useEffect, useState } from "react";
import { Keyboard, Platform } from "react-native";

/**
 * 收键盘 + 「键盘弹着没有」。
 *
 * RN 上 Keyboard.dismiss() 就够；web 上 Keyboard 根本没被输入框登记，得自己去
 * 把 document.activeElement 从那个 input/textarea 上摘下来——不然键盘不收，
 * 输入框还占着焦点，输入条一直被顶上来。
 *
 * 这里**曾经**有个 DismissTap 组件，用 Pressable 把整块内容包起来收键盘。已经
 * 删掉了：Pressable 祖先会先成为 JS responder，被包住的滚动容器（消息列表）
 * 在纵向拖动时抢不回 responder，那段列表就整片滑不动。要收键盘请用下面两条：
 * - 滚动容器上：`keyboardDismissMode="interactive"`（拖一下就收，系统原生行为）；
 * - 非滚动的空白区：自己包一层 Pressable 调 dismissKeyboard()，但**绝不要**
 *   跨着一层滚动容器包。
 */
export function dismissKeyboard() {
  Keyboard.dismiss();
  if (Platform.OS !== "web") return;
  const doc = typeof document === "undefined" ? null : document;
  const el = doc?.activeElement as HTMLElement | null;
  if (!el) return;
  const tag = el.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA") el.blur();
}

/**
 * 键盘有没有弹着。
 *
 * iOS 订阅 will 系列而不是 did 系列：键盘自己会走一段带弹簧的进场曲线，
 * 键盘动到半路 did 才发；等 did 再去收起建议条，看上去就是「键盘顶上来了，
 * 下面才慢半拍开始淡出」。will 系列在动画**开始**时就发，两边这才同步。
 *
 * 其余平台（Android / web）没有 will 事件，只有 did，那边本来也没有可对齐
 * 的键盘曲线，did 就够用。
 */
export function useKeyboardVisible(): boolean {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const ios = Platform.OS === "ios";
    const subscriptions = [
      Keyboard.addListener(ios ? "keyboardWillShow" : "keyboardDidShow", () =>
        setVisible(true),
      ),
      Keyboard.addListener(ios ? "keyboardWillHide" : "keyboardDidHide", () =>
        setVisible(false),
      ),
    ];
    return () => {
      for (const sub of subscriptions) sub.remove();
    };
  }, []);

  return visible;
}