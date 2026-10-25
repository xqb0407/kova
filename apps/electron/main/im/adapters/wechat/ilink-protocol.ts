/**
 * 微信 iLink Bot 协议 wire 类型（按协议事实声明本实现所需的字段子集；
 * JSON 传输，byte 字段为 base64 字符串）。非公开接口：形状可能随微信
 * 版本调整，变更时只改本文件与 ilink-client 的编解码。
 */

/** 消息条目类型（item.type） */
export const MESSAGE_ITEM_TYPE = {
  TEXT: 1,
  IMAGE: 2,
  VOICE: 3,
  FILE: 4,
  VIDEO: 5,
} as const;

/** 消息方向：USER=对方发来，BOT=本 bot 发出（回环，必须过滤） */
export const MESSAGE_TYPE = { USER: 1, BOT: 2 } as const;

/** 消息状态：长轮询会推同一 message_id 的多次状态更新，只投 FINISH */
export const MESSAGE_STATE = { NEW: 0, GENERATING: 1, FINISH: 2 } as const;

export interface IlinkTextItem {
  text?: string;
}

export interface IlinkMessageItem {
  type?: number;
  msg_id?: string;
  text_item?: IlinkTextItem;
}

/** 统一收发消息形状 */
export interface IlinkMessage {
  seq?: number;
  /** 平台消息 id（可能超出 Number 安全整数：保持字符串，勿数值化） */
  message_id?: string | number;
  from_user_id?: string;
  to_user_id?: string;
  /** 服务端事件时间（ms 纪元）；旧消息丢弃判定用（seq 是序号不是时间） */
  create_time_ms?: number;
  message_type?: number;
  message_state?: number;
  item_list?: IlinkMessageItem[];
  /** 回复必须原样回传 */
  context_token?: string;
  /** 客户端归一后的纯文本（normalizeMessage 填充） */
  text?: string;
}

/* ------------------------------ GetUpdates（长轮询） ------------------------------ */

export interface IlinkGetUpdatesReq {
  /** 服务端游标：首请求空串，之后回传上一响应的 get_updates_buf */
  get_updates_buf?: string;
}

export interface IlinkGetUpdatesResp {
  ret?: number;
  errcode?: number;
  errmsg?: string;
  msgs?: IlinkMessage[];
  get_updates_buf?: string;
  /** 服务端建议的下一次长轮询时长（ms） */
  longpolling_timeout_ms?: number;
}

/* ------------------------------ SendMessage ------------------------------ */

export interface IlinkSendMessageResp {
  ret?: number;
  errcode?: number;
  errmsg?: string;
}

/* ------------------------------ 扫码登录 ------------------------------ */

export interface IlinkQrcodeResp {
  ret?: number;
  errcode?: number;
  errmsg?: string;
  /** 二维码票据（状态轮询 key） */
  qrcode?: string;
  /** 二维码内容串（URL 形式，前端本地渲染成二维码；不是图片 base64） */
  qrcode_img_content?: string;
}

export type IlinkQrcodeStatus =
  | "wait"
  | "scaned"
  | "confirmed"
  | "expired"
  /** IDC 重定向：带 redirect_host，下一轮改连新主机 */
  | "scaned_but_redirect"
  /** 需要在手机上输入数字验证码（verify_code 随下一轮状态请求提交） */
  | "need_verifycode"
  /** 验证码多次错误，被限流 */
  | "verify_code_blocked"
  /** 该 bot 已绑定过同一实例，无需重复连接 */
  | "binded_redirect";

export interface IlinkQrcodeStatusResp {
  ret?: number;
  errcode?: number;
  errmsg?: string;
  status?: IlinkQrcodeStatus | string;
  /** confirmed 时下发 */
  bot_token?: string;
  ilink_bot_id?: string;
  /** 会话基址（后续 CGI 走它） */
  baseurl?: string;
  ilink_user_id?: string;
  /** scaned_but_redirect 时的新主机名（需补 https://） */
  redirect_host?: string;
}

/** 通用应答兜底 */
export interface IlinkCommonResp {
  ret?: number;
  errcode?: number;
  errmsg?: string;
  [key: string]: unknown;
}
