/**
 * git 快照 store 单测：在途请求必须按会话去重。
 *
 * 曾经的 bug：模块级单例 inflight 不按 sessionId 分——A 在飞时刷新 B 会直接返回
 * A 的 promise，B 永远拿不到更新。另外快照表没有淘汰，会话关闭要能释放。
 */
import { describe, expect, test, vi } from "vitest";

type Pending = {
  sessionId: string;
  resolve: (value: unknown) => void;
  reject: (err: unknown) => void;
};

const pending = vi.hoisted(() => [] as Pending[]);

vi.mock("@/lib/pi/pi-bridge", () => ({
  piRequest: (req: { sessionId: string }) =>
    new Promise((resolve, reject) => {
      pending.push({ sessionId: req.sessionId, resolve, reject });
    }),
}));

import {
  getGitStatusSnapshot,
  refreshGitStatus,
  releaseGitStatus,
  type GitFileStatus,
} from "./pi-git";

const okStatus = (branch: string, files: GitFileStatus[] = []) => ({
  type: "git_status",
  ok: true,
  repo: true,
  branch,
  files,
  truncated: false,
});

describe("refreshGitStatus", () => {
  test("A 在飞时刷新 B 会各自发请求，B 不再被 A 的 promise 吞掉", async () => {
    const a = refreshGitStatus("session-a");
    const b = refreshGitStatus("session-b");

    expect(pending.map((p) => p.sessionId)).toEqual(["session-a", "session-b"]);

    pending.find((p) => p.sessionId === "session-b")!.resolve(okStatus("b-branch"));
    await b;
    expect(getGitStatusSnapshot("session-b")).toMatchObject({
      loading: false,
      repo: true,
      branch: "b-branch",
    });

    // A 还在飞，B 的结果不受影响
    expect(getGitStatusSnapshot("session-a").loading).toBe(true);
    pending.find((p) => p.sessionId === "session-a")!.resolve(okStatus("a-branch"));
    await a;
    expect(getGitStatusSnapshot("session-a")).toMatchObject({
      loading: false,
      branch: "a-branch",
    });
  });

  test("同一会话并发刷新只发一次请求", async () => {
    const first = refreshGitStatus("session-dedupe");
    const second = refreshGitStatus("session-dedupe");

    expect(pending.filter((p) => p.sessionId === "session-dedupe")).toHaveLength(1);

    pending.find((p) => p.sessionId === "session-dedupe")!.resolve(okStatus("main"));
    await Promise.all([first, second]);
    expect(getGitStatusSnapshot("session-dedupe").branch).toBe("main");
  });

  test("会话关闭后释放快照，在途结果不会把快照写回来", async () => {
    const inflight = refreshGitStatus("session-closed");
    releaseGitStatus("session-closed");

    pending.find((p) => p.sessionId === "session-closed")!.resolve(okStatus("stale"));
    await inflight;

    expect(getGitStatusSnapshot("session-closed")).toMatchObject({
      loading: false,
      repo: false,
      branch: null,
    });

    // 释放后重新打开会话：发新请求，不复用旧的在途 promise
    const reopened = refreshGitStatus("session-closed");
    expect(pending.filter((p) => p.sessionId === "session-closed")).toHaveLength(2);
    pending.at(-1)!.resolve(okStatus("fresh"));
    await reopened;
    expect(getGitStatusSnapshot("session-closed").branch).toBe("fresh");
  });
});
