"use client";

/**
 * 项目 GitHub 仓库主页：about 页「GitHub 仓库」入口指向这里。
 */
export const GITHUB_REPO_URL = "https://github.com/xqb0407/kova-electron";

/**
 * 问题反馈出口（GitHub Issues）。
 *
 * about 页的「问题反馈」和崩溃界面的「打开反馈页」必须指向同一个地方，
 * 否则用户粘了一坨栈过来、我们却在一个没人看的 issue 区里找。
 */
export const FEEDBACK_ISSUES_URL = `${GITHUB_REPO_URL}/issues`;

/**
 * 预填 issue 的正文骨架，字段对齐 .github/ISSUE_TEMPLATE/bug_report.yml。
 *
 * 查询参数预填走的是「空白 issue」，GitHub 不会替你套模板表单，骨架得
 * 自己拼进 body——用户点开预填链接看到的就是模板结构，而不是一坨裸堆栈。
 * description 嵌进「问题描述」，其余字段留空给用户补。
 */
function bugTemplateBody(description: string): string {
  return [
    "### 问题描述",
    "",
    description,
    "",
    "### 复现步骤",
    "",
    "1. ",
    "2. ",
    "",
    "### 期望行为",
    "",
    "",
    "### 操作系统",
    "",
    "",
    "### Kova 版本",
    "",
    "",
    "### 运行方式",
    "",
    "",
    "### 日志 / 截图 / 录屏",
    "",
    "```shell",
    "",
    "```",
    "",
    "---",
    "",
    "提交前请先搜索是否已有相同 issue；贴日志前请先脱敏：API Key、token、用户名、个人路径等。",
  ].join("\n");
}

/**
 * 构造一个预填好的新 issue 链接。
 *
 * 不用 GitHub 的 API——离线也要能用（/issues/new 支持 title/body 查询参数）。
 * 标题里的换行和正文都要编码，正文动辄几十行堆栈，不编码会被浏览器截断。
 */
export function buildFeedbackIssueUrl(title: string, body: string): string {
  const params = new URLSearchParams({ title, body: bugTemplateBody(body) });
  return `${FEEDBACK_ISSUES_URL}/new?${params.toString()}`;
}
