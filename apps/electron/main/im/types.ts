/**
 * IM 通道契约：平台适配器接口与消息形状（单一事实源）。
 *
 * 设计：每个 IM 平台一个 adapter 文件实现本契约，路由/访问控制/绑定全部
 * 平台无关。适配器只拥有平台边缘——凭据绑定、入站归一化、出站投递；
 * 平台私有的回复凭据（如微信 context_token）经 replyContext 不透明透传，
 * 不污染通用类型。
 *
 * 多实例是一等公民：一个平台可同时绑定多个 Bot（channelId 区分），
 * 注册表按 (platform, channelId) 精确寻址，绝不跨实例兜底。
 */

export type ImPlatform = "wechat" | "feishu" | "dingtalk" | "wecom";

/** 实时连接状态（设置页状态点与文案） */
export type ImChannelStatus =
  | { state: "unbound"; message?: string }
  | { state: "connecting"; message?: string }
  | { state: "connected"; message?: string }
  | { state: "reauth"; message?: string }
  | { state: "error"; message?: string };

/** 回复颗粒度：standard=正文即时回传；full=正文+工具摘要；digest=整轮一行；live=思考/工具进度实时推送 */
export type ImReplyDetail = "standard" | "full" | "digest" | "live";

/** 适配器启动配置：路由器从通道配置 + secret 解出后传入 */
export interface ImChannelRuntimeConfig {
  channelId: string;
  /** 平台凭据（微信=扫码所得 bot token；secret 解密后明文，仅存内存） */
  credentials: Record<string, string>;
  /** 状态变化上报（连接/断开/需重扫），路由器并入 im_channels_status */
  onStatus: (status: ImChannelStatus) => void;
}

/** 入站消息（适配器归一化后的统一形状；text 已保证非空） */
export interface ImInboundMessage {
  platform: ImPlatform;
  channelId: string;
  /** p2p = 私聊；group = 群聊（微信 iLink 仍只产 p2p） */
  chatType: "p2p" | "group";
  /** 会话锚点：私聊=对方 id，群聊=群 id */
  chatId: string;
  senderId: string;
  /** 群聊发言人昵称（平台提供时带；缺失由 router 脱敏 id 兜底） */
  senderName?: string;
  /**
   * 群聊里是否 @ 了本机器人。适配器负责判定；p2p 不填。
   * 平台只推 @ 消息但载荷没有显式字段时按 true 处理（见各 parser 注释）。
   */
  mentioned?: boolean;
  /** 平台事件 id（去重键）；缺失则跳过去重层 */
  eventId?: string;
  /** 平台消息 id（部分平台资源下载、幂等投递需要） */
  messageId?: string;
  text: string;
  /** 平台私有回复凭据（微信 context_token 等），适配器解释 */
  replyContext?: unknown;
}

/** 出站目标：chatId 必带，replyContext 由适配器在发送时补平台细节 */
export interface ImOutboundTarget {
  chatId: string;
  replyContext?: unknown;
}

export interface ImAdapterStatusResult {
  status: ImChannelStatus;
}

/** 平台适配器契约（每个平台实现一份；生命周期由 manager 编排） */
export interface ImChannelAdapter {
  readonly platform: ImPlatform;
  readonly channelId: string;
  /** 建立连接并开始投递入站消息；重复调用幂等（已启动则 no-op） */
  start(cfg: ImChannelRuntimeConfig, sink: (msg: ImInboundMessage) => void): Promise<void>;
  /** 停止接收与轮询；幂等，停止后可再 start */
  stop(): Promise<void>;
  /** 发送纯文本到目标聊天 */
  sendText(target: ImOutboundTarget, text: string): Promise<void>;
  /** 当前状态快照 */
  status(): ImChannelStatus;
  /**
   * 「对方正在输入」状态（可选）：处理开始时 on(true)，收尾 on(false)。
   * 平台不支持时静默忽略；实现内部自行保活。
   */
  setTyping?(target: ImOutboundTarget, on: boolean): Promise<void>;
}

/** 适配器工厂：注册表按平台实例化（新平台 = 实现 + 工厂一行） */
export type ImAdapterFactory = (channelId: string) => ImChannelAdapter;
