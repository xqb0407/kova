/**
 * pi 1.5.0 参数校验层回归门（TypeBox → pi-schema 迁移后）。
 *
 * 背景：pi 1.5.0 把工具参数校验从 TypeBox 换成 pi-schema（compile coerce）。
 * 行为变化两条，都是升级后没有覆盖就会悄悄回归的：
 *   1. coerce 生效——数字参数发字符串、单值包数组等会被宽松修正（MCP 工具的
 *      plain JSON Schema 以前没有这层）；
 *   2. obj() 默认 closed（additionalProperties: false）——多余参数从不报错变为
 *      报清晰错误。
 *
 * 校验入口与生产一致：agent-loop 的 prepareToolCallArguments + validateToolArguments
 * （packages/pi-ai/src/utils/validation.ts），不走裸 execute。
 */
import { describe, expect, test } from "bun:test";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { isContextOverflow, StringEnum, validateToolArguments } from "@earendil-works/pi-ai";
import { arr, bool, int, lit, map, obj, opt, str, union, unknown as unknownSchema } from "@earendil-works/pi-schema";

/* ----------------------------- 校验入口复刻 ----------------------------- */
/* agent-loop.ts:736-737 的两步（prepare → validate）。测试里没有 argumentsError
 * 的 toolCall，prepare 是恒等，直接调 validateToolArguments。 */

function validateOf(tool: AgentTool, args: unknown): unknown {
	const toolCall = { name: tool.name, arguments: structuredClone(args) };
	return validateToolArguments(tool, toolCall);
}

function makeTool(parameters: AgentTool["parameters"]): AgentTool {
	return {
		name: "probe",
		label: "Probe",
		description: "schema probe",
		parameters,
		execute: async () => ({ content: [{ type: "text", text: "ok" }], details: undefined }),
	} as unknown as AgentTool;
}

/* --------------------------------- coerce --------------------------------- */

describe("pi-schema coerce（1.5.0 校验层新行为）", () => {
	test("string 参数收到数字：coerce 成字符串", () => {
		const tool = makeTool(obj({ path: str({ description: "file path" }) }));
		const args = validateOf(tool, { path: 12345 });
		expect(args).toEqual({ path: "12345" });
	});

	test("int 参数收到数字字符串：coerce 成整数", () => {
		const tool = makeTool(obj({ limit: int({ description: "line limit" }) }));
		const args = validateOf(tool, { limit: "42" });
		expect(args).toEqual({ limit: 42 });
	});

	test("bool 参数收到字符串：coerce 成布尔", () => {
		const tool = makeTool(obj({ force: bool({ description: "overwrite" }) }));
		expect(validateOf(tool, { force: "true" })).toEqual({ force: true });
		expect(validateOf(tool, { force: "false" })).toEqual({ force: false });
	});

	test("数组参数收到单值：coerce 包装成数组（CHANGELOG 所述语义）", () => {
		const tool = makeTool(obj({ ids: arr(int(), { description: "ids" }) }) as never);
		expect(validateOf(tool, { ids: 7 })).toEqual({ ids: [7] });
	});

	test("无法 coerce 的值仍被拒绝，错误文案为 pi-schema 格式", () => {
		const tool = makeTool(obj({ n: int({ description: "count" }) }));
		try {
			validateOf(tool, { n: "not-a-number" });
			expect.unreachable();
		} catch (error) {
			const message = (error as Error).message;
			expect(message).toContain('Validation failed for tool "probe"');
			expect(message).toContain("- n:");
		}
	});
});

/* ------------------------------- closed object ------------------------------- */

describe("obj() 默认 closed（多余参数拒绝）", () => {
	test("多余参数被拒绝且报出字段名", () => {
		const tool = makeTool(obj({ path: str() }));
		try {
			validateOf(tool, { path: "a", extra: true });
			expect.unreachable();
		} catch (error) {
			const message = (error as Error).message;
			expect(message).toContain('Validation failed for tool "probe"');
			expect(message).toContain("extra");
		}
	});

	test("open: true 恢复宽松（逃生口语义）", () => {
		const tool = makeTool(obj({ path: str() }, { open: true }));
		const args = validateOf(tool, { path: "a", extra: true });
		expect(args).toEqual({ path: "a", extra: true });
	});
});

/* --------------------------- 联合/lit/enum 写法 --------------------------- */

describe("union / lit / StringEnum 迁移写法", () => {
	test("lit 联合只接受枚举内取值", () => {
		const tool = makeTool(obj({ mode: union([lit("search"), lit("call")]) }));
		expect(validateOf(tool, { mode: "call" })).toEqual({ mode: "call" });
		expect(() => validateOf(tool, { mode: "nope" })).toThrow(/Validation failed for tool "probe"/);
	});

	test("StringEnum（pi-ai 导出，todo 工具路径）合法值通过", () => {
		const tool = makeTool(
			obj({
				status: StringEnum(["pending", "in_progress", "completed"] as const),
			}),
		);
		expect(validateOf(tool, { status: "pending" })).toEqual({ status: "pending" });
	});

	test("StringEnum 越界值被拒", () => {
		const tool = makeTool(
			obj({
				status: StringEnum(["pending", "in_progress", "completed"] as const),
			}),
		);
		expect(() => validateOf(tool, { status: "archived" })).toThrow(/Validation failed for tool "probe"/);
	});
});

/* --------------------------- 迁移等价性（TypeBox 对照） --------------------------- */

describe("迁移前后 JSON Schema 等价抽查", () => {
	test("opt 不进 required（与 TypeBox Optional 历史行为一致）", () => {
		// TypeBox 依赖已随迁移删除；此处的「等价性」断言的是迁移前的行为基线
		const tb = { required: ["a"] }; // Type.Object({a: String, b?: String}) 的行为快照
		const ps = obj({ a: str(), b: opt(str()) }) as { required?: string[] };
		expect(ps.required).toEqual(tb.required); // 都是 ["a"]
		expect(ps.required).toEqual(["a"]);
	});

	test("嵌套 schema 的 JSON 输出仍是合法 JSON Schema（生产工具实际形态）", () => {
		const tool = makeTool(
			obj({
				pattern: str({ description: "glob" }),
				path: opt(str({ description: "subdir" })),
				limit: opt(int()),
				force: opt(bool()),
				mode: union([lit("a"), lit("b")]),
				meta: opt(map(unknownSchema())),
			}),
		);
		// 合法参数直接通过
		expect(
			validateOf(tool, { pattern: "*.ts", mode: "b", meta: { k: 1 } }),
		).toEqual({ pattern: "*.ts", mode: "b", meta: { k: 1 } });
	});
});

/* --------------------- 错误文案可被 agent-errors 分类 --------------------- */

describe("校验错误文案与 kova 错误分类兼容", () => {
	test("Validation failed 前缀不与 context-overflow 判定冲突", () => {
		const tool = makeTool(obj({ n: int() }));
		let message = "";
		try {
			validateOf(tool, { n: "x" });
		} catch (error) {
			message = (error as Error).message;
		}
		// isContextOverflow 对普通错误返回 false（不会把校验错误误判成上下文溢出）
		const fakeAssistant = {
			stopReason: "error",
			errorMessage: message,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		} as never;
		expect(isContextOverflow(fakeAssistant, 100_000)).toBe(false);
	});
});
