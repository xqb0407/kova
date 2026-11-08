"use client";

/**
 * 升级通知的客户端形状与展示辅助（真正的检查在 Rust `update.rs`）。
 *
 * 清单托管在 R2：默认 `https://dl.openkova.site/{channel}/latest.json`
 * （preview / stable 两套；自建可用 kv `update.endpoint` 覆盖根地址）。
 * 这里不发起网络请求——命令、节流、忽略状态全在 Rust 侧，避免两处真相。
 */
import { t } from "@/lib/i18n";

export type UpdateInfo = {
  current: string;
  /** 清单里的最新版本（从未查到过 = null） */
  latest: string | null;
  hasUpdate: boolean;
  /** preview | stable */
  channel: string;
  notes: string | null;
  pageUrl: string | null;
  /** 当前平台安装包直链（清单未提供 = null，退回 pageUrl） */
  downloadUrl: string | null;
  /** 上次成功检查的时刻（ms） */
  checkedAt: number | null;
  /** 最新版本已被用户忽略 */
  skipped: boolean;
  autoCheck: boolean;
  fromCache: boolean;
};

/** 上次检查时间：口语化（刚刚 / N 分钟前 / N 小时前 / N 天前） */
export function formatCheckedAt(ts: number | null): string {
  if (!ts) return t("settings.about.neverChecked");
  const diff = Date.now() - ts;
  if (diff < 60_000) return t("settings.about.justNow");
  if (diff < 3_600_000)
    return t("settings.about.minutesAgo", { count: Math.floor(diff / 60_000) });
  if (diff < 86_400_000)
    return t("settings.about.hoursAgo", { count: Math.floor(diff / 3_600_000) });
  return t("settings.about.daysAgo", { count: Math.floor(diff / 86_400_000) });
}

/** 关于页那一行的状态文案 */
export function updateSummary(info: UpdateInfo | null): string {
  if (!info) return t("settings.about.reading");
  const when = formatCheckedAt(info.checkedAt);
  if (!info.latest)
    return t("settings.about.summaryCurrent", { current: info.current, when });
  if (info.hasUpdate && !info.skipped) {
    return t("settings.about.summaryNew", {
      latest: info.latest,
      current: info.current,
      when,
    });
  }
  if (info.hasUpdate && info.skipped) {
    return t("settings.about.summarySkipped", {
      latest: info.latest,
      current: info.current,
    });
  }
  return t("settings.about.summaryUpToDate", { current: info.current, when });
}

/* ------------------------------ 应用内升级 ------------------------------ */

/** 升级下载/安装进度（Rust `update:progress` 事件） */
export type UpdateProgress = {
  /** download | install | done */
  phase: string;
  done: number;
  total: number;
  message: string;
};

export const UPDATE_PROGRESS_EVENT = "update:progress";

/** 进度百分比（总量未知 = null） */
export function progressPct(p: UpdateProgress | null): number | null {
  return p && p.total > 0 ? Math.min(100, Math.round((p.done / p.total) * 100)) : null;
}

/** 阶段文案前缀（关于页进度条用；toast 直接用 message） */
export const UPDATE_PHASE_LABEL: Record<string, string> = {
  download: "settings.about.phaseDownload",
  install: "settings.about.phaseInstall",
  done: "settings.about.phaseDone",
};

/**
 * 应用内升级：调 Rust 的 `update_install`（下载 → 签名校验 → 原地替换），
 * 期间把 `update:progress` 事件转给 onProgress。**成功时应用会自动重启**，
 * 所以正常不会 resolve；失败抛错（该平台没有升级包 / 校验失败 / 下载失败）。
 */
export async function installUpdate(
  onProgress?: (p: UpdateProgress) => void,
): Promise<void> {
  let unlisten: (() => void) | undefined;
  try {
    const [{ invoke }, { listen }] = await Promise.all([
      import("@/desktop-bridge/core"),
      import("@/desktop-bridge/event"),
    ]);
    unlisten = await listen<UpdateProgress>(UPDATE_PROGRESS_EVENT, (e) =>
      onProgress?.(e.payload),
    );
    await invoke("update_install");
  } finally {
    unlisten?.();
  }
}
