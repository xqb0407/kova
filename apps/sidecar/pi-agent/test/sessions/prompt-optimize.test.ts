import { describe, test, expect } from "bun:test";
import type { Api, Context, Model } from "@earendil-works/pi-ai";
import {
  OPTIMIZE_MAX_INPUT,
  OPTIMIZE_SYSTEM_PROMPT,
  cleanOptimizedText,
  maskDirectives,
  optimizeContext,
  optimizeDraftPrompt,
  restoreDirectives,
} from "../../src/sessions/prompt-optimize";

const SKILL = ":skill[anxin-ppt]{name=skill:anxin-ppt}";
const AGENT = ":agent[评审员]{name=agent:reviewer}";
const TOOL = ":tool[web_search]";

/** 假 streamSimple：把文本按小块吐成 text_delta，并记录收到的 context/options */
function fakeStream(
  text: string,
  captured?: { current: { context?: Context; options?: Record<string, unknown> } },
) {
  return (
    _model: Model<Api>,
    context: Context,
    options?: { signal?: AbortSignal; reasoning?: string },
  ) => {
    if (captured) captured.current = { context, options: options as Record<string, unknown> };
    return (async function* () {
      const chunks = text.match(/[\s\S]{1,12}/g) ?? [];
      for (const c of chunks) {
        if (options?.signal?.aborted) return;
        yield { type: "text_delta", delta: c };
      }
    })();
  };
}

const MODEL = { provider: "p", id: "m", name: "M" } as unknown as Model<Api>;

describe("maskDirectives", () => {
  test("芯片换成占位符并建表", () => {
    const r = maskDirectives(`${SKILL} 生成一下 PPT`);
    expect(r.masked).toBe("[[c1]] 生成一下 PPT");
    expect(r.chips).toEqual([SKILL]);
    expect(r.numbers).toEqual([1]);
    expect(r.reserved.size).toBe(0);
  });

  test("多个芯片按出现顺序编号", () => {
    const r = maskDirectives(`${SKILL} 出片，${AGENT} 评审，${TOOL} 查资料`);
    expect(r.masked).toBe("[[c1]] 出片，[[c2]] 评审，[[c3]] 查资料");
    expect(r.chips).toEqual([SKILL, AGENT, TOOL]);
    expect(r.numbers).toEqual([1, 2, 3]);
  });

  test("无芯片文本原样返回", () => {
    const r = maskDirectives("普通提问 http://x 不变");
    expect(r.masked).toBe("普通提问 http://x 不变");
    expect(r.chips).toEqual([]);
    expect(r.numbers).toEqual([]);
  });

  test("草稿自带的占位符字面量记为 reserved，芯片序号避让", () => {
    const r = maskDirectives("字面量 [[c1]] 保留，还有 " + SKILL);
    expect(r.reserved.has(1)).toBe(true);
    // c1 被字面量占了 → 芯片从 c2 起编号
    expect(r.masked).toBe("字面量 [[c1]] 保留，还有 [[c2]]");
    expect(r.chips).toEqual([SKILL]);
    expect(r.numbers).toEqual([2]);
  });
});

describe("restoreDirectives", () => {
  test("往返恒等（单芯片在句首）", () => {
    const { masked, chips, numbers, reserved } = maskDirectives(`${SKILL} 生成一下`);
    expect(restoreDirectives(masked, chips, numbers, reserved)).toBe(`${SKILL} 生成一下`);
  });

  test("往返恒等（芯片在句中/句尾）", () => {
    for (const draft of [`用 ${AGENT} 看一下这段代码`, `先跑测试 ${TOOL}`]) {
      const { masked, chips, numbers, reserved } = maskDirectives(draft);
      expect(restoreDirectives(masked, chips, numbers, reserved)).toBe(draft);
    }
  });

  test("往返恒等（reserved 避让后序号不按下标反推）", () => {
    const draft = `占位符 [[c1]] 是字面量，指令用 ${SKILL}，再 ${AGENT} 复审`;
    const { masked, chips, numbers, reserved } = maskDirectives(draft);
    expect(numbers).toEqual([2, 3]);
    expect(restoreDirectives(masked, chips, numbers, reserved)).toBe(draft);
  });

  test("模型挪位后芯片跟着走", () => {
    const { chips, numbers, reserved } = maskDirectives(`${SKILL} 出 PPT，然后 ${AGENT} 评审`);
    const out = restoreDirectives(
      "[[c2]] 先评审这份稿子；完成后由 [[c1]] 出片",
      chips,
      numbers,
      reserved,
    );
    expect(out).toBe(`${AGENT} 先评审这份稿子；完成后由 ${SKILL} 出片`);
  });

  test("模型丢芯片 → 按原相对顺序补到文末", () => {
    const { chips, numbers, reserved } = maskDirectives(
      `${SKILL} 出片，${AGENT} 评审，${TOOL} 查资料`,
    );
    const out = restoreDirectives("做一份竞品分析", chips, numbers, reserved);
    expect(out).toBe(`做一份竞品分析\n${SKILL} ${AGENT} ${TOOL}`);
  });

  test("重复占位符只留首个", () => {
    const { chips, numbers, reserved } = maskDirectives(`${SKILL} 干活`);
    const out = restoreDirectives("[[c1]] 干活，再 [[c1]] 一次", chips, numbers, reserved);
    expect(out).toBe(`${SKILL} 干活，再 一次`);
  });

  test("表外幻影占位符删除并吃掉紧随空格，reserved 字面量原样保留", () => {
    const { chips, numbers, reserved } = maskDirectives("字面量 [[c7]] 留着");
    // 无芯片但 reserved 非空：还原仍会扫描
    expect(chips).toEqual([]);
    expect(reserved.has(7)).toBe(true);
    const out = restoreDirectives("请[[c9]] 完成它 [[c7]] 照旧", chips, numbers, reserved);
    expect(out).toBe("请完成它 [[c7]] 照旧");
  });

  test("模型改写占位符拼法仍还原为原始序列化文本", () => {
    const { chips, numbers, reserved } = maskDirectives(`${SKILL} 与 ${AGENT}`);
    for (const spelling of [
      "[c1] 先做 [c2] 后审",
      "{{c1}} 先做 {{c2}} 后审",
      "{c1} 先做 {c2} 后审",
      "〔c1〕 先做 〔c2〕 后审",
      "【C1】 先做 【C2】 后审",
      "[[ c1 ]] 先做 [[ C2 ]] 后审",
    ]) {
      expect(restoreDirectives(spelling, chips, numbers, reserved)).toBe(
        `${SKILL} 先做 ${AGENT} 后审`,
      );
    }
  });

  test("模型自己编出的芯片文本不被采纳", () => {
    const { chips, numbers, reserved } = maskDirectives(`${SKILL} 出片`);
    const out = restoreDirectives("[[c1]] 出片", chips, numbers, reserved);
    expect(out).toBe(`${SKILL} 出片`);
    expect(out).not.toContain(":skill[坏]");
  });
});

describe("cleanOptimizedText", () => {
  test("剥掉整体包裹的代码围栏", () => {
    expect(cleanOptimizedText("```text\n重构登录模块\n```")).toBe("重构登录模块");
    expect(cleanOptimizedText("```\n第一行\n第二行\n```")).toBe("第一行\n第二行");
  });

  test("正文中间的代码块不被误剥", () => {
    const text = "改这个函数：\n\n```ts\nconst a = 1\n```\n让它返回 2";
    expect(cleanOptimizedText(text)).toBe(text);
  });

  test("去掉「优化后：」一类前缀行", () => {
    expect(cleanOptimizedText("优化后：\n修复登录竞态")).toBe("修复登录竞态");
    expect(cleanOptimizedText("优化后的提示词：修复登录竞态")).toBe("修复登录竞态");
    expect(cleanOptimizedText("Optimized prompt:\nfix login race")).toBe("fix login race");
  });

  test("模型把 <草稿> 标签一起吐回来时剥掉成对首尾标签", () => {
    expect(cleanOptimizedText("<草稿>\n修复登录竞态\n</草稿>")).toBe("修复登录竞态");
    // 只出现一半的标签不剥（可能是正文引用）
    expect(cleanOptimizedText("<草稿>\n修复登录竞态")).toBe("<草稿>\n修复登录竞态");
  });

  test("空与纯空白返回空串", () => {
    expect(cleanOptimizedText("   \n  ")).toBe("");
  });
});

describe("optimizeContext", () => {
  test("system 规则含占位符保留条款，messages 只有一条 user", () => {
    const ctx = optimizeContext("[[c1]] 出片");
    expect(ctx.systemPrompt).toContain("[[c1]]");
    expect(ctx.systemPrompt).toContain("<草稿>");
    expect(ctx.messages).toHaveLength(1);
    expect(String(ctx.messages[0]!.content)).toContain("[[c1]] 出片");
  });

  test("草稿被 <草稿> 标签框住，指示里复述「唯一待优化文本」", () => {
    const ctx = optimizeContext("写个贪吃蛇");
    const content = String(ctx.messages[0]!.content);
    expect(content).toContain("<草稿>\n写个贪吃蛇\n</草稿>");
    expect(content).toContain("唯一的待优化文本");
  });
});

describe("optimizeDraftPrompt", () => {
  test("成功：芯片原文回填进结果，且 one-shot 不发送 reasoning 参数（关思考=不发）", async () => {
    const captured = { current: {} as { context?: Context; options?: Record<string, unknown> } };
    const res = await optimizeDraftPrompt(
      fakeStream(`分步骤产出演示稿：[[c1]]，完成后 [[c2]] 复审`, captured),
      MODEL,
      `${SKILL} 做个 PPT，${AGENT} 评审`,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.text).toBe(`分步骤产出演示稿：${SKILL}，完成后 ${AGENT} 复审`);
    expect(res.chipCount).toBe(2);
    // 送进模型的是掩码文本，不是芯片原文；one-shot 不带 reasoning 参数
    expect(String(captured.current.context!.messages[0]!.content)).not.toContain(":skill[");
    expect(captured.current.options?.reasoning).toBeUndefined();
    // 出站载荷诊断钩子（onPayload）随请求下发
    expect(typeof captured.current.options?.onPayload).toBe("function");
  });

  test("空草稿直接拒绝，不发请求", async () => {
    const res = await optimizeDraftPrompt(fakeStream("不该被调用"), MODEL, "   ");
    expect(res).toEqual({ ok: false, error: "草稿为空" });
  });

  test("只有芯片没有正文：本地拒绝，不发请求（模型只会看到占位符）", async () => {
    const res = await optimizeDraftPrompt(
      fakeStream("不该被调用"),
      MODEL,
      `${SKILL}  ${TOOL}  ${AGENT}`,
    );
    expect(res).toEqual({ ok: false, error: "草稿里只有芯片，没有可优化的文字" });
  });

  test("系统规则禁止「我没收到草稿」式回复", () => {
    expect(OPTIMIZE_SYSTEM_PROMPT).toContain("绝不");
    expect(OPTIMIZE_SYSTEM_PROMPT).toContain("没有收到草稿");
  });

  test("超长草稿拒绝", async () => {
    const res = await optimizeDraftPrompt(
      fakeStream("x"),
      MODEL,
      "长".repeat(OPTIMIZE_MAX_INPUT + 1),
    );
    expect(res.ok).toBe(false);
  });

  test("模型空输出判失败", async () => {
    const res = await optimizeDraftPrompt(fakeStream("  \n "), MODEL, "改点东西");
    expect(res).toEqual({ ok: false, error: "优化结果为空" });
  });

  test("增量缺失时回退 done 终态消息的文本块", async () => {
    const stream = () =>
      (async function* () {
        yield {
          type: "done",
          reason: "stop",
          message: {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "被忽略的思考内容" },
              { type: "text", text: `先梳理需求，再由 [[c1]] 实现` },
            ],
          },
        };
      })();
    const res = await optimizeDraftPrompt(stream as never, MODEL, `用 ${SKILL} 实现`);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.text).toBe(`先梳理需求，再由 ${SKILL} 实现`);
  });

  test("被长度截断（思考烧额度）的空输出给出可读原因", async () => {
    const stream = () =>
      (async function* () {
        yield {
          type: "done",
          reason: "length",
          message: { role: "assistant", content: [{ type: "thinking", thinking: "想了很久" }] },
        };
      })();
    const res = await optimizeDraftPrompt(stream as never, MODEL, "改点东西");
    expect(res).toEqual({ ok: false, error: "优化结果为空（输出被长度截断，多在思考上）" });
  });

  test("流内 error 事件判失败", async () => {
    const stream = () =>
      (async function* () {
        yield { type: "text_delta", delta: "半句" };
        yield { type: "error", error: "provider 500" };
      })();
    const res = await optimizeDraftPrompt(stream as never, MODEL, "改点东西");
    expect(res).toEqual({ ok: false, error: "模型返回错误" });
  });

  test("signal 中止返回已取消", async () => {
    const controller = new AbortController();
    const stream = (_m: Model<Api>, _c: Context, _options?: { signal?: AbortSignal }) =>
      (async function* () {
        controller.abort();
        yield { type: "text_delta", delta: "半途" };
      })();
    const res = await optimizeDraftPrompt(stream as never, MODEL, "改点东西", {
      signal: controller.signal,
    });
    expect(res).toEqual({ ok: false, error: "已取消" });
  });

  test("围栏包裹 + 前缀 + 芯片丢失：清洗后仍能补回芯片", async () => {
    const res = await optimizeDraftPrompt(
      fakeStream("```\n优化后：\n按需求实现导出功能\n```"),
      MODEL,
      `用 ${SKILL} 实现导出`,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.text).toBe(`按需求实现导出功能\n${SKILL}`);
  });
});
