/**
 * 备份/恢复端到端（CDP + 磁盘断言）：
 *   node apps/electron/scripts/e2e-backup.mjs [cdpPort] [outDir]
 * 覆盖：config get/set（含秘密字段 Set 位）→ backup_run local（明文/加密两种）
 * → peek_header → restore（staging + 待恢复标记）→ 校验 staging 内残行已修剪。
 * 换入（重启）由外层脚本再启一次实例并断言 pre-restore-* 与标记 .done。
 */
import { chromium } from "playwright-core";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const port = process.argv[2] ?? "9229";
const outDir = process.argv[3] ?? "/tmp/kova-bk-out";

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
out.config0 = await call("backup_config_get");
const set = await call("backup_config_set", {
  config: {
    ...out.config0,
    provider: "off",
    includeWorkspace: true,
    deviceName: "e2e-device",
    rememberPassphrase: false,
    s3SecretAccessKey: "sk-secret-e2e-123456",
    davPassword: "",
    passphrase: "",
  },
});
out.configSet = { deviceName: set.deviceName, s3SecretSet: set.s3SecretAccessKeySet, davSet: set.davPasswordSet };

const plainPath = join(outDir, "plain.piabk");
out.runPlain = await call("backup_run", { target: "local", localPath: plainPath });

const encPath = join(outDir, "enc.piabk");
out.runEncrypted = await call("backup_run", { target: "local", localPath: encPath, passphrase: "口令-pass-42" });

out.peekPlain = await call("backup_peek_header", { path: plainPath });
out.peekEnc = await call("backup_peek_header", { path: encPath });

// 恢复（本地明文）→ staging + 待恢复标记
out.restore = await call("backup_restore", { source: { localPath: plainPath } });

// 磁盘断言：staging 内容 + 残行修剪 + 标记文件
out.disk = {
  stagingDb: existsSync(join("/tmp/kova-e2e-bk", "restore-staging", "content", "state.db")),
  stagingSessions: readdirSync(join("/tmp/kova-e2e-bk", "restore-staging", "content", "sessions")),
  marker: existsSync(join("/tmp/kova-e2e-bk", "pending-restore.json")),
  tornTrimmed:
    readFileSync(join("/tmp/kova-e2e-bk", "restore-staging", "content", "sessions", "s1.jsonl"), "utf8") ===
    '{"type":"message","id":1}\n{"type":"message","id":2}\n{"type":"message","id":3}\n',
  workspaceBackedUp: existsSync(join("/tmp/kova-e2e-bk", "restore-staging", "content", "task-workspace", "abc", "out.txt")),
  envelopeSize: existsSync(plainPath) ? statSync(plainPath).size : 0,
};
out.markerContent = existsSync(join("/tmp/kova-e2e-bk", "pending-restore.json"))
  ? JSON.parse(readFileSync(join("/tmp/kova-e2e-bk", "pending-restore.json"), "utf8"))
  : null;

// 错误口令恢复应失败且清掉 staging
let errMsg = "";
try {
  await call("backup_restore", { source: { localPath: encPath, passphrase: "wrong-pass" } });
} catch (e) {
  errMsg = String(e.message ?? e);
}
out.wrongPassphrase = { errorHead: errMsg.slice(0, 120), stagingCleaned: !existsSync(join("/tmp/kova-e2e-bk", "restore-staging")) };

// 正确口令恢复（加密包）
out.restoreEncrypted = await call("backup_restore", { source: { localPath: encPath, passphrase: "口令-pass-42" } });

console.log(JSON.stringify(out, null, 2));
await browser.close();
