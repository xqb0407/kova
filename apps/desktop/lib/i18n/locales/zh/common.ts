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
    copyFailed: "复制失败",
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
  /** 文件操作的错误码文案（fsErrorText 用；键 = 主进程短码） */
  fsErrors: {
    cwdNotAllowed: "当前目录不受信任，操作被拒绝",
    badPath: "路径不合法",
    badName: '名称不合法（不能包含 \\ / : * ? " < > |）',
    alreadyExists: "同名文件或文件夹已存在",
    notFound: "目标不存在（可能已被移动或删除）",
    notADirectory: "目标不是文件夹",
    mkdirFailed: "新建文件夹失败",
    writeFailed: "新建文件失败",
    renameFailed: "重命名失败",
    moveFailed: "移动失败",
    deleteFailed: "删除失败",
    openFailed: "打开文件失败",
    revealFailed: "打开系统文件管理器失败",
    notDesktop: "仅桌面端可用",
    badBase64: "内容编码异常，写入被拒绝",
    tooLarge: "内容超过 32MB 上限",
    notSupported: "远程项目暂不支持该操作",
    outsideWorkspace: "路径不在项目目录内",
    fileUnreadable: "文件不存在或不可读",
    homeNotAllowed: "不能把家目录本身设为资料库位置（请选其中的一个文件夹）",
    appDataNotAllowed: "该目录存放应用私有数据，不能设为资料库位置",
    busy: "任务产物正在迁移，请稍候再试",
    fallback: "操作失败",
  },

};
