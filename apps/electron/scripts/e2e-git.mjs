/**
 * git 命令冒烟（CDP，两阶段以覆盖"检查点之后再改动"的真实语义）：
 *   node apps/electron/scripts/e2e-git.mjs [cdpPort] [repoPath]
 * 阶段1：kv workspace 指向仓库 → probe/status/log/graph/branches/checkpoint_create
 * 中途（Node 侧）：写文件（检查点之后的外部改动）
 * 阶段2：checkpoint diff 必须列出该文件与 patch；restore 后文件内容回到检查点时刻。
 */
import { chromium } from "playwright-core";
import { readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";

const port = process.argv[2] ?? "9223";
const repo = process.argv[3];
if (!repo) {
  console.error("usage: e2e-git.mjs <cdpPort> <repoPath>");
  process.exit(1);
}

const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
let page = null;
for (const c of browser.contexts()) for (const p of c.pages()) if (p.url().startsWith("kova://")) page = p;
if (!page) {
  console.error("FAIL: no kova:// page");
  process.exit(1);
}

const call = (cmd, args = {}) =>
  page.evaluate(
    async ({ cmd, args }) => {
      const r = await window.kovaHost.invoke(cmd, args);
      if (!r?.ok) throw new Error(`${cmd}: ${r?.error}`);
      return r.value;
    },
    { cmd, args },
  );

const out = {};
await call("kv_set", { key: "workspace", value: repo });
out.probe = await call("git_probe");
const st = await call("git_status", { cwd: repo });
out.status = { branch: st.branch, dirty: st.dirty, files: st.files.map((f) => f.path), last: st.lastCommit?.subject };
out.log = (await call("git_log", { cwd: repo, limit: 5 })).map((e) => e.subject);
out.graphRefs = (await call("git_log_graph", { cwd: repo, limit: 5 })).map((e) => e.refs.map((r) => `${r.kind}:${r.name}`));
out.branches = await call("git_branches", { cwd: repo });

// 检查点：此刻快照（含当前未提交改动）
const cp = await call("git_checkpoint_create", { cwd: repo, tag: "e2e-before" });
out.checkpoint = cp.hash?.slice(0, 12);

// 检查点之后再改动（模拟 agent/用户继续写文件）
const postFile = join(repo, "post-checkpoint.txt");
writeFileSync(postFile, "created after checkpoint\n");
appendFileSync(join(repo, "a.txt"), "appended after checkpoint\n");

// 阶段2：checkpoint diff 必须列出这两处变更
const d = await call("git_diff", { cwd: repo, checkpoint: cp.hash });
out.checkpointDiff = d.files.map((f) => ({
  path: f.path,
  status: f.status,
  added: f.added,
  removed: f.removed,
  hasPatch: (f.patch ?? "").length > 0,
}));

// restore：post-checkpoint 文件应被移除、a.txt 的追加行应消失
out.restored = (await call("git_checkpoint_restore", { cwd: repo, hash: cp.hash })).restored;
let removed = false;
try {
  readFileSync(postFile);
} catch {
  removed = true;
}
const reverted = !readFileSync(join(repo, "a.txt"), "utf8").includes("appended after checkpoint");
out.postRestore = { postFileRemoved: removed, aTxtReverted: reverted };

// restore 后 diff 应清空
out.diffAfterRestore = (await call("git_diff", { cwd: repo, checkpoint: cp.hash })).files.length;

console.log(JSON.stringify(out, null, 2));
await browser.close();
