/**
 * 会话交接（handoff）：摘要生成 + 新会话落盘/投影。
 *
 * 关键不变量：
 * - 新会话只写一条 checkpoint 行（strategy=handoff），不复制历史消息；
 * - 索引计数记 1（list_sessions 会过滤 message_count=0，否则切不过去）；
 * - 模型上下文 = 合成摘要消息（projectRestoreContext）；
 * - UI 投影首条是 compactionSummary / data-compaction，带 strategy + handoffFrom，
 *   不出现用户气泡；
 * - 交接检查点不参与"压缩后首轮重建"缓存统计；
 * - 偏好继承、可选归档源会话。
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import { initStorage, sessionPath } from "../../src/storage/storage";
import {
	sessionGet,
	sessionInsert,
	sessionList,
	sessionPrefsSet,
	sessionTouch,
	modelsReplace,
} from "../../src/storage/hostdb";
import { registerCustomProvider } from "../../src/model/model-catalog";
import { dispatch } from "../../src/protocol/protocol";
import {
	buildHandoffInstruction,
	generateHandoffBrief,
	handoffBriefHook,
	runHandoff,
	writeHandoffSession,
} from "../../src/sessions/handoff";
import {
	contextInfoFrom,
	makeSummaryMessage,
	projectRestoreContext,
} from "../../src/agent/context";
import { scanTranscript } from "../../src/sessions/transcript";
import { resolveSession } from "../../src/sessions/sessions";
import { dropRun, noteActiveTurn, running, trackSessionRun } from "../../src/sessions/registry";
import type { Running } from "../../src/types";

const tmp = mkdtempSync(path.join(tmpdir(), "pi-agent-handoff-"));
const srcId = "handoff-src";
const trimSrcId = "handoff-trim-src";
const summaryOnlyId = "handoff-summary-only";
const summaryTrimId = "handoff-summary-trim";

const lines: string[] = [];
let origWrite: typeof process.stdout.write;
const prevIdentityDir = process.env.PI_IDENTITY_DIR;

beforeAll(() => {
	initStorage(path.join(tmp, "state.db"), path.join(tmp, "sessions"));
	// resolveSession 会组装系统提示词并读身份文件：钉到空目录，避免触碰真实 ~/.kova/
	process.env.PI_IDENTITY_DIR = path.join(tmp, "identity");
	origWrite = process.stdout.write.bind(process.stdout);
	(process.stdout as unknown as { write: (c: unknown) => boolean }).write = (
		c: unknown,
	) => {
		lines.push(String(c));
		return true;
	};
});

afterAll(() => {
	(process.stdout as unknown as { write: (c: unknown) => boolean }).write =
		origWrite as unknown as (c: unknown) => boolean;
	if (prevIdentityDir === undefined) delete process.env.PI_IDENTITY_DIR;
	else process.env.PI_IDENTITY_DIR = prevIdentityDir;
});

const last = (): Record<string, unknown> => JSON.parse(lines[lines.length - 1]);

const fakeModel = (contextWindow = 128_000, maxTokens = 8_192) =>
	({
		id: "m",
		name: "m",
		api: "openai-completions",
		provider: "test",
		baseUrl: "",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow,
		maxTokens,
	}) as unknown as Model<Api>;

const msg = (role: "user" | "assistant", text: string, seq: number) => ({
	type: "message",
	seq,
	ui: null,
	agent: {
		role,
		content: [{ type: "text", text }],
		timestamp: seq + 1,
		...(role === "assistant" ? { stopReason: "stop" } : {}),
	},
});

const header = (id: string) => ({
	type: "header",
	schema: 1,
	id,
	cwd: tmp,
	created_at: new Date().toISOString(),
});

/** 源会话：两轮真实对话 + 偏好（供交接继承断言） */
const newHandoffSessionId: { value: string } = { value: "" };

beforeAll(async () => {
	// 注册 test/m 到模型目录：resolveSession 的模型恢复走 catalog，未注册会回落
	// unknown 占位（生产环境模型本来就在目录里）
	await modelsReplace("test", [
		{ modelId: "m", enabled: true, contextWindow: 128_000, maxTokens: 8_192 },
	]);
	await registerCustomProvider({
		id: "test",
		name: "Test",
		baseUrl: "https://test.local",
		api: "openai-chat",
	});

	await sessionInsert(srcId, tmp);
	await sessionTouch(srcId, "Long task", "build the thing", 4);
	await sessionPrefsSet(srcId, {
		modelProvider: "test",
		modelId: "m",
		thinkingLevel: "high",
		approvalLevel: "auto",
		appMode: "code",
		mode: "agent",
	});
	writeFileSync(
		sessionPath(srcId),
		[
			header(srcId),
			msg("user", "build the thing", 0),
			msg("assistant", "started", 1),
			msg("user", "next step", 2),
			msg("assistant", "done", 3),
		]
			.map((row) => JSON.stringify(row))
			.join("\n") + "\n",
	);

	// 裁剪用例源：8 条长消息，小窗口模型下必超预算
	await sessionInsert(trimSrcId, tmp);
	const long = "x".repeat(4_000);
	writeFileSync(
		sessionPath(trimSrcId),
		[
			header(trimSrcId),
			...Array.from({ length: 8 }, (_, i) =>
				msg(i % 2 === 0 ? "user" : "assistant", `${i}:${long}`, i),
			),
		]
			.map((row) => JSON.stringify(row))
			.join("\n") + "\n",
	);

	// 只有上一代摘要、没有新消息：交接应直接复用摘要，不再调模型
	await sessionInsert(summaryOnlyId, tmp);
	writeFileSync(
		sessionPath(summaryOnlyId),
		[
			header(summaryOnlyId),
			{
				type: "compaction",
				seq: 0,
				summary: "OLD SUMMARY",
				tokensBefore: 100,
				throughSeq: -1,
				createdAt: new Date().toISOString(),
			},
		]
			.map((row) => JSON.stringify(row))
			.join("\n") + "\n",
	);

	// 上一代摘要 + 8 条长消息：超预算裁剪时摘要头不能被裁掉（指令引用了它）
	await sessionInsert(summaryTrimId, tmp);
	const longTail = "y".repeat(4_000);
	writeFileSync(
		sessionPath(summaryTrimId),
		[
			header(summaryTrimId),
			{
				type: "compaction",
				seq: 0,
				summary: "OLD SUMMARY",
				tokensBefore: 100,
				throughSeq: -1,
				createdAt: new Date().toISOString(),
			},
			...Array.from({ length: 8 }, (_, i) =>
				msg(i % 2 === 0 ? "user" : "assistant", `${i}:${longTail}`, i + 1),
			),
		]
			.map((row) => JSON.stringify(row))
			.join("\n") + "\n",
	);

	// 端到端：注入假摘要，跑一次 handoff_session（带备注 + 归档源会话）
	handoffBriefHook.fn = async () => ({
		summary: "HANDOFF BRIEF",
		tokensBefore: 1_234,
		messageCount: 4,
		trimmed: false,
	});
	try {
		await dispatch("h-setup", {
			type: "handoff_session",
			sessionId: srcId,
			notes: "next is X",
			archiveSource: true,
		});
	} finally {
		// 失败也要复位，避免后续用例误用注入摘要
		handoffBriefHook.fn = undefined;
	}
	const reply = last();
	expect(reply.type).toBe("handoff_created");
	newHandoffSessionId.value = String(reply.sessionId);
});

describe("buildHandoffInstruction", () => {
	test("章节完整；notes 只在传入时出现；迭代摘要带重写开场", () => {
		const plain = buildHandoffInstruction()(undefined);
		for (const section of [
			"### Goal",
			"### Current State",
			"### Key Decisions",
			"### Files & Artifacts",
			"### Open Issues",
			"### Next Steps",
		]) {
			expect(plain).toContain(section);
		}
		expect(plain).not.toContain("keep A");
		expect(plain).toContain("Write in the language the user used most");

		const withNotes = buildHandoffInstruction("keep A")(undefined);
		expect(withNotes).toContain("keep A");
		expect(withNotes).toContain("do not execute it now");

		const iterative = buildHandoffInstruction()("OLD");
		expect(iterative).toContain("out of date");
	});

	test("超预算裁剪时指令声明最早部分已省略", () => {
		expect(
			buildHandoffInstruction(undefined, { trimmed: true })(undefined),
		).toContain("earliest part of this session was omitted");
	});
});

describe("generateHandoffBrief", () => {
	test("正常生成：返回摘要/占用/消息数，chat 上下文带 sessionId", async () => {
		const calls: {
			previous: string | undefined;
			sessionId: string;
			messageCount: number;
		}[] = [];
		const brief = await generateHandoffBrief({
			sessionId: srcId,
			model: fakeModel(),
			summarize: async (_messages, _reserve, previous, chat) => {
				calls.push({
					previous,
					sessionId: chat.sessionId,
					messageCount: chat.messages.length,
				});
				return "BRIEF";
			},
		});
		expect(brief.summary).toBe("BRIEF");
		expect(brief.messageCount).toBeGreaterThan(0);
		expect(brief.tokensBefore).toBeGreaterThan(0);
		expect(brief.trimmed).toBe(false);
		expect(calls).toHaveLength(1);
		expect(calls[0]!.previous).toBeUndefined();
		expect(calls[0]!.sessionId).toBe(srcId);
		expect(calls[0]!.messageCount).toBeGreaterThan(0);
	});

	test("空摘要 / 截断摘要判失败，不产生可用结果", async () => {
		await expect(
			generateHandoffBrief({
				sessionId: srcId,
				model: fakeModel(),
				summarize: async () => "   ",
			}),
		).rejects.toThrow("no content");
		await expect(
			generateHandoffBrief({
				sessionId: srcId,
				model: fakeModel(),
				summarize: async () => ({ text: "half", truncated: true }),
			}),
		).rejects.toThrow("truncated");
	});

	test("只有上一代摘要时直接复用，不再调模型", async () => {
		const brief = await generateHandoffBrief({
			sessionId: summaryOnlyId,
			model: fakeModel(),
			summarize: async () => {
				throw new Error("should not be called");
			},
		});
		expect(brief.summary).toBe("OLD SUMMARY");
		expect(brief.messageCount).toBe(0);
	});

	test("超预算时裁剪消息（保留头部 + 最近尾部）", async () => {
		let seen = 0;
		await generateHandoffBrief({
			sessionId: trimSrcId,
			model: fakeModel(4_000, 1_000),
			summarize: async (_messages, _reserve, _previous, chat) => {
				seen = chat.messages.length;
				return "TRIMMED";
			},
		});
		expect(seen).toBeGreaterThan(0);
		expect(seen).toBeLessThan(8);
	});

	test("超预算裁剪保留上一代摘要头（迭代摘要指令引用了它）", async () => {
		let firstText = "";
		let seen = 0;
		await generateHandoffBrief({
			sessionId: summaryTrimId,
			model: fakeModel(4_000, 1_000),
			summarize: async (_messages, _reserve, _previous, chat) => {
				seen = chat.messages.length;
				const first = chat.messages[0] as {
					content?: { type: string; text: string }[];
				};
				firstText = first.content?.[0]?.text ?? "";
				return "TRIMMED";
			},
		});
		expect(firstText).toContain("OLD SUMMARY");
		expect(seen).toBeLessThan(9);
	});

	test("驻留会话复用 state.messages + tools + thinkingLevel（缓存友好路径）", async () => {
		const sid = "handoff-resident";
		const threadId = "handoff-resident-thread";
		await sessionInsert(sid, tmp);
		const run = {
			agent: {
				state: {
					model: fakeModel(),
					messages: [
						{
							role: "system",
							content: [{ type: "text", text: "sys" }],
							timestamp: 0,
						},
						{
							role: "user",
							content: [{ type: "text", text: "hi" }],
							timestamp: 1,
						},
						{
							role: "assistant",
							content: [{ type: "text", text: "hello" }],
							timestamp: 2,
							stopReason: "stop",
							usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
						},
					],
					tools: [{ name: "fake-tool" }],
					thinkingLevel: "high",
				},
			},
			sessionId: sid,
		} as unknown as Running;
		running.set(threadId, run);
		trackSessionRun(sid, threadId);
		try {
			let tools: readonly unknown[] = [];
			let thinking: string | undefined;
			const brief = await generateHandoffBrief({
				sessionId: sid,
				model: fakeModel(),
				summarize: async (_messages, _reserve, _previous, chat) => {
					tools = chat.tools;
					thinking = chat.thinkingLevel;
					return "RESIDENT";
				},
			});
			expect(brief.summary).toBe("RESIDENT");
			expect(tools).toHaveLength(1);
			expect(thinking).toBe("high");
		} finally {
			dropRun(threadId);
		}
	});

	test("驻留会话超预算：裁剪同时保留 system 与摘要头", async () => {
		const sid = "handoff-resident-trim";
		const threadId = "handoff-resident-trim-thread";
		await sessionInsert(sid, tmp);
		const long = "z".repeat(4_000);
		const run = {
			agent: {
				state: {
					model: fakeModel(4_000, 1_000),
					messages: [
						{
							role: "system",
							content: [{ type: "text", text: "sys" }],
							timestamp: 0,
						},
						makeSummaryMessage("OLD SUMMARY"),
						...Array.from({ length: 8 }, (_, i) => ({
							role: i % 2 === 0 ? "user" : "assistant",
							content: [{ type: "text", text: `${i}:${long}` }],
							timestamp: i + 1,
							// 不写 usage：否则估算器只信最后一条 assistant 的 provider
							// 用量（15 tokens），会误判为远低于预算而不裁剪
							...(i % 2 === 1 ? { stopReason: "stop" } : {}),
						})),
					],
					tools: [],
					thinkingLevel: "high",
				},
			},
			sessionId: sid,
		} as unknown as Running;
		running.set(threadId, run);
		trackSessionRun(sid, threadId);
		try {
			let firstRole = "";
			let secondText = "";
			let seen = 0;
			await generateHandoffBrief({
				sessionId: sid,
				model: fakeModel(4_000, 1_000),
				summarize: async (_messages, _reserve, _previous, chat) => {
					seen = chat.messages.length;
					firstRole = (chat.messages[0] as { role: string }).role;
					const second = chat.messages[1] as {
						content: { type: string; text: string }[];
					};
					secondText = second.content[0]!.text;
					return "TRIMMED";
				},
			});
			expect(firstRole).toBe("system");
			expect(secondText).toContain("OLD SUMMARY");
			expect(seen).toBeLessThan(10);
		} finally {
			dropRun(threadId);
		}
	});
});

describe("handoff_session 端到端", () => {
	test("新会话只带 checkpoint 行，索引计数 1，list_sessions 可见", async () => {
		const newId = newHandoffSessionId.value;
		expect(newId).not.toBe(srcId);

		const row = (await sessionList()).find((r) => r.id === newId);
		expect(row).toBeDefined();
		expect(row!.title).toBe("Long task（交接）");
		expect(row!.message_count).toBe(1);
		// 普通会话（不是 side_chat），不会进级联删除分支
		expect(row!.kind).toBe("");

		const parsed = readFileSync(sessionPath(newId), "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as Record<string, unknown>);
		expect(parsed[0]!.type).toBe("header");
		expect(parsed[0]!.parentSession).toBe(srcId);
		// 模型/思考档位写转录设定行（思考不回落偏好列，必须落行才能恢复）
		const modelRow = parsed.find((line) => line.type === "model_change") as {
			provider: string;
			modelId: string;
		};
		expect(modelRow).toEqual(
			expect.objectContaining({ provider: "test", modelId: "m" }),
		);
		const thinkingRow = parsed.find(
			(line) => line.type === "thinking_level_change",
		) as { thinkingLevel: string };
		expect(thinkingRow.thinkingLevel).toBe("high");
		const scan = scanTranscript(newId);
		expect(scan.model).toEqual({ provider: "test", modelId: "m" });
		expect(scan.thinkingLevel).toBe("high");
		// 设定行在 checkpoint 之前：属于初始选择，scanTranscript 不把它当可见切换
		expect(scan.modelChanges).toHaveLength(0);
		const cp = parsed.find((line) => line.type === "compaction") as {
			summary: string;
			throughSeq: number;
			details: {
				strategy: string;
				handoffFrom: { sessionId: string; title: string };
			};
		};
		expect(cp.summary).toBe("HANDOFF BRIEF");
		expect(cp.throughSeq).toBe(-1);
		expect(cp.details.strategy).toBe("handoff");
		expect(cp.details.handoffFrom).toEqual({
			sessionId: srcId,
			title: "Long task",
		});
		// 没有复制任何历史消息行
		expect(parsed.some((line) => line.type === "message")).toBe(false);

		await dispatch("h-list", { type: "list_sessions" });
		const sessions = last().sessions as { sessionId: string }[];
		expect(sessions.some((s) => s.sessionId === newId)).toBe(true);

		// 偏好继承
		const prefs = await sessionGet(newId);
		expect(prefs?.modelProvider).toBe("test");
		expect(prefs?.modelId).toBe("m");
		expect(prefs?.thinkingLevel).toBe("high");
		expect(prefs?.approvalLevel).toBe("auto");
		expect(prefs?.appMode).toBe("code");

		// 源会话归档
		const source = (await sessionList()).find((r) => r.id === srcId);
		expect(source?.archived).toBe(1);
	});

	test("模型上下文 = 合成摘要消息（不是 user 气泡）", () => {
		const scan = scanTranscript(newHandoffSessionId.value);
		const restored = projectRestoreContext(
			scan.messages,
			scan.compactions.at(-1),
		);
		expect(restored).toHaveLength(1);
		expect(restored[0]!.role).toBe("user");
		const text = (restored[0]!.content as { type: string; text: string }[])[0]!
			.text;
		expect(text).toContain("HANDOFF BRIEF");
		expect(text).toContain("compacted into the following summary");
	});

	test("新会话 resolveSession：摘要进入 run，模型/思考按转录设定恢复", async () => {
		const newId = newHandoffSessionId.value;
		const threadId = "handoff-restore-thread";
		const run = await resolveSession(threadId, newId, tmp);
		try {
			const messages = run.agent.state.messages as {
				role?: string;
				content?: unknown;
			}[];
			const summary = messages.find((m) => m.role === "user");
			expect(summary).toBeDefined();
			const text = (summary!.content as { type: string; text: string }[])[0]!
				.text;
			expect(text).toContain("HANDOFF BRIEF");
			expect(run.agent.state.model?.provider).toBe("test");
			expect(run.agent.state.model?.id).toBe("m");
			expect(run.agent.state.thinkingLevel).toBe("high");
		} finally {
			dropRun(threadId);
		}
	});

	test("thread_snapshot / get_history 投影为交接卡，且带 strategy/handoffFrom", async () => {
		const newId = newHandoffSessionId.value;
		await dispatch("h-snap", { type: "thread_snapshot", sessionId: newId });
		const snapshot = last().snapshot as { messages: Record<string, unknown>[] };
		// 索引计数用的 usage 行是我们补的 assistant 行；快照里应只有 checkpoint
		// 消息 + 两条 assistant（没有 user 气泡、没有历史复制）
		expect(snapshot.messages.some((m) => m.role === "user")).toBe(false);
		// 初始模型选择不渲染「已切换到 X」分隔线
		expect(snapshot.messages.some((m) => m.role === "modelChange")).toBe(false);
		const cp = snapshot.messages.find(
			(m) => m.role === "compactionSummary",
		) as Record<string, unknown>;
		expect(cp).toBeDefined();
		expect(cp.strategy).toBe("handoff");
		expect(cp.handoffFrom).toEqual({ sessionId: srcId, title: "Long task" });

		await dispatch("h-hist", { type: "get_history", sessionId: newId });
		const messages = last().messages as {
			role: string;
			parts: { type: string; data?: Record<string, unknown> }[];
		}[];
		const card = messages.find(
			(m) => m.parts[0]?.type === "data-compaction",
		);
		expect(card).toBeDefined();
		expect(card!.parts[0]!.data?.strategy).toBe("handoff");
		expect(card!.parts[0]!.data?.handoffFrom).toEqual({
			sessionId: srcId,
			title: "Long task",
		});
	});

	test("context_info：lastCompaction 标记 handoff，缓存统计不算压缩重建", () => {
		// 补两轮带 usage 的 assistant 行：验第二条请求是正常缓存命中，而不是
		// 被"压缩后首轮重建"启发式误记成 rebuild
		appendFileSync(
			sessionPath(newHandoffSessionId.value),
			JSON.stringify({
				type: "message",
				seq: 1,
				ui: null,
				agent: {
					role: "assistant",
					content: [{ type: "text", text: "first answer" }],
					stopReason: "stop",
					timestamp: 10,
					usage: { input: 0, output: 10, cacheRead: 1_000, cacheWrite: 0 },
				},
			}) + "\n",
		);
		appendFileSync(
			sessionPath(newHandoffSessionId.value),
			JSON.stringify({
				type: "message",
				seq: 2,
				ui: null,
				agent: {
					role: "assistant",
					content: [{ type: "text", text: "second answer" }],
					stopReason: "stop",
					timestamp: 20,
					usage: { input: 0, output: 12, cacheRead: 1_000, cacheWrite: 0 },
				},
			}) + "\n",
		);
		const scan = scanTranscript(newHandoffSessionId.value);
		const info = contextInfoFrom({
			model: fakeModel(),
			messages: scan.messages.map((m) => m.agent),
			systemPrompt: "",
			tools: [],
			sessionId: newHandoffSessionId.value,
			compactionGeneration: 1,
		});
		expect(info.lastCompaction?.strategy).toBe("handoff");
		expect(info.lastCompaction?.handoffFrom).toEqual({
			sessionId: srcId,
			title: "Long task",
		});
		// 两条 assistant 请求：第二条是正常缓存命中，不该被记成"压缩后重建"
		expect(info.cacheMisses.requests).toBe(2);
		expect(info.cacheMisses.rebuilds).toBe(0);
	});

	test("未知会话 / 辅助会话拒绝交接", async () => {
		await expect(
			dispatch("h-404", {
				type: "handoff_session",
				sessionId: "no-such-session",
			}),
		).rejects.toThrow("session not found");
	});

	test("忙会话（在跑轮次）拒绝交接，不产生新会话", async () => {
		const before = (await sessionList()).length;
		noteActiveTurn("handoff-busy-thread", true, srcId, "req-busy");
		try {
			await expect(runHandoff({ sessionId: srcId })).rejects.toThrow(
				"session is busy",
			);
		} finally {
			noteActiveTurn("handoff-busy-thread", false);
		}
		expect((await sessionList()).length).toBe(before);
	});

	test("旧会话（偏好列 NULL、只有转录设定行）也继承模型/思考", async () => {
		const legacyId = "handoff-legacy";
		await sessionInsert(legacyId, tmp);
		writeFileSync(
			sessionPath(legacyId),
			[
				header(legacyId),
				{
					type: "model_change",
					provider: "test",
					modelId: "m",
					timestamp: new Date().toISOString(),
				},
				{
					type: "thinking_level_change",
					thinkingLevel: "low",
					timestamp: new Date().toISOString(),
				},
				msg("user", "legacy work", 0),
			]
				.map((row) => JSON.stringify(row))
				.join("\n") + "\n",
		);
		const result = await writeHandoffSession({
			sourceSessionId: legacyId,
			sourceTitle: "Legacy",
			cwd: tmp,
			brief: {
				summary: "LEGACY BRIEF",
				tokensBefore: 1,
				messageCount: 1,
				trimmed: false,
			},
		});
		const scan = scanTranscript(result.sessionId);
		expect(scan.model).toEqual({ provider: "test", modelId: "m" });
		expect(scan.thinkingLevel).toBe("low");
		// 索引偏好列同步投影，前端模型选择器/列表水合不会显示成全局默认
		const prefs = await sessionGet(result.sessionId);
		expect(prefs?.modelProvider).toBe("test");
		expect(prefs?.modelId).toBe("m");
		expect(prefs?.thinkingLevel).toBe("low");
	});
});
