/**
 * Office · 表格视图（Univer Sheets OSS）：聚合外壳的 sheet 引擎视图。
 * 桥为多播（外壳统一 attach/requestDoc）：本视图只消费 `.sheet.univer.json`
 * 的 doc.open，自带冲突框与「问AI/导出CSV」动作；卸载时释放 Univer 引擎
 * （容器随 React 分离，重挂必须重新引导）。
 * 文档 = 工作区里 `<名称>.sheet.univer.json`（Univer 工作簿快照），agent 直接
 * read/write；命令→序列化去重→doc.change 由宿主防抖写盘。
 */
import { type FC, useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeftIcon, DownloadIcon, SparklesIcon, TriangleAlertIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { bridge, bytesToBase64 } from "@/bridge";
import { workbookToCsv } from "./csv";
import { exportSnapshotToXlsx } from "./xlsx-bridge";
import { bootUniver, currentSnapshot, disposeEngine, loadWorkbook, onEngineChange, syncTheme } from "./univer";

/** 本视图认领的后缀（与宿主 opens glob 同域） */
const PATH_RE = /\.sheet\.univer\.json$/i;

function baseName(path: string): string {
  return (path.split("/").pop() ?? path).replace(PATH_RE, "");
}

export const SheetView: FC<{ fileRel: string; onHome: () => void }> = ({ fileRel, onHome }) => {
  /** 本地有未落盘（未收到 doc.saved 回执）的编辑 */
  const dirtyRef = useRef(false);
  /** 外部更新与本地编辑冲突：挂起外部内容等用户裁决 */
  const [conflict, setConflict] = useState<string | null>(null);
  const [bootError, setBootError] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const bootedRef = useRef(false);
  const univerApiRef = useRef<ReturnType<typeof bootUniver> | null>(null);

  const notify = useCallback((text: string, level: "info" | "error" = "info") => {
    bridge.notify(text, level);
  }, []);

  useEffect(() => {
    // 引擎侧已做序列化去重：只有内容真变化才回调，这里直接上报。
    // fromCalc（载入后计算值回填）是派生数据，不算用户编辑——不标 dirty，
    // 避免随后 agent 改档时误触冲突框。
    onEngineChange((snapshot, meta) => {
      if (!meta.fromCalc) dirtyRef.current = true;
      bridge.change(snapshot);
    });
  }, []);

  useEffect(() => {
    const detach = bridge.attach({
      onHandshake: (theme) => syncTheme(theme === "dark"),
      onDocOpen: (rev, json, external, path) => {
        void rev;
        // 多播：只消费本后缀的帧（外壳保证挂载本视图时绑定的是表格档）
        if (!path || !PATH_RE.test(path)) return;
        if (!external) {
          applyJson(json);
          return;
        }
        // 外部更新（agent/手改落盘）：本地未落盘 → 冲突挂起，否则直接换
        if (dirtyRef.current) {
          setConflict(json);
          return;
        }
        applyJson(json);
      },
      onSaved: () => {
        dirtyRef.current = false;
      },
      onDocError: (text) => notify(text, "error"),
      onTheme: (theme) => syncTheme(theme === "dark"),
      onAssetReply: () => {},
    });
    // 挂载时宿主可能已派发过当前档的 doc.open（多播错过）：主动请求重推一次
    bridge.requestDoc();
    return () => {
      detach();
      disposeEngine();
    };
    // applyJson 恒定引用（notify 为 useCallback([])）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* 载入快照进引擎（首次载入时引导 Univer；容器常驻本视图挂载期） */
  const applyJson = useCallback(
    (json: string): boolean => {
      if (!bootedRef.current) {
        const container = containerRef.current;
        if (!container) return false;
        try {
          univerApiRef.current = bootUniver(container);
          bootedRef.current = true;
        } catch (err) {
          setBootError(err instanceof Error ? err.message : String(err));
          return false;
        }
      }
      const api = univerApiRef.current;
      if (!api) return false;
      const res = loadWorkbook(api, json);
      if (!res.ok) notify(res.errorText, "error");
      return res.ok;
    },
    [notify],
  );

  const resolveConflict = useCallback(
    (choice: "reload" | "keep") => {
      const json = conflict;
      setConflict(null);
      if (!json) return;
      if (choice === "reload") {
        dirtyRef.current = false;
        applyJson(json);
      }
      // keep：保留本地编辑（之后的落盘会覆盖外部内容），不做任何事
    },
    [conflict, applyJson],
  );

  const exportCsv = useCallback(() => {
    const snapshot = currentSnapshot();
    if (snapshot === null) {
      notify("尚未载入文档", "error");
      return;
    }
    try {
      const csv = workbookToCsv(JSON.parse(snapshot));
      bridge.exportFile(`${baseName(fileRel)}.csv`, bytesToBase64(new TextEncoder().encode(csv)));
      notify("CSV 已导出");
    } catch (err) {
      notify(`导出失败：${err instanceof Error ? err.message : String(err)}`, "error");
    }
  }, [fileRel, notify]);

  const exportXlsx = useCallback(() => {
    const snapshot = currentSnapshot();
    if (snapshot === null) {
      notify("尚未载入文档", "error");
      return;
    }
    void (async () => {
      try {
        const bytes = await exportSnapshotToXlsx(JSON.parse(snapshot));
        bridge.exportFile(`${baseName(fileRel)}.xlsx`, bytesToBase64(bytes));
        notify("xlsx 已导出（值 + 公式 + 样式，可在 Excel/WPS 打开）");
      } catch (err) {
        notify(`导出失败：${err instanceof Error ? err.message : String(err)}`, "error");
      }
    })();
  }, [fileRel, notify]);

  const askAi = useCallback(() => {
    let where = "";
    try {
      const wb = univerApiRef.current?.getActiveWorkbook();
      const addr = wb?.getActiveRange()?.getA1Notation(true);
      if (addr) where = `（当前选中 ${addr}）`;
    } catch {
      // 选区取不到就只带文档路径
    }
    bridge.prefill(
      `请帮我处理表格文档 ${fileRel}${where}：先 read 最新内容再 edit，保持快照格式合法。`,
    );
  }, [fileRel]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-10 shrink-0 items-center gap-1 border-b border-border/60 px-2">
        <Button variant="ghost" size="sm" className="gap-1.5 text-muted-foreground" onClick={onHome}>
          <ArrowLeftIcon className="size-4" />
          全部文档
        </Button>
        <div className="mx-1 min-w-0 truncate text-sm font-medium" title={fileRel}>
          {baseName(fileRel)}
        </div>
        <div className="flex-1" />
        <Button variant="ghost" size="sm" className="gap-1.5 text-muted-foreground" onClick={askAi}>
          <SparklesIcon className="size-4" />
          问 AI
        </Button>
        <Button variant="ghost" size="sm" className="gap-1.5 text-muted-foreground" onClick={exportCsv}>
          <DownloadIcon className="size-4" />
          CSV
        </Button>
        <Button variant="ghost" size="sm" className="gap-1.5 text-muted-foreground" onClick={exportXlsx}>
          <DownloadIcon className="size-4" />
          xlsx
        </Button>
      </div>
      <div className="relative min-h-0 flex-1">
        <div ref={containerRef} className="absolute inset-0" />
        {bootError ? (
          <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-2 bg-background p-6 text-center">
            <TriangleAlertIcon className="size-6 text-destructive" />
            <div className="text-sm font-medium">表格引擎启动失败</div>
            <div className="max-w-md text-xs text-muted-foreground">{bootError}</div>
          </div>
        ) : null}
      </div>

      <Dialog open={conflict !== null} onOpenChange={(open) => !open && resolveConflict("keep")}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>外部修改与本地编辑冲突</DialogTitle>
            <DialogDescription>
              agent 或其他端更新了这份表格，而本面板还有未落盘的编辑。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => resolveConflict("keep")}>
              保留本地编辑
            </Button>
            <Button size="sm" onClick={() => resolveConflict("reload")}>
              放弃本地并刷新
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};
