/**
 * 插件层占位符展开（MCP stdio 条目与插件 hooks 命令串共用）。
 *
 * 单列此文件而非挂在 mcp-config 上：mcp-config 反向依赖 plugins/（取插件层
 * .mcp.json），hooks 读取在 plugins/store 里也依赖它——展开函数再住 mcp-config
 * 就成环。展开本身无依赖，放中立层最省事。
 */

/** 插件层展开上下文：缺省的字段对应占位符不展开（并计入 missing） */
export type PluginExpandCtx = {
  /** 插件根目录（绝对） */
  root?: string;
  /** 会话工作区（server / hook 据此解析工作区相对路径） */
  workspace?: string;
};

/**
 * 插件层字符串值占位符展开（command / args / env）：
 * - `${PLUGIN_ROOT}` / `${CLAUDE_PLUGIN_ROOT}` → 插件根绝对路径。两者同义：
 *   前者是本项目自有写法，后者是 Claude 生态 hooks.json 的写法（Claude Code 由
 *   宿主注入同名环境变量），第三方插件两个都可能出现。
 * - `${WORKSPACE}`   → 会话工作区
 * - `${BUN}`         → 应用内置 JS/TS 运行时（process.execPath）；命中时 usedBun=true，
 *   调用方据此补 `BUN_BE_BUN=1`——编译态 sidecar 二进制由此充当完整 bun CLI
 *   （真实 bun 上该变量无副作用），插件因而无需用户机器预装 node/bun。
 *
 * 展开只在插件层发生：用户/系统层配置里的同名写法保持字面量，语义不意外。
 */
export function expandPluginValue(
  value: string,
  ctx: PluginExpandCtx,
): { value: string; usedBun: boolean; missing: string[] } {
  let out = value;
  const missing: string[] = [];
  let usedBun = false;
  // 两个拼写同义：先定出实际出现的那个 token，再统一展开，避免别名漏判
  const rootToken = out.includes("${PLUGIN_ROOT}") ? "${PLUGIN_ROOT}" : "${CLAUDE_PLUGIN_ROOT}";
  if (out.includes(rootToken)) {
    if (ctx.root) out = out.split(rootToken).join(ctx.root);
    else missing.push(rootToken);
  }
  if (out.includes("${WORKSPACE}")) {
    if (ctx.workspace) out = out.split("${WORKSPACE}").join(ctx.workspace);
    else missing.push("${WORKSPACE}");
  }
  if (out.includes("${BUN}")) {
    out = out.split("${BUN}").join(process.execPath);
    usedBun = true;
  }
  return { value: out, usedBun, missing };
}
