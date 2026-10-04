import { chromium } from 'playwright';
const TOKEN = process.env.TOKEN;
const browser = await chromium.launch({ channel: 'chrome' });
const page = await (await browser.newContext({ viewport: { width: 420, height: 900 }, hasTouch: true, isMobile: true })).newPage();
await page.goto('http://localhost:8091/', { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.evaluate((t) => {
  localStorage.setItem('pi_remote_token', t);
  localStorage.setItem('pi_remote_host', 'ws://127.0.0.1:8787/ws');
}, TOKEN);
await page.goto('http://localhost:8091/', { waitUntil: 'networkidle', timeout: 60000 });
await page.waitForTimeout(9000);
const titles = ['五星红旗飘扬动画页面制作', '生成白猫黑底Logo', 'Next.js纯静态后台系统方案', '执行 ls /tmp', '工具使用提问'];
for (const title of titles) {
  const loc = page.getByText(title).first();
  if ((await loc.count()) === 0) { console.log('SKIP', title); continue; }
  await loc.click();
  await page.waitForTimeout(11000);
  const seen = new Set();
  for (let i = 0; i < 30; i++) {
    const hits = await page.evaluate(() => {
      const t = document.body.innerText;
      const re = /(?:已使用|执行中|等待确认|失败|已取消)\s+([A-Za-z_][\w.]*)/g;
      const out = []; let m;
      while ((m = re.exec(t))) out.push(m[1]);
      return out;
    });
    for (const h of hits) seen.add(h);
    await page.evaluate(() => {
      for (const el of document.querySelectorAll('div')) {
        if (el.scrollHeight > el.clientHeight + 50 && el.clientHeight > 400) el.scrollTop += 1500;
      }
    });
    await page.waitForTimeout(250);
  }
  console.log('SESSION:', title, '=> fallback:', [...seen].join(', ') || '(none)');
  await page.getByLabel('返回会话列表').click().catch(async () => {
    await page.goBack().catch(() => {});
  });
  await page.waitForTimeout(1500);
}
await browser.close();
