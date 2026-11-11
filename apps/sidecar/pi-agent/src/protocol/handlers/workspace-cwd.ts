/**
 * 设置类命令的 cwd 作用域：项目内统一收敛到主目录。
 *
 * MCP / Subagent / Skill / 插件这些“工作空间级配置”按项目主目录读写，
 * 会话本身在哪个附加目录不影响配置归属；没有项目归属时保持原 cwd。
 */
import { configCwdFor } from "../../agent/projects";

export function scopedCwd(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  return configCwdFor(value.trim());
}
