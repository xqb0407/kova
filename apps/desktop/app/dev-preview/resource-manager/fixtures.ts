/**
 * dev-preview 预览页的固定数据（形状与 Electron 主进程 main/resource.ts 的
 * resourceSample / resourceStorageScan 返回值一致，见 lib/resource/types.ts）。
 *
 * 预览页只用于在没有桌面壳的浏览器里核对版式——真实数据一律走 IPC，这里不参与
 * 生产路径（页面自身也只挂在 /dev-preview 下）。组 id 与类目 id 必须跟
 * main/resource.ts 保持同步，否则图标映射与默认展开状态会对不上真实界面。
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
  processCount: 10,
  groups: [
    {
      id: "kova",
      label: "Kova 应用",
      count: 5,
      cpu: 5.4,
      mem: 5.9 * GB,
      processes: [
        { pid: 33070, name: "主进程", detail: "browser", cpu: 3.7, mem: 1.1 * GB },
        { pid: 33071, name: "渲染进程", detail: "tab", cpu: 1.4, mem: 1.4 * GB },
        { pid: 33072, name: "渲染进程", detail: "tab", cpu: 0.1, mem: 0.9 * GB },
        { pid: 33073, name: "GPU 进程", detail: "gpu-process", cpu: 0.2, mem: 1.2 * GB },
        { pid: 33074, name: "服务进程", detail: "utility", cpu: 0.0, mem: 1.3 * GB },
      ],
    },
    {
      id: "pi-agent",
      label: "AI 运行时",
      count: 1,
      cpu: 0.1,
      mem: 0.4 * GB,
      processes: [
        {
          pid: 33140,
          name: "node",
          detail: "/usr/local/bin/node .../pi-agent-sidecar/dist/index.js",
          cpu: 0.1,
          mem: 0.4 * GB,
        },
      ],
    },
    {
      id: "tools",
      label: "终端与工具进程",
      count: 4,
      cpu: 0.3,
      mem: 0.9 * GB,
      processes: [
        { pid: 3176, name: "zsh", detail: "/bin/zsh -l", cpu: 0.1, mem: 0.1 * GB },
        { pid: 3180, name: "Chromium", detail: "Chromium --headless=new", cpu: 0.2, mem: 0.6 * GB },
        { pid: 39526, name: "git", detail: "/usr/bin/git status --porcelain", cpu: 0.0, mem: 0.1 * GB },
        { pid: 52991, name: "node", detail: "/usr/local/bin/node", cpu: 0.0, mem: 0.1 * GB },
      ],
    },
  ],
};

const categories: Category[] = [
  {
    id: "sessions",
    label: "会话记录",
    hint: "对话转录与索引（sessions/*.jsonl + state.db）",
    bytes: 1.4 * GB,
    // 真机上这类目会同时命中一个超长名（state.db 的定时备份），长度差异极大——
    // 路径列的对齐问题正是在这种数据下才暴露的，夹具必须保留这个形状
    paths: [
      "~/Library/Application Support/com.kova.assistant/sessions",
      "~/Library/Application Support/com.kova.assistant/state.db.bak-2026-09-30T14-10-46-234Z-shm",
    ],
    cleanable: false,
  },
  {
    id: "workspace",
    label: "任务产物",
    hint: "无目录任务的产物文件（task-workspace/）",
    bytes: 979 * MB,
    paths: ["~/Library/Application Support/com.kova.assistant/task-workspace"],
    cleanable: false,
  },
  {
    id: "attachments",
    label: "文档附件",
    hint: "粘贴文档中转副本（attachments/）",
    bytes: 246 * MB,
    paths: ["~/Library/Application Support/com.kova.assistant/attachments"],
    cleanable: false,
  },
  {
    id: "checkpoints",
    label: "Git 检查点",
    hint: "影子 git-dir 检查点（checkpoints/）",
    bytes: 245 * MB,
    paths: ["~/Library/Application Support/com.kova.assistant/checkpoints"],
    cleanable: false,
  },
  {
    id: "logs",
    label: "磁盘日志",
    hint: "按日归档日志目录",
    bytes: 466 * MB,
    paths: ["~/Library/Logs/com.kova.assistant"],
    cleanable: true,
  },
  {
    id: "browser-cache",
    label: "浏览器缓存",
    hint: "面板浏览器渲染缓存",
    bytes: 12.4 * MB,
    paths: ["~/Library/Application Support/com.kova.assistant/browser-panel"],
    cleanable: true,
  },
  {
    id: "model-cache",
    label: "模型调用缓存",
    hint: "请求级缓存（~/.kova cache）",
    bytes: 64.2 * MB,
    paths: ["~/.kova/cache"],
    cleanable: true,
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
