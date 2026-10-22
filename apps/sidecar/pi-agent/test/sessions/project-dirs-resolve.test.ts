/**
 * 项目虚拟目录的端到端装配测试：真实 resolveSession → 提示词 / 工具 / 技能缓存
 * / 只读投影 / 项目目录热更新。
 *
 * 单测覆盖了纯函数；这里专门验证「接线」：模块依赖环、run 字段初始化、
 * 系统提示词注入、search 工具注册，以及项目目录变更后的热生效。
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { initStorage } from "../../src/storage/storage";
import { resolveSession, running, dropRun, projectContextInfo } from "../../src/sessions/sessions";
import { contextInfo } from "../../src/agent/context";
import { recomputeRunsForProject } from "../../src/sessions/external-dirs";
import {
  addProjectDir,
  resetProjectDirsForTest,
  seedProjectDirsForTest,
} from "../../src/agent/project-dirs";

const tmp = realpathSync(mkdtempSync(path.join(tmpdir(), "project-dirs-resolve-")));
const main = path.join(tmp, "frontend");
const backend = path.join(tmp, "backend");
const shared = path.join(tmp, "shared");
for (const dir of [main, backend, shared]) mkdirSync(dir, { recursive: true });
writeFileSync(path.join(backend, "AGENTS.md"), "BACKEND_RULES");
writeFileSync(path.join(shared, "AGENTS.md"), "SHARED_RULES");

const prevIdentityDir = process.env.PI_IDENTITY_DIR;
const lines: string[] = [];
let origWrite: typeof process.stdout.write;

beforeAll(() => {
  initStorage(path.join(tmp, "state.db"), path.join(tmp, "sessions"));
  process.env.PI_IDENTITY_DIR = path.join(tmp, "identity");
  // resolveSession/项目目录事件会写协议流；吞掉，避免污染测试输出
  origWrite = process.stdout.write.bind(process.stdout);
  (process.stdout as unknown as { write: (c: unknown) => boolean }).write = (
    c: unknown,
  ) => {
    lines.push(String(c));
    return true;
  };
  seedProjectDirsForTest({
    [main]: [{ path: backend, label: "backend" }],
  });
});

afterAll(() => {
  (process.stdout as unknown as { write: (c: unknown) => boolean }).write =
    origWrite as unknown as (c: unknown) => boolean;
  if (prevIdentityDir === undefined) delete process.env.PI_IDENTITY_DIR;
  else process.env.PI_IDENTITY_DIR = prevIdentityDir;
  running.clear();
  resetProjectDirsForTest();
});

/** 系统提示词正文（0.99 起落在转录首条 system 消息上） */
function systemPromptText(run: Awaited<ReturnType<typeof resolveSession>>): string {
  const msg = run.agent.state.messages.find((m) => m.role === "system") as
    | { content?: unknown }
    | undefined;
  const content = msg?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (part as { text?: string })?.text ?? "")
      .join("");
  }
  return "";
}

describe("resolveSession：项目虚拟目录装配", () => {
  test("主目录会话拿到附加根、提示词与检索工具", async () => {
    const run = await resolveSession("project-thread", undefined, main);
    expect(run.cwd).toBe(main);
    expect(run.externalDirs.map((d) => d.path)).toEqual([backend]);

    const prompt = systemPromptText(run);
    expect(prompt).toContain("## Project Folders (additional code repositories)");
    expect(prompt).toContain("BACKEND_RULES");

    const tools = run.agent.state.tools?.map((t) => t.name) ?? [];
    expect(tools).toContain("search_external_files");
    // 模型侧不能增删项目目录
    expect(tools).not.toContain("add_directory");

    // 只读投影与 live 读数逐字段一致（含外部目录段与工具面）
    const projected = await projectContextInfo("project-thread", run.sessionId);
    expect(projected).toEqual(contextInfo(run));
  });

  test("附加根里的会话：排除自身，提示词拿到主目录", async () => {
    const run = await resolveSession("backend-thread", undefined, backend);
    expect(run.cwd).toBe(backend);
    expect(run.externalDirs.map((d) => d.path)).toEqual([main]);
    const prompt = systemPromptText(run);
    // backend 自己的 AGENTS.md 由工作区指令层注入，不应在 Project Folders 段重复
    expect(prompt).toContain("## Instructions");
    expect(prompt).not.toContain("### backend");
  });

  test("普通任务（无 cwd）不挂任何项目目录", async () => {
    const run = await resolveSession("task-thread", undefined, undefined);
    expect(run.externalDirs).toEqual([]);
    const prompt = systemPromptText(run);
    expect(prompt).not.toContain("## Project Folders");
  });

  test("项目目录变更后热生效：run 清单、提示词同步更新", async () => {
    const run = await resolveSession("hot-thread", undefined, main);
    expect(run.externalDirs.map((d) => d.path)).toEqual([backend]);
    const beforeTokens = contextInfo(run).systemPromptTokens;

    await addProjectDir(main, shared);
    const affected = await recomputeRunsForProject(main, [main, backend]);
    expect(affected).toContain(run.sessionId);
    expect(run.externalDirs.map((d) => d.path).sort()).toEqual(
      [backend, shared].sort(),
    );
    const prompt = systemPromptText(run);
    expect(prompt).toContain("SHARED_RULES");

    // 投影同步跟上（事实源是项目配置，不是 run 内存）。
    // 注意：热重排沿用 composeRunPrompt 的既有语义（不写 Model 行），只读投影
    // 仍带 Model 行，所以两侧 token 读数允许相差一行模型描述（约 6–10 tokens）。
    const live = contextInfo(run);
    const projected = await projectContextInfo("hot-thread", run.sessionId);
    expect(live.systemPromptTokens).toBeGreaterThan(beforeTokens);
    expect(projected.systemPromptTokens).toBeGreaterThan(beforeTokens);
    expect(
      Math.abs(projected.systemPromptTokens - live.systemPromptTokens),
    ).toBeLessThanOrEqual(20);
    expect(projected.toolTokens).toBe(live.toolTokens);
    expect(projected.messageTokens).toBe(live.messageTokens);
    dropRun("hot-thread");
  });
});
