/**
 * 消息 id 的产出与钉扎（从 messageProjection 抽出的纯逻辑，便于单测）：
 *
 * - 落盘行（带 __seq）用 `pi-msg:<seq>`：与桌面端同规，往上翻页 prepend 下标平移
 *   也不影响它；
 * - 在飞行（无 seq）用独立前缀的 `pi-msg-idx:<下标>`；
 * - `__optimisticId`（乐观镜像自带、与真实行对齐的 id）优先；
 * - **钉扎**：同一行在整个会话里只发一个 id。直播行先拿下标形式、落盘后本会换成
 *   seq 形式，React key 一变整条消息卸载重挂（markdown 重解析、代码块重挂、
 *   打字机归零、收尾闪一下），钉住之后不再换。
 *
 * 行身份：优先 `s:<seq>`（落盘行，翻页稳定）；未落盘的行用 `i:<index>`（只对尾巴
 * 上在飞的那 1~2 条有意义）。行落盘后在同一行上补记 seq 键，后续快照/翻页仍认旧 id。
 *
 * 下标台账的前提：**转录只在尾部增长**（append-only），所以 `i:<index>` 对同一行
 * 一直成立。唯一的下标平移来源是分页窗的旧页 prepend（§6）——那里必须调
 * `shiftIndexPins` 把已登记的 `i:` 键整体右移，否则在飞行落盘时按平移后的下标
 * 回查会落空、id 换新（React 重挂），错位到别的行还可能撞出重复 id。
 */
export type StableIdAnchor = { __seq?: number; __optimisticId?: string };

/** 取转录行 seq（无则 undefined）。形参放宽到 unknown：调用方常直接递
 *  PiAgentMessage 联合（含无 __seq 的 unknown 成员），宽类型免去每处断言，
 *  也避开 TS 弱类型「无公共属性」的报错。 */
export const seqOf = (anchor: unknown): number | undefined => {
  if (anchor === null || typeof anchor !== "object") return undefined;
  const seq = (anchor as { __seq?: unknown }).__seq;
  return typeof seq === "number" ? seq : undefined;
};

let idPins: Map<string, string> | null = null;

/** 在投影调用外挂上钉扎台账（同步调用，无并发问题；纯函数签名不变） */
export const withIdPins = <T,>(pins: Map<string, string>, fn: () => T): T => {
  idPins = pins;
  try {
    return fn();
  } finally {
    idPins = null;
  }
};

export const messageId = (
  anchor: StableIdAnchor | undefined,
  index: number,
): string => {
  const pinned = anchor?.__optimisticId;
  if (pinned) return pinned;
  const seq = seqOf(anchor);
  const seqKey = seq !== undefined ? `s:${seq}` : undefined;
  const idxKey = `i:${index}`;
  if (idPins) {
    const hit = (seqKey ? idPins.get(seqKey) : undefined) ?? idPins.get(idxKey);
    if (hit) {
      if (seqKey) idPins.set(seqKey, hit);
      return hit;
    }
  }
  const fresh = seq !== undefined ? `pi-msg:${seq}` : `pi-msg-idx:${index}`;
  if (idPins) idPins.set(seqKey ?? idxKey, fresh);
  return fresh;
};

/** 分页 prepend 后的下标台账右移（by = 新前置的行数）：`i:<index>` 的点位随行
 *  整体后移，键值原样保留。`s:<seq>` 键与下标无关，不动。 */
export const shiftIndexPins = (pins: Map<string, string>, by: number): void => {
  if (by <= 0) return;
  const moved: [string, string][] = [];
  for (const [key, value] of pins) {
    if (!key.startsWith("i:")) continue;
    const index = Number.parseInt(key.slice(2), 10);
    if (!Number.isFinite(index)) continue;
    moved.push([`i:${index + by}`, value]);
  }
  for (const [key, value] of moved) pins.set(key, value);
};
