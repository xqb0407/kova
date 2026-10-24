/**
 * 请求超时预算（三层共用的单一事实源）。
 *
 * 铁律：**外层必须比内层多等**——渲染层通道 > 主进程配对 > 侧车内部上限。
 * 反过来就会出现「侧车还在跑、上层先判超时」：用户拿到的是含糊的本地超时，
 * 侧车仍在占着 mgmt 串行队列，界面看起来像死了（2026-10 假死事故的直接组合：
 * 侧车等 180s / 主进程 30s 判死 / 渲染层 15s 先行超时）。
 *
 * 取数链（三层都从这里算，别在各自文件里写死数字）：
 *   侧车侧上限  sidecarBudgetMs(type)   —— 该命令在侧车内部可能的最长耗时
 *   渲染层预算  channelTimeoutMs(type)  —— max(地板, 上限 + CHANNEL_SLACK_MS)
 *   主进程配对  pairWaitMs(type)        —— 渲染层预算 + PAIR_SLACK_MS
 *
 * 新增慢命令：只需在 SIDECAR_BUDGET_MS 登记它的侧车侧上限，三层自动错开；
 * 通道还会把显式传入的更短超时抬到 sidecarBudgetMs（见 pi-channel/pi-ws-channel
 * 的 request），所以调用方写 15s 也压不住 20s 的握手——写短了只会让上层白报超时。
 * 不变量与源码钉桩见 apps/sidecar/pi-agent/test/protocol/timeout-budget.test.ts。
 */

/** 渲染层比侧车侧上限多等的余量（IPC 往返 + 结果序列化） */
export const CHANNEL_SLACK_MS = 5_000;
/** 主进程比渲染层多等的余量：让渲染层先落定，错误是侧车的明确原因而非本地悬空 */
export const PAIR_SLACK_MS = 5_000;
/** 渲染层默认地板：与既有 15s 行为一致（未登记命令的通道预算取下限） */
export const CHANNEL_FLOOR_MS = 15_000;
/** 未登记命令的侧车侧上限：管理命令都是本地/亚秒级动作，5s 已是纯余量 */
export const DEFAULT_SIDECAR_BUDGET_MS = 5_000;

/**
 * 各命令在侧车侧可能的最长耗时（含其内部 RPC / 网络 / 模型等待）。
 * 只登记"会明显超过亚秒级"的命令；其余一律走 DEFAULT_SIDECAR_BUDGET_MS。
 * 注意：派活式/两段式的命令（optimize_prompt、plugin 耗时操作、授权等）在
 * handler 里**不**等长任务，这里的上限只覆盖它们受理段的真实等待。
 */
export const SIDECAR_BUDGET_MS: Record<string, number> = {
  /** 强制握手：连接 10s + 列工具 10s（MCP_CONNECT_TIMEOUT_MS × 2）+ 余量 */
  test_mcp_server: 22_000,
  /** 缓存未命中时的懒握手：同上 */
  get_mcp_server_tools: 22_000,
  /** 交互式授权受理：只等授权链接生成（侧车 MCP_AUTH_URL_TIMEOUT_MS = 30s） */
  authorize_mcp_server: 32_000,
  /** 提示词优化：一次独立 provider 请求（侧车内部无上限，按历史前端预算 120s） */
  optimize_prompt: 122_000,
  /** 连通性测试：两段式（受理即返回），迟到结果帧最晚 = fetch 20s 超时 + 余量。
   *  此前未登记：渲染层 15s 地板先超时、侧车 fetch 20s 还在跑，层级倒挂 */
  test_provider: 22_000,
  /** 端点模型列表拉取：两段式，迟到结果帧最晚 = fetch 15s 超时 + 余量 */
  fetch_models: 17_000,
  /** 项目虚拟目录变更：需重扫附加根技能/指令并对所有驻留会话重排提示词 */
  add_project_dir: 30_000,
  remove_project_dir: 30_000,
};

/** 该命令在侧车侧可能的最长耗时 */
export function sidecarBudgetMs(type: string): number {
  return SIDECAR_BUDGET_MS[type] ?? DEFAULT_SIDECAR_BUDGET_MS;
}

/** 渲染层通道预算：不短于地板，也不短于侧车侧上限 + 余量 */
export function channelTimeoutMs(type: string): number {
  return Math.max(CHANNEL_FLOOR_MS, sidecarBudgetMs(type) + CHANNEL_SLACK_MS);
}

/** 主进程配对等待预算（严格大于渲染层预算） */
export function pairWaitMs(type: string): number {
  return channelTimeoutMs(type) + PAIR_SLACK_MS;
}