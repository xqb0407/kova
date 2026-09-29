/**
 * 主题引用完整性修复（改名 / 删除 / 升级剪旧三条变更路径共用一个入口）。
 *
 * 主题的事实引用面有三处：sessions.design_theme 列（含未驻留会话）、驻留
 * Running.designTheme、「最近使用」kv。只清驻留 run 会让未驻留会话下次物化
 * 时命中悬空 ref（恢复链回落最近使用、胶囊回显旧 id），升级删内置时更是全表
 * 都可能中招——本模块扫描改写到 {scope,id} 精确相等的一切引用。
 * 落库 fire-and-forget（persistModePrefs 同款容错，DB 失败仅日志）；驻留 run
 * 只改字段，提示词重排由调用方按既有节奏做（set 重排单会话、save/delete 全量）。
 */
import { running } from "../sessions/registry";
import { sessionList, sessionPrefsSet } from "../storage/hostdb";
import { logErr } from "../log";
import {
  decodeThemeColumn,
  encodeThemeColumn,
  getLastUsedDesignTheme,
  setLastUsedDesignTheme,
} from "./state";
import type { ThemeRef } from "./store";

function sameRef(a: ThemeRef | null | undefined, b: ThemeRef): boolean {
  return !!a && a.scope === b.scope && a.id === b.id;
}

/** 被重映射波及的驻留会话（调用方据此推 design_theme_set 通知帧给其它窗口） */
export type RemappedThread = {
  threadId: string;
  sessionId: string;
  theme: ThemeRef | null;
};

/**
 * 把指向 from 的一切引用改写为 to（null = 显式"不使用主题"，落 ""，
 * 不让恢复链悄悄回落到别的主题）。rename 场景 to 传新 ref，保持用户
 * 正在用的主题连续；"最近使用"恰好指向旧 ref 时一并跟齐。
 * 返回驻留 run 中被改的会话（未驻留的靠偏好列 + 下次水合自然跟齐，无需推送）。
 */
export async function remapThemeRefs(from: ThemeRef, to: ThemeRef | null): Promise<RemappedThread[]> {
  const toJson = encodeThemeColumn(to);
  try {
    // 会话偏好列扫描：解码后按 {scope,id} 比对（不做 JSON 串精确匹配，
    // 容忍历史键序/空白差异写进去的等值引用）
    for (const row of await sessionList()) {
      if (sameRef(decodeThemeColumn(row.designTheme), from)) {
        void sessionPrefsSet(row.id, {
          designTheme: toJson,
        }).catch((err) => logErr("design-md: remap session prefs failed:", row.id, err));
      }
    }
  } catch (err) {
    logErr("design-md: remap scan failed:", err);
  }
  const changed: RemappedThread[] = [];
  for (const run of running.values()) {
    if (sameRef(run.designTheme, from)) {
      run.designTheme = to;
      changed.push({ threadId: run.threadId, sessionId: run.sessionId, theme: to });
    }
  }
  if (sameRef(getLastUsedDesignTheme(), from)) {
    await setLastUsedDesignTheme(to);
  }
  return changed;
}

/** 升级剪旧清理：被新主题包移除的内置 slug，逐个把引用收口为"不使用主题" */
export async function clearRemovedBuiltinThemes(slugs: string[]): Promise<void> {
  for (const slug of slugs) {
    await remapThemeRefs({ scope: "builtin", id: slug }, null);
  }
}
