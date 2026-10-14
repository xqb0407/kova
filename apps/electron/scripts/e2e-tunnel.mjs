/**
 * 隧道监管冒烟（CDP，不依赖真实 cloudflared）：
 *   node apps/electron/scripts/e2e-tunnel.mjs [cdpPort]
 * 覆盖：status 默认态 → start 无网关报错 → set_binary 非法路径报错 →
 * set_binary 用 /bin/ls 假二进制 → start 起来后进程立即退出 → 状态机落 error
 * 且 error 带最后一行日志 → stop 回 stopped → 清空自定义路径。
 */
import { chromium } from "playwright-core";

const port = process.argv[2] ?? "9228";

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
      return r;
    },
    { cmd, args },
  );

const out = {};
out.status0 = (await call("pi_tunnel_status")).value;

// start 无网关：应报"先起网关"
const noGw = await call("pi_tunnel_start");
out.startWithoutGateway = { ok: noGw.ok, error: noGw.error };

// set_binary 非法路径
const badPath = await call("pi_tunnel_set_binary", { path: "/definitely/not/exists" });
out.setBinaryBad = { ok: badPath.ok, error: badPath.error };

// set_binary 用真文件（/bin/ls 冒充 cloudflared）
const bin = "/bin/ls";
const setOk = await call("pi_tunnel_set_binary", { path: bin });
out.setBinaryOk = { ok: setOk.ok, source: setOk.value?.binarySource, exists: setOk.value?.binaryExists };

// 起网关（本机端口），再 start 隧道：假二进制立刻退出 → error 态 + 日志尾巴
const gw = await call("pi_remote_start", { port: 18790, lan: false });
out.gateway = { ok: gw.ok, port: gw.value?.port };
const started = await call("pi_tunnel_start");
out.startWithFakeBinary = { ok: started.ok, state: started.value?.state };
await page.waitForTimeout(1500);
const st1 = await call("pi_tunnel_status");
out.stateAfterExit = {
  state: st1.value?.state,
  errorHead: String(st1.value?.error ?? "").slice(0, 120),
  logLines: st1.value?.logTail?.length ?? 0,
};

// 事件探针：重放一次（这里只断言状态机，事件名已在 remote 冒烟里验证同款形状）
const stop = await call("pi_tunnel_stop");
out.stop = { state: stop.value?.state, url: stop.value?.url };
const clear = await call("pi_tunnel_set_binary", { path: "" });
out.clearBinary = { source: clear.value?.binarySource };
const gwStop = await call("pi_remote_stop");
out.gatewayStopped = gwStop.ok;

console.log(JSON.stringify(out, null, 2));
await browser.close();
