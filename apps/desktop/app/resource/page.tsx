"use client";

/**
 * 资源管理器窗口的页面（Tauri 独立窗口 label=resource 加载本路由）。
 *
 * 取数全在容器里，视图组件只负责画（同一份视图给 dev-preview 预览页复用，见
 * components/resource/resource-manager.tsx 的注释）：
 * - 进程快照每 2s 拉一次，只在 CPU / 内存页拉；窗口不可见时跳过这一拍。
 *   Rust 侧的 CPU 是两次刷新之间的差值，2s 落在 sysinfo 要求的最小间隔之上。
 * - 存储扫描按需触发（进存储页自动扫一次，"重新计算"可手动重扫），带预算上限，
 *   所以有独立的 loading / 错误态。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { ResourceManagerView } from "@/components/resource/resource-manager";
import {
  cleanStorage,
  fetchSample,
  fetchStorage,
  hasResourceSource,
  revealPath,
} from "@/lib/resource/api";
import { formatBytes } from "@/lib/resource/format";
import type { Category, ResourceTab, Sample, Storage } from "@/lib/resource/types";

/** 采样间隔：肉眼够顺滑，又不会让 sysinfo 的差值小到读不出 CPU */
const SAMPLE_INTERVAL_MS = 2000;

/** 清理确认文案：按类目说明到底删了什么、有什么后果 */
const CLEAN_PROMPT: Record<string, string> = {
  logs: "将删除今天以前的全部日志目录（当天日志保留，正在写的那份不动）。",
  "browser-cache": "将清空内置浏览器的站点数据与缓存，相关网站需要重新登录。",
  "model-cache": "将删除 MCP 工具清单缓存与调用审计记录，不含任何聊天记录。",
};

export default function ResourcePage() {
  // 运行环境必须在**挂载后**再判定：服务端预渲染时 isTauri() 必然为 false，
  // 若在渲染期直接用它，桌面窗口注水时首帧与 HTML 不一致（React 会丢掉服务端
  // HTML 改走客户端整树渲染，控制台报 "Encountered a script tag while rendering"
  // 一类的注水错误）。null = 尚未判定。
  const [desktop, setDesktop] = useState<boolean | null>(null);
  const [tab, setTab] = useState<ResourceTab>("cpu");
  const [sample, setSample] = useState<Sample | null>(null);
  const [sampleError, setSampleError] = useState<string | null>(null);
  const [storage, setStorage] = useState<Storage | null>(null);
  const [storageLoading, setStorageLoading] = useState(false);
  const [storageError, setStorageError] = useState<string | null>(null);
  const [cleaningId, setCleaningId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pendingClean, setPendingClean] = useState<Category | null>(null);
  // CPU 采样历史（顶部磁贴的走势）：只留最近 40 拍（2s 一拍 ≈ 80 秒）
  const [history, setHistory] = useState<{ appCpu: number[]; sysCpu: number[] }>({
    appCpu: [],
    sysCpu: [],
  });
  // 默认展开应用自身服务；工具类进程（终端/git/node/无头浏览器…）默认折起——
  // 智能体猛跑工具时那一组能到几十个进程，展开会把服务本身挤下去
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>({
    core: true,
    render: true,
    plugin: true,
  });
  const rescanning = useRef(false);

  // 窗口标题：原生标题栏由 Rust 侧设置，这里管住 HTML 标题（任务管理器 / 截图工具看这个）
  useEffect(() => {
    document.title = "资源管理器";
  }, []);

  // 环境判定：与上面注释同一件事，放在 effect 里保证首帧与预渲染 HTML 一致
  useEffect(() => {
    setDesktop(hasResourceSource());
  }, []);

  useEffect(() => {
    if (desktop !== true || tab === "storage") return;
    let cancelled = false;
    const tick = async () => {
      if (document.visibilityState !== "visible") return;
      try {
        const next = await fetchSample();
        if (cancelled || !next) return;
        setSample(next);
        setSampleError(null);
        setHistory((prev) => ({
          appCpu: [...prev.appCpu, next.appCpu].slice(-40),
          sysCpu: [...prev.sysCpu, next.sysCpu].slice(-40),
        }));
      } catch (err) {
        if (!cancelled) setSampleError(err instanceof Error ? err.message : String(err));
      }
    };
    void tick();
    const timer = setInterval(() => void tick(), SAMPLE_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [desktop, tab]);

  const rescan = useCallback(async () => {
    if (rescanning.current) return;
    rescanning.current = true;
    setStorageLoading(true);
    try {
      const next = await fetchStorage();
      if (next) {
        setStorage(next);
        setStorageError(null);
      }
    } catch (err) {
      setStorageError(err instanceof Error ? err.message : String(err));
    } finally {
      rescanning.current = false;
      setStorageLoading(false);
    }
  }, []);

  // 进存储页自动扫一次。失败不自动重试（storageError 非空即停），
  // 否则一个必然失败的扫描会变成每帧一轮
  useEffect(() => {
    if (desktop !== true || tab !== "storage" || storage || storageError || storageLoading) return;
    void rescan();
  }, [desktop, tab, storage, storageError, storageLoading, rescan]);

  const runClean = useCallback(async () => {
    const category = pendingClean;
    if (!category) return;
    setPendingClean(null);
    setCleaningId(category.id);
    setNotice(null);
    try {
      const result = await cleanStorage([category.id]);
      const entry = result?.entries.find((e) => e.id === category.id);
      const freed = entry?.freedBytes ?? result?.freedBytes ?? 0;
      const failed = entry?.failed.length ?? 0;
      const parts = [`${category.label}：已释放 ${formatBytes(freed)}`];
      if (failed > 0) parts.push(`${failed} 项未能删除（可能正被占用）`);
      if (result?.warnings.length) parts.push(result.warnings[0]);
      setNotice(parts.join("；"));
      // 清理完立刻重算：卡片里的数字必须跟着动，否则用户会以为没生效
      await rescan();
    } catch (err) {
      setStorageError(err instanceof Error ? err.message : String(err));
    } finally {
      setCleaningId(null);
    }
  }, [pendingClean, rescan]);

  const toggleGroup = useCallback((id: string) => {
    setExpandedGroups((prev) => ({ ...prev, [id]: !prev[id] }));
  }, []);

  /** 在文件管理器里定位类目路径（Rust 侧只放行本应用自己的数据根） */
  const revealCategory = useCallback(async (category: Category) => {
    const path = category.paths[0];
    if (!path) return;
    try {
      await revealPath(path);
    } catch (err) {
      setStorageError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  return (
    <>
      <ResourceManagerView
        desktop={desktop === true}
        booting={desktop === null}
        tab={tab}
        onTabChange={setTab}
        sample={sample}
        sampleError={sampleError}
        history={history}
        storage={storage}
        storageLoading={storageLoading}
        storageError={storageError}
        onRescan={() => void rescan()}
        onClean={setPendingClean}
        onReveal={(category) => void revealCategory(category)}
        cleaningId={cleaningId}
        notice={notice}
        expandedGroups={expandedGroups}
        onToggleGroup={toggleGroup}
      />

      <AlertDialog
        open={pendingClean !== null}
        onOpenChange={(open) => {
          if (!open) setPendingClean(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>清理「{pendingClean?.label ?? ""}」？</AlertDialogTitle>
            <AlertDialogDescription>
              {CLEAN_PROMPT[pendingClean?.id ?? ""] ?? "此操作无法撤销。"}
              {pendingClean && pendingClean.bytes > 0
                ? `预计释放 ${formatBytes(pendingClean.bytes)}。`
                : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel size="default">取消</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              size="default"
              onClick={() => {
                void runClean();
              }}
            >
              清理
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
