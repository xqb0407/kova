"use client";

/**
 * 远程与 IM 管理页（主区整页视图）：侧边栏「远程」菜单激活时替换聊天区渲染。
 * 页签放在应用顶部 Header 的页面槽位（与资料库/子代理页同款 portal 注入）。
 * 「远程控制」左右布局：左侧 hero 标题 + 配置区（限宽、易读），右侧整块
 * 圆角插画面板；「接入 IM」保持自身的列表/详情两栏。
 */

import { useEffect, useState, type FC } from "react";
import { createPortal } from "react-dom";
import { Segmented } from "@/components/custom-ui/segmented";
import { RemoteSettings } from "@/components/settings/components/remote-settings";
import { ImChannelsPanel } from "@/components/agent-thread/im-channels-panel";
import { useT } from "@/lib/i18n";

export const RemoteView: FC<{ onBackToChat?: () => void }> = () => {
  const t = useT();
  const [tab, setTab] = useState<"remote" | "im">("remote");
  const [headerSlot, setHeaderSlot] = useState<HTMLElement | null>(null);

  useEffect(() => {
    setHeaderSlot(
      document.querySelector<HTMLElement>('[data-slot="page-header-actions"]'),
    );
  }, []);

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <div className="mx-auto flex w-full  flex-col px-8 pt-8 pb-10">
        {/* 默认 stretch（不写 items-start）：右侧栏需要撑满行高，
            sticky 才有可粘滞的滚动区间；内容区自身靠内容高度 */}
        {tab === "remote" ? (
          // 内容块整体居中：左栏不再单独限宽，否则窗口变宽后 banner 会被推到
          // 最右侧，和正文之间空出一截。1288 = 896（正文）+ 32（gap）+ 360（banner）
          <div className="mx-auto grid w-full max-w-322 gap-8 lg:grid-cols-[minmax(0,1fr)_360px]">
            <div className="min-w-0">
              <div className="mb-6">
                <h1 className="text-2xl font-semibold tracking-tight">
                  {t("remote.view.heroTitle")}
                </h1>
                <p className="text-muted-foreground mt-1.5 text-sm">
                  {t("remote.view.heroDesc")}
                </p>
              </div>
              <RemoteSettings embedded />
            </div>

            <aside className="hidden lg:block">
              {/* 单层卡：白色页面上再套一层白色内板会只剩一圈灰边，看起来像描边空框 */}
              <div className="sticky top-8 overflow-hidden rounded-2xl bg-muted/40">
                <div className="flex items-center justify-center px-5 pt-6">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src="/illustrations/remote-team.svg"
                    alt={t("remote.view.illustrationAlt")}
                    className="h-auto w-full object-contain select-none"
                    draggable={false}
                  />
                </div>
                <div className="px-5 pt-4 pb-5">
                  <div className="text-sm font-medium">{t("remote.view.asideTitle")}</div>
                  <p className="text-muted-foreground mt-1.5 text-xs leading-relaxed">
                    {t("remote.view.asideDesc")}
                  </p>
                </div>
              </div>
            </aside>
          </div>
        ) : (
          <div className="mx-auto w-full max-w-322">
            <div className="mb-6">
              <h1 className="text-2xl font-semibold tracking-tight">
                {t("remote.view.imTitle")}
              </h1>
              <p className="text-muted-foreground mt-1.5 text-sm">
                {t("remote.view.imDesc")}
              </p>
            </div>
            <ImChannelsPanel />
          </div>
        )}
      </div>

      {headerSlot &&
        createPortal(
          <Segmented<"remote" | "im">
            value={tab}
            className="w-fit"
            options={[
              { value: "remote", label: t("remote.view.tabRemote") },
              { value: "im", label: t("remote.view.tabIm") },
            ]}
            onChange={setTab}
          />,
          headerSlot,
        )}
    </div>
  );
};
