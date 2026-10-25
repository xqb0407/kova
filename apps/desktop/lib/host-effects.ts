/**
 * 桌面端宿主副作用端口（HostEffects）。
 *
 * 与移动端 `apps/mobile/lib/host-effects.ts` 同名同形：运行时基座
 * （PiClientBase / TurnCheckpointTracker）只依赖这组端口，不再直接引用
 * 面板、文件树、子代理台账、完成提醒这些宿主 UI 模块。桌面端这里全部转发到
 * 真实实现（行为零变化），移动端则是显式空实现。
 *
 * 两端端口表面一致后，运行时核才能整体上移到 `packages/pi-runtime`。
 */

export {
  focusPanelTabFor,
  focusPluginPanelFor,
  getCurrentPanelThreadId,
} from "@/lib/panels/panel-tabs";
export type { PanelTabType, PanelTabExtra } from "@/lib/panels/panel-tabs";

export { refreshFileTree } from "@/lib/workspace/file-tree";

export { resyncPiRunning } from "@/lib/pi/pi-running";

export { emitAgentEvent } from "@/lib/pi/agent-events";

export { applyDelegationChunk } from "@/lib/subagent/subagent-runs";
