/**
 * 资源管理器的数据契约：与 `src-tauri/src/resource.rs` 的 serde 结构一一对应
 * （Rust 侧统一 `rename_all = "camelCase"`）。字段改名要两边同改，否则前端拿到
 * undefined 而不是报错。
 */

/** 页签：CPU / 内存 / 存储 */
export type ResourceTab = "cpu" | "mem" | "storage";

/** 单个进程：CPU 与内存都是"占整机"的量纲（Rust 侧已按核数归一化） */
export type ProcRow = {
  pid: number;
  /** 友好名（"渲染进程"/"终端 zsh"/"pi-agent 运行时"…） */
  name: string;
  /** 可执行路径或命令行，仅作 tooltip */
  detail: string;
  /** 占整机 CPU 百分比 */
  cpu: number;
  /** 常驻内存字节（RSS 估算） */
  mem: number;
};

export type GroupStat = {
  id: string;
  label: string;
  count: number;
  cpu: number;
  mem: number;
  processes: ProcRow[];
};

export type Sample = {
  tsMs: number;
  appName: string;
  cpuCount: number;
  appCpu: number;
  appMem: number;
  sysCpu: number;
  sysMemUsed: number;
  sysMemTotal: number;
  processCount: number;
  groups: GroupStat[];
};

export type DiskInfo = {
  mount: string;
  total: number;
  free: number;
};

export type Category = {
  id: string;
  label: string;
  hint: string;
  bytes: number;
  paths: string[];
  cleanable: boolean;
};

export type Storage = {
  tsMs: number;
  appName: string;
  dataDir: string;
  totalBytes: number;
  /** 扫描触到预算上限：数字偏小 */
  truncated: boolean;
  disk: DiskInfo;
  categories: Category[];
};

export type CleanEntry = {
  id: string;
  label: string;
  freedBytes: number;
  removed: string[];
  failed: string[];
};

export type CleanResult = {
  freedBytes: number;
  entries: CleanEntry[];
  warnings: string[];
};
