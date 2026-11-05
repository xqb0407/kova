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
  /** 轮内最后一条「有实质内容」的 assistant 消息下标（尾部纯分隔线/无渲染
   *  兜底块不算，无内容消息也不算）；没有则 -1。答案面可见性挂它：空闲/
   *  手动压缩或切模型会在轮末留下一条独立的消息，轮末身份归它，但答案不能
   *  被挤进过程面——轮中消息收起后整块卸载，答案会连同那一列分隔线一起
   *  消失。 */
  answerTail: number;
};

export type TurnIndex = {
  turns: Turn[];
  /** 消息 id → 所属轮次、是否轮首、是否答案尾位（折叠状态与耗时都用它） */
  slots: Map<
    string,
    { turnIndex: number; isHeader: boolean; isAnswerTail: boolean }
  >;
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
        answerTail: -1,
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
      answerTail: -1,
    });
  }
  // 每轮补状态位（一次线性扫，索引本身已按 messages 数组身份缓存）：
  //  - running：轮内任一消息仍在流式
  //  - answerTail：轮内最后一条有实质内容的 assistant 消息（尾部纯分隔线
  //    消息不算，见 Turn.answerTail）
  //  - interrupted：answerTail 带 data-stopped（直播 abort chunk / 历史重建
  //    stopReason "aborted" 落同一个 part）。不能用轮末消息判：模型切换/
  //    压缩分隔线会被追加到轮末，把中止标记顶掉，整轮就显示成正常结束。
  for (const turn of turns) {
    for (let i = turn.start; i < turn.end; i++) {
      const message = messages[i];
      if (message.status?.type === "running") turn.running = true;
      if (message.role !== "assistant") continue;
      if (hasVisibleContent(message)) turn.answerTail = i;
    }
    const answerTail =
      turn.answerTail >= 0 ? messages[turn.answerTail] : undefined;
    turn.interrupted =
      answerTail?.role === "assistant" &&
      answerTail.content.some(
        (part) => part.type === "data" && part.name === "stopped",
      );
  }

  const slots = new Map<
    string,
    { turnIndex: number; isHeader: boolean; isAnswerTail: boolean }
  >();
  const byId = new Map<string, number>();
  const turnByKey = new Map<string, Turn>();
  turns.forEach((turn, turnIndex) => {
    turnByKey.set(turn.key, turn);
    for (let i = turn.start; i < turn.end; i++) {
      slots.set(String(messages[i].id), {
        turnIndex,
        isHeader: i === turn.start,
        isAnswerTail: i === turn.answerTail,
      });
      byId.set(String(messages[i].id), i);
    }
  });
  return { turns, slots, byId, turnByKey };
}

/**
 * 不承载答案的独立 data part：
 * - `compaction` / `model-change`：上下文事件分隔线（有横幅渲染）；
 * - `pi-bash-execution` / `pi-branch-summary` / `pi-custom-message` /
 *   `pi-unsupported-message`：投影兜底/扩展块，目前都没有注册 DataUI
 *   （渲染为空）。
 * 它们都只占一条独立 assistant 消息、不承载答案。漏认时会被当成「有实质
 * 内容」的消息抢走轮次 answerTail，真实回答被挤进收起的过程区——切换模型后
 * 上一条回答凭空消失就是这么来的。
 *
 * 注意 `pi-custom-message` 只拦「纯 data」：带正文的自定义消息仍由 text part
 * 判为有内容，不会被这条名单吃掉。
 */
const NON_ANSWER_PART_NAMES: ReadonlySet<string> = new Set([
  "compaction",
  "model-change",
  "pi-bash-execution",
  "pi-branch-summary",
  "pi-custom-message",
  "pi-unsupported-message",
]);

function isNonAnswerPart(part: ThreadMessage["content"][number]): boolean {
  return (
    part.type === "data" &&
    NON_ANSWER_PART_NAMES.has((part as { name?: string }).name ?? "")
  );
}

/**
 * 消息是否有实质内容：至少一个不在上方「不承载答案」名单里的 part。空
 * content 的消息同判无内容（渲染不出东西，别占答案位）。
 */
function hasVisibleContent(message: ThreadMessage): boolean {
  return message.content.some((part) => !isNonAnswerPart(part));
}

/**
 * 纯「无答案」消息（内容全是不承载答案的 data part）：没有答案面，轮末拆分
 * 对它无意义——整条归过程区，收起隐藏、展开回原位（分隔线属于折叠里的过程
 * 记录，不在收起态露在外部）。口径比 assistant-message 操作栏的 dividerOnly
 * 窄：那里是「全是 data part」（含成图），这里只认上表里的块。
 */
export function isDividerOnlyMessage(message: ThreadMessage): boolean {
  return message.content.length > 0 && message.content.every(isNonAnswerPart);
}

/** 纯模型切换分隔线消息：它是轮间事件（解释下一轮为什么换了模型/缓存为何
 *  重建），不属于上一轮的过程细节。UI 侧必须始终可见，不能跟压缩线一起
 *  收进过程折叠区。 */
export function isModelChangeOnlyMessage(message: ThreadMessage): boolean {
  return (
    isDividerOnlyMessage(message) &&
    message.content.some(
      (part) =>
        part.type === "data" &&
        (part as { name?: string }).name === "model-change",
    )
  );
}

/**
 * 该消息是否是本轮收尾（后面到下一条 user 之前再没有有实质内容的 assistant）。
 *
 * 不能直接判「下一条不是 assistant」：模型切换/压缩分隔线（以及无渲染的
 * 兜底块）会被追加在轮末，真实回答的下一条是它们——操作栏（复制/重新生成/
 * 分叉）会整轮消失。跳过这些块再判，与 packTurnSlot 的 answerTail 同一口径。
 */
export function isTurnEndMessage(
  messages: readonly ThreadMessage[],
  messageId: string,
): boolean {
  const idx = messageIndexById(messages, messageId);
  if (idx === -1) return true;
  // 分隔线自己不是答案，不能挂操作栏
  if (isDividerOnlyMessage(messages[idx]!)) return false;
  for (let i = idx + 1; i < messages.length; i++) {
    const next = messages[i]!;
    if (next.role !== "assistant") return true;
    if (!isDividerOnlyMessage(next)) return false;
  }
  return true;
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
 *   flags（逐位）`isTurnStart isTurnEnd isLastTurn interrupted turnRunning isAnswerTail dividerOnly`
 *   ——`"<flags>|<anchorUserIndex>|<turnKey>"`
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
  const messageIndex = index.byId.get(messageId);
  const dividerOnly =
    messageIndex !== undefined && isDividerOnlyMessage(messages[messageIndex]);
  const isTurnEnd = String(messages[turn.end - 1]?.id) === messageId;
  const isLastTurn = info.turnIndex === index.turns.length - 1;
  const anchorUserIndex =
    messages[turn.start]?.role === "user" ? turn.start : -1;
  return [
    `${info.isHeader ? 1 : 0}${isTurnEnd ? 1 : 0}${isLastTurn ? 1 : 0}${turn.interrupted ? 1 : 0}${turn.running ? 1 : 0}${info.isAnswerTail ? 1 : 0}${dividerOnly ? 1 : 0}`,
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
  /** 轮内最后一条有实质内容的 assistant 消息（尾部纯压缩分隔线消息不算）：
   *  答案面可见性挂它，见 Turn.answerTail */
  isAnswerTail: boolean;
  /** 纯压缩分隔线消息（没有答案面）：不走轮末拆分，整条归过程区 */
  dividerOnly: boolean;
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
    isAnswerTail: flags[5] === "1",
    dividerOnly: flags[6] === "1",
    anchorUserIndex: Number(anchorUserIndex),
    turnKey: rest.join("|"),
  };
}

/**
 * TurnSlot 的呈现分支（纯函数，单测锁住顺序）：分支顺序是行为的一部分——
 * 「轮末拆分」必须先于「整条渲染」，否则已结束的轮末（isTurnEnd 恒真）会被
 * 当成流式整条渲染；「运行中强制展开」必须先于普通折叠，否则跑着的长轮
 * 只剩最后一块可见。
 *
 *  - summary：轮首，正文 + 工作摘要行
 *  - split：已结束的轮末/答案尾，过程面（可收起）+ 回答面（常显）
 *  - full：流式轮末 / 编辑中，整条渲染
 *  - forced：本轮仍在跑，过程恒展开（不受折叠态影响）
 *  - collapsible：普通过程消息（含工具成图），跟随折叠态
 */
export type TurnSlotPresentation =
  | "summary"
  | "split"
  | "full"
  | "forced"
  | "collapsible";

export function resolveTurnSlotPresentation(
  slot: TurnSlotInfo,
  ctx: { isEditing: boolean; threadRunning: boolean },
): TurnSlotPresentation {
  if (slot.isTurnStart) return "summary";
  if (
    (slot.isTurnEnd || slot.isAnswerTail) &&
    !slot.dividerOnly &&
    !ctx.isEditing &&
    !slot.turnRunning
  ) {
    return "split";
  }
  // 纯分隔线消息在压缩进行中也要整条渲染：横幅是那段唯一的进度反馈
  const streamingTurnEnd =
    slot.isTurnEnd &&
    (!slot.dividerOnly ||
      slot.turnRunning ||
      (slot.isLastTurn && ctx.threadRunning));
  if (streamingTurnEnd || ctx.isEditing) return "full";
  if (slot.turnRunning || (slot.isLastTurn && ctx.threadRunning)) {
    return "forced";
  }
  return "collapsible";
}

/**
 * 本轮触发 user 消息的稳定投影 id（pi-msg:<seq>）；开场段/越界返回 ""。
 * 检查点卡/产物卡的锚点匹配用：数组下标会随 compaction/model-change 分隔线
 * 插入、截断漂移，id 跨列表结构变化稳定。
 */
export function turnAnchorUserId(
  messages: readonly ThreadMessage[],
  slot: Pick<TurnSlotInfo, "anchorUserIndex">,
): string {
  if (slot.anchorUserIndex < 0) return "";
  return String(messages[slot.anchorUserIndex]?.id ?? "");
}

/**
 * 折叠轮的「过程叙述」正文集合（折叠面的切分，纯函数便于单测）。
 *
 * 为什么要切：一轮（= 一次 loop）在投影侧被合并成**一条**消息，消息里夹着
 * 每一步的叙述正文（"换个词搜一下" 这类过程记录，见 messageProjection 的
 * 合并语义）。收起一轮时该收的是整个过程——叙述正文与工具行、思考一样归过程面，
 * 最外层只留**最后一次动手（工具调用 / 思考）之后的正文**，也就是最终回答；
 * 不切的话收起态会摊出一墙过程叙述（真实回归：一轮 22 步留下 15 段叙述）。
 *
 * 兜底：最后一次动手之后没有正文（用户手动中断、停在工具调用上）时退回
 * 「最后一次开口说的话」——被中断的轮也该看得见它停在哪句话上，而不是收起成
 * 一行空白。「回答」为空的极端情况（整轮没写过正文）返回空集合，收起后只剩
 * 工作摘要行。
 *
 * 返回按对象身份匹配的集合：渲染回调拿不到 part 下标（GroupedParts 只给 part
 * 本身），而库里 text part 的 state 对象与 message.parts[i] 是同一个引用
 * （part client 的浅记忆化 subject），按身份判是 O(1) 且无下标扫描。
 * 认不出（身份不成立）时集合为空 ⇒ 正文全部留在答案面，退回改动前的行为：
 * 宁可不折叠，不吞正文。
 */
export function collectProcessTexts(
  parts: readonly { type?: string; text?: string }[],
): WeakSet<object> {
  // 「有内容的正文」才算数：投影会留下只有空白的 text part（工具间隙的换行），
  // 拿它当回答会让收起态看起来是空的
  const hasText = (part: { type?: string; text?: string } | undefined) =>
    part?.type === "text" && (part.text ?? "").trim().length > 0;
  // 最后一次「动手」的位置：工具调用与思考都算，与过程面的呈现口径一致
  let lastWork = -1;
  for (let i = 0; i < parts.length; i++) {
    const type = parts[i]?.type;
    if (type === "tool-call" || type === "reasoning") lastWork = i;
  }
  let answerFrom = lastWork + 1;
  let hasAnswerText = false;
  for (let i = answerFrom; i < parts.length; i++) {
    if (hasText(parts[i])) {
      hasAnswerText = true;
      break;
    }
  }
  if (!hasAnswerText) {
    let lastText = -1;
    for (let i = 0; i < parts.length; i++) {
      if (hasText(parts[i])) lastText = i;
    }
    answerFrom = lastText >= 0 ? lastText : parts.length;
  }

  const processTexts = new WeakSet<object>();
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (part?.type !== "text") continue;
    // 界外的正文（更早的叙述）+ 只有空白的正文都归过程面：空白渲染不出内容，
    // 别占着答案面的位置
    if (i < answerFrom || !hasText(part)) processTexts.add(part);
  }
  return processTexts;
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
