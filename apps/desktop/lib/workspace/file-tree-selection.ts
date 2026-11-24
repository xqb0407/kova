/**
 * 文件树多选纯逻辑：点击/修饰键选区计算、折叠剪枝、批量目标归一化、
 * 拖拽载荷编解码。与 React 无关，便于单测。
 */

export type TreeSelectionModifiers = {
  /** Cmd（macOS）/ Ctrl（其它平台） */
  toggle: boolean;
  /** Shift */
  range: boolean;
};

export type TreeSelectionTarget = {
  value: string;
  disabled?: boolean;
};

export type TreeSelectionResult = {
  selected: string[];
  anchor: string | null;
  active: string;
  additive: boolean;
  range: boolean;
};

function selectableValues(visible: readonly TreeSelectionTarget[]): string[] {
  return visible.filter((item) => !item.disabled).map((item) => item.value);
}

function orderByVisible(set: ReadonlySet<string>, order: readonly string[]): string[] {
  return order.filter((value) => set.has(value));
}

/**
 * 行点击后的选区：
 * - 普通点击 → 只选当前行；
 * - Cmd/Ctrl → 切换当前行；
 * - Shift → 锚点到当前行的可见区间替换选区；
 * - Cmd/Ctrl+Shift → 区间并入。
 * 选区始终按 visible 顺序输出；点击 disabled 行不改变选区。
 */
export function applyRowSelection(args: {
  current: readonly string[];
  anchor: string | null;
  visible: readonly TreeSelectionTarget[];
  clicked: string;
  modifiers: TreeSelectionModifiers;
}): TreeSelectionResult {
  const order = selectableValues(args.visible);
  const clickedIndex = order.indexOf(args.clicked);
  if (clickedIndex < 0) {
    return {
      selected: [...args.current],
      anchor: args.anchor,
      active: args.clicked,
      additive: args.modifiers.toggle,
      range: args.modifiers.range,
    };
  }

  if (args.modifiers.range && args.anchor) {
    const anchorIndex = order.indexOf(args.anchor);
    if (anchorIndex >= 0) {
      const start = Math.min(anchorIndex, clickedIndex);
      const end = Math.max(anchorIndex, clickedIndex);
      const rangeValues = order.slice(start, end + 1);
      const selected = args.modifiers.toggle
        ? orderByVisible(new Set([...args.current, ...rangeValues]), order)
        : rangeValues;
      return {
        selected,
        anchor: args.anchor,
        active: args.clicked,
        additive: args.modifiers.toggle,
        range: true,
      };
    }
  }

  if (args.modifiers.toggle) {
    const next = new Set(args.current);
    if (next.has(args.clicked)) next.delete(args.clicked);
    else next.add(args.clicked);
    return {
      selected: orderByVisible(next, order),
      anchor: args.clicked,
      active: args.clicked,
      additive: true,
      range: false,
    };
  }

  return {
    selected: [args.clicked],
    anchor: args.clicked,
    active: args.clicked,
    additive: false,
    range: false,
  };
}

/** 折叠目录后剔除其下不可见的选中项（目录自身仍保留） */
export function pruneCollapsedSelection(
  selected: readonly string[],
  collapsedDirs: readonly string[],
): string[] {
  if (collapsedDirs.length === 0) return [...selected];
  return selected.filter(
    (value) => !collapsedDirs.some((dir) => value.startsWith(`${dir}/`)),
  );
}

/**
 * 一次折叠动作后该保留的选区：只剔除「折叠前就选中、且被这次折叠藏起来」
 * 的项。previous 传折叠前的选区快照，current 传当前选区——
 * - 用户折叠时两者通常相同，正常剪掉后代；
 * - 换根/外部恢复时 current 里可能是新选中的路径，即使它恰好位于新根
 *   折叠的目录下，也不该被这次 expanded 变化误删；
 * - 普通点击文件夹会同时把选区收敛成该目录，剪枝不能把这次新选择覆盖掉。
 */
export function pruneSelectionOnCollapse(
  previousSelected: readonly string[],
  currentSelected: readonly string[],
  collapsedDirs: readonly string[],
): string[] {
  if (collapsedDirs.length === 0) return [...currentSelected];
  const stillSelected = new Set(
    pruneCollapsedSelection(previousSelected, collapsedDirs),
  );
  const hidden = new Set(
    previousSelected.filter((value) => !stillSelected.has(value)),
  );
  if (hidden.size === 0) return [...currentSelected];
  return currentSelected.filter((value) => !hidden.has(value));
}

/**
 * 批量操作目标归一化：父目录也在选区时只保留父目录，避免删/移父子重复。
 * 输入按现有顺序输出。
 */
export function topLevelTargets(selected: readonly string[]): string[] {
  if (selected.length <= 1) return [...selected];
  const set = new Set(selected);
  return selected.filter((value) => {
    const parts = value.split("/");
    for (let i = 1; i < parts.length; i += 1) {
      if (set.has(parts.slice(0, i).join("/"))) return false;
    }
    return true;
  });
}

/** 多选拖拽载荷：JSON 数组（保留旧的单字符串读取兼容） */
export function serializeTreeDragPayload(rels: readonly string[]): string {
  return JSON.stringify(rels);
}

export function parseTreeDragPayload(raw: string): string[] {
  const text = raw.trim();
  if (!text) return [];
  if (text.startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(text);
      if (Array.isArray(parsed)) {
        return parsed.filter(
          (item): item is string => typeof item === "string" && item.length > 0,
        );
      }
    } catch {
      /* 文件名本身以 [ 开头：按旧单值处理 */
    }
  }
  return [text];
}
