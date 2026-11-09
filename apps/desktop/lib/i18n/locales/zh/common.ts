/**
 * 中文词典（事实源）：通用小词。英文版 en/common.ts 以 `typeof zhCommon`
 * 对齐形状——漏 key、多 key 直接编译报错。
 *
 * 注意：这里**不加** as const——加上后值会收窄成字面量类型，英文词典就不得
 * 逐字重复中文了；不加则叶子类型放宽为 string，正是镜像校验想要的。
 *
 * 约定：只收用户可见文案；代码注释、console 日志不进词典。
 * 嵌套对象按功能域再分组，t() 用点路径取值（"common.action.confirm"）。
 */
export const zhCommon = {
  action: {
    confirm: "确定",
    cancel: "取消",
    save: "保存",
    close: "关闭",
    done: "完成",
    next: "下一步",
    back: "上一步",
    skipStep: "跳过这一步",
    skip: "跳过",
    retry: "重试",
    copy: "复制",
    copied: "已复制",
    delete: "删除",
    edit: "编辑",
    add: "添加",
    create: "新建",
    open: "打开",
    browse: "浏览",
    search: "搜索",
    loading: "加载中…",
    none: "暂无",
    expand: "展开",
    collapse: "收起",
    more: "更多",
    reset: "恢复默认",
    enable: "开启",
    disable: "关闭",
    apply: "应用",
  },
  state: {
    configured: "已配置",
    notConfigured: "未配置",
    enabled: "已启用",
    disabled: "已停用",
    on: "开",
    off: "关",
    optional: "可选",
    required: "必填",
    default: "默认",
    custom: "自定义",
    unknown: "未知",
    error: "出错了",
    success: "成功",
    failed: "失败",
  },
  lang: {
    label: "语言",
    system: "跟随系统",
    zh: "中文",
    en: "English",
  },
  appMode: {
    code: "编码",
    work: "工作",
    design: "设计",
  },
  newChat: "新对话",
  error: {
    appCrashed: "应用出了点问题",
    reloadWindow: "重新加载窗口",
  },
};
