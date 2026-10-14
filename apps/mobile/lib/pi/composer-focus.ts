"use client";

/**
 * 输入框实例登记处：菜单（＋ 菜单 / @·/ 触发菜单）打开时要收键盘、选完要把
 * 焦点还给输入框，但 assistant-ui 的 ComposerPrimitive.Input 没有对外的
 * focus()。桌面端 cm-composer-input.tsx 里有一份同样的登记表（composerViews），
 * 这里给 RN 版一个最小实现：DefaultComposerInput 挂载时登记自己的 TextInput，
 * 菜单侧调 focusComposerInput()。
 */
import { useEffect, type RefObject } from "react";

type FocusableInput = { focus: () => void };

let current: FocusableInput | null = null;

/** 挂载即登记（RN 的 TextInput 实例本身就是可 focus 的对象） */
export function registerComposerInput(
  input: FocusableInput | null,
): () => void {
  current = input;
  return () => {
    if (current === input) current = null;
  };
}

/** 把焦点还给输入框（菜单选完/关掉后调用；未挂载时静默无事） */
export function focusComposerInput(): void {
  current?.focus();
}

/** 组件里用：ref 变化即登记 */
export function useRegisterComposerInput(
  ref: RefObject<FocusableInput | null>,
): void {
  useEffect(() => {
    if (!ref.current) return;
    return registerComposerInput(ref.current);
  }, [ref]);
}
