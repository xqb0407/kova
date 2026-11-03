"use client";

import { memo, useCallback, useRef, type FC } from "react";
import {
  ColorPicker,
  ColorPickerArea,
  ColorPickerChannels,
  ColorPickerContent,
  ColorPickerEyeDropper,
  ColorPickerHexInput,
  ColorPickerHue,
  ColorPickerSwatch,
  ColorPickerTrigger,
} from "@/components/custom-ui/color-picker";
import { cn } from "@/lib/utils";
import { useThrottledCommit } from "./use-throttled-commit";

/**
 * 取色面板本体：非受控（defaultValue），拖动状态完全由面板自己持有。
 * memo 忽略父组件的 store 回声；只有外部换色时由 key 重挂载。
 * 这样拖色时不会出现「面板 setState + 父组件回写 value」的两次渲染。
 */
const ColorPickerBody = memo(
  function ColorPickerBody({
    initialValue,
    onValueChange,
    onValueCommit,
  }: {
    initialValue: string;
    onValueChange: (hex: string) => void;
    onValueCommit: (hex: string) => void;
  }) {
    // defaultValue 只在挂载时读；父组件后续传入的新值不会打断拖动
    const initial = useRef(initialValue).current;
    return (
      <ColorPicker
        defaultValue={initial}
        onValueChange={onValueChange}
        onValueCommit={onValueCommit}
        alpha={false}
        className="w-fit"
      >
        <ColorPickerTrigger className="border-border/60 bg-background h-8 gap-2 rounded-lg pr-2.5 pl-2 text-[13px] leading-5" />
        <ColorPickerContent align="end" className="w-64">
          <ColorPickerArea />
          <div className="flex items-center gap-2">
            <ColorPickerHue className="flex-1" />
            <ColorPickerEyeDropper className="size-8" />
          </div>
          <div className="flex items-center gap-2">
            <ColorPickerSwatch className="size-8" />
            <ColorPickerHexInput />
          </div>
          <ColorPickerChannels format="rgb" />
        </ColorPickerContent>
      </ColorPicker>
    );
  },
  // 回调稳定；initialValue 只在挂载时读，父组件重渲染不需要带着面板重渲染
  (prev, next) =>
    prev.onValueChange === next.onValueChange &&
    prev.onValueCommit === next.onValueCommit,
);

/**
 * 颜色行控件：复用 custom-ui/color-picker（色块 + 取色面板 + hex 输入）。
 * 只接受不透明色（主题令牌不接受 alpha），重置按钮仅在用户覆盖过时出现。
 *
 * 拖动取色面板时面板自身满帧；写 store（重算整套主题变量）按 50ms 节流，
 * 松手（onValueCommit）立即提交最终值。外部换色（重置/换模式/预设）用
 * revision 作 key 重挂载面板，保证显示与 store 一致。
 */
export const ColorField: FC<{
  value: string;
  /** 是否已有用户覆盖（决定「重置」是否出现） */
  overridden: boolean;
  onChange: (hex: string) => void;
  onReset: () => void;
  className?: string;
}> = ({ value, overridden, onChange, onReset, className }) => {
  const { revision, schedule, commitNow } = useThrottledCommit(
    value,
    onChange,
    50,
    { previewOnSchedule: false },
  );
  const handleChange = useCallback(
    (hex: string) => schedule(hex.slice(0, 7)),
    [schedule],
  );
  const handleCommit = useCallback(
    (hex: string) => commitNow(hex.slice(0, 7)),
    [commitNow],
  );

  return (
    <div className={cn("flex items-center gap-2", className)}>
      {/* 始终占位：拖动中第一次提交会让 overridden 变 true，避免面板/触发器左右跳 */}
      <button
        type="button"
        onClick={onReset}
        disabled={!overridden}
        aria-hidden={!overridden}
        tabIndex={overridden ? 0 : -1}
        className={cn(
          "text-muted-foreground hover:text-foreground text-[13px] leading-5 transition-colors",
          !overridden && "invisible",
        )}
      >
        重置
      </button>
      <ColorPickerBody
        key={revision}
        initialValue={value}
        onValueChange={handleChange}
        onValueCommit={handleCommit}
      />
    </div>
  );
};
