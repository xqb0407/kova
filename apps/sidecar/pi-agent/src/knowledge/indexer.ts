/**
 * KnowledgeService 的索引边界。
 *
 * 文件域（任务产物 + 资料库）归 Knowledge 域所有；会话域仍由全局搜索索引
 * 提供，这里作为统一入口暴露。
 */
export {
  artifactWatermark,
  buildArtifactIndexRows,
  recentArtifacts,
  refreshArtifactsIndex,
} from "./artifact-index";
export { searchSessions } from "../search/search-index";
