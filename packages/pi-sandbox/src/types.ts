/** 沙箱档位：off = 不生成计划；workspace = 写隔离。 */
export const SANDBOX_TIERS = ["off", "workspace"] as const;
export type SandboxTier = (typeof SANDBOX_TIERS)[number];

/** 网络策略：allow / deny。当前只支持整段放行或整段拒绝。 */
export const SANDBOX_NETWORKS = ["allow", "deny"] as const;
export type SandboxNetwork = (typeof SANDBOX_NETWORKS)[number];

/** 沙箱后端不可用时：拒绝执行，或按用户配置允许降级。 */
export const SANDBOX_FALLBACKS = ["deny", "allow"] as const;
export type SandboxFallback = (typeof SANDBOX_FALLBACKS)[number];

export type SandboxConfig = {
  tier: SandboxTier;
  network: SandboxNetwork;
  /** 是否把常见包管理器的缓存目录列为可写（默认允许，否则 npm/pnpm/cargo 安装会失败）。 */
  allowPackageCaches: boolean;
  onUnavailable: SandboxFallback;
};

export type SandboxPlatform = "darwin" | "win32" | "linux" | "other";

/**
 * sidecar 生成、host 消费的纯数据计划。
 * 不包含命令、环境变量或密钥；host 只按这些根做路径/网络裁决。
 */
export type SandboxPlan = {
  version: 1;
  tier: "workspace";
  platform: SandboxPlatform;
  cwd: string;
  /** 默认为空；strict 档预留。workspace 档只使用 denyReadRoots。 */
  readRoots: string[];
  denyReadRoots: string[];
  /** 即使落在写根内也必须拒绝的文件（如本机授权清单，防止 Agent 自己扩权）。 */
  denyWritePaths: string[];
  writeRoots: string[];
  tempRoots: string[];
  cacheRoots: string[];
  network: SandboxNetwork;
  /** 后端不可用时：拒绝执行 / 允许按无沙箱路径执行（仅 darwin 的 Seatbelt 缺失时生效）。 */
  onUnavailable: SandboxFallback;
};
