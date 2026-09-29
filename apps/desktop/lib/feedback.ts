"use client";

/**
 * 问题反馈出口。
 *
 * about 页的「问题反馈」和崩溃界面的「打开反馈页」必须指向同一个地方，
 * 否则用户粘了一坨栈过来、我们却在一个没人看的 issue 区里找。
 */
export const FEEDBACK_ISSUES_URL = "https://gitee.com/herther/pi-kova/issues";

/**
 * 构造一个预填好的新 issue 链接。
 *
 * 不用 gitee 的 API——离线也要能用。标题里的换行和正文都要编码，
 * 正文动辄几十行堆栈，不编码会被浏览器截断。
 */
export function buildFeedbackIssueUrl(title: string, body: string): string {
  const params = new URLSearchParams({ title, body });
  return `${FEEDBACK_ISSUES_URL}/new?${params.toString()}`;
}
