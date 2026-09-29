/**
 * 画布状态核（CanvasDoc v3：纯 objects 无限画布）：
 *   文档 + 选择 + 撤销历史 + 桥生命周期。
 * 写路径：mutation → commit(doc) → 800ms 防抖 bridge.change → 宿主 doc.saved → dirty 清。
 * 外部（agent）写盘到达 doc.open{external}：本地干净直接应用；有未保存改动挂冲突
 * 对话框（载入外部/保留本地），绝不静默覆盖。
 *
 * 元素全部落在画布级容器（CANVAS_ROOT = "root"）；containerId 保留在 Sel 形状里
 * 只为兼容既有调用面，取值恒为 root。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { bridge } from "./bridge";
import {
  blankDoc,
  CANVAS_ROOT,
  parseDoc,
  serializeDoc,
  uid,
  type CanvasDoc,
  type El,
  type ImageEl,
} from "./doc";
import { preloadDocAssets } from "./render";
import { syncBoundArrows } from "./bind";
import { domMeasure, fittedTextHeight } from "./textfit";
import {
  alignBoxes,
  boxOf,
  distributeBoxes,
  offsetPasted,
  regroupCopies,
  reorderForZ,
  unionBox,
  type AlignMode,
} from "./geometry";

export const HISTORY_MAX = 50;
const SAVE_DEBOUNCE_MS = 800;
/** 连续微调（字号步进/透明度滑杆/拖动中的中间态）合并为一次历史 */
const COALESCE_MS = 500;

/** 选中集合：containerId 恒为 CANVAS_ROOT（保留字段兼容既有调用面） */
export type Sel = { containerId: string; elIds: string[] };

export type CanvasStore = ReturnType<typeof useCanvas>;

/** 与宿主 assetsDirFor 同规则：`dir/base.ext` → `dir/base-assets` */
export function assetsDirForDoc(docPath: string | null): string {
  if (!docPath) return "assets";
  const cut = docPath.lastIndexOf("/");
  const dir = cut >= 0 ? docPath.slice(0, cut) : "";
  const base = (cut >= 0 ? docPath.slice(cut + 1) : docPath).replace(/\.[^.]*$/, "");
  return `${dir ? `${dir}/` : ""}${base}-assets`;
}

/** 画布级元素列表（= doc.objects）；containerId 非 root 时返回 null（保留字段兼容既有调用面） */
export function containerEls(doc: CanvasDoc, containerId: string): El[] | null {
  if (containerId !== CANVAS_ROOT) return null;
  return doc.objects;
}

function jsonEquals(a: string, b: string): boolean {
  return a === b;
}

export function useCanvas() {
  const [doc, setDocState] = useState<CanvasDoc>(() => blankDoc());
  const docRef = useRef(doc);
  const [fileRel, setFileRel] = useState<string | null>(null);
  const [hasDoc, setHasDoc] = useState(false);
  /** 文档内容真正到达过（doc.open 解析成功或本地新建）——握手带 path 不算 */
  const [docLoaded, setDocLoaded] = useState(false);
  const [connected, setConnected] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [sel, setSel] = useState<Sel | null>(null);
  const [conflict, setConflict] = useState<{ json: string } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  /** 绑定的文档在盘上但解析失败：编辑器顶部持久横幅（4 秒 toast 会被错过，只剩"空画布"像插件坏了） */
  const [docCorrupt, setDocCorrupt] = useState(false);

  const historyRef = useRef<{ past: string[]; future: string[]; lastAt: number; lastJson: string }>({
    past: [],
    future: [],
    lastAt: 0,
    lastJson: "",
  });
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fileRelRef = useRef<string | null>(null);
  fileRelRef.current = fileRel;
  const dirtyRef = useRef(false);
  dirtyRef.current = dirty;
  /** 应用内元素剪贴板（⌘C/⌘X/⌘V）；粘贴按次数级联 +20px */
  const clipboardRef = useRef<El[]>([]);
  const pasteSeqRef = useRef(0);

  const notifyLater = useCallback((text: string) => {
    setNotice(text);
    setTimeout(() => setNotice((n) => (n === text ? null : n)), 4000);
  }, []);

  const sendSoon = useCallback((next: CanvasDoc) => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      saveTimer.current = null;
      bridge.change(serializeDoc(docRef.current));
    }, SAVE_DEBOUNCE_MS);
  }, []);

  /** 应用新文档（不改历史栈；undo/redo/外部开档共用）。
   *  统一入口先同步连线绑定（Excalidraw 式：被绑元素动了端点跟着动） */
  const applyDoc = useCallback(
    (raw: CanvasDoc, opts?: { freshReset?: boolean; markDirty?: boolean }) => {
      const next = syncBoundArrows(raw);
      if (opts?.freshReset) {
        historyRef.current = { past: [], future: [], lastAt: 0, lastJson: serializeDoc(next) };
        setSel(null);
      }
      docRef.current = next;
      setDocState(next);
      preloadDocAssets(next);
      setDocCorrupt(false);
      if (opts?.markDirty !== false) setDirty(true);
    },
    [],
  );

  /**
   * 唯一写入口。opts.coalesce=true：连续微调节流记录历史；
   * opts.pushBefore：显式声明"本次变更前压栈"（离散操作默认 true）。
   */
  const commit = useCallback(
    (next: CanvasDoc, opts?: { coalesce?: boolean }) => {
      const h = historyRef.current;
      const curJson = serializeDoc(docRef.current);
      const now = Date.now();
      const coalescing =
        !!opts?.coalesce && now - h.lastAt < COALESCE_MS && h.lastJson !== "";
      if (!coalescing) {
        h.past.push(curJson);
        if (h.past.length > HISTORY_MAX) h.past.shift();
        h.future = [];
        h.lastAt = now;
        h.lastJson = curJson;
      } else {
        h.lastAt = now;
      }
      // 先同步绑定再发盘：回写的 JSON 与内存/渲染一致（二次 sync 幂等）
      const synced = syncBoundArrows(next);
      applyDoc(synced);
      sendSoon(synced);
    },
    [applyDoc, sendSoon],
  );

  /* ---------------- 桥生命周期 ---------------- */

  useEffect(() => {
    bridge.attach({
      onHandshake: (_theme, ctx) => {
        setConnected(true);
        if (ctx.fileRelPath) {
          setFileRel(ctx.fileRelPath);
          setHasDoc(true);
        }
        bridge.requestDoc();
      },
      onDocOpen: (rev, json, external, path) => {
        void rev;
        if (path) {
          setFileRel(path);
          setHasDoc(true);
        }
        let parsed: CanvasDoc | null = null;
        try {
          parsed = parseDoc(JSON.parse(json));
        } catch {
          parsed = null;
        }
        if (!parsed) {
          // 盘上有档但读不回来：置持久横幅。注意此时**不发 doc.change**，
          // 编辑器的空态不会被写回覆盖掉坏档（保留用户修复的机会）。
          setDocCorrupt(true);
          notifyLater("文档不是有效的画布 JSON，已保持原内容");
          return;
        }
        setDocLoaded(true);
        if (!external) {
          applyDoc(parsed, { freshReset: true, markDirty: false });
          return;
        }
        // 外部更新：内容相同忽略；本地有未保存改动 → 冲突挂起
        if (jsonEquals(serializeDoc(parsed), serializeDoc(docRef.current))) return;
        const localDirty =
          dirtyRef.current ||
          (saveTimer.current !== null && serializeDoc(docRef.current) !== historyRef.current.lastJson);
        if (localDirty) {
          setConflict({ json });
        } else {
          applyDoc(parsed, { freshReset: true });
          sendSoon(parsed);
        }
      },
      onSaved: () => {
        setDirty(false);
        dirtyRef.current = false;
      },
      onDocError: (text) => notifyLater(text),
      onTheme: () => {},
      onAssetReply: () => {},
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const resolveConflict = useCallback(
    (mode: "reload" | "keep") => {
      if (!conflict) return;
      if (mode === "reload") {
        try {
          const parsed = parseDoc(JSON.parse(conflict.json));
          if (parsed) {
            applyDoc(parsed, { freshReset: true });
            sendSoon(parsed);
          }
        } catch {
          notifyLater("外部内容解析失败");
        }
      }
      setConflict(null);
    },
    [conflict, applyDoc, sendSoon, notifyLater],
  );

  /* ---------------- 当前上下文 ---------------- */

  /** 元素操作默认落位容器：有选择用选择容器，否则画布（root） */
  const defaultContainerId = sel?.containerId ?? CANVAS_ROOT;

  /** 容器元素列表（恒为 objects）；不存在返回 null */
  const mapContainer = useCallback(
    (containerId: string, fn: (els: El[]) => El[]): CanvasDoc | null => {
      const cur = docRef.current;
      if (containerId !== CANVAS_ROOT) return null;
      return { ...cur, objects: fn(cur.objects) };
    },
    [],
  );

  /* ---------------- 元素级 mutation ---------------- */

  const updateEl = useCallback(
    (containerId: string, elId: string, patch: Partial<El> | ((el: El) => El), coalesce?: boolean) => {
      const next = mapContainer(containerId, (els) =>
        els.map((el) => {
          if (el.id !== elId) return el;
          const out = typeof patch === "function" ? patch(el) : ({ ...el, ...patch } as El);
          // 文本自动增高（只增不减）：内容/字号变化后防止溢出固定 h 被裁切
          if (out.kind === "text") {
            const h = fittedTextHeight(out, domMeasure);
            if (h > out.h) return { ...out, h } as El;
          }
          return out;
        }),
      );
      if (next) commit(next, { coalesce });
    },
    [mapContainer, commit],
  );

  const addEl = useCallback(
    (containerId: string, el: El) => {
      const next = mapContainer(containerId, (els) => [...els, el]);
      if (next) commit(next);
      setSel({ containerId, elIds: [el.id] });
    },
    [mapContainer, commit],
  );

  /** 拖入/粘贴/文件选择的图片：经桥落盘资产 + 放 400×300 ImageEl（at=画布绝对坐标左上角） */
  const insertImageFromFile = useCallback(
    async (
      file: File,
      at?: { containerId?: string; x?: number; y?: number },
    ) => {
      const ext = (/\.([a-z0-9]+)$/i.exec(file.name)?.[1] ?? "png").toLowerCase();
      const name = `${file.name.replace(/\.[^.]*$/, "").slice(0, 40) || "image"}-${Date.now().toString(36)}.${ext}`;
      const dataUrl = await new Promise<string>((res, rej) => {
        const fr = new FileReader();
        fr.onload = () => res(String(fr.result));
        fr.onerror = () => rej(new Error("read-failed"));
        fr.readAsDataURL(file);
      });
      bridge.attachFile(name, dataUrl.slice(dataUrl.indexOf(",") + 1));
      const containerId = at?.containerId ?? defaultContainerId;
      if (containerId !== CANVAS_ROOT) return;
      const el: ImageEl = {
        kind: "image",
        id: uid("i"),
        src: `${assetsDirForDoc(fileRelRef.current)}/${name}`,
        x: Math.round(at?.x ?? 80),
        y: Math.round(at?.y ?? 80),
        w: 400,
        h: 300,
        fit: "cover",
      };
      addEl(containerId, el);
    },
    [defaultContainerId, addEl],
  );

  const deleteSelected = useCallback(() => {
    if (!sel || sel.elIds.length === 0) return;
    const ids = new Set(sel.elIds);
    const els = containerEls(docRef.current, sel.containerId);
    if (!els) return;
    if (!els.some((e) => ids.has(e.id) && !e.locked)) return; // 全是锁定：不产生历史
    const next = mapContainer(sel.containerId, (list) => list.filter((e) => !ids.has(e.id) || e.locked));
    if (next) commit(next);
    setSel(null);
  }, [sel, mapContainer, commit]);

  const duplicateSelected = useCallback(() => {
    if (!sel || sel.elIds.length === 0) return;
    const ids = new Set(sel.elIds);
    let newIds: string[] = [];
    const next = mapContainer(sel.containerId, (els) => {
      const copies = regroupCopies(
        els.filter((e) => ids.has(e.id) && !e.locked),
      ).map((e) => {
        const copy = { ...structuredClone(e), id: uid("c"), x: e.x + 20, y: e.y + 20 } as El;
        newIds.push(copy.id);
        return copy;
      });
      return [...els, ...copies];
    });
    if (!next) return;
    commit(next);
    setSel({ containerId: sel.containerId, elIds: newIds });
  }, [sel, mapContainer, commit]);

  /** 组合选中元素：统一挂新 groupId（一层扁平标注，不嵌套；导出无感知） */
  const groupSelected = useCallback(() => {
    if (!sel || sel.elIds.length < 2) return;
    const ids = new Set(sel.elIds);
    const gid = `g${Math.random().toString(36).slice(2, 10)}`;
    const next = mapContainer(sel.containerId, (els) =>
      els.map((el) => (ids.has(el.id) ? ({ ...el, groupId: gid } as El) : el)),
    );
    if (next) commit(next);
  }, [sel, mapContainer, commit]);

  /** 解组：清除选中元素所属的组标注（按组 id 整组清，避免残留半组） */
  const ungroupSelected = useCallback(() => {
    if (!sel || sel.elIds.length === 0) return;
    const ids = new Set(sel.elIds);
    const next = mapContainer(sel.containerId, (els) => {
      const gids = new Set(els.flatMap((e) => (ids.has(e.id) && e.groupId ? [e.groupId] : [])));
      if (gids.size === 0) return els;
      return els.map((el) => (el.groupId && gids.has(el.groupId) ? ({ ...el, groupId: undefined } as El) : el));
    });
    if (next) commit(next);
  }, [sel, mapContainer, commit]);

  /** nudge：方向键微调（commit 合并，按住连发不堆历史） */
  const nudge = useCallback(
    (dx: number, dy: number) => {
      if (!sel) return;
      const ids = new Set(sel.elIds);
      const next = mapContainer(sel.containerId, (els) =>
        els.map((e) => (ids.has(e.id) && !e.locked ? { ...e, x: e.x + dx, y: e.y + dy } : e)),
      );
      if (next) commit(next, { coalesce: true });
    },
    [sel, mapContainer, commit],
  );

  /** 拖拽/缩放结束的整体落位（elements 已含最终几何） */
  const setContainerElements = useCallback(
    (containerId: string, elements: El[]) => {
      const next = mapContainer(containerId, () => elements);
      if (next) commit(next);
    },
    [mapContainer, commit],
  );

  /* ---------------- 选择集合操作（对齐/分布/图层/剪贴板/轮换） ---------------- */

  /** 以回调方式改当前容器被选元素并整体提交；no-op 安全 */
  const mutateSelected = useCallback(
    (fn: (els: El[]) => El[] | null) => {
      if (!sel || sel.elIds.length === 0) return;
      const next = mapContainer(sel.containerId, (els) => {
        const out = fn(els);
        return out ?? els;
      });
      if (!next) return;
      commit(next);
    },
    [sel, mapContainer, commit],
  );

  /**
   * 6 向对齐：多选相对组并盒（单选无可参照的容器边，no-op——
   * 无限画布没有画板边界可对齐）。
   */
  const alignSelected = useCallback(
    (mode: AlignMode) => {
      if (!sel) return;
      mutateSelected((els) => {
        const ids = new Set(sel.elIds);
        const items = els.filter((e) => ids.has(e.id)).map((e) => ({ id: e.id, box: boxOf(e) }));
        if (items.length < 2) return null;
        const refBox = unionBox(items.map((i) => i.box));
        if (!refBox) return null;
        const moves = alignBoxes(items, mode, refBox);
        return els.map((e) => {
          const m = moves.get(e.id);
          return m ? ({ ...e, x: m.x, y: m.y } as El) : e;
        });
      });
    },
    [mutateSelected, sel],
  );

  /** 等间隙分布（≥3 生效） */
  const distributeSelected = useCallback(
    (axis: "h" | "v") => {
      mutateSelected((els) => {
        const ids = new Set(sel!.elIds);
        const items = els.filter((e) => ids.has(e.id)).map((e) => ({ id: e.id, box: boxOf(e) }));
        const moves = distributeBoxes(items, axis);
        return els.map((e) => {
          const m = moves.get(e.id);
          return m ? ({ ...e, x: m.x, y: m.y } as El) : e;
        });
      });
    },
    [mutateSelected, sel],
  );

  /** z 序：置于顶层/底层、上移/下移一层 */
  const moveSelectedZ = useCallback(
    (mode: "front" | "back" | "forward" | "backward") => {
      mutateSelected((els) => reorderForZ(els, new Set(sel!.elIds), mode));
    },
    [mutateSelected, sel],
  );

  /** 复制选中元素到应用内剪贴板 */
  const copySelected = useCallback(() => {
    if (!sel || sel.elIds.length === 0) return;
    const ids = new Set(sel.elIds);
    const els = containerEls(docRef.current, sel.containerId);
    if (!els) return;
    clipboardRef.current = els.filter((e) => ids.has(e.id)).map((e) => structuredClone(e));
    pasteSeqRef.current = 0;
  }, [sel]);

  const cutSelected = useCallback(() => {
    copySelected();
    deleteSelected();
  }, [copySelected, deleteSelected]);

  /** 粘贴到画布：级联偏移，重复粘贴每次 +20px；剪贴板为空返回 false */
  const pasteClipboard = useCallback(() => {
    const clip = clipboardRef.current;
    if (clip.length === 0) return false;
    const containerId = defaultContainerId;
    if (!containerEls(docRef.current, containerId)) return false;
    pasteSeqRef.current += 1;
    const off = pasteSeqRef.current * 20;
    const pasted = regroupCopies(offsetPasted(clip, off, off, (old) => uid(old.split("-")[0] ?? "e")));
    const next = mapContainer(containerId, (els) => [...els, ...pasted]);
    if (next) commit(next);
    setSel({ containerId, elIds: pasted.map((e) => e.id) });
    return true;
  }, [defaultContainerId, mapContainer, commit]);

  /** ⌘A：全选画布元素（锁定元素不参与） */
  const selectAllInContainer = useCallback(() => {
    const els = containerEls(docRef.current, defaultContainerId);
    if (!els || els.length === 0) return;
    const ids = els.filter((e) => !e.locked).map((e) => e.id);
    if (ids.length === 0) return;
    setSel({ containerId: defaultContainerId, elIds: ids });
  }, [defaultContainerId]);

  /** Tab/⇧Tab：沿数组顺序轮换单选 */
  const cycleSelection = useCallback(
    (dir: 1 | -1) => {
      const els = containerEls(docRef.current, defaultContainerId);
      if (!els || els.length === 0) return;
      const cur = sel?.containerId === defaultContainerId ? sel.elIds[0] : undefined;
      const idx = cur ? els.findIndex((e) => e.id === cur) : -1;
      const nextIdx = (((idx < 0 ? (dir === 1 ? 0 : -1) : idx + dir) % els.length) + els.length) % els.length;
      const next = els[nextIdx];
      if (next) setSel({ containerId: defaultContainerId, elIds: [next.id] });
    },
    [defaultContainerId, sel],
  );

  /** 当前被选元素（右键菜单/浮条判能用） */
  const selectedEls = useCallback((): El[] => {
    if (!sel) return [];
    const ids = new Set(sel.elIds);
    const els = containerEls(docRef.current, sel.containerId);
    return els ? els.filter((e) => ids.has(e.id)) : [];
  }, [sel]);

  /* ---------------- 撤销/重做 ---------------- */

  const undo = useCallback(() => {
    const h = historyRef.current;
    if (h.past.length === 0) return;
    const cur = serializeDoc(docRef.current);
    const prev = h.past.pop()!;
    h.future.push(cur);
    const parsed = parseDoc(JSON.parse(prev));
    if (parsed) applyDoc(parsed, { markDirty: true });
    sendSoon(parsed ?? docRef.current);
  }, [applyDoc, sendSoon]);

  const redo = useCallback(() => {
    const h = historyRef.current;
    if (h.future.length === 0) return;
    const cur = serializeDoc(docRef.current);
    const nextJson = h.future.pop()!;
    h.past.push(cur);
    const parsed = parseDoc(JSON.parse(nextJson));
    if (parsed) applyDoc(parsed);
    sendSoon(parsed ?? docRef.current);
  }, [applyDoc, sendSoon]);

  /* ---------------- 新建/另存 ---------------- */

  const createDoc = useCallback((name: string) => {
    // 半角 + 全角都挡：全角？：＊｜等在 Windows/同步盘上会炸，macOS 上留着也是隐患
    const clean = name.trim().replace(/[/\\:*?"<>|？：＊｜＞＜＼／]/g, "");
    if (!clean) return;
    const seed = () => blankDoc(clean);
    if (bridge.standalone) {
      // 开发态（浏览器直开）没有宿主落盘：本地新建，change 自动走 localStorage
      applyDoc(seed(), { freshReset: true });
      setFileRel(null);
      setHasDoc(true);
      setDocLoaded(true);
      return;
    }
    const rel = /\.canvas\.json$/i.test(clean) ? clean : `${clean}.canvas.json`;
    bridge.create(rel, serializeDoc(seed()));
  }, [applyDoc]);

  const flushSave = useCallback(() => {
    if (saveTimer.current) {
      clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    bridge.change(serializeDoc(docRef.current));
  }, []);

  return {
    doc,
    docRef,
    fileRel,
    fileRelRef,
    hasDoc,
    docLoaded,
    connected,
    dirty,
    sel,
    setSel,
    defaultContainerId,
    conflict,
    resolveConflict,
    notice,
    commit,
    applyDoc,
    sendSoon,
    updateEl,
    addEl,
    insertImageFromFile,
    deleteSelected,
    duplicateSelected,
    groupSelected,
    ungroupSelected,
    nudge,
    setContainerElements,
    alignSelected,
    distributeSelected,
    moveSelectedZ,
    copySelected,
    cutSelected,
    pasteClipboard,
    selectAllInContainer,
    cycleSelection,
    selectedEls,
    hasClipboard: () => clipboardRef.current.length > 0,
    undo,
    redo,
    createDoc,
    flushSave,
    notifyLater,
    docCorrupt,
    dismissDocCorrupt: () => setDocCorrupt(false),
    canUndo: historyRef.current.past.length > 0,
    canRedo: historyRef.current.future.length > 0,
  };
}
