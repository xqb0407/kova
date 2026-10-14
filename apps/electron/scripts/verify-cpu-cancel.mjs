import { chromium } from "playwright-core";
const b = await chromium.connectOverCDP("http://127.0.0.1:19466");
const pages = []; for (const c of b.contexts()) for (const p of c.pages()) pages.push(p);
const main = pages.find((p) => p.url().includes("index.html"));
await main.bringToFront();
const out = {};
const sample = () => main.evaluate(async () => {
  const r = await window.kovaHost.invoke("resource_sample", {});
  return r.ok ? { sysCpu: Number(r.value.sysCpu.toFixed(1)), appCpu: Number(r.value.appCpu.toFixed(1)), cores: r.value.cpuCount, appMB: Math.round(r.value.appMem / 1048576) } : { error: r.error };
});
out.idle = await sample();

// 终端里制造 CPU 负载（4 个 yes 烧核），采样后再 Ctrl-C
for (let i = 0; i < 3; i++) { await main.keyboard.press("Escape"); await main.waitForTimeout(250); }
const back = main.getByText("返回应用", { exact: false }).first();
if (await back.count()) { await back.click().catch(() => {}); await main.waitForTimeout(800); }
await main.locator('button[aria-label="新标签"]').first().click().catch(() => {});
await main.waitForTimeout(700);
await main.getByText("终端", { exact: true }).last().click().catch(() => {});
await main.waitForTimeout(1500);
await main.evaluate(() => document.querySelector(".xterm-helper-textarea")?.focus?.());
await main.keyboard.type("for i in 1 2 3 4; do yes > /dev/null & done; sleep 0.2\r", { delay: 12 });
await new Promise((r) => setTimeout(r, 2500));
out.loaded = await sample();
await main.evaluate(() => document.querySelector(".xterm-helper-textarea")?.focus?.());
await main.keyboard.type("\u0003", { delay: 10 }); // Ctrl-C
await new Promise((r) => setTimeout(r, 1500));
out.afterCtrlC = await sample();
out.termRows = await main.evaluate(() => (document.querySelector(".xterm-rows")?.innerText ?? "").replace(/\s+/g, " ").slice(-160));

// 工具调用中断：prompt 起一条长 bash，然后 abort，看进程是否被杀
await main.getByRole("button", { name: /新对话/ }).first().click().catch(() => {});
await main.waitForTimeout(1000);
const tid = "cancel-" + Date.now();
await main.evaluate(async (tid) => {
  await window.kovaHost.invoke("pi_prompt", { requestId: tid, text: "用 bash 工具运行命令：sleep 300 ; echo done（必须调用 bash 工具，不要自己编造结果）", threadId: tid, sessionId: null, cwd: null });
}, tid);
await new Promise((r) => setTimeout(r, 9000));
out.sleepRunningBeforeAbort = await main.evaluate(async () => {
  const r = await window.kovaHost.invoke("resource_sample", {});
  return r.ok ? r.value.groups.some((g) => g.processes.some((p) => /sleep/.test(p.name))) : null;
});
await main.evaluate((tid) => window.kovaHost.invoke("pi_abort", { threadId: tid }), tid);
await new Promise((r) => setTimeout(r, 4000));
out.afterAbort = await main.evaluate(async () => {
  const r = await window.kovaHost.invoke("resource_sample", {});
  return r.ok ? { sysCpu: Number(r.value.sysCpu.toFixed(1)), hasSleep: r.value.groups.some((g) => g.processes.some((p) => /sleep/.test(p.name))) } : { error: r.error };
});
console.log(JSON.stringify(out, null, 2).slice(0, 2000));
await b.close();
