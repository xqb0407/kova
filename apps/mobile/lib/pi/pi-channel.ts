"use client";

import type { PiResponse } from "@/lib/pi/pi-bridge";

/**
 * pi-agent 通道抽象：把"管理类请求-响应 + 自发通知订阅 + 全局中断"收口成接口。
 *
 * 移动端只有一种实现：WsPiChannel（走 WebSocket 连桌面端的 remote.rs 网关，
 * 见 pi-ws-channel.ts）。主工程的另一个实现 TauriPiChannel 依赖 Tauri
 * invoke/event，本工程不含该部分——通道注册表与接口定义原样保留。
 *
 * prompt 流式输出不走本接口：react-pi 新链路（pi-runtime/PiClientBase）经
 * Tauri 事件行 / WS 原始行自行分流并重建 partial。piRequest 通过模块级注册表
 * （setPiChannel/getPiChannel）与具体通道解耦：运行时 provider 挂载前 set，
 * 之后所有调用原样工作在任一通道上。
 */

/** prompt 附件（用户图片 + 文档，随 prompt 下发 sidecar）。
 *  闸门在 sidecar（prompt-attachments.ts），前端在 addAttachment 时做同款前置校验 */
export type PiPromptAttachment = {
  name: string;
  mimeType: string;
  /** 图片与网页端文档：裸 base64 内联（注意请求体体积） */
  data?: string;
  /** 桌面端文档：经 Rust attachment_stage 落盘中转后的绝对路径（帧不带字节） */
  path?: string;
};

export type PiChannelStatus = {
  connected: boolean;
  error?: string;
};

/* 通知帧契约单源 pi-protocol（设计文档 §1）：与 sidecar 广播端共用 schema，
 * 本文件不再手抄镜像。插件清单载荷域内自有契约，在本地类型上以交叉保留。 */
import type {
  AutomationFiredFrame,
  AutomationRunDoneFrame,
  ContextChangedFrame,
  PluginOpResultFrame,
  RunningTurn,
  SubagentActivityItem,
  SubagentRunStatus,
} from "pi-protocol";

export type { SubagentRunStatus, SubagentActivityItem };

/** list_running turns 明细项：一个确定在跑的轮次（会话 + 其 prompt requestId） */
export type PiRunningTurn = RunningTurn;

/** 定时任务自发通知帧（sidecar automation 调度器钩子发出，无 id） */
export type PiAutomationFrame = AutomationFiredFrame | AutomationRunDoneFrame;

/**
 * 插件耗时操作结果自发通知帧（sidecar plugins 分发 case 发出，无 id；
 * 受理 → plugin_op_accepted，完成 → plugin_op_result）。
 * 成功时携带刷新后的 plugins + marketplaces 双清单，前端 store 整包并入。
 */
export type PiPluginOpFrame = PluginOpResultFrame & {
  plugins?: import("@/lib/pi/pi-bridge").PiPluginEntry[];
  marketplaces?: import("@/lib/pi/pi-bridge").PiMarketplaceEntry[];
  workspaceCwd?: string | null;
};

/** 上下文读数变化自发通知帧（sidecar 轮次收尾点现算推送，无 id，盖事件
 *  水印；设计文档 §7——桌面占用环经 pi-context 镜像直更，缺口回拉 context_info）。 */
export type PiContextChangedFrame = ContextChangedFrame;

/**
 * 设计主题推送帧族（无 id 自发通知，见 handlers/design-md.ts push）：
 * - design_themes：save/delete 后的新清单（发起方另有带 id 应答，双收幂等）
 * - design_theme_set：set 选中后的线程新值；改名重映射/删除收口波及的驻留
 *   线程也逐线程推此帧。他窗胶囊与远程连接据此直更。
 */
export type PiDesignThemesPushFrame = import("@/lib/pi/pi-bridge").PiDesignThemesResponse;
export type PiDesignThemeSetPushFrame = {
  type: "design_theme_set";
  threadId: string;
  sessionId: string;
  theme: import("@/lib/pi/pi-bridge").PiThemeRef | null;
};
export type PiDesignThemePush = PiDesignThemesPushFrame | PiDesignThemeSetPushFrame;

export interface PiChannel {
  readonly kind: "tauri" | "ws";
  /** 管理类请求-响应；id 注入由实现负责（Tauri 侧 Rust 注入，WS 侧 JS 注入） */
  request(payload: Record<string, unknown>, timeoutMs?: number): Promise<PiResponse>;
  /**
   * 能力可选（与 listRunning 成对）：订阅"会话 turn 起止"事件流。
   * cb(sessionId, active)；sessionId = null 表示事件源失效（后端重启等），
   * 订阅方应清空集合并用 listRunning 重新水合。返回退订函数。
   * 时序契约：监听登记本身可能是异步的（Tauri listen 返回 Promise）。注册
   * 窗口里广播的 turn_changed 会永久丢失，而种子无法替它兜底（种子早于事件
   * 时就看不到），所以订阅方必须先 await 返回的退订函数就绪、再发起 listRunning
   * 种子——sidecar 对 turn_changed 与 list_running 响应按 stdout 全序写出，
   * "先订阅、后种子、种子只并入不清除"即可无漏合并。
   * 微信/系统 app 等推送型通道不实现，侧边栏运行指示降级为框架自带的
   * 仅挂载线程 isRunning。
   */
  subscribeTurns?(
    cb: (sessionId: string | null, active: boolean) => void,
  ): (() => void) | Promise<() => void>;
  /**
   * 能力可选（与 subscribeTurns 同款无 id 通道）：订阅子代理活动通知行
   * （subagent_activity：delegate 的思考/正文增量、工具起止、轮次、结算终态）。
   * cb(delegationId, item)。WS 通道暂缺（网关不转发无 id 自发行）→ 缺省即降级：
   * 消息行绑定走 prompt 流 data-subagentDelegation、面板 tab 走快照补水合。
   */
  subscribeSubagentActivity?(
    cb: (delegationId: string, item: SubagentActivityItem) => void,
  ): (() => void) | Promise<() => void>;
  /**
   * 能力可选（同款无 id 自发通知通道）：订阅定时任务通知帧
   * （automation_fired / automation_run_done，见 PiAutomationFrame）。
   * WS 通道经网关白名单转发（remote.rs broadcast_notification）。
   */
  subscribeAutomationEvents?(
    cb: (frame: PiAutomationFrame) => void,
  ): (() => void) | Promise<() => void>;
  /**
   * 能力可选（同款无 id 自发通知通道）：订阅插件耗时操作结果帧
   * （plugin_op_result，见 PiPluginOpFrame）。
   * WS 通道经网关白名单转发（remote.rs broadcast_notification）。
   */
  subscribePluginOps?(
    cb: (frame: PiPluginOpFrame) => void,
  ): (() => void) | Promise<() => void>;
  /**
   * 能力可选（同款无 id 自发通知通道）：订阅上下文读数推送帧
   * （context_changed，见 PiContextChangedFrame，设计文档 §7）。
   * sidecar 轮次收尾点推送，桌面占用环镜像直更；WS 通道经网关
   * 白名单转发（remote.rs broadcast_notification）。
   */
  subscribeContextChanges?(
    cb: (frame: PiContextChangedFrame) => void,
  ): (() => void) | Promise<() => void>;
  /**
   * 能力可选（同款无 id 自发通知通道）：订阅设计主题推送帧
   * （design_themes / design_theme_set，见 PiDesignThemePush）。管理页
   * save/delete 与胶囊 set 后 sidecar 自发；他窗清单/胶囊与远程连接
   * 据此直更（remote.rs 白名单转发）。
   */
  subscribeDesignThemes?(
    cb: (frame: PiDesignThemePush) => void,
  ): (() => void) | Promise<() => void>;
  /** 能力可选（与 subscribeTurns 成对）：当前正在跑 turn 的会话 id 种子清单 */
  listRunning?(): Promise<string[]>;
  /**
   * 能力可选（随 listRunning）：在跑轮次的 {sessionId, requestId} 明细。
   * 运行态事实源（sidecar activeTurns）经此透出请求 id——webview 存储被清/
   * 配额连带导致在飞流登记丢失时，前端据此重建登记并按 requestId attach，
   * 刷新续流不再依赖 sessionStorage 存活。旧后端应答缺 turns 时返回空清单
   * （登记重建降级为仅 localStorage 镜像/最近会话兜底）。
   */
  listRunningTurns?(): Promise<PiRunningTurn[]>;
  /** 中断指定线程的活跃 turn 与其排队消息（缺省 = 全局兜底，停掉一切） */
  abort(threadId?: string): Promise<void>;
  close?(): void;
  /** WS 通道连接状态回调；Tauri 通道恒连接，可不实现 */
  onStatusChange?(cb: (s: PiChannelStatus) => void): () => void;
}

// ---------- 模块级注册表 ----------

let current: PiChannel | null = null;

export function setPiChannel(ch: PiChannel | null) {
  current = ch;
}

/** 只读探测当前注册通道（无兜底副作用）：供卸载延迟销毁判断"注册表还是不是我" */
export function peekPiChannel(): PiChannel | null {
  return current;
}

export function getPiChannel(): PiChannel {
  // 桌面端这里兜底惰性创建 TauriPiChannel；移动端不能——没有 Tauri 宿主，
  // 兜底只会把「还没配对/还没连上」伪装成一个更晚、更难定位的失败。
  // 明确早失败，让调用方（piRequest）把「未连接」如实抛给 UI。
  if (!current) {
    throw new Error("pi-agent 通道尚未就绪：请先完成配对");
  }
  return current;
}
