"use client";

/**
 * Plate 编辑器与宿主（资料库/预览页）之间的桥：
 * - 图片相对路径 → 可渲染 URL（桌面壳 kova://）；
 * - 选图 / 粘贴落库（FileViewer 里接资料库，dev-preview 可不提供）。
 */

import { createContext, useContext } from "react";
import type { InsertedImage } from "./image-upload";

export interface PlateEditorBridge {
  resolveImageSrc: (src: string) => string;
  /** 原生笔记编辑器：启用 Markdown 无法表达的块能力（合并单元格/背景等） */
  nativeNote?: boolean;
  pickImage?: () => Promise<InsertedImage | null>;
  uploadImageFiles?: (files: File[]) => Promise<InsertedImage[]>;
}

const defaultBridge: PlateEditorBridge = {
  resolveImageSrc: (src) => src,
};

export const PlateEditorBridgeContext =
  createContext<PlateEditorBridge>(defaultBridge);

export function usePlateEditorBridge(): PlateEditorBridge {
  return useContext(PlateEditorBridgeContext);
}
