/**
 * dev-preview 预览页的固定数据（形状与 Rust 侧 `resource_sample` /
 * `resource_storage_scan` 的返回值一致，见 lib/resource/types.ts）。
 *
 * 预览页只用于在没有桌面壳的浏览器里核对版式——真实数据一律走 IPC，这里不参与
 * 生产路径（页面自身也只挂在 /dev-preview 下）。
 */

import type { Category, Sample, Storage } from "@/lib/resource/types";

const MB = 1024 * 1024;
const GB = 1024 * MB;

/** 固定时刻（不用 Date.now()）：示例数据在服务端预渲染与客户端注水时必须一致 */
const FIXTURE_TS = Date.UTC(2026, 9, 12, 13, 6);

export const SAMPLE_FIXTURE: Sample = {
  tsMs: FIXTURE_TS,
  appName: "Kova",
  cpuCount: 10,
  appCpu: 5.5,
  appMem: 8.2 * GB,
  sysCpu: 30.4,
  sysMemUsed: 62 * GB,
  sysMemTotal: 64 * GB,
  processCount: 16,
  groups: [
    {
      id: "core",
      label: "基础服务",
      count: 5,
      cpu: 5.4,
      mem: 5.9 * GB,
      processes: [
        { pid: 33070, name: "Kova 主进程", detail: "/Applications/Kova.app/Contents/MacOS/kova", cpu: 3.7, mem: 1.1 * GB },
        { pid: 33074, name: "kova-worker 运行时", detail: "/Applications/Kova.app/Contents/Resources/binaries/kova-worker", cpu: 1.4, mem: 1.4 * GB },
        { pid: 33073, name: "网络进程", detail: "com.apple.WebKit.Networking", cpu: 0.1, mem: 0.9 * GB },
        { pid: 33071, name: "GPU 进程", detail: "com.apple.WebKit.GPU", cpu: 0.2, mem: 1.2 * GB },
        { pid: 33120, name: "WebKit 辅助进程", detail: "com.apple.WebKit.WebContent", cpu: 0.0, mem: 1.3 * GB },
      ],
    },
    {
      id: "render",
      label: "窗口与渲染",
      count: 2,
      cpu: 0.2,
      mem: 0.8 * GB,
      processes: [
        { pid: 33072, name: "渲染进程", detail: "com.apple.WebKit.WebContent", cpu: 0.1, mem: 0.5 * GB },
        { pid: 42811, name: "渲染进程", detail: "com.apple.WebKit.WebContent", cpu: 0.1, mem: 0.3 * GB },
      ],
    },
    {
      id: "plugin",
      label: "插件与扩展",
      count: 2,
      cpu: 0.1,
      mem: 0.6 * GB,
      processes: [
        { pid: 46977, name: "插件进程", detail: "/usr/local/bin/node ~/.kova/plugins/demo/index.js", cpu: 0.1, mem: 0.4 * GB },
        { pid: 46981, name: "插件进程", detail: "/usr/local/bin/bun ~/.kova/plugins/office/index.ts", cpu: 0.0, mem: 0.2 * GB },
      ],
    },
    {
      id: "terminal",
      label: "终端与工具",
      count: 7,
      cpu: 0.3,
      mem: 0.9 * GB,
      processes: [
        { pid: 3176, name: "终端 zsh", detail: "/bin/zsh -l", cpu: 0.1, mem: 0.1 * GB },
        { pid: 3180, name: "无头浏览器", detail: "Chromium --headless=new", cpu: 0.2, mem: 0.6 * GB },
        { pid: 39526, name: "git 进程", detail: "/usr/bin/git status --porcelain", cpu: 0.0, mem: 0.1 * GB },
        { pid: 52991, name: "node 进程", detail: "/usr/local/bin/node", cpu: 0.0, mem: 0.1 * GB },
      ],
    },
  ],
};

const categories: Category[] = [
  {
    id: "sessions",
    label: "会话记录与数据库",
    hint: "state.db 与 sessions/*.jsonl：聊天记录本身，不可清理",
    bytes: 1.4 * GB,
    // 真机上这类目会同时命中一个超长名（state.db 的定时备份），长度差异极大——
    // 路径列的对齐问题正是在这种数据下才暴露的，夹具必须保留这个形状
    paths: [
      "~/Library/Application Support/com.kova.assistant/state.db",
      "~/Library/Application Support/com.kova.assistant/state.db.bak-2026-09-30T14-10-46-234Z-shm",
      "~/Library/Application Support/com.kova.assistant/state.db-wal",
      "~/Library/Application Support/com.kova.assistant/sessions",
    ],
    cleanable: false,
  },
  {
    id: "workspace",
    label: "工作区与附件",
    hint: "agent 任务产物与暂存的粘贴附件",
    bytes: 979 * MB,
    paths: ["~/Library/Application Support/com.kova.assistant/task-workspace"],
    cleanable: false,
  },
  {
    id: "logs",
    label: "日志与崩溃报告",
    hint: "按天分目录的应用 / kova-worker / 网页日志",
    bytes: 466 * MB,
    paths: ["~/Library/Logs/com.kova.assistant"],
    cleanable: true,
  },
  {
    id: "plugins",
    label: "插件、技能与设计主题",
    hint: "内置/社区插件、技能与设计主题的本地副本",
    bytes: 376 * MB,
    paths: ["~/Library/Application Support/com.kova.assistant/plugins", "~/.kova/plugins"],
    cleanable: false,
  },
  {
    id: "checkpoints",
    label: "检查点（影子 Git）",
    hint: "代码检查点的对象库，删掉将无法回滚到历史检查点",
    bytes: 245 * MB,
    paths: ["~/Library/Application Support/com.kova.assistant/checkpoints"],
    cleanable: false,
  },
  {
    id: "model-cache",
    label: "模型调用轨迹与缓存",
    hint: "MCP 工具清单缓存与调用审计（不含聊天记录）",
    bytes: 64.2 * MB,
    paths: ["~/.kova/mcp-cache.json", "~/.kova/mcp-audit.jsonl"],
    cleanable: true,
  },
  {
    id: "browser-cache",
    label: "浏览器渲染缓存",
    hint: "内置浏览器面板的站点数据与缓存，删掉只是重新登录",
    bytes: 12.4 * MB,
    paths: ["~/Library/Application Support/com.kova.assistant/browser-panel"],
    cleanable: true,
  },
  {
    id: "memory",
    label: "记忆与知识",
    hint: "长期记忆与设计主题文档",
    bytes: 2.7 * MB,
    paths: ["~/.kova/memory", "~/.kova/design-md"],
    cleanable: false,
  },
  {
    id: "config",
    label: "配置与凭据",
    hint: "密钥、MCP 配置、规则与人格文件",
    bytes: 1.1 * MB,
    paths: ["~/Library/Application Support/com.kova.assistant/master.dev.key", "~/.kova/mcp.json"],
    cleanable: false,
  },
  {
    id: "other",
    label: "其他",
    hint: "未被上面归类到的小文件",
    bytes: 1.6 * MB,
    paths: ["~/Library/Application Support/com.kova.assistant/pending-restore.json"],
    cleanable: false,
  },
];

export const STORAGE_FIXTURE: Storage = {
  tsMs: FIXTURE_TS,
  appName: "Kova",
  dataDir: "~/Library/Application Support/com.kova.assistant",
  totalBytes: categories.reduce((sum, c) => sum + c.bytes, 0),
  truncated: false,
  disk: { mount: "/", total: 460 * GB, free: 102 * GB },
  categories,
};

/** 顶部磁贴的走势样例：固定算式生成（不用 Math.random，保证注水一致） */
export const HISTORY_FIXTURE = {
  appCpu: Array.from({ length: 40 }, (_, i) => 4 + 3 * Math.sin(i / 3) + (i % 7 === 0 ? 3 : 0)),
  sysCpu: Array.from({ length: 40 }, (_, i) => 30 + 8 * Math.sin(i / 5 + 1)),
};
