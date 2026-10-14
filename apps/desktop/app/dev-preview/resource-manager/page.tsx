"use client";

/**
 * 资源管理器版式预览页。
 *
 * 用真实视图组件（ResourceManagerView）配固定数据渲染，不依赖桌面壳 —— 无头浏览器
 * 截图核对 CPU / 内存 / 存储三页的卡片、表格与占比条是否成立。真实数据一律走 IPC，
 * 这里不参与生产路径。
 * `#storage` / `#mem` 可直接落到对应页签（截图脚本用），点击页签同样可切换。
 */

import { useEffect, useState } from "react";
import { ResourceManagerView } from "@/components/resource/resource-manager";
import type { ResourceTab } from "@/lib/resource/types";
import { SAMPLE_FIXTURE, STORAGE_FIXTURE, HISTORY_FIXTURE } from "./fixtures";

const isTab = (value: string): value is ResourceTab =>
  value === "cpu" || value === "mem" || value === "storage";

export default function ResourceManagerPreviewPage() {
  const [tab, setTab] = useState<ResourceTab>("cpu");
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    const apply = () => {
      const hash = window.location.hash.replace("#", "");
      if (isTab(hash)) setTab(hash);
    };
    apply();
    window.addEventListener("hashchange", apply);
    return () => window.removeEventListener("hashchange", apply);
  }, []);

  return (
    <>
      <ResourceManagerView
        desktop
        booting={false}
        tab={tab}
        onTabChange={setTab}
        sample={SAMPLE_FIXTURE}
        sampleError={null}
        history={HISTORY_FIXTURE}
        storage={STORAGE_FIXTURE}
        storageLoading={false}
        storageError={null}
        onRescan={() => setNotice("预览页：真实数据来自 Rust 侧 resource_storage_scan")}
        onClean={() => setNotice("预览页：清理会弹二次确认，不会真的删除")}
        onReveal={(category) =>
          setNotice(`预览页：真实环境会在访达中打开 ${category.paths[0] ?? "该类目"}`)
        }
        cleaningId={null}
        notice={notice}
        expandedGroups={{ core: true, render: true, plugin: true }}
        onToggleGroup={() => {}}
      />
      {/* 样例数据必须一眼可辨：这里列出的进程/目录都是编的，不是本机真实采样。
          贴右下角，不挡内容 */}
      <div className="bg-foreground text-background fixed right-3 bottom-3 z-50 rounded-full px-3 py-1 text-xs font-medium shadow-lg">
        预览页：固定样例数据，非真实采样
      </div>
    </>
  );
}
