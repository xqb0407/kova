/**
 * 设计台状态核（DesignDoc）：
 *   文档 + 页面内选择集 + 撤销历史(50 步/500ms 合并) + 桥生命周期(800ms 防抖写盘)
 *   + 外部冲突框 + 损坏档横幅 + 应用内剪贴板(子树深复制重发 id) + 视口。
 *
 * 写路径唯一：mutation → commit(doc) → sendSoon → bridge.change → doc.saved 清 dirty。
 * 外部（agent）写盘到达 doc.open{external}：本地干净直接应用；有未保存改动挂冲突框。
 * 树操作全部 immutable 重建（mapNodes）；几何一致性靠 geometry.normalizeGroups/deriveGroupBox。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { bridge } from "./bridge";
import {
  DEVICE_PRESETS,
  blankDoc,
  newNode,
  newFrame,
  parseDesignDoc,
  serializeDoc,
  starterDoc,
  uid,
  findNode,
  type DesignDoc,
  type DesignNode,
  type NodeType,
  type Page,
  type TextRun,
} from "./doc";
import {
  applyAlign,
  normalizeGroups,
  round1,
  selectionWorldBox,
  unionBox,
  worldBoxOf,
  aabbRotated,
  type AlignMode,
  type Box,
} from "./geometry";
import { preloadDocAssets } from "./leafer/assets";

export const HISTORY_MAX = 50;
const SAVE_DEBOUNCE_MS = 800;
const COALESCE_MS = 500;

/**
 * 全局「拖拽微调会话」：NumField 标签横向 scrub 期间置 true，
 * commit 把这一串连续写入全部按 coalesce 合并 —— 一次拖拽 = 一步撤销。
 */
export const scrubSession = { active: false };

export type Tool =
  | "select"
  | "hand"
  | "frame"
  | "text"
  | NodeType;

/** 选择集：页面 + 节点 id（文档树全局定位，不依赖容器寻址） */
export type Sel = { pageId: string; ids: string[] };
/** 视口：screen = world·s + (tx,ty) */
export type View = { s: number; tx: number; ty: number };

/** 与宿主 assetsDirFor 同规则：dir/base.ext → dir/base-assets */
export function assetsDirForDoc(docPath: string | null): string {
  if (!docPath) return "assets";
  const cut = docPath.lastIndexOf("/");
  const dir = cut >= 0 ? docPath.slice(0, cut) : "";
  const base = (cut >= 0 ? docPath.slice(cut + 1) : docPath).replace(/\.[^.]*$/, "");
  return `${dir ? `${dir}/` : ""}${base}-assets`;
}

/* ---------------- 纯树工具（immutable） ---------------- */

/** 递归映射整棵列表：fn 返回替换节点；deleteFor 命中则连同子树移除 */
function mapNodes(nodes: DesignNode[], fn: (n: DesignNode) => DesignNode | null): DesignNode[] {
  const out: DesignNode[] = [];
  for (const n of nodes) {
    const hit = fn(n);
    if (hit === null) continue; // 删除（含子树）
    const next = "children" in hit ? { ...hit, children: mapNodes(hit.children, fn) } : hit;
    out.push(next);
  }
  return out;
}

/** 替换 id 命中的节点（fn 收到旧节点；返回 null = 删除） */
function replaceNode(nodes: DesignNode[], id: string, fn: (n: DesignNode) => DesignNode | null): DesignNode[] {
  return mapNodes(nodes, (n) => (n.id === id ? fn(n) : n));
}

/** 在 id 命中的兄弟列表内调用（回调收到数组并返回新数组）；同时探入子树 */
function mapSiblings(nodes: DesignNode[], id: string, fn: (list: DesignNode[], index: number) => DesignNode[]): DesignNode[] | null {
  const idx = nodes.findIndex((n) => n.id === id);
  if (idx >= 0) return fn(nodes, idx);
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i]!;
    if ("children" in n) {
      const sub = mapSiblings(n.children, id, fn);
      if (sub) {
        const copy = nodes.slice();
        copy[i] = { ...n, children: sub };
        return copy;
      }
    }
  }
  return null;
}

/** 子树 id 重发（深复制粘贴/组内克隆） */
function regenIds(n: DesignNode): DesignNode {
  const next = { ...n, id: uid(n.type[0]!) } as DesignNode;
  if ("children" in next) next.children = next.children.map(regenIds);
  return next;
}

const cloneNode = (n: DesignNode): DesignNode => regenIds(structuredClone(n));

export function useDesign() {
  const [doc, setDoc] = useState<DesignDoc>(() => blankDoc());
  const docRef = useRef(doc);
  const [fileRel, setFileRel] = useState<string | null>(null);
  const [docLoaded, setDocLoaded] = useState(false);
  const [connected, setConnected] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [sel, setSelState] = useState<Sel | null>(null);
  const [tool, setTool] = useState<Tool>("select");
  const [view, setViewState] = useState<View>({ s: 1, tx: 0, ty: 0 });
  const [conflict, setConflict] = useState<{ json: string } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [docCorrupt, setDocCorrupt] = useState(false);
  /** 就地文本编辑中的节点 id（DesignStage 挂 DOM overlay） */
  const [editingTextId, setEditingTextId] = useState<string | null>(null);

  const historyRef = useRef<{ past: string[]; future: string[]; lastAt: number; lastJson: string }>({
    past: [],
    future: [],
    lastAt: 0,
    lastJson: "",
  });
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dirtyRef = useRef(false);
  dirtyRef.current = dirty;
  const fileRelRef = useRef<string | null>(null);
  fileRelRef.current = fileRel;
  const clipboardRef = useRef<DesignNode[]>([]);
  const pasteSeqRef = useRef(0);
  const viewRef = useRef(view);
  viewRef.current = view;
  /** 视口 CSS 像素尺寸（DesignStage 上报；fit/zoomAt 用） */
  const sizeRef = useRef({ w: 1, h: 1 });

  const notifyLater = useCallback((text: string) => {
    setNotice(text);
    setTimeout(() => setNotice((n) => (n === text ? null : n)), 4000);
  }, []);

  const sendSoon = useCallback((next: DesignDoc) => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      saveTimer.current = null;
      bridge.change(serializeDoc(docRef.current));
      // standalone 没有宿主 doc.saved 回执：落 localStorage 即视为已保存
      if (bridge.standalone) setDirty(false);
    }, SAVE_DEBOUNCE_MS);
  }, []);

  const applyDoc = useCallback((raw: DesignDoc, opts?: { freshReset?: boolean; markDirty?: boolean }) => {
    const next = raw;
    if (opts?.freshReset) {
      historyRef.current = { past: [], future: [], lastAt: 0, lastJson: serializeDoc(next) };
      setSelState(null);
      setEditingTextId(null);
    }
    docRef.current = next;
    setDoc(next);
    preloadDocAssets(next);
    setDocCorrupt(false);
    if (opts?.markDirty !== false) setDirty(true);
  }, []);

  /** 唯一写入口；coalesce=连续微调合并历史 */
  const commit = useCallback(
    (next: DesignDoc, opts?: { coalesce?: boolean }) => {
      const h = historyRef.current;
      const curJson = serializeDoc(docRef.current);
      const now = Date.now();
      const coalescing = (!!opts?.coalesce || scrubSession.active) && now - h.lastAt < COALESCE_MS && h.lastJson !== "";
      if (!coalescing) {
        h.past.push(curJson);
        if (h.past.length > HISTORY_MAX) h.past.shift();
        h.future = [];
        h.lastAt = now;
        h.lastJson = curJson;
      } else {
        h.lastAt = now;
      }
      const fixed = cloneDoc(next);
      normalizeGroups(fixed);
      applyDoc(fixed);
      sendSoon(fixed);
    },
    [applyDoc, sendSoon],
  );

  /* ---------------- 桥生命周期 ---------------- */

  useEffect(() => {
    bridge.attach({
      onHandshake: (_theme, ctx) => {
        setConnected(true);
        if (ctx.fileRelPath) setFileRel(ctx.fileRelPath);
        bridge.requestDoc();
      },
      onDocOpen: (_rev, json, external, path) => {
        if (path) setFileRel(path);
        const res = parseDesignDoc(json);
        if (!res.doc || res.fatal) {
          // 盘上档不可用：持久横幅提示，且不发 doc.change（避免空态覆盖坏档）
          setDocCorrupt(true);
          notifyLater("文档不是有效的设计档 JSON，已保持原内容");
          return;
        }
        setDocLoaded(true);
        if (!external) {
          applyDoc(res.doc, { freshReset: true, markDirty: false });
          return;
        }
        if (serializeDoc(res.doc) === serializeDoc(docRef.current)) return;
        const localDirty =
          dirtyRef.current ||
          (saveTimer.current !== null && serializeDoc(docRef.current) !== historyRef.current.lastJson);
        if (localDirty) {
          setConflict({ json });
        } else {
          applyDoc(res.doc, { freshReset: true });
          sendSoon(res.doc);
        }
      },
      onSaved: () => setDirty(false),
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
        const res = parseDesignDoc(conflict.json);
        if (res.doc && !res.fatal) {
          applyDoc(res.doc, { freshReset: true });
          sendSoon(res.doc);
        } else notifyLater("外部内容解析失败");
      }
      setConflict(null);
    },
    [conflict, applyDoc, sendSoon, notifyLater],
  );

  /* ---------------- 当前上下文 ---------------- */

  const page: Page = useMemo(
    () => doc.pages.find((p) => p.id === doc.activePage) ?? doc.pages[0]!,
    [doc],
  );
  const selIds = sel && sel.pageId === page.id ? sel.ids : [];

  const setSel = useCallback(
    (ids: string[]) => {
      setSelState({ pageId: docRef.current.activePage, ids });
    },
    [],
  );

  /* ---------------- 文档级 mutation ---------------- */

  /** 以回调改活动页节点列表并提交 */
  const mutatePage = useCallback(
    (fn: (nodes: DesignNode[]) => DesignNode[], opts?: { coalesce?: boolean }) => {
      const cur = docRef.current;
      const p = (cur.pages.find((x) => x.id === cur.activePage) ?? cur.pages[0])!;
      const next: DesignDoc = {
        ...cur,
        pages: cur.pages.map((x) => (x.id === p.id ? { ...x, nodes: fn(x.nodes) } : x)),
      };
      commit(next, opts);
    },
    [commit],
  );

  /** 节点补丁（任意深度；null 函数 = 删除）。几何编辑高频路径。 */
  const updateNode = useCallback(
    (id: string, patch: Partial<DesignNode> | ((n: DesignNode) => DesignNode | null), opts?: { coalesce?: boolean }) => {
      mutatePage(
        (nodes) => replaceNode(nodes, id, (n) => (typeof patch === "function" ? patch(n) : ({ ...n, ...patch } as DesignNode))),
        opts,
      );
    },
    [mutatePage],
  );

  /** 落账批量应用（一次手势 = 一个 undo 步）；items 为 ledger 结果集 */
  const applyLedger = useCallback(
    (items: { id: string; patch: Record<string, unknown> }[]) => {
      if (items.length === 0) return;
      mutatePage((nodes) => {
        let out = nodes;
        for (const { id, patch } of items) {
          out = replaceNode(out, id, (n) => ({ ...n, ...patch } as DesignNode));
        }
        return out;
      });
    },
    [mutatePage],
  );

  /** 新建节点：parentId 缺省落页面级；返回新节点 id */
  const addNode = useCallback(
    (node: DesignNode, parentId?: string): string => {
      mutatePage((nodes) => {
        if (!parentId) return [...nodes, node];
        return replaceNode(nodes, parentId, (p) =>
          "children" in p ? { ...p, children: [...p.children, node] } : p,
        );
      });
      setSel([node.id]);
      setTool("select");
      return node.id;
    },
    [mutatePage, setSel],
  );

  /** 画框拖出新 frame（工具栏 frame/形状按下拖拽用：给定世界盒；line/arrow 带走向） */
  const createBoxed = useCallback(
    (type: NodeType | "frame", box: Box, text?: string, dir?: 0 | 1 | 2 | 3): string => {
      const name = type === "frame" ? "画板" : undefined;
      const node =
        type === "frame"
          ? newFrame({ w: Math.max(2, round1(box.w)), h: Math.max(2, round1(box.h)), x: round1(box.x), y: round1(box.y), name })
          : newNode(type, { x: round1(box.x), y: round1(box.y), w: Math.max(1, round1(box.w)), h: Math.max(1, round1(box.h)) }, name);
      if (type === "text" && node.type === "text") {
        node.runs = [{ text: text || "文本", size: 16, color: "#111111" }];
      }
      if ((node.type === "line" || node.type === "arrow") && dir !== undefined) node.dir = dir;
      return addNode(node);
    },
    [addNode],
  );

  const deleteSelected = useCallback(() => {
    if (selIds.length === 0) return;
    const ids = new Set(selIds);
    mutatePage((nodes) => {
      const drop = (list: DesignNode[]): DesignNode[] =>
        list.filter((n) => !ids.has(n.id)).map((n) => ("children" in n ? { ...n, children: drop(n.children) } : n));
      return drop(nodes);
    });
    setSel([]);
  }, [selIds, mutatePage, setSel]);

  /** 收集选中根子树（按树序；选中节点整体命中时不再深入其子级） */
  const collectSelected = useCallback((): DesignNode[] => {
    if (selIds.length === 0) return [];
    const ids = new Set(selIds);
    const roots: DesignNode[] = [];
    const collect = (list: DesignNode[]) => {
      for (const n of list) {
        if (ids.has(n.id)) roots.push(n);
        else if ("children" in n) collect(n.children);
      }
    };
    collect(page.nodes);
    return roots;
  }, [selIds, page]);

  /** ⌘D：原位旁复制，插回同一父容器的相邻位（Figma 语义）；子树深复制重发 id，根偏移 +20 */
  const duplicateSelected = useCallback(() => {
    const roots = collectSelected();
    if (roots.length === 0) return;
    const pairs = roots.map((src) => {
      const copy = cloneNode(src);
      copy.x = round1(copy.x + 20);
      copy.y = round1(copy.y + 20);
      return { srcId: src.id, copy };
    });
    mutatePage((nodes) => {
      let out = nodes;
      for (const { srcId, copy } of pairs) {
        const res = mapSiblings(out, srcId, (list, i) => {
          const arr = list.slice();
          arr.splice(i + 1, 0, copy);
          return arr;
        });
        if (res) out = res;
      }
      return out;
    });
    setSel(pairs.map((p) => p.copy.id));
  }, [collectSelected, mutatePage, setSel]);

  /** 成组（要求选中同一父级同层；跨层 v1 提示不支持）。组盒 = 选中 AABB 并集（父局部系）。 */
  const groupSelected = useCallback(() => {
    const ids = new Set(selIds);
    if (ids.size < 2) return;
    const locs = [...ids]
      .map((id) => findNode(docRef.current, id))
      .filter((l): l is NonNullable<typeof l> => !!l)
      .sort((a, b) => a.index - b.index);
    if (locs.length !== ids.size) return;
    // 同层判定：siblings 数组引用相同（页面级 parent 为 null，数组引用照样唯一）
    if (locs.some((l) => l.siblings !== locs[0]!.siblings)) {
      notifyLater("暂只支持同层成组");
      return;
    }
    const u = unionBox(
      locs.map((l) => aabbRotated({ x: l.node.x, y: l.node.y, w: l.node.w, h: l.node.h }, l.node.rotation || 0)),
    );
    if (!u) return;
    const kids = locs.map((l) => {
      const c = structuredClone(l.node);
      c.x = round1(c.x - u.x);
      c.y = round1(c.y - u.y);
      return c;
    });
    const gid = uid("g");
    const group: DesignNode = {
      type: "group",
      id: gid,
      name: "组",
      x: round1(u.x),
      y: round1(u.y),
      w: round1(u.w),
      h: round1(u.h),
      children: kids,
    };
    const anchorId = locs[0]!.node.id;
    mutatePage((nodes) => {
      const res = mapSiblings(nodes, anchorId, (list) => {
        // 组插到首个选中项的位置；其余选中项从同层摘除
        const arr = list.filter((n) => !ids.has(n.id) || n.id === anchorId);
        arr[arr.findIndex((n) => n.id === anchorId)] = group;
        return arr;
      });
      return res ?? nodes;
    });
    setSel([gid]);
  }, [selIds, mutatePage, setSel, notifyLater]);

  /** 拆组：子节点坐标回父局部，组位被子节点整体替换 */
  const ungroupSelected = useCallback(() => {
    const ids = new Set(selIds);
    mutatePage((nodes) => {
      const drop = (list: DesignNode[]): DesignNode[] => {
        const out: DesignNode[] = [];
        for (const n of list) {
          if (n.type === "group" && ids.has(n.id)) {
            for (const c of n.children) {
              out.push({ ...c, x: round1(c.x + n.x), y: round1(c.y + n.y) } as DesignNode);
            }
          } else {
            out.push("children" in n ? { ...n, children: drop(n.children) } : n);
          }
        }
        return out;
      };
      return drop(nodes);
    });
  }, [selIds, mutatePage]);

  /** 图层序：上移/下移/置顶/置底（同级兄弟互换；Figma 面板显示倒序） */
  const reorderSelected = useCallback(
    (dir: "up" | "down" | "front" | "back") => {
      if (selIds.length === 0) return;
      mutatePage((nodes) => {
        let out = nodes;
        // 自后向前逐个处理，避免位移失效（up 从尾开始，down 从头开始）
        const order = dir === "up" || dir === "front" ? [...selIds].reverse() : [...selIds];
        for (const id of order) {
          const moved = mapSiblings(out, id, (list, i) => {
            const arr = list.slice();
            const [n] = arr.splice(i, 1);
            if (!n) return list;
            const j = dir === "up" ? Math.min(arr.length, i + 1) : dir === "down" ? Math.max(0, i - 1) : dir === "front" ? arr.length : 0;
            arr.splice(j, 0, n);
            return arr;
          });
          if (moved) out = moved;
        }
        return out;
      });
    },
    [selIds, mutatePage],
  );

  const renameNode = useCallback(
    (id: string, name: string) => {
      updateNode(id, { name: name.slice(0, 120) || "未命名" } as Partial<DesignNode>);
    },
    [updateNode],
  );

  const toggleFlag = useCallback(
    (id: string, flag: "visible" | "locked") => {
      const n = findNode(docRef.current, id)?.node;
      if (!n) return;
      if (flag === "visible") updateNode(id, { visible: n.visible === false } as Partial<DesignNode>);
      else updateNode(id, { locked: !n.locked } as Partial<DesignNode>);
    },
    [updateNode],
  );

  /** 方向键微调（coalesce） */
  const nudge = useCallback(
    (dx: number, dy: number) => {
      if (selIds.length === 0) return;
      const ids = new Set(selIds);
      mutatePage(
        (nodes) => mapNodes(nodes, (n) => (ids.has(n.id) ? ({ ...n, x: round1(n.x + dx), y: round1(n.y + dy) } as DesignNode) : n)),
        { coalesce: true },
      );
    },
    [selIds, mutatePage],
  );

  /** 对齐/分布：多选相对并集盒；单选相对所在 frame 盒（page 级无参照则跳过）。锁定/隐藏层整体不参与 */
  const align = useCallback(
    (mode: AlignMode) => {
      if (selIds.length === 0) return;
      const cur = docRef.current;
      const movable = selIds.filter((id) => {
        const l = findNode(cur, id);
        return !!l && l.node.locked !== true && l.node.visible !== false;
      });
      if (movable.length === 0) return;
      let ref: Box | null = null;
      if (movable.length > 1) ref = selectionWorldBox(cur, movable);
      else {
        const l = findNode(cur, movable[0]!);
        ref = l?.parent ? worldBoxOf(cur, l.parent.id) : null;
      }
      const next = cloneDoc(cur);
      applyAlign(next, movable, mode, ref);
      commit(next);
    },
    [selIds, commit],
  );

  /* ---------------- 文本就地编辑 ---------------- */

  const setTextRuns = useCallback(
    (id: string, runs: TextRun[]) => {
      updateNode(id, { runs } as Partial<DesignNode>);
    },
    [updateNode],
  );

  /* ---------------- 剪贴板（⌘C/⌘X/⌘V） ---------------- */

  /** ⌘C：剪存子树副本，坐标归一到页面级世界系（粘贴总落页面顶层，视觉位置不变） */
  const copySelected = useCallback(() => {
    const roots = collectSelected();
    if (roots.length === 0) return;
    const cur = docRef.current;
    clipboardRef.current = roots.map((n) => {
      const c = cloneNode(n);
      const wb = worldBoxOf(cur, n.id);
      if (wb) {
        c.x = round1(wb.x);
        c.y = round1(wb.y);
      }
      return c;
    });
    pasteSeqRef.current = 0;
  }, [collectSelected]);

  const cutSelected = useCallback(() => {
    copySelected();
    deleteSelected();
  }, [copySelected, deleteSelected]);

  const pasteClipboard = useCallback(() => {
    if (clipboardRef.current.length === 0) return;
    pasteSeqRef.current += 1;
    const off = pasteSeqRef.current * 20;
    const copies = clipboardRef.current.map(cloneNode).map((c) => ({ ...c, x: round1(c.x + off), y: round1(c.y + off) } as DesignNode));
    const ids = copies.map((c) => c.id);
    mutatePage((nodes) => [...nodes, ...copies]);
    setSel(ids);
  }, [mutatePage, setSel]);

  /* ---------------- 图片资产 ---------------- */

  const insertImageFile = useCallback(
    async (file: File, at?: { x: number; y: number }) => {
      const ext = (/\.([a-z0-9]+)$/i.exec(file.name)?.[1] ?? "png").toLowerCase();
      const name = `${file.name.replace(/\.[^.]*$/, "").slice(0, 40) || "image"}-${Date.now().toString(36)}.${ext}`;
      const dataUrl = await new Promise<string>((res, rej) => {
        const fr = new FileReader();
        fr.onload = () => res(String(fr.result));
        fr.onerror = () => rej(new Error("read-failed"));
        fr.readAsDataURL(file);
      });
      bridge.attachFile(name, dataUrl.slice(dataUrl.indexOf(",") + 1));
      const node: DesignNode = {
        type: "image",
        id: uid("i"),
        name: file.name.slice(0, 60) || "图片",
        x: round1(at?.x ?? 0),
        y: round1(at?.y ?? 0),
        w: 320,
        h: 240,
        src: `${assetsDirForDoc(fileRelRef.current)}/${name}`,
        fit: "cover",
      } as DesignNode;
      addNode(node);
    },
    [addNode],
  );

  /* ---------------- 页面 ---------------- */

  const switchPage = useCallback((id: string) => {
    const cur = docRef.current;
    if (!cur.pages.some((p) => p.id === id)) return;
    commit({ ...cur, activePage: id });
    setSel([]);
    setEditingTextId(null);
  }, [commit, setSel]);

  const addPage = useCallback(() => {
    const p: Page = { id: uid("p"), name: `页面 ${docRef.current.pages.length + 1}`, nodes: [] };
    commit({ ...docRef.current, pages: [...docRef.current.pages, p], activePage: p.id });
    setSel([]);
  }, [commit, setSel]);

  const renamePage = useCallback((id: string, name: string) => {
    commit({
      ...docRef.current,
      pages: docRef.current.pages.map((p) => (p.id === id ? { ...p, name: name.slice(0, 60) || p.name } : p)),
    });
  }, [commit]);

  const deletePage = useCallback((id: string) => {
    const cur = docRef.current;
    if (cur.pages.length <= 1) return;
    const pages = cur.pages.filter((p) => p.id !== id);
    const activePage = cur.activePage === id ? pages[0]!.id : cur.activePage;
    commit({ ...cur, pages, activePage });
    setSel([]);
  }, [commit, setSel]);

  /* ---------------- 文档命令 ---------------- */

  const renameDoc = useCallback((name: string) => {
    commit({ ...docRef.current, meta: { ...docRef.current.meta, name: name.slice(0, 80) || "UI 设计" } });
  }, [commit]);

  /** 新建设计档：宿主态写盘（<名>.uidesign.json，宿主回推 doc.open）；独立态本地直开 */
  const createDoc = useCallback(
    (name: string, presetKey: string) => {
      const clean = name.trim().replace(/[/\\:*?"<>|？：＊｜＞＜＼／]/g, "");
      if (!clean) return;
      const seed = starterDoc(clean, presetKey in DEVICE_PRESETS ? presetKey : "ios-390");
      if (bridge.standalone) {
        applyDoc(seed, { freshReset: true });
        sendSoon(seed); // 直开不经 commit：手动落 localStorage，否则刷新丢档
        setFileRel(null);
        setDocLoaded(true);
        return;
      }
      bridge.create(`${clean}.uidesign.json`, serializeDoc(seed));
    },
    [applyDoc, sendSoon],
  );

  /* ---------------- 撤销 / 重做 ---------------- */

  const undo = useCallback(() => {
    const h = historyRef.current;
    if (h.past.length === 0) return;
    const curJson = serializeDoc(docRef.current);
    const prev = h.past.pop()!;
    h.future.push(curJson);
    if (h.future.length > HISTORY_MAX) h.future.shift();
    h.lastAt = 0; // 阻断后续 coalesce 续接
    const res = parseDesignDoc(prev);
    if (res.doc) {
      applyDoc(res.doc, { markDirty: true });
      sendSoon(res.doc);
    }
  }, [applyDoc, sendSoon]);

  const redo = useCallback(() => {
    const h = historyRef.current;
    if (h.future.length === 0) return;
    const curJson = serializeDoc(docRef.current);
    const next = h.future.pop()!;
    h.past.push(curJson);
    h.lastAt = 0;
    const res = parseDesignDoc(next);
    if (res.doc) {
      applyDoc(res.doc, { markDirty: true });
      sendSoon(res.doc);
    }
  }, [applyDoc, sendSoon]);

  /* ---------------- 视口 ---------------- */

  const setView = useCallback((v: View | ((prev: View) => View)) => {
    setViewState((prev) => (typeof v === "function" ? v(prev) : v));
  }, []);

  const setViewportSize = useCallback((w: number, h: number) => {
    sizeRef.current = { w: Math.max(1, w), h: Math.max(1, h) };
  }, []);

  /** 以屏幕点为锚缩放（滚轮）：world 不动点方程 */
  const zoomAt = useCallback((factor: number, screenX: number, screenY: number) => {
    setViewState((prev) => {
      const s = Math.min(8, Math.max(0.02, prev.s * factor));
      const k = s / prev.s;
      return { s, tx: screenX - (screenX - prev.tx) * k, ty: screenY - (screenY - prev.ty) * k };
    });
  }, []);

  const zoomTo = useCallback((s: number) => {
    const { w, h } = sizeRef.current;
    zoomAt(Math.min(8, Math.max(0.02, s)) / viewRef.current.s, w / 2, h / 2);
  }, [zoomAt]);

  const zoomBy = useCallback((factor: number) => {
    const { w, h } = sizeRef.current;
    zoomAt(factor, w / 2, h / 2);
  }, [zoomAt]);

  /** 适配：目标世界盒（缺省=全页面内容并集）居中 + 留边距 */
  const fitView = useCallback((box?: Box) => {
    const cur = docRef.current;
    let b = box;
    if (!b) {
      const p = (cur.pages.find((x) => x.id === cur.activePage) ?? cur.pages[0])!;
      const boxes = p.nodes.map((n) => worldBoxOf(cur, n.id)).filter((x): x is Box => !!x);
      b = unionBox(boxes) ?? { x: 0, y: 0, w: 1200, h: 800 };
    }
    const { w, h } = sizeRef.current;
    const pad = 80;
    const s = Math.min(8, Math.max(0.02, Math.min((w - pad * 2) / b.w, (h - pad * 2) / b.h)));
    if (!isFinite(s) || s <= 0) return;
    setViewState({ s, tx: w / 2 - (b.x + b.w / 2) * s, ty: h / 2 - (b.y + b.h / 2) * s });
  }, []);

  const fitSelection = useCallback(() => {
    if (selIds.length === 0) return fitView();
    const b = selectionWorldBox(docRef.current, selIds);
    if (b) fitView(b);
  }, [selIds, fitView]);

  /* ---------------- 历史查询 ---------------- */

  const canUndo = historyRef.current.past.length > 0;
  const canRedo = historyRef.current.future.length > 0;

  return {
    doc,
    docRef,
    page,
    fileRel,
    docLoaded,
    connected,
    dirty,
    sel,
    selIds,
    setSel,
    tool,
    setTool,
    view,
    setView,
    setViewportSize,
    zoomAt,
    zoomTo,
    zoomBy,
    fitView,
    fitSelection,
    conflict,
    resolveConflict,
    notice,
    docCorrupt,
    editingTextId,
    setEditingTextId,
    // mutation
    commit,
    mutatePage,
    updateNode,
    applyLedger,
    addNode,
    createBoxed,
    deleteSelected,
    duplicateSelected,
    groupSelected,
    ungroupSelected,
    reorderSelected,
    renameNode,
    toggleFlag,
    nudge,
    align,
    setTextRuns,
    copySelected,
    cutSelected,
    pasteClipboard,
    insertImageFile,
    // pages
    switchPage,
    addPage,
    renamePage,
    deletePage,
    renameDoc,
    createDoc,
    // history
    undo,
    redo,
    canUndo,
    canRedo,
  };
}

export type DesignStore = ReturnType<typeof useDesign>;

/** structuredClone 整档（commit 前归一化用，文档体量小可接受） */
function cloneDoc(d: DesignDoc): DesignDoc {
  return structuredClone(d);
}
