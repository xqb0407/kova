/**
 * 会话交接（handoff）：把当前会话整理成一份结构化交接摘要，创建一个只带
 * 摘要、不复制历史消息的新会话。
 *
 * 设计取舍：
 * - 复用压缩摘要的完整管线（defaultSummarize 的重试/裁剪/缓存亲和），只替换
 *   尾部指令——摘要请求与聊天请求同形时，驻留会话能命中 provider 的前缀缓存。
 * - 新会话的摘要以 compaction 检查点行承载：projectRestoreContext 恢复时自动
 *   变成模型上下文，UI 投影成「交接卡」（details.strategy = "handoff"）；
 *   不写普通 user 消息行，避免看起来像用户自己说过的话。
 * - 索引计数记 1：list_sessions 会过滤 message_count=0 的会话（切换会找不到
 *   列表项），而交接卡在 UI 上确实占一条可见内容。
 * - 摘要请求的 usage 只写进检查点 details 供观测，不写 assistant 转录行——
 *   它不属于任何会话的对话用量，也不该污染缓存命中率统计。
 */
import { randomUUID } from "node:crypto";
import { unlinkSync, writeFileSync } from "node:fs";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import { isApprovalLevel } from "pi-protocol";
import {
	contextBudget,
	defaultSummarize,
	isCompactableMessage,
	isSummaryMessage,
	projectRestoreContext,
	summaryTextOf,
	type SummarizeFn,
	type SummarizeOutcome,
	type SummaryPromptBuilder,
} from "../agent/context";
import { normalizeSessionMode } from "../agent/modes";
import { logAt, logErr } from "../log";
import { getModels } from "../model/model-catalog";
import { sessionPath } from "../storage/storage";
import {
	sessionDelete,
	sessionGet,
	sessionInsert,
	sessionList,
	sessionPrefsSet,
	sessionSetArchived,
	sessionTouch,
} from "../storage/hostdb";
import { estimateContextTokens, estimateTokens } from "../vendor/pi-harness/compaction";
import {
	adoptSessionArtifacts,
	collectArtifactReferences,
	removeSessionArtifacts,
	rewriteArtifactReferences,
} from "./artifact-store";
import { findRunBySession, listActiveTurnSessions } from "./registry";
import { shouldQueue } from "./prompt-queue";
import { isModelUnavailable, sessionModelFor } from "./resolve";
import { stripDirectiveTokens } from "./session-title-summarize";
import {
	readTranscriptHeaderRemote,
	scanTranscript,
} from "./transcript";
import { sanitizeRemoteForHeader, type RemoteTarget } from "../types";

/** notes 上限：交接备注只是给摘要模型的补充说明，不承载正文 */
const HANDOFF_NOTES_MAX = 4_000;
/** 超预算时的保留目标（hardLimit 的比例）：给摘要指令与输出留足空间 */
const HANDOFF_TRIM_TARGET_RATIO = 0.7;

export type HandoffBrief = {
	summary: string;
	/** 交接前源上下文的估算 token（检查点 details 与 UI 展示用） */
	tokensBefore: number;
	/** 实际进入摘要范围的消息条数（不含系统头/合成摘要头/错误轮） */
	messageCount: number;
	/** 摘要请求的 provider 用量（观测位；不写 transcript） */
	usage?: SummarizeOutcome["usage"];
	attempts?: number;
	/** 超预算裁剪过最早的历史（摘要里已声明） */
	trimmed: boolean;
};

export type GenerateHandoffOptions = {
	sessionId: string;
	/** 用户在交接对话框里填的补充说明（只进摘要指令，不破坏聊天前缀缓存） */
	notes?: string;
	/** 测试注入；缺省走 defaultSummarize（真实模型请求） */
	summarize?: SummarizeFn;
	/** 调用方超时（handler 传 280s，客户端 300s 先于它放弃） */
	signal?: AbortSignal;
	/** 测试注入：固定模型（缺省按会话真值解析：state.model → 转录 → 偏好） */
	model?: Model<Api>;
};

/** 交接指令：与压缩摘要共用"真实对话 + 尾部指令"的形状，只换章节与措辞。
 *  notes / trimmed 只出现在指令里——消息前缀保持与会话原文逐字节一致，
 *  这是驻留会话能命中 prompt cache 的前提。 */
export function buildHandoffInstruction(
	notes?: string,
	opts?: { trimmed?: boolean },
): SummaryPromptBuilder {
	const trimmedNote = opts?.trimmed
		? "[note: the earliest part of this session was omitted to fit the model window; do not assume you have seen everything.]"
		: "";
	const cleanNotes = (notes ?? "").trim().slice(0, HANDOFF_NOTES_MAX);
	const notesBlock = cleanNotes
		? [
				"The user added this note for the handoff:",
				"<note>",
				cleanNotes,
				"</note>",
				"Treat it as context for the brief (especially Next Steps); do not execute it now.",
			].join("\n")
		: "";
	return (previousSummary) => {
		const intro = previousSummary
			? "The summary at the start of this conversation is out of date: the messages after it are new. Rewrite that summary so it covers the whole session from the beginning, keeping everything in it that is still true."
			: "The conversation above is the session so far.";
		return [
			intro,
			"",
			"This session is being handed off to a NEW chat session. The new session will start with no messages; your brief below will be its only context. The workspace on disk is unchanged.",
			...(trimmedNote ? ["", trimmedNote] : []),
			...(notesBlock ? ["", notesBlock] : []),
			"",
			"Your task now is to write a handoff brief that a later agent can continue from with no other context. Do NOT continue the conversation, do NOT answer anything in it, and do NOT call any tools — reply with the brief text only.",
			"",
			"Use exactly these sections:",
			"### Goal",
			"### Current State",
			"### Key Decisions",
			"### Files & Artifacts",
			"### Open Issues",
			"### Next Steps",
			"",
			'Keep each section concise but specific. Preserve exact file paths, function names, commands, URLs and error messages. Note what was already tried and failed. Write in the language the user used most in this conversation. If a section has nothing, write "None".',
		].join("\n");
	};
}

/**
 * 把消息裁到模型预算内（超 hardLimit 才动手）：
 * - 保留头部（leading system / 上一代摘要 / 首条 user 目标）；
 * - 从尾部往前累积到 ~70% hardLimit；
 * - 切点吸附到 user 边界，避免留下悬空 toolResult（部分 provider 直接 400）。
 */
function fitMessagesToBudget(
	messages: AgentMessage[],
	model: Model<Api>,
): { messages: AgentMessage[]; trimmed: boolean } {
	const budget = contextBudget(messages, model);
	if (budget.tokens < budget.hardLimit) return { messages, trimmed: false };
	const target = Math.max(
		1_000,
		Math.floor(budget.hardLimit * HANDOFF_TRIM_TARGET_RATIO),
	);
	const rest = [...messages];
	const head: AgentMessage[] = [];
	const first = rest[0] as { role?: string } | undefined;
	// leading system 永远保留（承载角色/工具约定）；合成摘要头也必须保留——
	// previousSummary 会作为迭代摘要的输入写进指令，裁掉它等于让模型重写一份
	// 自己看不到的摘要。首条 user 常带目标，但只在它不挤占一半预算时保留。
	if (first) {
		const role = first.role;
		const summaryHead = isSummaryMessage(first as AgentMessage);
		if (
			role === "system" ||
			summaryHead ||
			(role === "user" && estimateTokens(rest[0]!) <= target / 2)
		) {
			head.push(rest.shift()!);
			// system 头后面紧跟的摘要头同样保留（驻留路径的典型形状）
			const next = rest[0];
			if (next && isSummaryMessage(next as AgentMessage)) {
				head.push(rest.shift()!);
			}
		}
	}
	let used = head.reduce((sum, m) => sum + estimateTokens(m), 0);
	let start = rest.length;
	while (start > 0) {
		const cost = estimateTokens(rest[start - 1]!);
		if (used + cost > target) break;
		used += cost;
		start -= 1;
	}
	while (start < rest.length) {
		if ((rest[start] as { role?: string }).role === "user") break;
		start += 1;
	}
	if (start >= rest.length) {
		// 窗口里没有完整回合可留（畸形/极短上下文）：退回最后一条 user 起的尾部
		let lastUser = -1;
		for (let i = rest.length - 1; i >= 0; i--) {
			if ((rest[i] as { role?: string }).role === "user") {
				lastUser = i;
				break;
			}
		}
		return lastUser >= 0
			? { messages: [...head, ...rest.slice(lastUser)], trimmed: true }
			: { messages: head, trimmed: true };
	}
	return { messages: [...head, ...rest.slice(start)], trimmed: true };
}

/** 首条非 system 消息是合成摘要头时取它的正文（迭代摘要用） */
function previousSummaryOf(messages: AgentMessage[]): string | undefined {
	const firstContent = messages.find(
		(m) => (m as { role?: string }).role !== "system",
	);
	return firstContent && isSummaryMessage(firstContent)
		? summaryTextOf(firstContent)
		: undefined;
}

/**
 * 生成交接摘要。驻留会话用 state.messages + tools（与聊天前缀同形，可命中
 * 缓存）；非驻留会话从转录恢复上下文（tools 传空，冷请求）。
 */
export async function generateHandoffBrief(
	options: GenerateHandoffOptions,
): Promise<HandoffBrief> {
	const { sessionId } = options;
	const row = await sessionGet(sessionId);
	if (!row) throw new Error(`session not found: ${sessionId}`);
	// findRunBySession 只信 runningBySession 索引；索引陈旧（线程改绑残留）时
	// 可能指到别的 session——校验 run.sessionId，不匹配就回退转录投影。
	const residentRun = findRunBySession(sessionId)?.run;
	const resident =
		residentRun && residentRun.sessionId === sessionId ? residentRun : undefined;
	// 驻留 run 的 state 是权威上下文（含 leading system）；非驻留退到转录投影。
	// 两种形态都不读 pending/partial：调用方已保证没有在跑轮次。
	const scan = resident ? undefined : scanTranscript(sessionId);
	// 两种来源都归一到 AgentMessage[]：projectRestoreContext 返回 pi-ai Message[]，
	// 与 AgentMessage 结构同形，只是类型联合看起来不同
	const projected: AgentMessage[] = resident
		? (resident.agent.state.messages as AgentMessage[])
		: (projectRestoreContext(
				scan!.messages,
				scan!.compactions.at(-1),
			) as unknown as AgentMessage[]);
	const previousSummary = previousSummaryOf(projected);
	const compactable = projected.filter(isCompactableMessage);
	// 与 compaction 的 tokensBefore 同口径：含 leading system，供 UI 显示
	// 「交接前 N tokens」；空摘要复用分支也用它。
	const tokensBefore = estimateContextTokens(projected).tokens;

	// 只有摘要头、没有新内容：直接沿用上一代摘要，不再花一次模型请求
	if (compactable.length === 0) {
		if (previousSummary?.trim()) {
			return {
				summary: previousSummary,
				tokensBefore,
				messageCount: 0,
				trimmed: false,
			};
		}
		throw new Error("nothing to hand off: this session has no conversation content");
	}

	const model =
		options.model ??
		resident?.agent.state.model ??
		(await sessionModelFor(scan?.model ?? null, row));
	if (isModelUnavailable(model)) {
		throw new Error("no model configured: cannot summarize this session");
	}
	const budget = contextBudget(projected, model);
	const fitted = fitMessagesToBudget(projected, model);
	const summarize =
		options.summarize ??
		defaultSummarize(
			model,
			options.signal,
			getModels(),
			buildHandoffInstruction(options.notes, { trimmed: fitted.trimmed }),
		);
	const chat = {
		messages: fitted.messages,
		// 驻留才带工具表：同表同序才可能命中前缀缓存；非驻留重建工具表不值得
		tools: resident
			? ((resident.agent.state.tools ?? []) as readonly unknown[])
			: [],
		sessionId,
		thinkingLevel: resident
			? (resident.agent.state.thinkingLevel as string | undefined)
			: (scan?.thinkingLevel ?? undefined),
	};
	const raw = await summarize(
		compactable,
		budget.requestHeadroom,
		previousSummary,
		chat,
	);
	const outcome: SummarizeOutcome =
		typeof raw === "string" ? { text: raw } : raw;
	const summary = outcome.text.trim();
	if (!summary) {
		throw new Error("summary generation returned no content");
	}
	if (outcome.truncated === true) {
		throw new Error("summary generation was truncated at the output cap");
	}
	return {
		summary,
		tokensBefore,
		messageCount: compactable.length,
		...(outcome.usage ? { usage: outcome.usage } : {}),
		...(outcome.attempts ? { attempts: outcome.attempts } : {}),
		trimmed: fitted.trimmed,
	};
}

/** 交接摘要生成 seam：handler 调它，测试注入假实现（仿 titleSummarizeHook） */
export const handoffBriefHook: { fn?: typeof generateHandoffBrief } = {};

/** 源会话标题兜底：索引标题 → 首条消息（剥芯片）→ 未命名 */
export function handoffSourceTitle(row: {
	title: string;
	first_message: string;
}): string {
	const title = row.title.trim();
	if (title) return title;
	const first = stripDirectiveTokens(row.first_message).trim().slice(0, 60);
	return first || "未命名会话";
}

export type HandoffSessionInput = {
	sourceSessionId: string;
	sourceTitle: string;
	cwd: string;
	remote?: RemoteTarget | null;
	brief: HandoffBrief;
	archiveSource?: boolean;
};

/** 新会话里的交接卡标题后缀（与 fork 的「（分支）」同款事实源：后端拼接）。
 *  链式交接（交接会话再交接）剥掉上一次的后缀，避免「X（交接）（交接）」堆叠。 */
function handoffTitle(sourceTitle: string): string {
	const base = sourceTitle.replace(/(?:（交接）)+$/u, "").trim() || sourceTitle;
	return `${base}（交接）`;
}

/** 继承源会话的模型/思考/审批/工作模式/设计主题；goal 模式降级为 agent
 *  （goal 的运行态不随交接复制，带着 goal 档位只会得到一个空目标会话）。 */
async function copySessionPrefs(
	prefs: Awaited<ReturnType<typeof sessionGet>>,
	targetSessionId: string,
): Promise<void> {
	if (!prefs) return;
	await sessionPrefsSet(targetSessionId, {
		...(prefs.mode
			? {
					mode:
						prefs.mode === "goal"
							? "agent"
							: normalizeSessionMode(prefs.mode),
				}
			: {}),
		...(isApprovalLevel(prefs.approvalLevel)
			? { approvalLevel: prefs.approvalLevel }
			: {}),
		...(prefs.modelProvider ? { modelProvider: prefs.modelProvider } : {}),
		...(prefs.modelId ? { modelId: prefs.modelId } : {}),
		...(prefs.thinkingLevel ? { thinkingLevel: prefs.thinkingLevel } : {}),
		...(prefs.designTheme !== null && prefs.designTheme !== undefined
			? { designTheme: prefs.designTheme }
			: {}),
		...(prefs.appMode ? { appMode: prefs.appMode } : {}),
	});
}

/**
 * 落盘新会话：header + 一条交接检查点行（seq 0，throughSeq -1 = 覆盖全部
 * 历史，但新会话本来就没有消息行），再写索引/标题/偏好。
 *
 * 索引计数记 1 的原因见文件头。artifact 收养让摘要里引用的产物在源会话
 * 被删除后仍可读（与 fork 同款）。
 */
export async function writeHandoffSession(
	input: HandoffSessionInput,
): Promise<{ sessionId: string; archived: boolean }> {
	const newId = randomUUID();
	const now = new Date().toISOString();
	const sourceTitle = input.sourceTitle.trim() || "未命名会话";
	const title = handoffTitle(sourceTitle);
	// 偏好只读一次：既用于转录设定行（模型/思考的真值），也用于索引偏好列。
	// 注意思考档位不能只写偏好列——resolveSession 的 initialThinking 只认转录
	// 的 thinking_level_change 行或全局默认，不回落偏好列。
	const prefs = await sessionGet(input.sourceSessionId);
	// 模型/思考的有效值按 resolveSession 同一优先级取：转录设定行 > 偏好列。
	// 旧会话可能只有转录行、偏好列为 NULL；只看偏好列会让新会话掉回全局模型。
	const sourceScan = scanTranscript(input.sourceSessionId);
	const effectiveModel = sourceScan.model
		? sourceScan.model
		: prefs?.modelProvider && prefs.modelId
			? { provider: prefs.modelProvider, modelId: prefs.modelId }
			: null;
	const effectiveThinking = sourceScan.thinkingLevel ?? prefs?.thinkingLevel ?? null;
	const references = collectArtifactReferences(input.brief.summary);
	const mapping = await adoptSessionArtifacts({
		sourceSessionId: input.sourceSessionId,
		targetSessionId: newId,
		references,
	});
	const settingRows: Record<string, unknown>[] = [];
	if (effectiveModel) {
		settingRows.push({
			type: "model_change",
			provider: effectiveModel.provider,
			modelId: effectiveModel.modelId,
			timestamp: now,
		});
	}
	if (effectiveThinking) {
		settingRows.push({
			type: "thinking_level_change",
			thinkingLevel: effectiveThinking,
			timestamp: now,
		});
	}
	const checkpoint = {
		type: "compaction",
		seq: 0,
		summary: input.brief.summary,
		tokensBefore: input.brief.tokensBefore,
		throughSeq: -1,
		createdAt: now,
		details: {
			generation: 1,
			strategy: "handoff",
			handoffFrom: {
				sessionId: input.sourceSessionId,
				title: sourceTitle,
			},
			messageCount: input.brief.messageCount,
			...(input.brief.usage ? { summaryUsage: input.brief.usage } : {}),
			...(input.brief.attempts
				? { summaryAttempts: input.brief.attempts }
				: {}),
			...(input.brief.trimmed ? { trimmed: true } : {}),
		},
	};
	const body = rewriteArtifactReferences(
		[
			// 设定行必须写在 checkpoint 之前：scanTranscript 的 model_change
			// afterSeq 从"此前最大 seq"推出，写在其后会被当成一次切换事件，
			// 空会话顶部会冒出一条「已切换到 X」分隔线。写在 checkpoint 前
			// afterSeq=null（初始选择，不渲染）。
			...settingRows.map((row) => JSON.stringify(row)),
			JSON.stringify(checkpoint),
		],
		mapping,
	);
	const header = {
		type: "header",
		schema: 1,
		id: newId,
		cwd: input.cwd,
		created_at: now,
		// 交接溯源：源会话 id（与 fork 的 parentSession 同字段，kind 留空 =
		// 普通会话，不会进 side_chat 的列表过滤/级联删除分支）
		parentSession: input.sourceSessionId,
		...(input.remote
			? { remote: sanitizeRemoteForHeader(input.remote) }
			: {}),
	};
	try {
		writeFileSync(
			sessionPath(newId),
			JSON.stringify(header) + "\n" + body.join("\n") + "\n",
		);
		await sessionInsert(newId, input.cwd, {
			// 交接与 fork/side_chat 同语义：继承源会话的项目归属（共享目录/
			// 非唯一 cwd 时按 cwd 推导会丢项目上下文）
			...(prefs?.projectId ? { projectId: prefs.projectId } : {}),
		});
		// 交接卡在 UI 上是一条可见内容；索引 0 会被 list_sessions 过滤掉
		await sessionTouch(newId, title, "", 1);
	} catch (error) {
		await removeSessionArtifacts(newId).catch(() => undefined);
		// 索引行可能已插入（sessionInsert 成功、touch 失败）：一并清掉，
		// 否则留下 count=0 的幽灵行
		await sessionDelete(newId).catch(() => undefined);
		try {
			unlinkSync(sessionPath(newId));
		} catch {
			// 文件没写成功/已被清掉：忽略
		}
		throw error;
	}
	// 偏好继承是尽力而为：失败不该让已经落盘的交接失败
	try {
		await copySessionPrefs(prefs, newId);
		// 旧会话可能只有转录设定行、偏好列 NULL：把有效模型/思考补投影到
		// 索引列，前端模型选择器与列表水合才不会显示成全局默认
		if (effectiveModel || effectiveThinking) {
			await sessionPrefsSet(newId, {
				...(effectiveModel
					? {
							modelProvider: effectiveModel.provider,
							modelId: effectiveModel.modelId,
						}
					: {}),
				...(effectiveThinking
					? { thinkingLevel: effectiveThinking }
					: {}),
			});
		}
	} catch (error) {
		logErr("handoff: copy session prefs failed:", error);
	}
	let archived = false;
	if (input.archiveSource) {
		try {
			await sessionSetArchived(input.sourceSessionId, true);
			archived = true;
		} catch (error) {
			logErr("handoff: archive source session failed:", error);
		}
	}
	logAt(
		"event",
		`handoff: ${input.sourceSessionId} -> ${newId} (${input.brief.tokensBefore} tokens, ${input.brief.messageCount} messages${input.brief.trimmed ? ", trimmed" : ""})`,
	);
	return { sessionId: newId, archived };
}

/** handler 入口：生成摘要 + 落盘（测试通过 handoffBriefHook 注入摘要） */
export async function runHandoff(options: {
	sessionId: string;
	notes?: string;
	archiveSource?: boolean;
}): Promise<{ sessionId: string; archived: boolean }> {
	// 忙检查：在跑轮次（含审批/问题挂起）与队列里待派发的消息都不能交接——
	// 后者还没落盘，摘要会漏掉用户刚排进去的指令。
	if (listActiveTurnSessions().includes(options.sessionId)) {
		throw new Error("session is busy: wait for the current response to finish");
	}
	const owner = findRunBySession(options.sessionId);
	if (
		owner &&
		owner.run.sessionId === options.sessionId &&
		shouldQueue(owner.threadId)
	) {
		throw new Error("session is busy: wait for the current response to finish");
	}
	const source = await sessionListRow(options.sessionId);
	if (!source) throw new Error(`session not found: ${options.sessionId}`);
	// 辅助会话的正文是父会话的 model-only 副本，再交接只会把语义带得更乱
	if (source.kind === "side_chat") {
		throw new Error("side chat session cannot be handed off");
	}
	const sourceTitle = handoffSourceTitle(source);
	const brief = await (handoffBriefHook.fn ?? generateHandoffBrief)({
		sessionId: options.sessionId,
		...(options.notes ? { notes: options.notes } : {}),
		signal: AbortSignal.timeout(280_000),
	});
	return writeHandoffSession({
		sourceSessionId: options.sessionId,
		sourceTitle,
		cwd: source.cwd,
		remote: readTranscriptHeaderRemote(options.sessionId),
		brief,
		...(options.archiveSource ? { archiveSource: true } : {}),
	});
}

/** 索引行读取（避免 sessions.ts 与 handoff.ts 的导入环：这里直接用 hostdb） */
async function sessionListRow(
	sessionId: string,
): Promise<
	{ title: string; first_message: string; cwd: string; kind: string } | undefined
> {
	const rows = await sessionList();
	const row = rows.find((r) => r.id === sessionId);
	return row
		? {
				title: row.title,
				first_message: row.first_message,
				cwd: row.cwd,
				kind: row.kind,
			}
		: undefined;
}
