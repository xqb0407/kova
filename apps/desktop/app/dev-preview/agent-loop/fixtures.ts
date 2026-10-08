/**
 * 【临时验证页，验证后删除】Agent loop 可视化的静态录制数据。
 *
 * 只有数据，没有类型与派生逻辑——那些在 lib/pi/loop-model.ts，视图与真实适配
 * （lib/pi/loop-adapter.ts）共用同一套。这里的数据用来在没跑真会话时把形态摆出来：
 * 半路 / 正常+委派 / 大会话扇出 / 失败链路四种形状各有要验的点。
 *
 * 定位：与既有「链路追踪」面板划清边界。那边按 span 类型（llm/tool/retry）分层看
 * 耗时，是瀑布图；这边按 loop 的真实结构分层——一次迭代 = 模型意图 → N 个工具 →
 * 结果回喂。分界线是迭代边界与回喂边，瀑布图里看不到。
 */

import type { LoopIteration, LoopRun, LoopStep } from "@/lib/pi/loop-model";

/* ------------------------------- 录制数据 ------------------------------- */

const NOW = Date.parse("2026-10-08T14:32:10+08:00");

/**
 * #13 半路（在飞）：验证 running 态的观感——末尾两个 step 尚未收口，
 * 最后一个 llm 正在输出。
 */
const RUN_IN_FLIGHT: LoopRun = {
  traceId: "a3f19c2e8b7d4051a6c2f0d9e3b5c781",
  source: "ui",
  model: "claude-sonnet-4.5",
  startMs: NOW,
  // 在飞由 durationMs=null 表达，outcome 不参与（它只回答「最后为什么停」）
  durationMs: null,
  usage: { input: 67_740, output: 4_680, cacheRead: 57_100 },
  iterations: [
    {
      index: 1,
      intent: "先看下 package.json 里 express 的版本，再决定怎么改",
      stoppedBecause: "tool-call",
      feedBack: "express: ^4.18.2，devDependencies 里有 6 个包依赖它",
      steps: [
        {
          id: "s13-1-llm",
          kind: "llm",
          name: "claude-sonnet-4.5",
          atMs: 0,
          durationMs: 1_840,
          status: "ok",
          usage: { input: 15_240, output: 1_120, cacheRead: 12_800 },
          result: "先读 package.json 确认版本。",
        },
        {
          id: "s13-1-read",
          kind: "tool",
          name: "read",
          atMs: 1_840,
          durationMs: 212,
          status: "ok",
          args: { file_path: "/repo/package.json", limit: 120 },
          result:
            '{\n  "dependencies": {\n    "express": "^4.18.2",\n    "cors": "^2.8.5"\n  }\n}',
        },
        {
          id: "s13-1-why",
          kind: "tool",
          name: "bash",
          atMs: 2_052,
          durationMs: 1_096,
          status: "error",
          args: { command: "pnpm why express" },
          error: {
            message: "命令退出码 1",
            exitCode: 1,
            stderr:
              "ERR_PNPM_NO_MATCHING_VERSION  No matching version found for express@^4.21.0\n  in lockfile: express@4.18.2",
          },
        },
      ],
    },
    {
      index: 2,
      intent: "pnpm why 报错是因为 lockfile 里锁的是 4.18.2，直接读 lockfile 确认",
      stoppedBecause: "tool-call",
      feedBack: "lockfile 中 express 解析到 4.18.2，共 6 处引用",
      steps: [
        {
          id: "s13-2-llm",
          kind: "llm",
          name: "claude-sonnet-4.5",
          atMs: 3_148,
          durationMs: 2_120,
          status: "ok",
          usage: { input: 16_180, output: 1_340, cacheRead: 13_600 },
          result: "pnpm why 报错说明本地 lockfile 还是旧的，直接查 lockfile。",
        },
        {
          id: "s13-2-read",
          kind: "tool",
          name: "read",
          atMs: 5_268,
          durationMs: 380,
          status: "ok",
          args: { file_path: "/repo/pnpm-lock.yaml" },
          result: "…\n  express@4.18.2:\n    dependencies:\n      accepts: 1.3.8\n…\n  '/express@4.18.2':\n",
        },
        {
          id: "s13-2-grep",
          kind: "tool",
          name: "grep",
          atMs: 5_648,
          durationMs: 96,
          status: "ok",
          args: { pattern: "express", path: "/repo", glob: "**/*.ts" },
          result: "src/server.ts:14:import express from \"express\"\nsrc/routes/user.ts:3:…",
        },
      ],
    },
    {
      index: 3,
      intent: "确认是 4.18.2，把它提到 ^4.21.0 再装",
      stoppedBecause: "tool-call",
      steps: [
        {
          id: "s13-3-llm",
          kind: "llm",
          name: "claude-sonnet-4.5",
          atMs: 5_744,
          durationMs: 1_920,
          status: "ok",
          usage: { input: 17_420, output: 1_580, cacheRead: 14_900 },
          result: "确认无误，升级 express 到 ^4.21.0。",
        },
        {
          id: "s13-3-edit",
          kind: "tool",
          name: "edit",
          atMs: 7_664,
          durationMs: 148,
          status: "ok",
          args: {
            file_path: "/repo/package.json",
            old_string: '"express": "^4.18.2"',
            new_string: '"express": "^4.21.0"',
          },
          result: "已更新 1 处（package.json:14）",
        },
        // 在飞：正在跑安装，尚未收口
        {
          id: "s13-3-install",
          kind: "tool",
          name: "bash",
          atMs: 7_812,
          durationMs: null,
          status: "ok",
          args: { command: "pnpm install" },
        },
        // 在飞：这一轮的 llm 正在流式输出
        {
          id: "s13-4-llm",
          kind: "llm",
          name: "claude-sonnet-4.5",
          atMs: 7_812,
          durationMs: null,
          status: "ok",
          usage: { input: 18_900, output: 640, cacheRead: 15_800 },
        },
      ],
    },
  ],
};

/**
 * #12 正常完成 + Task 委派：验证子代理递归嵌套的观感。
 * 主代理跑了 4 次迭代，第 2 次委派出一个子 run。
 */
const RUN_WITH_SUBAGENT: LoopRun = {
  traceId: "b71d0e94c3a2f6185d9e7b0a4c2f8361",
  source: "ui",
  model: "claude-sonnet-4.5",
  startMs: NOW - 412_000,
  durationMs: 9_180,
  outcome: {
    reason: "completed",
    detail: "第 4 次迭代给出最终答案，循环自然收尾",
  },
  usage: { input: 120_880, output: 8_900, cacheRead: 105_500 },
  iterations: [
    {
      index: 1,
      intent: "先把 pnpm-workspace.yaml 的配置读出来，确认包结构",
      stoppedBecause: "tool-call",
      feedBack: "4 个包：web / api / shared / scripts",
      steps: [
        {
          id: "s12-1-llm",
          kind: "llm",
          name: "claude-sonnet-4.5",
          atMs: 0,
          durationMs: 1_620,
          status: "ok",
          usage: { input: 24_180, output: 1_460, cacheRead: 21_000 },
          result: "先看 workspace 配置。",
        },
        {
          id: "s12-1-read",
          kind: "tool",
          name: "read",
          atMs: 1_620,
          durationMs: 190,
          status: "ok",
          args: { file_path: "/repo/pnpm-workspace.yaml" },
          result:
            "packages:\n  - 'apps/web'\n  - 'apps/api'\n  - 'packages/shared'\n  - 'packages/scripts'",
        },
      ],
    },
    {
      index: 2,
      intent: "这个改动横跨 3 个包，让子代理并行摸清影响面，别一个个读",
      stoppedBecause: "tool-call",
      feedBack: "子代理回报：6 处 import、2 处类型定义、1 处运行时配置",
      steps: [
        {
          id: "s12-2-llm",
          kind: "llm",
          name: "claude-sonnet-4.5",
          atMs: 1_810,
          durationMs: 2_340,
          status: "ok",
          result: "影响面太宽，委派子代理并行调查。",
        },
        {
          id: "s12-2-task",
          kind: "tool",
          name: "Task",
          atMs: 4_150,
          durationMs: 5_890,
          status: "ok",
          usage: { input: 25_900, output: 2_240, cacheRead: 22_800 },
          args: {
            subagent_type: "Explore",
            prompt: "找出仓库里所有引用 packages/shared 的位置，按 import / 类型 / 配置分类",
          },
          result: "共 9 处：6 处 import、2 处类型定义、1 处 vite 别名配置",
        },
      ],
    },
    {
      index: 3,
      intent: "影响面清楚了，动手改 alias 配置和 6 处 import",
      stoppedBecause: "tool-call",
      feedBack: "6 处 import 已改写，vite alias 指向新路径",
      steps: [
        {
          id: "s12-3-llm",
          kind: "llm",
          name: "claude-sonnet-4.5",
          atMs: 10_040,
          durationMs: 2_180,
          status: "ok",
          usage: { input: 34_600, output: 2_180, cacheRead: 30_200 },
          result: "开始改。",
        },
        {
          id: "s12-3-edit",
          kind: "tool",
          name: "edit",
          atMs: 12_220,
          durationMs: 340,
          status: "ok",
          args: { file_path: "/repo/apps/web/vite.config.ts" },
          result: "已更新 1 处别名",
        },
        {
          id: "s12-3-write",
          kind: "tool",
          name: "write",
          atMs: 12_560,
          durationMs: 180,
          status: "ok",
          args: { file_path: "/repo/packages/shared/index.ts" },
          result: "已写入 84 行",
        },
      ],
    },
    {
      index: 4,
      intent: "跑一遍测试确认没打破别的东西",
      stoppedBecause: "final-answer",
      steps: [
        {
          id: "s12-4-llm",
          kind: "llm",
          name: "claude-sonnet-4.5",
          atMs: 12_740,
          durationMs: 3_020,
          status: "ok",
          usage: { input: 36_200, output: 3_020, cacheRead: 31_500 },
          result: "测试全绿，改动完成。",
        },
        {
          id: "s12-4-test",
          kind: "tool",
          name: "bash",
          atMs: 15_760,
          durationMs: 3_100,
          status: "ok",
          args: { command: "pnpm test" },
          result: "PASS  42 tests across 6 files\nTests:  42 passed, 42 total",
        },
      ],
    },
  ],
  // 委派跑出的子 run：父边即迭代 2 里那次 Task 工具调用
  children: [
    {
      traceId: "c92e4b10d5f6a23847e0b9c3a1d5f680",
      source: "subagent",
      model: "claude-haiku-4.5",
      startMs: NOW - 412_000 + 4_150,
      durationMs: 5_880,
      outcome: { reason: "completed" },
      usage: { input: 22_140, output: 2_410 },
      iterations: [
        {
          index: 1,
          intent: "grep 所有 shared 的引用",
          stoppedBecause: "tool-call",
          steps: [
            {
              id: "sub1-1-grep",
              kind: "tool",
              name: "grep",
              atMs: 4_150,
              durationMs: 420,
              status: "ok",
              args: { pattern: "@repo/shared", path: "/repo" },
              result: "6 matches in 4 files",
            },
          ],
        },
        {
          index: 2,
          intent: "再看类型定义和 vite 配置",
          stoppedBecause: "final-answer",
          steps: [
            {
              id: "sub1-2-llm",
              kind: "llm",
              name: "claude-haiku-4.5",
              atMs: 4_570,
              durationMs: 1_880,
              status: "ok",
              usage: { input: 21_400, output: 2_410, cacheRead: 19_000 },
              result: "共 9 处引用，已分类。",
            },
          ],
        },
      ],
    },
  ],
};

/**
 * #11 失败链路：验证失败可见性。
 * 429 限流重试 → 重试耗尽 → 最终 error。三个失败维度（工具失败 / 重试 / 终止原因）
 * 在同一个 run 里都有。
 */
const RUN_FAILED: LoopRun = {
  traceId: "d5c81f37a9e2b6041c8f3a7d5b9e2410",
  source: "ui",
  model: "claude-sonnet-4.5",
  startMs: NOW - 1_180_000,
  durationMs: 3_240,
  outcome: {
    reason: "error",
    detail: "连续 3 次 429 后 provider 放弃，本轮终止",
  },
  usage: { input: 19_540, output: 620, cacheRead: 10_500 },
  iterations: [
    {
      index: 1,
      intent: "先把依赖装上",
      stoppedBecause: "tool-call",
      feedBack: "安装未成功，node_modules 仍缺失",
      steps: [
        {
          id: "s11-1-llm",
          kind: "llm",
          name: "claude-sonnet-4.5",
          atMs: 0,
          durationMs: 1_480,
          status: "ok",
          usage: { input: 6_240, output: 320, cacheRead: 5_100 },
          result: "先装依赖。",
        },
        {
          id: "s11-1-install",
          kind: "tool",
          name: "bash",
          atMs: 1_480,
          durationMs: 640,
          status: "error",
          args: { command: "pnpm install" },
          error: {
            message: "命令退出码 127",
            exitCode: 127,
            stderr: "sh: pnpm: command not found",
          },
        },
        {
          id: "s11-1-retry",
          kind: "retry",
          name: "429",
          atMs: 2_120,
          durationMs: 2_000,
          status: "retry",
          retry: {
            attempt: 1,
            delayMs: 2_000,
            reason: "provider 返回 429 Too Many Requests，指数退避后重试",
          },
        },
      ],
    },
    {
      index: 2,
      intent: "pnpm 没装，用 npx 试试",
      stoppedBecause: "tool-call",
      feedBack: "npx 同样不可用，环境缺少包管理器",
      steps: [
        {
          id: "s11-2-llm",
          kind: "llm",
          name: "claude-sonnet-4.5",
          atMs: 4_120,
          durationMs: 1_360,
          status: "ok",
          usage: { input: 6_580, output: 240, cacheRead: 5_400 },
          result: "换 npx。",
        },
        {
          id: "s11-2-npx",
          kind: "tool",
          name: "bash",
          atMs: 5_480,
          durationMs: 720,
          status: "error",
          args: { command: "npx pnpm install" },
          error: {
            message: "命令退出码 127",
            exitCode: 127,
            stderr: "sh: npx: command not found",
          },
        },
        {
          id: "s11-2-retry",
          kind: "retry",
          name: "429",
          atMs: 6_200,
          durationMs: 2_000,
          status: "retry",
          retry: {
            attempt: 2,
            delayMs: 2_000,
            reason: "provider 返回 429，退避预算已用 2/3",
          },
        },
      ],
    },
    {
      index: 3,
      intent: "最后试一次 corepack",
      stoppedBecause: "aborted",
      steps: [
        {
          id: "s11-3-llm",
          kind: "llm",
          name: "claude-sonnet-4.5",
          atMs: 8_200,
          durationMs: null,
          status: "error",
          usage: { input: 6_720, output: 60 },
          error: {
            message: "provider 连续 3 次 429，放弃本轮",
          },
        },
      ],
    },
  ],
};
/** 列表按时间倒序展示（最新在上）：#13 → #12 → #11 */
export const RUNS: LoopRun[] = [RUN_IN_FLIGHT, RUN_WITH_SUBAGENT, RUN_FAILED];

/**
 * 大会话：32 次迭代 + 6 个并行子代理扇出。
 *
 * 存在的理由不是「多一条数据」，而是小会话撑不起 3D 视图——3~4 次迭代摊在空间里
 * 就是几个孤零零的球，看不出结构。3D 的价值在规模：迭代够多才看得出推进方向，
 * 并行委派够多才看得出扇出。这条数据就是用来检验那两件事的。
 * 程序化生成而非手写，避免几百行字面量淹没契约本身。
 */
function buildScaleRun(): LoopRun {
  const TOOLS = ["read", "grep", "bash", "edit", "write"] as const;
  // 上下文逐轮增长（与真实 loop 行为一致），每 8 轮一次长上下文台阶
  let ctx = 22_000;
  let t = 0;

  const iterations: LoopIteration[] = Array.from({ length: 32 }, (_, i) => {
    const n = i + 1;
    const llmIn = ctx;
    const llmOut = 700 + ((i * 137) % 1600);
    const llmDur = 1400 + ((i * 311) % 2200);
    const steps: LoopStep[] = [
      {
        id: `sc-${n}-llm`,
        kind: "llm",
        name: "claude-sonnet-4.5",
        atMs: t,
        durationMs: llmDur,
        status: "ok",
        usage: { input: llmIn, output: llmOut, cacheRead: Math.round(llmIn * 0.82) },
        result: `第 ${n} 次迭代的模型输出。`,
      },
    ];
    // 工具数随迭代起伏：模拟「改一轮要连着读五个文件」的密集段
    const toolCount = 1 + ((i * 3) % 4);
    for (let k = 0; k < toolCount; k++) {
      const name = TOOLS[(i + k) % TOOLS.length];
      // 每 7 轮撞一次失败，制造可读的红色聚集
      const bad = (i + k) % 7 === 3;
      steps.push({
        id: `sc-${n}-${name}-${k}`,
        kind: "tool",
        name,
        atMs: t + llmDur + k * 90,
        durationMs: bad ? 900 + k * 220 : 120 + ((i + k) * 97) % 1400,
        status: bad ? "error" : "ok",
        ...(bad
          ? {
              error: {
                message: "命令退出码 1",
                exitCode: 1,
                stderr: `ERR_${name.toUpperCase()}  第 ${n} 轮校验未通过`,
              },
            }
          : {}),
        args: { path: `/repo/src/mod-${i}-${k}.ts`, command: `${name} --check` },
        result: bad ? undefined : `${name} ok (${120 + ((i + k) * 97) % 1400}ms)`,
      });
    }
    t += llmDur + toolCount * 600;
    ctx += 1_400 + ((i * 211) % 900);

    return {
      index: n,
      intent: `第 ${n} 步：确认上一轮的改动没有影响 ${TOOLS[i % TOOLS.length]} 相关的调用点`,
      stoppedBecause: "tool-call",
      feedBack: `${toolCount} 个工具结果已回喂，上下文增至 ${llmIn.toLocaleString()} tok`,
      steps,
    } satisfies LoopIteration;
  });

  // 6 个并行子代理：3D 里每个占一个 Y 层，扇出才读得出来
  const children: LoopRun[] = Array.from({ length: 6 }, (_, c) => {
    const ci = c + 1;
    const cin = 14_000 + c * 4_200;
    return {
      traceId: `scale-sub-${ci}`,
      source: "subagent",
      model: "claude-haiku-4.5",
      startMs: NOW - 900_000 + 24_000 + c * 1_800,
      durationMs: 5_200 + c * 1_400,
      outcome: { reason: "completed" },
      usage: { input: cin, output: 1_200 + c * 340 },
      iterations: [
        {
          index: 1,
          intent: `并行摸清第 ${ci} 组调用点`,
          stoppedBecause: "final-answer",
          steps: [
            {
              id: `sc-sub-${ci}-llm`,
              kind: "llm",
              name: "claude-haiku-4.5",
              atMs: 0,
              durationMs: 2_600 + c * 300,
              status: "ok",
              usage: { input: cin, output: 1_200 + c * 340 },
              result: `第 ${ci} 组影响面已确认。`,
            },
          ],
        },
      ],
    } satisfies LoopRun;
  });

  const totalOut = iterations.reduce(
    (n, it) => n + (it.steps[0].usage?.output ?? 0),
    0,
  );
  const totalIn = iterations.reduce((n, it) => n + (it.steps[0].usage?.input ?? 0), 0);

  return {
    traceId: "f0e1d2c3b4a5968778695a4b3c2d1e0f",
    source: "ui",
    model: "claude-sonnet-4.5",
    startMs: NOW - 900_000,
    durationMs: t,
    outcome: { reason: "completed", detail: "32 次迭代后给出最终答案" },
    usage: {
      input: totalIn,
      output: totalOut,
      cacheRead: Math.round(totalIn * 0.82),
    },
    iterations,
    children,
  };
}

export const RUN_SCALE = buildScaleRun();
