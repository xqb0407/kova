/**
 * Deck 状态核（CanvasDoc v2：objects + frames 双容器）：
 *   文档 + 选择 + 撤销历史 + 桥生命周期。
 * 写路径：mutation → commit(doc) → 800ms 防抖 bridge.change → 宿主 doc.saved → dirty 清。
 * 外部（agent）写盘到达 doc.open{external}：本地干净直接应用；有未保存改动挂冲突
 * 对话框（载入外部/保留本地），绝不静默覆盖。
 *
 * 元素级操作一律以 containerId 寻址：CANVAS_ROOT("root") = 画布级 objects，
 * 其余 = frames 里某页框的 elements（框内局部坐标）。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { bridge } from "./bridge";
import { buildStarterDeck, buildTemplateFrame } from "./templates";
import {
  blankDoc,
  blankFrame,
  CANVAS_ROOT,
  nextFramePos,
  parseDoc,
  resizeFrames,
  serializeDoc,
  tidyLayout,
  titleFrame,
  uiStarterDoc,
  uid,
  type Box,
  type CanvasDoc,
  type DocKind,
  type El,
  type Frame,
  type ImageEl,
  type PagePreset,
  type SlideTransition,
} from "./doc";
import { preloadDocAssets } from "./render";
import { syncBoundArrows } from "./bind";
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

/** 选中集合：容器（"root"=画布级 objects，其余=页框 id）+ 框内元素 id */
export type Sel = { containerId: string; elIds: string[] };

/** 外壳模式：board=白板画布（只编辑 objects）；deck=幻灯片（只编辑当前页框 elements） */
export type Surface = "board" | "deck";

export type DeckStore = ReturnType<typeof useDeck>;

/** 与宿主 assetsDirFor 同规则：`dir/base.ext` → `dir/base-assets` */
export function assetsDirForDoc(docPath: string | null): string {
  if (!docPath) return "assets";
  const cut = docPath.lastIndexOf("/");
  const dir = cut >= 0 ? docPath.slice(0, cut) : "";
  const base = (cut >= 0 ? docPath.slice(cut + 1) : docPath).replace(/\.[^.]*$/, "");
  return `${dir ? `${dir}/` : ""}${base}-assets`;
}

/** 新建幻灯片档的种子 JSON（聚合外壳首页「新建幻灯片」用；deck 编辑器内的新建走 store.createDoc） */
export function deckSeedJson(name: string, preset: PagePreset = "16:9"): string {
  const clean = name.trim().replace(/[/\\:*?"<>|？：＊｜＞＜＼／]/g, "");
  const d = blankDoc(preset, clean || "幻灯片", "deck");
  d.frames.push(blankFrame(preset));
  return serializeDoc(d);
}

/** 容器元素列表（root → objects；页框 → elements）；不存在返回 null */
export function containerEls(doc: CanvasDoc, containerId: string): El[] | null {
  if (containerId === CANVAS_ROOT) return doc.objects;
  return doc.frames.find((f) => f.id === containerId)?.elements ?? null;
}

/** 单选对齐的参照框：页框=画板本身；画布级无容器返回 null（对齐键只在幻灯片出现，见 Inspector 对齐区） */
function containerBox(doc: CanvasDoc, containerId: string): Box | null {
  if (containerId === CANVAS_ROOT) return null;
  const f = doc.frames.find((x) => x.id === containerId);
  return f ? { x: 0, y: 0, w: f.w, h: f.h } : null;
}

function jsonEquals(a: string, b: string): boolean {
  return a === b;
}

export function useDeck() {
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
  const [surface, setSurface] = useState<Surface>("board");

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

  /** 应用新文档（不改历史栈；undo/redo/外部开档共用）。opts.freshReset 清历史。
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

  /* ---------------- 桥生命周期（多播消费者：只处理画布档的帧） ---------------- */

  useEffect(() => {
    const isDeckFile = (path: string | null): boolean =>
      path === null ? false : /\.canvas\.json$/i.test(path);
    const detach = bridge.attach({
      onHandshake: (_theme, ctx) => {
        setConnected(true);
        if (ctx.fileRelPath && isDeckFile(ctx.fileRelPath)) {
          setFileRel(ctx.fileRelPath);
          setHasDoc(true);
        }
      },
      onDocOpen: (rev, json, external, path) => {
        void rev;
        // 聚合外壳下宿主帧是多播的：只消费画布档（.canvas.json）的 doc.open
        if (!isDeckFile(path)) return;
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
    // 聚合外壳下本视图挂载可能晚于宿主派发当前档：请求重推一次（幂等）
    bridge.requestDoc();
    // 双保险：桥已完成握手时直接视为已连接（attach 的补发握手正常会覆盖，
    // 这里兜住任何错过补发的路径，避免卡"正在连接工作区…"）
    if (!bridge.standalone && bridge.bridgeState !== "standalone") setConnected(true);
    return detach;
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

  const currentFrameId = doc.frames[0]?.id ?? "";
  /** 聚焦页框（选择所在框；root 选择/无选择回落第一框）。objects 不走这里 */
  const activeFrame =
    doc.frames.find((f) => f.id === (sel?.containerId ?? currentFrameId)) ?? doc.frames[0];
  /**
   * 元素操作默认落位容器（模式感知）：
   *   board 只编辑 objects：有选择（root）用选择，否则画布，绝不落不可见的页框；
   *   deck 只编辑当前页：有选择用选择容器，否则聚焦页框，无页框回落画布（外壳会引导先建页）。
   */
  const defaultContainerId =
    sel?.containerId ?? (surface === "deck" ? activeFrame?.id : undefined) ?? CANVAS_ROOT;

  /** 容器元素列表（root → objects；页框 → elements）；不存在返回 null */
  const mapContainer = useCallback(
    (containerId: string, fn: (els: El[]) => El[]): CanvasDoc | null => {
      const cur = docRef.current;
      if (containerId === CANVAS_ROOT) return { ...cur, objects: fn(cur.objects) };
      const idx = cur.frames.findIndex((f) => f.id === containerId);
      if (idx < 0) return null;
      const frames = cur.frames.slice();
      frames[idx] = { ...frames[idx], elements: fn(frames[idx].elements) };
      return { ...cur, frames };
    },
    [],
  );

  /* ---------------- 元素级 mutation（按容器寻址） ---------------- */

  const updateEl = useCallback(
    (containerId: string, elId: string, patch: Partial<El> | ((el: El) => El), coalesce?: boolean) => {
      const next = mapContainer(containerId, (els) =>
        els.map((el) =>
          el.id === elId
            ? typeof patch === "function"
              ? patch(el)
              : ({ ...el, ...patch } as El)
            : el,
        ),
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

  /** 拖入/粘贴/文件选择的图片：经桥落盘资产 + 放 400×300 ImageEl（at=容器局部坐标左上角） */
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
      const owner =
        containerId === CANVAS_ROOT ? null : docRef.current.frames.find((f) => f.id === containerId) ?? null;
      if (containerId !== CANVAS_ROOT && !owner) return;
      const el: ImageEl = {
        kind: "image",
        id: uid("i"),
        src: `${assetsDirForDoc(fileRelRef.current)}/${name}`,
        x: Math.round(at?.x ?? (owner ? owner.w / 2 - 200 : 80)),
        y: Math.round(at?.y ?? (owner ? owner.h / 2 - 150 : 80)),
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
    const next = mapContainer(sel.containerId, (els) => els.filter((e) => !ids.has(e.id)));
    if (next) commit(next);
    setSel(null);
  }, [sel, mapContainer, commit]);

  const duplicateSelected = useCallback(() => {
    if (!sel || sel.elIds.length === 0) return;
    const ids = new Set(sel.elIds);
    let newIds: string[] = [];
    const next = mapContainer(sel.containerId, (els) => {
      const copies = regroupCopies(
        els.filter((e) => ids.has(e.id)),
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
        els.map((e) => (ids.has(e.id) ? { ...e, x: e.x + dx, y: e.y + dy } : e)),
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
   * 6 向对齐：多选相对组框；单选相对容器（页框画板）。
   * 对齐键只在幻灯片（deck）浮动条出现——无限画布没有可对齐的参照边。
   */
  const alignSelected = useCallback(
    (mode: AlignMode) => {
      if (!sel) return;
      mutateSelected((els) => {
        const ids = new Set(sel.elIds);
        const items = els.filter((e) => ids.has(e.id)).map((e) => ({ id: e.id, box: boxOf(e) }));
        const refBox: Box | null =
          (items.length > 1 ? unionBox(items.map((i) => i.box)) : null) ??
          containerBox(docRef.current, sel.containerId);
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

  /** 粘贴到当前容器：级联偏移，重复粘贴每次 +20px；剪贴板为空返回 false */
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

  /** ⌘A：全选当前容器元素 */
  const selectAllInContainer = useCallback(() => {
    const els = containerEls(docRef.current, defaultContainerId);
    if (!els || els.length === 0) return;
    setSel({ containerId: defaultContainerId, elIds: els.map((e) => e.id) });
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

  /* ---------------- 页框级 mutation ---------------- */

  const selectFrame = useCallback((containerId: string) => {
    const idx = docRef.current.frames.findIndex((f) => f.id === containerId);
    if (idx >= 0) setSel({ containerId, elIds: [] });
  }, []);

  const addFrame = useCallback(
    (opts?: { title?: boolean; at?: { x: number; y: number } }) => {
      const preset = docRef.current.meta.pagePreset;
      const at = opts?.at ?? nextFramePos(docRef.current.frames);
      const frame = opts?.title ? titleFrame(preset, "新标题页", "", at) : blankFrame(preset, at);
      const idx = Math.max(
        0,
        docRef.current.frames.findIndex((f) => f.id === (sel?.containerId ?? "")),
      );
      const frames = docRef.current.frames.slice();
      frames.splice(idx + 1, 0, frame);
      commit({ ...docRef.current, frames });
      setSel({ containerId: frame.id, elIds: [] });
    },
    [docRef, sel, commit],
  );

  /** 模板库：主题+版式 → 新页（追加在最后，落位在现有页右侧一排） */
  const insertTemplateFrame = useCallback(
    (themeId: string, layoutId: string) => {
      const preset = docRef.current.meta.pagePreset;
      const frame = buildTemplateFrame(themeId, layoutId, preset, nextFramePos(docRef.current.frames));
      if (!frame) return;
      commit({ ...docRef.current, frames: [...docRef.current.frames, frame] });
      setSel({ containerId: frame.id, elIds: [] });
    },
    [commit],
  );

  /** 模板库：整套起步页（封面→目录→章节→要点→数据→结尾），空档也能一键拉起 */
  const applyStarterDeck = useCallback(
    (themeId: string) => {
      const preset = docRef.current.meta.pagePreset;
      const built = buildStarterDeck(themeId, preset, nextFramePos(docRef.current.frames));
      if (built.length === 0) return;
      commit({ ...docRef.current, frames: [...docRef.current.frames, ...built] });
      setSel({ containerId: built[0]!.id, elIds: [] });
    },
    [commit],
  );

  const duplicateFrame = useCallback(
    (frameId: string) => {
      const idx = docRef.current.frames.findIndex((f) => f.id === frameId);
      if (idx < 0) return;
      const copy: Frame = structuredClone(docRef.current.frames[idx]);
      copy.id = uid("s");
      const at = nextFramePos(docRef.current.frames);
      copy.x = at.x;
      copy.y = at.y;
      const frames = docRef.current.frames.slice();
      frames.splice(idx + 1, 0, copy);
      commit({ ...docRef.current, frames });
      setSel({ containerId: copy.id, elIds: [] });
    },
    [commit],
  );

  /** 删页：允许删到 0 页（deck 空态引导新建；objects 可能仍在白板上） */
  const removeFrame = useCallback(
    (frameId: string) => {
      const frames = docRef.current.frames;
      const idx = frames.findIndex((f) => f.id === frameId);
      if (idx < 0) return;
      const next = frames.filter((f) => f.id !== frameId);
      commit({ ...docRef.current, frames: next });
      const target = next[Math.min(idx, next.length - 1)];
      setSel(target ? { containerId: target.id, elIds: [] } : null);
    },
    [commit],
  );

  /** 拖拽页框名称标签的落位提交（框内局部坐标不变，内容跟随） */
  const setFramePos = useCallback(
    (frameId: string, x: number, y: number, coalesce?: boolean) => {
      const idx = docRef.current.frames.findIndex((f) => f.id === frameId);
      if (idx < 0) return;
      const frames = docRef.current.frames.slice();
      frames[idx] = { ...frames[idx], x: Math.round(x), y: Math.round(y) };
      commit({ ...docRef.current, frames }, { coalesce });
    },
    [commit],
  );

  /** 缩略图栏拖拽调页序（数组序=放映/导出页序，不动画布位置） */
  const moveFrame = useCallback(
    (from: number, to: number) => {
      const frames = docRef.current.frames.slice();
      if (from < 0 || from >= frames.length || to < 0 || to >= frames.length || from === to) return;
      const [f] = frames.splice(from, 1);
      frames.splice(to, 0, f);
      commit({ ...docRef.current, frames });
    },
    [commit],
  );

  /** 一键整理：全部页框网格归位（幂等） */
  const tidyFrames = useCallback(() => {
    commit(tidyLayout(docRef.current));
  }, [commit]);

  const setFrameBackground = useCallback(
    (frameId: string, background: string) => {
      const idx = docRef.current.frames.findIndex((f) => f.id === frameId);
      if (idx < 0) return;
      const frames = docRef.current.frames.slice();
      frames[idx] = { ...frames[idx], background };
      commit({ ...docRef.current, frames }, { coalesce: true });
    },
    [commit],
  );

  /** 页切换动画：undefined/"slide" 归一为缺省（不落 transition 键） */
  const setFrameTransition = useCallback(
    (frameId: string, transition: SlideTransition) => {
      const idx = docRef.current.frames.findIndex((f) => f.id === frameId);
      if (idx < 0) return;
      const frames = docRef.current.frames.slice();
      const next = { ...frames[idx] };
      if (transition === "slide") delete next.transition;
      else next.transition = transition;
      frames[idx] = next;
      commit({ ...docRef.current, frames });
    },
    [commit],
  );

  const setPreset = useCallback(
    (preset: PagePreset) => {
      commit(resizeFrames(docRef.current, preset));
    },
    [commit],
  );

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

  const createDoc = useCallback((name: string, preset: PagePreset, kind: DocKind = "board") => {
    // 半角 + 全角都挡：全角？：＊｜等在 Windows/同步盘上会炸，macOS 上留着也是隐患
    const clean = name.trim().replace(/[/\\:*?"<>|？：＊｜＞＜＼／]/g, "");
    if (!clean) return;
    /** 幻灯片自带一张空白页；UI 设计档自带三块移动端设备画板（进去就能继续画） */
    const seed = () => {
      if (kind === "ui") return uiStarterDoc(clean);
      const d = blankDoc(preset, clean, kind);
      if (kind === "deck") d.frames.push(blankFrame(preset));
      return d;
    };
    if (bridge.standalone) {
      // 开发态（浏览器直开）没有宿主落盘：本地新建，change 自动走 localStorage
      applyDoc(seed(), { freshReset: true });
      setFileRel(null);
      setHasDoc(true);
      setDocLoaded(true);
      return;
    }
    // office 新档认领 `*.deck.canvas.json`（宿主面板路由按后缀匹配；用户显式带后缀则尊重）
    const rel = /\.canvas\.json$/i.test(clean) ? clean : `${clean}.deck.canvas.json`;
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
    activeFrame,
    defaultContainerId,
    surface,
    setSurface,
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
    selectFrame,
    addFrame,
    insertTemplateFrame,
    applyStarterDeck,
    duplicateFrame,
    removeFrame,
    setFramePos,
    moveFrame,
    tidyFrames,
    setFrameBackground,
    setFrameTransition,
    setPreset,
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
