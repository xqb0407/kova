"use client";

/**
 * 项目虚拟目录（多代码工程合并）的前端只读 API。
 *
 * 事实源在项目实体表（sidecar 的 projects/project_folders）；文件夹的增删
 * 统一走「编辑项目」表单的 saveProject，不再从这里写。文件树切根时读取
 * 当前项目的 roots 即可。
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
