"use client";

/**
 * Plate 编辑器共享插件表（资料库正文 / dev-preview 同一套能力）。
 *
 * 注意：必须在模块级创建并保持引用稳定，否则 `usePlateEditor` 每次渲染
 * 都会重建编辑器，DOM 持续重建（表现为无法点击、光标丢失）。
 */

import remarkGfm from "remark-gfm";
import { common, createLowlight } from "lowlight";
import { DndProvider } from "react-dnd";
import { HTML5Backend } from "react-dnd-html5-backend";
import {
  KEYS,
  TrailingBlockPlugin,
} from "platejs";
import {
  createPlatePlugin,
  type PlateEditor,
  ParagraphPlugin,
} from "platejs/react";
import {
  BlockquotePlugin,
  BoldPlugin,
  CodePlugin,
  H1Plugin,
  H2Plugin,
  H3Plugin,
  H4Plugin,
  H5Plugin,
  H6Plugin,
  HorizontalRulePlugin,
  ItalicPlugin,
  StrikethroughPlugin,
} from "@platejs/basic-nodes/react";
import {
  BlockquoteRules,
  BoldRules,
  CodeRules,
  HeadingRules,
  HorizontalRuleRules,
  ItalicRules,
  StrikethroughRules,
} from "@platejs/basic-nodes";
import {
  BulletedListRules,
  isOrderedList,
  OrderedListRules,
  TaskListRules,
} from "@platejs/list";
import { ListPlugin } from "@platejs/list/react";
import { IndentPlugin } from "@platejs/indent/react";
import { CodeBlockRules } from "@platejs/code-block";
import {
  CodeBlockPlugin,
  CodeLinePlugin,
  CodeSyntaxPlugin,
} from "@platejs/code-block/react";
import { LinkPlugin } from "@platejs/link/react";
import {
  TableCellHeaderPlugin,
  TableCellPlugin,
  TablePlugin,
  TableRowPlugin,
} from "@platejs/table/react";
import { ImagePlugin } from "@platejs/media/react";
import { CaptionPlugin } from "@platejs/caption/react";
import { FindReplacePlugin } from "@platejs/find-replace";
import { deserializeMd, MarkdownPlugin, serializeMd } from "@platejs/markdown";
import { DndPlugin } from "@platejs/dnd";
import { BlockDraggable } from "./block-draggable";
import { BlockList } from "./block-list";
import {
  BlockquoteElement,
  CalloutElement,
  CodeBlockElement,
  CodeLeaf,
  CodeLineElement,
  CodeSyntaxLeaf,
  ColumnElement,
  ColumnGroupElement,
  H1Element,
  H2Element,
  H3Element,
  H4Element,
  H5Element,
  H6Element,
  HrElement,
  ImageElement,
  LinkElement,
  ParagraphElement,
  SearchHighlightLeaf,
  TableCellElement,
  TableCellHeaderElement,
  TableElement,
  TableRowElement,
  ToggleElement,
} from "./simple-elements";

export const plateLowlight = createLowlight(common);

const indentTargets = [
  ...KEYS.heading,
  KEYS.p,
  KEYS.blockquote,
  KEYS.codeBlock,
  KEYS.img,
];

/** 原生笔记独有的 Notion 块。类型使用 Plate/Markdown 识别的标准 key，
 *  Markdown 导出时由 lib/notes/native-markdown.ts 做降级。 */
export const CalloutPlugin = createPlatePlugin({
  key: KEYS.callout,
  node: { isElement: true },
}).withComponent(CalloutElement);

export const TogglePlugin = createPlatePlugin({
  key: KEYS.toggle,
  node: { isElement: true },
}).withComponent(ToggleElement);

export const ColumnGroupPlugin = createPlatePlugin({
  key: KEYS.columnGroup,
  node: { isElement: true },
}).withComponent(ColumnGroupElement);

export const ColumnPlugin = createPlatePlugin({
  key: KEYS.column,
  node: { isElement: true },
}).withComponent(ColumnElement);

export const PLATE_PLUGINS = [
  ParagraphPlugin.withComponent(ParagraphElement),
  H1Plugin.configure({
    inputRules: [HeadingRules.markdown()],
    node: { component: H1Element },
  }),
  H2Plugin.configure({
    inputRules: [HeadingRules.markdown()],
    node: { component: H2Element },
  }),
  H3Plugin.configure({
    inputRules: [HeadingRules.markdown()],
    node: { component: H3Element },
  }),
  H4Plugin.configure({
    inputRules: [HeadingRules.markdown()],
    node: { component: H4Element },
  }),
  H5Plugin.configure({
    inputRules: [HeadingRules.markdown()],
    node: { component: H5Element },
  }),
  H6Plugin.configure({
    inputRules: [HeadingRules.markdown()],
    node: { component: H6Element },
  }),
  BlockquotePlugin.configure({
    inputRules: [BlockquoteRules.markdown()],
    node: { component: BlockquoteElement },
  }),
  HorizontalRulePlugin.configure({
    inputRules: [
      HorizontalRuleRules.markdown({ variant: "-" }),
      HorizontalRuleRules.markdown({ variant: "_" }),
    ],
    node: { component: HrElement },
  }),

  BoldPlugin.configure({
    inputRules: [
      BoldRules.markdown({ variant: "*" }),
      BoldRules.markdown({ variant: "_" }),
    ],
  }),
  ItalicPlugin.configure({
    inputRules: [
      ItalicRules.markdown({ variant: "*" }),
      ItalicRules.markdown({ variant: "_" }),
    ],
  }),
  StrikethroughPlugin.configure({
    inputRules: [StrikethroughRules.markdown()],
  }),
  CodePlugin.configure({
    inputRules: [CodeRules.markdown()],
    node: { component: CodeLeaf },
  }),

  IndentPlugin.configure({
    inject: { targetPlugins: indentTargets },
    options: { offset: 24 },
  }),
  ListPlugin.configure({
    inputRules: [
      BulletedListRules.markdown({ variant: "-" }),
      BulletedListRules.markdown({ variant: "*" }),
      OrderedListRules.markdown({ variant: "." }),
      OrderedListRules.markdown({ variant: ")" }),
      TaskListRules.markdown({ checked: false }),
      TaskListRules.markdown({ checked: true }),
    ],
    inject: {
      nodeProps: {
        nodeKey: KEYS.listType,
        query: ({ nodeProps }) => {
          const element = nodeProps.element;
          return !!element?.listStyleType && !isOrderedList(element);
        },
        transformProps: ({ props }) => ({
          ...props,
          role: "listitem",
          style: {
            ...props.style,
            display: "list-item",
          },
        }),
      },
      targetPlugins: indentTargets,
    },
    render: { belowNodes: BlockList },
  }),

  CodeBlockPlugin.configure({
    inputRules: [CodeBlockRules.markdown({ on: "match" })],
    node: { component: CodeBlockElement },
    options: { lowlight: plateLowlight },
  }),
  CodeLinePlugin.withComponent(CodeLineElement),
  CodeSyntaxPlugin.withComponent(CodeSyntaxLeaf),

  LinkPlugin.withComponent(LinkElement),
  TablePlugin.withComponent(TableElement),
  TableRowPlugin.withComponent(TableRowElement),
  TableCellPlugin.withComponent(TableCellElement),
  TableCellHeaderPlugin.withComponent(TableCellHeaderElement),
  CalloutPlugin,
  TogglePlugin,
  ColumnGroupPlugin,
  ColumnPlugin,
  ImagePlugin.withComponent(ImageElement),
  CaptionPlugin,

  FindReplacePlugin.withComponent(SearchHighlightLeaf),

  DndPlugin.configure({
    options: { enableScroller: true },
    render: {
      aboveNodes: BlockDraggable,
      aboveSlate: ({ children }) => (
        <DndProvider backend={HTML5Backend}>{children}</DndProvider>
      ),
    },
  }),

  // 表格/代码块/图片后面始终保留一个可输入的空段落
  TrailingBlockPlugin.configure({
    options: { type: KEYS.p },
  }),

  MarkdownPlugin.configure({
    options: {
      remarkPlugins: [remarkGfm],
      remarkStringifyOptions: {
        bullet: "-",
        emphasis: "*",
        rule: "-",
        strong: "*",
      },
    },
  }),
];

/** 正文 Markdown → Plate 初始值（frontmatter 由调用方剥离） */
export function plateValueFromMarkdown(
  editor: PlateEditor,
  body: string,
) {
  return deserializeMd(editor, body);
}

/** Plate 文档 → 正文 Markdown（frontmatter 由调用方拼回） */
export function markdownFromPlate(editor: PlateEditor): string {
  // 空段落用 ZWSP 占位才能往返，但会把 ​ 写进 .md；
  // 资料库以纯净 Markdown 为准，空段落直接丢弃。
  const markdown = serializeMd(editor, {
    preserveEmptyParagraphs: false,
  }).replace(/^\n+/, "");
  const trimmed = markdown.trimEnd();
  return trimmed ? `${trimmed}\n` : "";
}
