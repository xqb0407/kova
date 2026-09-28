/** FileMenu：左上角文件区 —— 面板菜单（回首页/新建/导出）+ 文档名（可改）+ 保存状态 */
import { useRef, useState, type FC } from "react";
import { Download, FileCode2, Globe, Home, Image as ImageIcon, LayoutGrid, PenLine, Play } from "lucide-react";
import type { DesignStore } from "../state";
import { InlineEdit, Menu, MenuItem } from "./ui";
import { nodesToSvg, saveBlob, svgToPngBlob } from "../export";
import { docToPrototypeHtml } from "../html";
import { makeMeasure } from "../leafer/measure";
import { bridge } from "../bridge";

/** 文件菜单：笔形触发 + 文档名 chip；停靠栏与悬浮胶囊内同款 ghost 样式（无描边） */
export const FileMenu: FC<{ store: DesignStore; onGoHome: () => void; onPreview?: () => void }> = ({
  store,
  onGoHome,
  onPreview,
}) => {
  const { doc, page, selIds, dirty, connected, renameDoc, createDoc } = store;
  const [editing, setEditing] = useState(false);
  const [exporting, setExporting] = useState(false);
  const measureRef = useRef<ReturnType<typeof makeMeasure> | null>(null);
  if (!measureRef.current) measureRef.current = makeMeasure();

  const doExport = async (kind: "png2" | "png1" | "svg") => {
    if (exporting) return;
    setExporting(true);
    try {
      const ids = selIds.length > 0 ? selIds : page.nodes.map((n) => n.id);
      const r = await nodesToSvg(doc, ids, measureRef.current!);
      if (!r) {
        bridge.notify("没有可导出的内容", "error");
        return;
      }
      const base = `${doc.meta.name}${selIds.length > 0 ? "-选区" : ""}`.slice(0, 60);
      if (kind === "svg") {
        await saveBlob(`${base}.svg`, new Blob([r.svg], { type: "image/svg+xml;charset=utf-8" }));
        bridge.notify(`已导出 ${base}.svg`);
      } else {
        const blob = await svgToPngBlob(r.svg, r.box.w, r.box.h, kind === "png2" ? 2 : 1);
        await saveBlob(`${base}.png`, blob);
        bridge.notify(`已导出 ${base}.png`);
      }
    } catch {
      bridge.notify("导出失败，请重试", "error");
    } finally {
      setExporting(false);
    }
  };
  // 交互原型：全档所有画板导出为自包含单文件 HTML（hash 路由 + 热点跳转，浏览器直接打开体验）
  const doExportHtml = async () => {
    if (exporting) return;
    setExporting(true);
    try {
      const html = await docToPrototypeHtml(doc, { measure: measureRef.current!, title: doc.meta.name });
      if (!html) {
        bridge.notify("没有画板，无法导出原型：先用 F 画一块", "error");
        return;
      }
      const base = `${doc.meta.name}-原型`.slice(0, 60);
      await saveBlob(`${base}.html`, new Blob([html], { type: "text/html;charset=utf-8" }));
      bridge.notify("已导出 HTML 原型：浏览器打开即可点击体验");
    } catch {
      bridge.notify("导出原型失败，请重试", "error");
    } finally {
      setExporting(false);
    }
  };
  return (
    <div className="pointer-events-auto flex items-center gap-1">
      <Menu
        trigger={
          <button
            type="button"
            title="文件菜单"
            className="flex h-8 w-8 items-center justify-center rounded-full transition-colors hover:bg-[var(--secondary)]"
            style={{ color: "var(--foreground)" }}
          >
            <PenLine size={14} />
          </button>
        }
      >
        <MenuItem icon={<Home size={13} />} onClick={onGoHome}>
          回到设计首页
        </MenuItem>
        <MenuItem icon={<LayoutGrid size={13} />} onClick={() => createDoc("UI 设计", "ios-390")}>
          新建示例设计（iPhone）
        </MenuItem>
        <MenuItem icon={<ImageIcon size={13} />} disabled={exporting} onClick={() => void doExport("png2")}>
          {exporting ? "导出中…" : "导出 PNG（2x）"}
        </MenuItem>
        <MenuItem icon={<Download size={13} />} disabled={exporting} onClick={() => void doExport("png1")}>
          导出 PNG（1x）
        </MenuItem>
        <MenuItem icon={<FileCode2 size={13} />} disabled={exporting} onClick={() => void doExport("svg")}>
          导出 SVG
        </MenuItem>
        {onPreview && (
          <MenuItem icon={<Play size={13} />} title="从选中画板（或第一个画板）起播，点击高亮热点跳转" onClick={onPreview}>
            预览交互原型（P）
          </MenuItem>
        )}
        <MenuItem icon={<Globe size={13} />} disabled={exporting} title="自包含单文件，浏览器打开即点即玩" onClick={() => void doExportHtml()}>
          导出 HTML 原型
        </MenuItem>
      </Menu>
      <div className="flex h-8 items-center gap-2 rounded-full px-2.5">
        {editing ? (
          <InlineEdit
            value={doc.meta.name}
            onCommit={(v) => {
              renameDoc(v.trim() || doc.meta.name);
              setEditing(false);
            }}
            className="w-[110px]"
          />
        ) : (
          <button
            type="button"
            title="双击重命名文档"
            onDoubleClick={() => setEditing(true)}
            className="max-w-[104px] truncate text-[12.5px] font-medium"
            style={{ color: "var(--foreground)" }}
          >
            {doc.meta.name}
          </button>
        )}
        <span className="text-[11px]" style={{ color: "var(--muted-foreground)" }}>
          {connected ? (dirty ? "未保存…" : "已保存") : "本地草稿"}
        </span>
      </div>
    </div>
  );
};
