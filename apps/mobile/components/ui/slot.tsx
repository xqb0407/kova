import { cn } from '@/lib/utils';
import * as React from 'react';
import { Text as RNText } from 'react-native';

type SlotProps = React.ComponentProps<typeof RNText>;

function mergeRefs<T>(...refs: (React.Ref<T> | undefined)[]): React.Ref<T> | undefined {
  const defined = refs.filter(Boolean) as React.Ref<T>[];
  if (defined.length === 0) return undefined;
  if (defined.length === 1) return defined[0];
  return (value: T | null) => {
    for (const ref of defined) {
      if (typeof ref === 'function') {
        (ref as (value: T | null) => void)(value);
      } else {
        (ref as React.RefObject<T | null>).current = value;
      }
    }
  };
}

/**
 * Slot：把自身的 props（className / style / ref / 事件）合并进唯一的子元素，
 * 供带 `asChild` 的组件使用。子元素的值优先级高于 Slot。
 */
function Slot({ children, ...slotProps }: SlotProps & { children?: React.ReactNode }) {
  if (!React.isValidElement<SlotProps>(children)) {
    return null;
  }

  const childProps = children.props as Record<string, unknown>;
  const slotRecord = slotProps as Record<string, unknown>;
  const merged: Record<string, unknown> = { ...slotRecord, ...childProps };

  const className = cn(slotProps.className, childProps.className as string | undefined);
  if (className) merged.className = className;

  if (slotProps.style != null || childProps.style != null) {
    merged.style = [slotProps.style, childProps.style];
  }

  for (const key of Object.keys(slotRecord)) {
    const slotValue = slotRecord[key];
    const childValue = childProps[key];
    if (typeof slotValue === 'function' && typeof childValue === 'function') {
      merged[key] = (...args: unknown[]) => {
        (childValue as (...a: unknown[]) => void)(...args);
        (slotValue as (...a: unknown[]) => void)(...args);
      };
    }
  }

  merged.ref = mergeRefs(
    childProps.ref as React.Ref<unknown> | undefined,
    slotRecord.ref as React.Ref<unknown> | undefined
  );

  return React.cloneElement(children, merged);
}

export { Slot };
