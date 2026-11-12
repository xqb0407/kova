/**
 * 预置自动化模板（M3.7）：管理页"从模板新建"的清单，经 automation_templates
 * 命令随应答下发（事实源在 sidecar，前端不复制一份，避免口径漂移）。
 *
 * schedule 用与任务定义相同的三型字符串（croner 表达式 / "+1d" 相对 / "6h" 间隔）：
 * 相对 once 在保存时由 resolveScheduledTaskDefinition 现算成绝对时刻，
 * 模板本身因此不会"过期"。policy 按任务性质预置（默认最小组合）。
 */

export type AutomationTemplate = {
  id: string;
  name: string;
  description: string;
  prompt: string;
  type: "cron" | "once" | "interval";
  schedule: string;
  toolPolicyProfile: "read-only" | "workspace-write" | "full";
};

export const AUTOMATION_TEMPLATES: AutomationTemplate[] = [
  {
    id: "tpl-daily-briefing",
    name: "每日晨报",
    description: "每天早上汇总今日日程与待办要点",
    prompt:
      "汇总今天需要我关注的事项：整理未完成的待办、今天到期的日程，以及最近会话里提到但还没有结论的事情，输出一份不超过 10 条的晨报清单。",
    type: "cron",
    schedule: "30 8 * * *",
    toolPolicyProfile: "read-only",
  },
  {
    id: "tpl-weekly-report",
    name: "每周周报草稿",
    description: "周五傍晚回顾一周工作，生成周报草稿",
    prompt:
      "回顾本周（周一至今）的会话记录与工作产物，按「本周完成 / 进行中 / 下周计划 / 风险」四个部分起草一份周报，语言简洁，条目不超过 5 条每节。",
    type: "cron",
    schedule: "0 17 * * 5",
    toolPolicyProfile: "read-only",
  },
  {
    id: "tpl-repo-check",
    name: "仓库每日体检",
    description: "跑一遍测试与构建，汇总失败项（需指定工作目录）",
    prompt:
      "在当前工作目录：1) 运行测试与构建；2) 如有失败，定位并汇总失败原因与相关文件；3) 输出体检报告，包含通过率和最值得优先修复的问题。不要修改任何文件，只做只读分析。",
    type: "cron",
    schedule: "0 9 * * 1-5",
    toolPolicyProfile: "workspace-write",
  },
  {
    id: "tpl-watch-scan",
    name: "定期信息巡检",
    description: "每 6 小时检索一次指定主题的最新动态",
    prompt:
      "检索并汇总最近 6 小时内「（把这里换成你关注的主题，如：某开源项目 releases、某竞品公告）」的新动态；没有值得关注的变化就只输出一句「无异常」。",
    type: "interval",
    schedule: "6h",
    toolPolicyProfile: "read-only",
  },
  {
    id: "tpl-one-off",
    name: "稍后提醒",
    description: "一天后自动执行一次的一次性任务",
    prompt: "（把这里换成一件你想稍后再做的事，例如：提醒我整理并发送上周的报销材料。）",
    type: "once",
    schedule: "+1d",
    toolPolicyProfile: "read-only",
  },
];
