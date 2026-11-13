/**
 * sidecar 换代对账（pi_restarted 广播的渲染层端）。
 *
 * 背景：dev 模式 sidecar 跑在 `bun --watch` 下（scripts/dev.mjs 包装），源码
 * 一改就原地换代——进程句柄没换，宿主看不到 close，pi-exit 不会响；热重启
 * 与崩溃重启对前端表现完全一致：旧实例的 running 表随模块状态清零，在跑
 * 轮次没有 agent_end 收尾，UI 永远停在 running，点停止也是对空表 abort
 * （2026-10-24「停止不了」的根因）。
 *
 * 对账口径：快照权威。收到 pi_restarted 就对所有「自认为在跑」的控制器拉
 * thread_snapshot，跑没跑以 sidecar 现状为准（新实例 running 表必然为空 →
 * 全部归位，队列镜像/在飞 partial 也随快照重建）。确有在跑被腰斩时提一句，
 * 免得用户对着已经死掉的流式界面干等；冷启动无在跑轮次，无感。
 */
import { subscribeWireFrames } from "@/lib/pi/wire-bus";
import { toast } from "@/components/ui/toast";

/** 对账只需要的控制器切面（PiThreadController 与测试桩的共同最小形状） */
export type RestartReconcilableController = {
  getState: () => {
    runStatus: string;
    compaction: { active: boolean };
    retry: { active: boolean };
  };
  refresh: () => Promise<void>;
  /** sidecar 换代：旧实例的在飞 prompt 不会再收到 finish，撤掉起跑上屏但
   *  未回显的乐观消息（见 ThreadController.discardLostPrompts）。 */
  discardLostPrompts?: () => void;
  /** sidecar 换代：在跑轮被腰斩且快照里没有可回显的回复行时，投影补一条
   *  合成的 aborted 空回复，「回复已被你终止」占位才有落点
   *  （见 ThreadController.markInterruptedTurn）。 */
  markInterruptedTurn?: () => void;
};

type RestartReconcilableRegistry = {
  readonly disposed: boolean;
  controllers: ReadonlyMap<string, RestartReconcilableController>;
};

/** 「自认为在跑」：runStatus 之外还看压缩/重试——它们卡死同样表现为不可交互 */
export const isPiStateBusy = (state: {
  runStatus: string;
  compaction: { active: boolean };
  retry: { active: boolean };
}): boolean =>
  state.runStatus === "running" ||
  state.compaction.active ||
  state.retry.active;

/** 清理失败不能反过来打断换代对账：单项异常记日志后继续。 */
const discardLostPromptsSafely = (
  controller: RestartReconcilableController,
): void => {
  try {
    controller.discardLostPrompts?.();
  } catch (error) {
    console.error("[react-pi] discardLostPrompts failed", error);
  }
};

const markInterruptedTurnSafely = (
  controller: RestartReconcilableController,
): void => {
  try {
    controller.markInterruptedTurn?.();
  } catch (error) {
    console.error("[react-pi] markInterruptedTurn failed", error);
  }
};

/** 对一轮快照对账：让每个在跑控制器各拉一次快照，返回受影响的线程数。
 *  换代同时清理起跑上屏的乐观消息：在跑的控制器等快照落定后再清（已落盘的
 *  消息先由快照确认，避免删了又加的一帧闪动）；空闲控制器直接清（正常无
 *  可清项，只是把丢失的 pending 台账收口）。 */
export const reconcileRunningControllers = (
  controllers: Iterable<RestartReconcilableController>,
): number => {
  let interrupted = 0;
  for (const controller of controllers) {
    // 必须按方法调用保留 this（controller 是类实例；裸取函数引用会丢 this）
    if (!isPiStateBusy(controller.getState())) {
      discardLostPromptsSafely(controller);
      continue;
    }
    interrupted += 1;
    void controller
      .refresh()
      .catch(() => {
        // load() 已把错误记进 state.lastError
      })
      .finally(() => {
        discardLostPromptsSafely(controller);
        markInterruptedTurnSafely(controller);
      });
  }
  return interrupted;
};

let installed = false;
/** 当前活跃 registry 的供给（install 时装订；触发时现读） */
let registryProvider: (() => RestartReconcilableRegistry | null) | null = null;

/** 执行一次换代对账。两个帧源共用：桌面 pi-chunk-batch（wire-bus）与
 *  远程网页端 WS 网关（WsPiChannel.subscribeSidecarRestart）。 */
export const reconcileAfterSidecarRestart = (): void => {
  const registry = registryProvider?.() ?? null;
  if (!registry || registry.disposed) return;
  const interrupted = reconcileRunningControllers(registry.controllers.values());
  if (interrupted > 0) {
    toast.message({
      title: "AI 服务已重启",
      description: `${interrupted} 个进行中的回复被中断，界面已对账归位`,
    });
  }
};

/** 装订 pi_restarted 订阅（幂等，模块级单次；registry 由调用方供给——
 *  usePiRuntime 传 lastRegistry getter，回调触发时读到的总是当前活跃 registry）。
 *  pi-chunk-batch 是桌面 IPC 专属传输：远程网页端/SSR 没有 kovaHost，listen
 *  会抛——桌面端在此装订，远程端由 RemoteRuntimeProvider 经
 *  WsPiChannel.subscribeSidecarRestart 调 reconcileAfterSidecarRestart 达到同效。 */
export const installRestartReconcile = (
  getRegistry: () => RestartReconcilableRegistry | null,
): void => {
  if (installed) return;
  installed = true;
  registryProvider = getRegistry;
  subscribeWireFrames(["pi_restarted"], () => reconcileAfterSidecarRestart()).catch(() => {
    // 非 Electron 宿主：无传输可订，桌面专属功能按缺位处理
  });
};

/** 仅供测试：清掉「已装订」标记与 registry 供给。bun test 同进程跑多文件时，
 *  若别的文件先经 usePiRuntime 装订过（生产 getter 生效），本文件要用自己的
 *  getter 重装。 */
export function resetRestartReconcileForTests(): void {
  installed = false;
  registryProvider = null;
}
