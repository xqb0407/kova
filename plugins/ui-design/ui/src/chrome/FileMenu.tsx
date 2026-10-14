/** FileMenu：左上角文件区 —— 面板菜单（回首页/新建/导入/导出）+ 文档名（可改）+ 保存状态 */
import { useRef, useState, type ChangeEvent, type FC } from "react";
import { Download, FileCode2, FilePlus, FolderDown, Globe, Home, Image as ImageIcon, LayoutGrid, PenLine, Play, Upload } from "lucide-react";
import type { DesignStore } from "../state";
import { InlineEdit, Menu, MenuItem } from "./ui";
import { docToPrototypeHtmlSelfContained, nodesToSvg, resolveImages, saveBlob, svgToPngBlob } from "../export";
import {
  buildManifest,
  externalImagesMap,
  planBundle,
  serializeManifest,
  type BundleFileResult,
} from "../bundle";
import { renderPrototypeHtml } from "../html";
import { serializeDoc } from "../doc";
import { makeMeasure } from "../leafer/measure";
import { blobToBase64, bridge } from "../bridge";

/** 文件菜单：笔形触发 + 文档名 chip；停靠栏与悬浮胶囊内同款 ghost 样式（无描边） */
export const FileMenu: FC<{ store: DesignStore; onGoHome: () => void; onPreview?: () => void }> = ({
  store,
  onGoHome,
  onPreview,
}) => {
  const { doc, page, selIds, fileRel, dirty, connected, renameDoc, createDoc } = store;
  const [editing, setEditing] = useState(false);
  const [exporting, setExporting] = useState(false);
  /** 隐藏文件选择器：accept 随菜单项换（图片/SVG/设计档 JSON 三条目共用一个 input） */
  const fileRef = useRef<HTMLInputElement | null>(null);
  const pickFiles = (accept: string) => {
    if (fileRef.current) fileRef.current.accept = accept;
    fileRef.current?.click();
  };
  const onPicked = (e: ChangeEvent<HTMLInputElement>) => {
    const files = [...(e.target.files ?? [])];
    e.target.value = "";
    if (files.length > 0) void store.importFiles(files);
  };
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
      const html = await docToPrototypeHtmlSelfContained(doc, { measure: measureRef.current!, title: doc.meta.name });
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
  // 导出工程包：静态目录包（源档副本 + 逐画板位图 + 外链资产 + index.html 可点原型 + manifest），
  // 目录结构与 manifest 和 MCP export_doc 共用同一纯装配器 ui/src/bundle.ts，两条链路产物一致。
  const doExportBundle = async () => {
    if (exporting) return;
    if (bridge.standalone) {
      bridge.notify("工程包需在 Kova 宿主里导出（要写多文件目录）；单文件导出不受影响", "error");
      return;
    }
    setExporting(true);
    try {
      const ids = selIds.length > 0 ? selIds : page.nodes.map((n) => n.id);
      const docRel = fileRel ?? "design.uidesign.json";
      const dirBase = (docRel.split("/").pop() ?? docRel).replace(/\.[^.]*$/, "");
      const plan = planBundle(doc, page, ids, dirBase);
      if (plan.screens.length === 0) {
        bridge.notify("没有可见画板可导出：先用 F 画一块", "error");
        return;
      }
      const files: BundleFileResult[] = [];
      const b64Bytes = (b64: string) =>
        Math.round((b64.length * 3) / 4) - (b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0);
      const push = (path: string, b64: string, meta: Omit<BundleFileResult, "path" | "bytes">) => {
        bridge.exportFile(path, b64, true);
        files.push({ path, bytes: b64Bytes(b64), ...meta });
      };
      const writeText = async (path: string, text: string, meta: Omit<BundleFileResult, "path" | "bytes">) =>
        push(path, await blobToBase64(new Blob([text])), meta);

      // ① 源档副本
      await writeText(plan.sourcePath, serializeDoc(doc), { kind: "source" });

      // ② 位图资产逐份复制进 assets/（dataURL 剥头即原始字节；读不到的不入包）
      const imgData = await resolveImages(new Set(plan.assets.map((a) => a.src)));
      let missingAssets = 0;
      for (const a of plan.assets) {
        const url = imgData.get(a.src);
        if (!url) {
          missingAssets += 1;
          continue;
        }
        push(a.path, url.slice(url.indexOf(",") + 1), { kind: "asset" });
      }

      // ③ 逐画板位图/矢量（PNG 浏览器光栅化；倍率同包约束：min(scale, maxDim/最长边)）
      if (plan.formats.has("png") || plan.formats.has("svg")) {
        for (const s of plan.screens) {
          const r = await nodesToSvg(doc, [s.id], measureRef.current!, { images: imgData });
          if (!r) continue;
          if (plan.formats.has("svg")) {
            await writeText(s.svgPath, r.svg, {
              kind: "svg",
              screen: s.name,
              width: Math.round(r.box.w),
              height: Math.round(r.box.h),
            });
          }
          if (plan.formats.has("png")) {
            const eff = Math.max(0.1, Math.min(plan.scale, plan.maxDim / Math.max(r.box.w, r.box.h, 1)));
            const blob = await svgToPngBlob(r.svg, r.box.w, r.box.h, eff);
            push(s.pngPath, await blobToBase64(blob), {
              kind: "png",
              screen: s.name,
              width: Math.max(1, Math.round(r.box.w * eff)),
              height: Math.max(1, Math.round(r.box.h * eff)),
            });
          }
        }
      }

      // ④ 可点原型：位图外链 assets/<文件>（与包同目录，非 dataURL 内联）
      if (plan.formats.has("html")) {
        const html = renderPrototypeHtml(doc, {
          measure: measureRef.current!,
          pageId: page.id,
          title: doc.meta.name,
          images: externalImagesMap(plan),
        });
        if (html) await writeText(plan.indexHtmlPath, html, { kind: "html" });
      }

      // ⑤ manifest 最后写：列出包内其余全部文件
      const manifest = buildManifest(doc, plan, docRel, files, new Date().toISOString());
      await writeText(plan.manifestPath, serializeManifest(manifest), { kind: "manifest" });

      bridge.notify(`已导出工程包 ${plan.dir}/（${files.length} 个文件${missingAssets ? `，${missingAssets} 个位图缺失未入包` : ""}）`);
    } catch {
      bridge.notify("工程包导出失败，请重试", "error");
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
        <MenuItem icon={<Upload size={13} />} title="位图落到画布并登记资产（png/jpg/gif/webp/avif…）" onClick={() => pickFiles("image/*")}>
          导入图片…
        </MenuItem>
        <MenuItem icon={<FileCode2 size={13} />} title="SVG 解析为可编辑矢量节点（渐变/蒙版/滤镜降级）" onClick={() => pickFiles(".svg,image/svg+xml")}>
          导入 SVG…
        </MenuItem>
        <MenuItem icon={<FilePlus size={13} />} title="另一份 *.uidesign.json 并入本档：页/组件/实例整体重映射 id" onClick={() => pickFiles(".json,application/json")}>
          导入设计档…
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
        <MenuItem
          icon={<FolderDown size={13} />}
          disabled={exporting}
          title="写工作区目录包：源档副本 + 逐画板 PNG + 外链资产 + 原型 index.html + manifest"
          onClick={() => void doExportBundle()}
        >
          导出工程包
        </MenuItem>
      </Menu>
      <input ref={fileRef} type="file" multiple hidden onChange={onPicked} />
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
