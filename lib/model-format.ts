/** 上下文窗口大小格式化：1234567 -> 1.2M，128000 -> 128K */
export const fmtContextWindow = (n: number): string => {
  if (n >= 1_000_000) return `${Math.round(n / 100_000) / 10}M`;
  if (n >= 1_000) return `${Math.round(n / 1000)}K`;
  return String(n);
};
