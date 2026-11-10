"use client";

/**
 * 项目虚拟目录（多代码工程合并）的前端 API。
 *
 * 事实源在 sidecar（kv pi.projectDirs）；这里只做请求-应答，不建全局 store：
 * 目录管理只在项目「⋯」弹层里发生，打开时现拉一次即可，天然是新鲜的。
 * 变更后 sidecar 会按新的分组归属广播 sessions_changed，侧栏自动归并。
 */
import {
  piRequest,
  type PiExternalDir,
  type PiProjectDirsResponse,
} from "@/lib/pi/pi-bridge";

export type ProjectDirsInfo = {
  /** 项目主目录（会话 cwd 的默认归属） */
  main: string;
  /** main + 附加根（main 在首位） */
  roots: PiExternalDir[];
  /** 针对请求 cwd 的生效附加目录（cwd 是某个根时排除自己） */
  dirs: PiExternalDir[];
  /** 当前不存在的根路径（配置保留，提示词/检索跳过） */
  missing: string[];
};

function toInfo(res: PiProjectDirsResponse): ProjectDirsInfo {
  return {
    main: res.main,
    roots: res.roots,
    dirs: res.dirs,
    missing: res.missing ?? [],
  };
}

/** 系统目录选择器（非桌面壳环境返回 null） */
export async function pickProjectDir(): Promise<string | null> {
  try {
    const { open } = await import("@/desktop-bridge/plugin-dialog");
    const picked = await open({
      directory: true,
      multiple: false,
      title: "选择项目目录",
    });
    return typeof picked === "string" ? picked : null;
  } catch {
    return null;
  }
}

export async function fetchProjectDirs(
  cwd: string,
  projectId?: string,
): Promise<ProjectDirsInfo> {
  const res = await piRequest<PiProjectDirsResponse>({
    type: "get_project_dirs",
    cwd,
    ...(projectId ? { projectId } : {}),
  });
  return toInfo(res);
}

export async function addProjectDir(
  cwd: string,
  path: string,
  projectId?: string,
): Promise<ProjectDirsInfo> {
  const res = await piRequest<PiProjectDirsResponse>({
    type: "add_project_dir",
    cwd,
    path,
    ...(projectId ? { projectId } : {}),
  });
  return toInfo(res);
}

export async function removeProjectDir(
  cwd: string,
  path: string,
  projectId?: string,
): Promise<ProjectDirsInfo> {
  const res = await piRequest<PiProjectDirsResponse>({
    type: "remove_project_dir",
    cwd,
    path,
    ...(projectId ? { projectId } : {}),
  });
  return toInfo(res);
}

/** 从项目移除前的确认（跨所有会话生效，值得一次确认） */
export async function confirmRemoveProjectDir(path: string): Promise<boolean> {
  try {
    const { confirm } = await import("@/desktop-bridge/plugin-dialog");
    return await confirm(
      `从项目中移除这个目录？\n\n${path}\n\n该项目所有对话将不再加载它的 AGENTS.md、技能与文件检索。`,
      { title: "移除项目目录" },
    );
  } catch {
    return false;
  }
}
