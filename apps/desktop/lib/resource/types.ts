/**
 * 资源管理器的数据契约：与 Electron 主进程 `main/resource.ts` 的返回值结构一致
 * （沿用原 Rust 宿主 resource.rs 的 camelCase 形状）。字段改名要与主进程同改，
 * 否则前端拿到 undefined 而不是报错。
 */

/** 页签：CPU / 内存 / 存储 */
export type ResourceTab = "cpu" | "mem" | "storage";

/** 单个进程：CPU 与内存都是"占整机"的量纲（主进程已按核数归一化） */
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

/** 扫描进度（主进程逐类目回推）：done/total 是已完成类目的计数 */
export type StorageProgress = {
  done: number;
  total: number;
  category: Category;
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
