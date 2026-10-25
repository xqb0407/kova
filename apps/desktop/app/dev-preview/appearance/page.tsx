"use client";

/** 【临时验证页】外观设置性能检查：/dev-preview/appearance */
import { AppearanceSettings } from "@/components/settings/components/appearance-settings";

export default function Page() {
  return (
    <div className="bg-background h-screen">
      <AppearanceSettings />
    </div>
  );
}
