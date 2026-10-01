/**
 * 轮次切分（消息流的折叠单位）：一轮 = 一条 user 消息 + 其后直到下一条
 * user 之前的全部 assistant 消息；开场（首条 user 之前）的 assistant 预置
 * 内容自成第 0 轮。与左侧刻度条的 pickRoundAnchors 同语义，但这里从消息
 * 状态算（刻度条那条走 DOM）。
 *
 * 性能约定：索引按 messages 数组身份缓存在 WeakMap 里——流式期间每次
 * token 都会换新数组，但每个挂载消息的选择器都只做一次 O(1) 查表，
 * 不会出现 O(轮数 × 消息数) 的重复扫描。
 */
import type {
  ThreadAssistantMessage,
  ThreadAssistantMessagePart,
  ThreadMessage,
} from "@assistant-ui/react";

export type Turn = {
  /** 首条消息 id：轮次身份键（折叠状态与耗时都用它） */
  key: string;
  /** 消息下标区间 [start, end) */
  start: number;
  end: number;
  /** 本轮被手动中断（Stop / 立即发送中止）：当"已结束轮"对待，可收起。
   *  判定只看轮末消息——中断标记一定落在被中止的那条（=该轮最后一条）上。 */
  interrupted: boolean;
  /** 轮内还有消息在流式（status === "running"）：此时绝不能收起、不显示摘要行。
   *  只看线程级 isRunning 不够——它会有短暂为 false 的空窗（排队准备段、
   *  上一轮被中止的收尾），那些瞬间会被误判成"轮已结束"。 */
  running: boolean;
};

export type TurnIndex = {
  turns: Turn[];
  /** 消息 id → 所属轮次与是否轮首（折叠状态与耗时都用它） */
  slots: Map<string, { turnIndex: number; isHeader: boolean }>;
  /** 消息 id → 数组下标（选择器里的 O(1) 定位；流式期间选择器每次通知都重跑，
   *  全量 findIndex 会随消息数平方膨胀） */
  byId: Map<string, number>;
  /** 轮次键 → 轮次（packTurnSummary/getTurnParts 的 O(1) 查找） */
  turnByKey: Map<string, Turn>;
};

const indexCache = new WeakMap<readonly ThreadMessage[], TurnIndex>();

/** 轮次索引（缓存命中即返回，选择器里可放心调用）。
 *  构建失败一律 fail-open：返回空索引 ⇒ 每条消息都拿不到槽位 ⇒ 全部按正常方式
 *  渲染（折叠失效但内容不丢）。对齐 dsh-message-fold 的原则：无法确认的结构
 *  一律保留原样，绝不让展示层把消息吞掉。 */
export function getTurnIndex(messages: readonly ThreadMessage[]): TurnIndex {
  const cached = indexCache.get(messages);
  if (cached) return cached;
  let built: TurnIndex;
  try {
    built = buildTurnIndex(messages);
  } catch {
    built = { turns: [], slots: new Map(), byId: new Map(), turnByKey: new Map() };
  }
  indexCache.set(messages, built);
  return built;
}

export function buildTurnIndex(messages: readonly ThreadMessage[]): TurnIndex {
  const turns: Turn[] = [];
  let start = -1;
  for (let i = 0; i < messages.length; i++) {
    if (start === -1) {
      start = i;
      continue;
    }
    // user 消息起新轮：非 user（assistant/system）并入当前轮
    if (messages[i].role === "user") {
      turns.push({
        key: String(messages[start].id),
        start,
        end: i,
        interrupted: false,
        running: false,
      });
      start = i;
    }
  }
  if (start !== -1) {
    turns.push({
      key: String(messages[start].id),
      start,
      end: messages.length,
      interrupted: false,
      running: false,
    });
  }
  // 每轮补两个状态位（一次线性扫，索引本身已按 messages 数组身份缓存）：
  //  - interrupted：轮末消息带 data-stopped（直播 abort chunk / 历史重建
  //    stopReason "aborted" 落同一个 part）
  //  - running：轮内任一消息仍在流式
  for (const turn of turns) {
    const last = messages[turn.end - 1];
    turn.interrupted =
      last?.role === "assistant" &&
      last.content.some((part) => part.type === "data" && part.name === "stopped");
    for (let i = turn.start; i < turn.end; i++) {
      if (messages[i].status?.type === "running") {
        turn.running = true;
        break;
      }
    }
  }

  const slots = new Map<string, { turnIndex: number; isHeader: boolean }>();
  const byId = new Map<string, number>();
  const turnByKey = new Map<string, Turn>();
  turns.forEach((turn, turnIndex) => {
    turnByKey.set(turn.key, turn);
    for (let i = turn.start; i < turn.end; i++) {
      slots.set(String(messages[i].id), { turnIndex, isHeader: i === turn.start });
      byId.set(String(messages[i].id), i);
    }
  });
  return { turns, slots, byId, turnByKey };
}

/**
 * 消息 id → 数组下标（缓存索引查表，O(1)）；不存在返回 -1。
 * 语义与 messages.findIndex((m) => m.id === id) 一致，供消息级选择器
 * （AssistantActionBar 的 isTurnEnd 等）替代全量扫描。
 */
export function messageIndexById(
  messages: readonly ThreadMessage[],
  messageId: string,
): number {
  return getTurnIndex(messages).byId.get(messageId) ?? -1;
}

/**
 * 消息在本轮里的位置，打包成字符串供 useAuiState 选择器使用（原始值，
 * Object.is 挡住流式期间的重渲；内部走缓存索引，O(1)）：
 *   `"<isTurnStart>|<isTurnEnd>|<isLastTurn>|<anchorUserIndex>|<turnKey>"`
 * anchorUserIndex = 本轮触发的 user 消息下标（开场 assistant 段为 -1）。
 */
export function packTurnSlot(
  messages: readonly ThreadMessage[],
  messageId: string,
): string {
  const index = getTurnIndex(messages);
  const info = index.slots.get(messageId);
  if (!info) return "";
  const turn = index.turns[info.turnIndex];
  const isTurnEnd = String(messages[turn.end - 1]?.id) === messageId;
  const isLastTurn = info.turnIndex === index.turns.length - 1;
  const anchorUserIndex =
    messages[turn.start]?.role === "user" ? turn.start : -1;
  return [
    `${info.isHeader ? 1 : 0}${isTurnEnd ? 1 : 0}${isLastTurn ? 1 : 0}${turn.interrupted ? 1 : 0}${turn.running ? 1 : 0}`,
    anchorUserIndex,
    turn.key,
  ].join("|");
}

export type TurnSlotInfo = {
  isTurnStart: boolean;
  isTurnEnd: boolean;
  isLastTurn: boolean;
  /** 本轮被手动中断（可收起，不再按"最新轮保持展开"） */
  interrupted: boolean;
  /** 轮内仍在流式（不能收起、不显示摘要行） */
  turnRunning: boolean;
  /** 本轮触发的 user 消息下标（开场 assistant 段为 -1） */
  anchorUserIndex: number;
  turnKey: string;
};

export function parseTurnSlot(packed: string): TurnSlotInfo | null {
  const [flags, anchorUserIndex, ...rest] = packed.split("|");
  if (!flags) return null;
  return {
    isTurnStart: flags[0] === "1",
    isTurnEnd: flags[1] === "1",
    isLastTurn: flags[2] === "1",
    interrupted: flags[3] === "1",
    turnRunning: flags[4] === "1",
    anchorUserIndex: Number(anchorUserIndex),
    turnKey: rest.join("|"),
  };
}

/**
 * 槽位 +「压缩分隔线保命」标记的打包/解析：两者必须成对改。
 * 之前打包写成 `keep\u0000slot` 而解析按 `slot\u0000keep` 解，结果每条消息
 * 都解析成空槽位（全默认收起）——轮中消息全被隐藏，只有带压缩分隔线的侥幸
 * 渲染，看起来像"消息消失了"。收进同模块 + 单测锁住往返。
 */
export type TurnSlotWithKeep = { slot: TurnSlotInfo; keepsVisible: boolean };

export function packTurnSlotWithKeep(
  messages: readonly ThreadMessage[],
  messageId: string,
  keepsVisible: boolean,
): string {
  const slot = packTurnSlot(messages, messageId);
  if (!slot) return "";
  return `${keepsVisible ? 1 : 0}\u0000${slot}`;
}

export function parseTurnSlotWithKeep(packed: string): TurnSlotWithKeep | null {
  const [keep, slot] = packed.split("\u0000");
  const parsed = parseTurnSlot(slot ?? "");
  if (!parsed) return null;
  return { slot: parsed, keepsVisible: keep === "1" };
}

/**
 * 本轮全部 assistant 消息的 parts（按顺序摊平），引用按 messages 数组身份
 * 缓存——折叠轮里轮中消息不挂载，产物卡/检查点这类「交付物」统一挂到轮末，
 * 需要按本轮整体取数据。
 */
const turnPartsCache = new WeakMap<
  readonly ThreadMessage[],
  Map<string, ThreadAssistantMessage["content"]>
>();

export function getTurnParts(
  messages: readonly ThreadMessage[],
  turnKey: string,
): ThreadAssistantMessage["content"] {
  let byKey = turnPartsCache.get(messages);
  if (!byKey) {
    byKey = new Map();
    turnPartsCache.set(messages, byKey);
  }
  const cached = byKey.get(turnKey);
  if (cached) return cached;
  const turn = getTurnIndex(messages).turnByKey.get(turnKey);
  const parts: ThreadAssistantMessagePart[] = [];
  if (turn) {
    for (let i = turn.start; i < turn.end; i++) {
      const message = messages[i];
      if (message.role !== "assistant") continue;
      parts.push(...message.content);
    }
  }
  const frozen: ThreadAssistantMessage["content"] = parts;
  byKey.set(turnKey, frozen);
  return frozen;
}

/** 摘要行需要展示的轮次数据（只在真正渲染摘要行时提取，不进流式选择器） */
export type TurnSummary = {
  /** 本轮消息条数 */
  messageCount: number;
  /** 本轮是否有「可收起的过程」：轮中消息，或轮末消息里除正文/压缩线之外的 part
   *  （工具、思考、data）——没有过程时摘要行是空开关，不占位 */
  hasProcess: boolean;
  /** 可收起过程块数（轮内 tool-call + reasoning part 数）：无耗时时摘要行显示它。
   *  旧口径「轮中消息数 + 轮末是否有过程」在新投影链路失效——一轮的
   *  assistant+toolResult 全合并进一条消息，轮内恒 2 条，计数恒等于 1。 */
  collapsedCount: number;
  /** 工具调用次数 */
  toolCount: number;
  /** 改动到的不同文件数（edit/write 的 file_path 去重） */
  fileCount: number;
  /** 用户提问全文（渲染时截断） */
  userText: string;
  /** 末条 assistant 消息的正文（渲染时截断） */
  answerText: string;
  hasAssistant: boolean;
  /** 本轮最后一条 assistant 消息的结束时刻（ms）；仅本轮直播结束后才有 */
  timingEnd: number | null;
};

/** 从工具调用输入里取文件路径（edit/write 用 snake_case 的 file_path） */
function toolFilePath(input: unknown): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const path = (input as { file_path?: unknown }).file_path;
  return typeof path === "string" ? path : undefined;
}

/**
 * 打包成字符串选择器（同 ToolGroupSection 的用法）：值不变时 Object.is
 * 相等，流式期间摘要头不会因新对象身份反复重渲。按轮次键查找（不用下标：
 * 往上翻历史 prepend 后下标会漂移）。
 */
export function packTurnSummary(messages: readonly ThreadMessage[], turnKey: string): string {
  const turn = getTurnIndex(messages).turnByKey.get(turnKey);
  if (!turn) return "";
  let toolCount = 0;
  let processParts = 0;
  let userText = "";
  let answerText = "";
  let hasAssistant = false;
  let timingEnd: number | null = null;
  const files = new Set<string>();

  for (let i = turn.start; i < turn.end; i++) {
    const message = messages[i];
    if (message.role === "user") {
      if (!userText) {
        const text = message.content.find((p) => p.type === "text");
        userText = text?.type === "text" ? text.text.slice(0, 400) : "";
      }
      continue;
    }
    if (message.role !== "assistant") continue;
    hasAssistant = true;
    for (const part of message.content) {
      if (part.type === "reasoning") {
        processParts += 1;
        continue;
      }
      if (part.type !== "tool-call") continue;
      processParts += 1;
      toolCount += 1;
      if (part.toolName === "edit" || part.toolName === "write") {
        const path = toolFilePath(part.args);
        if (path) files.add(path);
      }
    }
    const timing = message.metadata?.timing;
    if (timing?.totalStreamTime !== undefined) {
      timingEnd = timing.streamStartTime + timing.totalStreamTime;
    }
    // 末条（含 streaming 中的最新文本）作回答摘要
    for (let j = message.content.length - 1; j >= 0; j--) {
      const part = message.content[j];
      if (part.type === "text" && part.text.trim()) {
        answerText = part.text.slice(0, 400);
        break;
      }
    }
  }

  // 轮末消息里除正文与压缩分隔线外还有 part ⇒ 有过程可收
  const endMessage = messages[turn.end - 1];
  const endHasProcess =
    endMessage !== undefined &&
    endMessage.content.some(
      (part) =>
        part.type !== "text" &&
        !(part.type === "data" && part.name === "compaction"),
    );
  const hasProcess = turn.end - turn.start > 2 || endHasProcess;
  // 过程块口径（tool-call + reasoning）：消息数口径在新投影链路恒 1，见类型注释
  const collapsedCount = processParts;

  return [
    turn.end - turn.start,
    hasProcess ? 1 : 0,
    collapsedCount,
    toolCount,
    files.size,
    timingEnd ?? -1,
    hasAssistant ? 1 : 0,
    userText,
    answerText,
  ].join("\u0000");
}

export function parseTurnSummary(packed: string): TurnSummary {
  const [
    messageCount,
    hasProcess,
    collapsedCount,
    toolCount,
    fileCount,
    timingEnd,
    hasAssistant,
    userText,
    answerText,
  ] = packed.split("\u0000");
  return {
    messageCount: Number(messageCount) || 0,
    hasProcess: hasProcess === "1",
    collapsedCount: Number(collapsedCount) || 0,
    toolCount: Number(toolCount) || 0,
    fileCount: Number(fileCount) || 0,
    timingEnd: Number(timingEnd) >= 0 ? Number(timingEnd) : null,
    hasAssistant: hasAssistant === "1",
    userText: userText ?? "",
    answerText: answerText ?? "",
  };
}
