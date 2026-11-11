/**
 * 纯路径工具：不依赖桌面桥/React，供 workspace-store、项目名称存储与
 * 「新建工作区」表单共用。保持无副作用，单测可直接引入。
 */

/** 路径最后一段作为显示名（兼容 / 与 \） */
export function pathBasename(path: string): string {
  const parts = path.split(/[\\/]/u).filter(Boolean);
  return parts.at(-1) ?? path;
}
