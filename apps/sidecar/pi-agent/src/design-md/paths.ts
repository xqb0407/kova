/**
 * 设计主题目录解析（与 skills/discovery.ts 的 systemSkillsDir 同族链）：
 *   PI_DESIGN_MD_DIR（测试钉住） > <PI_DB_PATH 同级>/design-md（生产，Rust 注入）
 *   > ~/.kova/design-md（兜底）
 * 布局：<root>/builtin/<slug>/DESIGN.md（主题包解压产物，只读）、
 *       <root>/user/<slug>.md（用户主题，可编辑）。
 */
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export function designMdRootDir(): string {
  if (process.env.PI_DESIGN_MD_DIR) return process.env.PI_DESIGN_MD_DIR;
  const db = process.env.PI_DB_PATH;
  if (db) return join(dirname(resolve(db)), "design-md");
  return join(homedir(), ".kova", "design-md");
}

export function builtinThemesDir(): string {
  return join(designMdRootDir(), "builtin");
}

export function userThemesDir(): string {
  return join(designMdRootDir(), "user");
}
