"use client";

/**
 * Plate 列表渲染（从官方 plate-ui 模板裁剪）：
 * Plate 的列表不是嵌套 ul/li，而是给块加 listStyleType/indent；这里把
 * 有序列表和待办包成真正的 ol/ul/li，无序列表由 ListPlugin 的 inject 处理。
 */

import React from "react";
import type { TListElement } from "platejs";
import { isOrderedList } from "@platejs/list";
import {
  useTodoListElement,
  useTodoListElementState,
} from "@platejs/list/react";
import {
  type PlateElementProps,
  type RenderNodeWrapper,
  useReadOnly,
} from "platejs/react";
import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/utils";

const config: Record<
  string,
  {
    Li: React.FC<PlateElementProps>;
    Marker: React.FC<PlateElementProps>;
  }
> = {
  todo: {
    Li: TodoLi,
    Marker: TodoMarker,
  },
};

export const BlockList: RenderNodeWrapper = (props) => {
  if (!props.element.listStyleType) return;
  if (!isOrderedList(props.element)) return;
  return (props) => <List {...props} />;
};

function List(props: PlateElementProps) {
  const { listStart, listStyleType } = props.element as TListElement;
  const { Li, Marker } = config[listStyleType] ?? {};
  const ListTag = isOrderedList(props.element) ? "ol" : "ul";

  return (
    <ListTag
      className="relative m-0 p-0"
      style={{ listStyleType }}
      start={listStart}
    >
      {Marker && <Marker {...props} />}
      {Li ? <Li {...props} /> : <li>{props.children}</li>}
    </ListTag>
  );
}

function TodoMarker(props: PlateElementProps) {
  const state = useTodoListElementState({ element: props.element });
  const { checkboxProps } = useTodoListElement(state);
  const readOnly = useReadOnly();

  return (
    <div contentEditable={false}>
      <Checkbox
        className={cn(
          "-left-6 absolute top-1",
          readOnly && "pointer-events-none",
        )}
        {...checkboxProps}
      />
    </div>
  );
}

function TodoLi(props: PlateElementProps) {
  return (
    <li
      className={cn(
        "list-none",
        (props.element.checked as boolean) &&
          "text-muted-foreground line-through",
      )}
    >
      {props.children}
    </li>
  );
}
