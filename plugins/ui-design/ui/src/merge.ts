/**
 * 设计档合并导入：把另一份 *.uidesign.json 的页面（可选子集）并进目标档。
 * 纯函数、不可变——面板「导入设计档」与 MCP import_doc 共用同一条口径。
 *
 * 核心是 **id 全量重发 + 引用重映射**：页 id、全部节点 id（页面树 + 主档树）、组件 id
 * 一律换新（uid），否则 id 相撞会让选择/撤销/覆盖寻址全乱。两处引用必须跟着修：
 *   - instance.componentId → compMap（旧组件 id → 新）
 *   - instance.overrides 的 key（主档原始节点 id）→ nodeMap（旧节点 id → 新）
 * 嵌套实例（主档里再放别的组件的实例）由"先全量重发、再统一改写引用"的两趟顺序覆盖。
 */
import { remapVarColors, uid, type ComponentDef, type DesignDoc, type DesignNode, type InstanceNode, type Page, type VariableDef } from "./doc";

export type MergeResult = {
  /** 合并后的完整文档（调用方拿去 commit/save） */
  doc: DesignDoc;
  /** 新页的 id/名称（activePage 不变；调用方决定要不要切过去） */
  pages: { id: string; name: string }[];
  components: number;
  /** 并入的变量数（id 已重发、名字已去重） */
  variables: number;
  nodes: number;
  warnings: string[];
};

/** 子树 id 重发（不可变），沿途收集 旧 id→新 id 到 map */
function reidTree(n: DesignNode, map: Map<string, string>): DesignNode {
  const c = { ...n, id: uid(n.type[0]!) } as DesignNode;
  map.set(n.id, c.id);
  if ("children" in c) c.children = c.children.map((k) => reidTree(k, map));
  return c;
}

/** 改写全部实例引用：componentId 按组件映射换；overrides 的 key 按节点映射换（查不到的保留原样，视为死覆盖） */
function remapRefs(list: DesignNode[], nodeMap: Map<string, string>, compMap: Map<string, string>, dead: Set<string>): void {
  for (const n of list) {
    if (n.type === "instance") {
      const inst = n as InstanceNode;
      if (inst.componentId) {
        const nc = compMap.get(inst.componentId);
        if (nc) inst.componentId = nc;
        else dead.add(inst.componentId);
      }
      if (inst.overrides) {
        const o: Record<string, Record<string, unknown>> = {};
        for (const [k, v] of Object.entries(inst.overrides)) o[nodeMap.get(k) ?? k] = v;
        inst.overrides = o;
      }
    }
    if ("children" in n) remapRefs(n.children, nodeMap, compMap, dead);
  }
}

/**
 * 把 incoming 的页面（opts.pageNames 可按页 id 或名称挑子集）与组件表并入 target。
 * 双方都必须是已通过 parseDesignDoc 的合法档；本函数不校验、不深拷贝 target。
 */
export function mergeImportedDoc(target: DesignDoc, incoming: DesignDoc, opts?: { pageNames?: string[] }): MergeResult {
  const warnings: string[] = [];
  const nodeMap = new Map<string, string>();
  const compMap = new Map<string, string>();

  // ① 组件先走：overrides 的 key 指向主档节点 id，节点映射表必须覆盖主档树
  const comps: ComponentDef[] = (incoming.components ?? []).map((c) => {
    const id = uid("c");
    compMap.set(c.id, id);
    return { id, name: c.name, nodes: c.nodes.map((n) => reidTree(n, nodeMap)) };
  });

  let pages = incoming.pages;
  if (opts?.pageNames?.length) {
    const want = new Set(opts.pageNames);
    pages = pages.filter((p) => want.has(p.id) || want.has(p.name));
    const missed = opts.pageNames.filter((q) => !pages.some((p) => p.id === q || p.name === q));
    if (missed.length) warnings.push(`来源档里没有这些页：${missed.join("、")}`);
  }
  if (pages.length === 0) throw new Error("导入失败：来源档没有可导入的页面");

  const newPages: Page[] = pages.map((p) => ({ id: uid("p"), name: p.name, nodes: p.nodes.map((n) => reidTree(n, nodeMap)) }));

  // ② 两趟都齐了，统一改写实例引用（页面树 + 主档树）
  const dead = new Set<string>();
  for (const c of comps) remapRefs(c.nodes, nodeMap, compMap, dead);
  for (const p of newPages) remapRefs(p.nodes, nodeMap, compMap, dead);
  if (dead.size) warnings.push(`${dead.size} 个实例引用的组件未在来源档内，将显示为「组件缺失」占位`);

  // ③ 变量表：id 重发 + 名字对目标档去重；页面树/主档树/覆盖值里的 var: 引用同步改写
  const varMap = new Map<string, string>();
  const takenNames = new Set((target.variables ?? []).map((v) => v.name));
  const newVars: VariableDef[] = (incoming.variables ?? []).map((v) => {
    const id = uid("v");
    varMap.set(v.id, id);
    let name = v.name;
    for (let i = 2; takenNames.has(name); i++) name = `${v.name} ${i}`;
    takenNames.add(name);
    return { id, name, value: v.value, ...(v.desc ? { desc: v.desc } : {}) };
  });
  if (newVars.length) {
    for (const c of comps) remapVarColors(c.nodes, varMap);
    for (const p of newPages) remapVarColors(p.nodes, varMap);
  }

  const doc: DesignDoc = {
    ...target,
    pages: [...target.pages, ...newPages],
    components: comps.length || target.components?.length ? [...(target.components ?? []), ...comps] : undefined,
    variables: newVars.length || target.variables?.length ? [...(target.variables ?? []), ...newVars] : undefined,
  };
  let nodes = 0;
  const count = (list: DesignNode[]): void => {
    for (const n of list) {
      nodes++;
      if ("children" in n) count(n.children);
    }
  };
  for (const p of newPages) count(p.nodes);
  for (const c of comps) count(c.nodes);
  return { doc, pages: newPages.map((p) => ({ id: p.id, name: p.name })), components: comps.length, variables: newVars.length, nodes, warnings };
}
