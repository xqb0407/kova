import { chromium } from "playwright-core";
const b = await chromium.connectOverCDP("http://127.0.0.1:19466");
const pages = []; for (const c of b.contexts()) for (const p of c.pages()) pages.push(p);
const main = pages.find((p) => p.url().includes("index.html"));
const out = {};
const tid = "abort-" + Date.now();
await main.evaluate(async (tid) => {
  await window.kovaHost.invoke("pi_prompt", { requestId: tid, text: "用 bash 工具运行：sleep 120 ; echo done（必须真的调用 bash 工具执行这条命令）", threadId: tid, sessionId: null, cwd: null });
}, tid);
console.log("prompt sent:", tid);
out.tid = tid;
console.log(JSON.stringify(out));
await b.close();
