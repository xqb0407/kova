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
  fetchGitDiff,
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

  test("同一会话并发刷新只发一次在途请求，完成后补拉一次", async () => {
    const first = refreshGitStatus("session-dedupe");
    const second = refreshGitStatus("session-dedupe");
    const requests = () => pending.filter((p) => p.sessionId === "session-dedupe");

    expect(requests()).toHaveLength(1);

    requests()[0]!.resolve(okStatus("stale"));
    await Promise.all([first, second]);
    expect(getGitStatusSnapshot("session-dedupe").branch).toBe("stale");

    // 并发期间的第二次触发没有丢：完成后自动补拉，最后一次状态最终可见
    expect(requests()).toHaveLength(2);
    requests()[1]!.resolve(okStatus("fresh"));
    await refreshGitStatus("session-dedupe");
    expect(getGitStatusSnapshot("session-dedupe").branch).toBe("fresh");
  });

  test("刷新失败保留上一次成功结果，只记录错误", async () => {
    const file: GitFileStatus = {
      path: "src/a.ts",
      status: "M",
      added: 3,
      removed: 1,
      untracked: false,
    };
    const first = refreshGitStatus("session-error");
    pending.find((p) => p.sessionId === "session-error")!.resolve(okStatus("main", [file]));
    await first;
    expect(getGitStatusSnapshot("session-error")).toMatchObject({
      repo: true,
      branch: "main",
      files: [file],
      error: null,
    });

    const second = refreshGitStatus("session-error");
    pending.at(-1)!.reject(new Error("network down"));
    await second;
    expect(getGitStatusSnapshot("session-error")).toMatchObject({
      loading: false,
      repo: true,
      branch: "main",
      files: [file],
      error: "network down",
    });
  });

  test("sidecar 明确报错时进入错误态，错误可见且可重试", async () => {
    const first = refreshGitStatus("session-reject");
    pending.find((p) => p.sessionId === "session-reject")!.resolve(okStatus("main"));
    await first;

    const second = refreshGitStatus("session-reject");
    pending.at(-1)!.resolve({
      type: "git_status",
      ok: false,
      errorText: "会话没有绑定工作目录",
      repo: false,
      files: [],
    });
    await second;
    expect(getGitStatusSnapshot("session-reject")).toMatchObject({
      loading: false,
      repo: false,
      branch: null,
      files: [],
      error: "会话没有绑定工作目录",
    });

    // 错误态下再刷新：错误先清空、请求重新发出
    const retry = refreshGitStatus("session-reject");
    expect(getGitStatusSnapshot("session-reject")).toMatchObject({
      loading: true,
      error: null,
    });
    pending.at(-1)!.resolve(okStatus("main"));
    await retry;
    expect(getGitStatusSnapshot("session-reject")).toMatchObject({
      loading: false,
      repo: true,
      branch: "main",
      error: null,
    });
  });

  test("会话关闭后释放快照，在途结果不会把快照写回来", async () => {
    const inflight = refreshGitStatus("session-closed");
    // 记一次待补拉：release 必须一并清掉，否则会被重开的请求消费出多余一次拉取
    void refreshGitStatus("session-closed");
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
    const requests = () => pending.filter((p) => p.sessionId === "session-closed");
    expect(requests()).toHaveLength(2);
    requests()[1]!.resolve(okStatus("fresh"));
    await reopened;
    expect(getGitStatusSnapshot("session-closed").branch).toBe("fresh");
    // release 清掉的待补拉标记不能被重开的请求消费成第三次拉取
    expect(requests()).toHaveLength(2);
  });
});

describe("fetchGitDiff", () => {
  test("成功时返回可判别结果", async () => {
    const promise = fetchGitDiff("session-diff", "a.ts");
    pending.at(-1)!.resolve({
      type: "git_diff",
      ok: true,
      path: "a.ts",
      diff: "@@ -1 +1 @@",
      untracked: false,
      truncated: false,
    });

    await expect(promise).resolves.toEqual({
      ok: true,
      diff: "@@ -1 +1 @@",
      untracked: false,
      truncated: false,
    });
  });

  test("sidecar 报错时保留 errorText，而不是退化成空 diff", async () => {
    const promise = fetchGitDiff("session-diff", "b.ts");
    pending.at(-1)!.resolve({
      type: "git_diff",
      ok: false,
      path: "b.ts",
      errorText: "路径不在会话工作目录内",
    });

    await expect(promise).resolves.toEqual({
      ok: false,
      error: "路径不在会话工作目录内",
    });
  });

  test("请求异常返回 failed 而不是 null", async () => {
    const promise = fetchGitDiff("session-diff", "c.ts");
    pending.at(-1)!.reject(new Error("network down"));

    await expect(promise).resolves.toEqual({
      ok: false,
      error: "network down",
    });
  });
});
