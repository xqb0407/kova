"use client";

/**
 * 桌宠设置节：总开关（内嵌角标 + 悬浮窗入口）、预览选宠、自定义 pet.json
 * 地址、悬浮窗显隐（仅桌面壳——窗口由主进程管理，网页端没有托盘/悬浮窗）。
 * 版式对齐 general-settings：max-w-5xl 容器 + 分节标题 + bg-muted/50 行组。
 *
 * 选宠是**预览卡片**而不是下拉框：每只宠物用真实图集现场渲染一个 idle 动画，
 * 先看后选，点卡片即应用（内嵌与悬浮窗同步切换）。
 */

import type { FC } from "react";
import { useEffect, useRef, useState } from "react";
import { Switch } from "@/components/ui/switch";
import { Slider } from "@/components/ui/slider";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { SettingRow } from "@/components/custom-ui/setting-row";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { Pet } from "@/components/pet/pet";
import { invalidatePetLibrary, usePetLibrary } from "@/lib/pet/library";
import { openPetsDir } from "@/desktop-bridge/pet";
import {
  patchPetPrefs,
  usePetPrefs,
  type PetMode,
} from "@/lib/settings/pet-prefs";
import { isDesktop } from "@/lib/desktop-env";

/**
 * 预览卡片：滚入视口才挂载真实图集（宠物多时设置页不会一次拉几十 MB），
 * 自定义卡片右上角可移除。
 */
const PreviewCard: FC<{
  configUrl: string;
  name: string;
  selected: boolean;
  removable: boolean;
  onSelect: () => void;
  onRemove: () => void;
}> = ({ configUrl, name, selected, removable, onSelect, onRemove }) => {
  const boxRef = useRef<HTMLSpanElement | null>(null);
  const [inView, setInView] = useState(false);
  useEffect(() => {
    const el = boxRef.current;
    if (!el || inView) return undefined;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setInView(true);
          observer.disconnect();
        }
      },
      { rootMargin: "160px" },
    );
    observer.observe(el);
    return () => {
      observer.disconnect();
    };
  }, [inView]);

  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "relative flex w-44 flex-col items-center gap-2 rounded-2xl border p-3 transition-colors",
        selected ? "border-primary bg-primary/5" : "border-transparent bg-muted/50 hover:bg-muted",
      )}
    >
      {selected && (
        <span className="absolute right-2 top-2 rounded-full bg-primary px-2 py-0.5 text-xs font-medium leading-none whitespace-nowrap text-primary-foreground">
          使用中
        </span>
      )}
      {removable && !selected && (
        <span
          aria-label="移除该自定义宠物"
          role="button"
          tabIndex={0}
          onClick={(event) => {
            event.stopPropagation();
            onRemove();
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.stopPropagation();
              onRemove();
            }
          }}
          className="absolute right-2 top-2 flex size-5 cursor-pointer items-center justify-center rounded-full border border-border/60 bg-background/80 text-xs leading-none hover:bg-muted"
        >
          ×
        </span>
      )}
      <span ref={boxRef} className="flex h-28 w-full items-end justify-center overflow-hidden rounded-xl bg-muted/70">
        {inView ? <Pet manifest={configUrl} size={92} motion="idle" /> : null}
      </span>
      <span className="line-clamp-2 text-center text-sm leading-snug font-medium">{name}</span>
    </button>
  );
};

export const PetSettings: FC = () => {
  const prefs = usePetPrefs();
  const desktop = isDesktop();
  const [customUrl, setCustomUrl] = useState("");
  // 宠物库：放文件夹进 pets 目录即出现（对齐 Codex 的 ~/.codex/pets 模型）
  const [librarySeq, setLibrarySeq] = useState(0);
  const library = usePetLibrary(librarySeq);
  const refreshLibrary = () => {
    invalidatePetLibrary();
    setLibrarySeq((seq) => seq + 1);
  };

  /** 应用自定义地址：切过去，并入库为一张预览卡片（重复添加只更新位置） */
  const applyCustom = () => {
    const url = customUrl.trim();
    if (url === "") return;
    const name = decodeURIComponent(url.split("/").pop() ?? url).replace(/\.jsonc?$/i, "") || "自定义宠物";
    const customPets = prefs.customPets.some((p) => p.configUrl === url)
      ? prefs.customPets
      : [...prefs.customPets, { configUrl: url, name }];
    patchPetPrefs({ configUrl: url, customPets });
    setCustomUrl("");
  };

  const removeCustom = (configUrl: string) => {
    const customPets = prefs.customPets.filter((p) => p.configUrl !== configUrl);
    // 删掉的是使用中的那只：回退默认素材
    patchPetPrefs({ customPets, ...(prefs.configUrl === configUrl ? { configUrl: "" } : {}) });
  };

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <div className="flex w-full max-w-5xl flex-col gap-8 self-center px-8 py-8">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">桌宠</h1>
        </div>

        <section className="flex flex-col gap-3">
          <h2 className="text-base font-semibold">启用与显示位置</h2>
          <p className="text-muted-foreground text-sm">
            两种形态二选一：应用内=主窗口角落常驻角标（可自由拖拽换位）；独立悬浮窗=置顶透明小窗（拖身体或顶部条移动，不占任务栏）。任务完成/出错、等待审批/回答、定时任务完成/失败时，宠物会做对应动作并弹气泡提醒，点气泡跳到对应会话。
          </p>
          <div className="bg-muted/50 flex flex-col gap-1 rounded-2xl p-2">
            <SettingRow label="启用桌宠" desc="总开关；关闭后角标消失、悬浮窗一并收起。">
              <Switch
                checked={prefs.mode !== "off"}
                onCheckedChange={(checked) => patchPetPrefs({ mode: checked === true ? "inline" : "off" })}
              />
            </SettingRow>
            {prefs.mode !== "off" && (
              <SettingRow
                label="显示位置"
                desc={
                  desktop
                    ? "二选一。切到独立悬浮窗会自动开窗，切回应用内自动收起；托盘菜单也能随时开关悬浮窗。"
                    : "浏览器/网页端仅支持应用内角标；独立悬浮窗需在桌面客户端中使用。"
                }
              >
                <Select
                  value={prefs.mode}
                  items={[
                    { value: "inline", label: "应用内角标" },
                    ...(desktop ? [{ value: "floating", label: "独立悬浮窗" }] : []),
                  ]}
                  onValueChange={(value) => {
                    if (value === null) return;
                    patchPetPrefs({ mode: value as PetMode });
                  }}
                >
                  <SelectTrigger className="w-44">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="inline">应用内角标</SelectItem>
                    {desktop && <SelectItem value="floating">独立悬浮窗</SelectItem>}
                  </SelectContent>
                </Select>
              </SettingRow>
            )}
          </div>
        </section>

        <section className="flex flex-col gap-3">
          <h2 className="text-base font-semibold">外观</h2>
          <p className="text-muted-foreground text-sm">
            预览为真实图集现场渲染（idle 循环，滚入视口才加载），点卡片即应用，内嵌与悬浮窗同步切换。宠物来自宠物目录扫描与远程地址，可移除自定义项。
          </p>
          {desktop && (
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <span>
                宠物目录：{library.dir === "" ? "（扫描中…）" : library.dir}
                {library.dir !== "" && library.pets.length === 0 ? "（空）" : ""}
              </span>
              <Button variant="outline" size="sm" onClick={refreshLibrary}>
                重新扫描
              </Button>
              <Button variant="outline" size="sm" onClick={() => void openPetsDir().catch(() => {})}>
                打开目录
              </Button>
            </div>
          )}
          {library.pets.length === 0 && prefs.customPets.length === 0 && (
            <p className="rounded-xl bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
              还没有宠物：把宠物文件夹（含 pet.json 与 spritesheet）放进上面的宠物目录后点「重新扫描」，或在下方添加远程地址。
            </p>
          )}
          <div className="flex flex-wrap gap-3">
            {library.pets.map((pet) => (
              <PreviewCard
                key={`lib:${pet.id}`}
                configUrl={pet.configUrl}
                name={pet.name}
                selected={prefs.configUrl === pet.configUrl}
                removable={false}
                onSelect={() => {
                  patchPetPrefs({ configUrl: pet.configUrl });
                  setCustomUrl("");
                }}
                onRemove={() => {}}
              />
            ))}
            {prefs.customPets.map((p) => (
              <PreviewCard
                key={`custom:${p.configUrl}`}
                configUrl={p.configUrl}
                name={p.name}
                selected={prefs.configUrl === p.configUrl}
                removable
                onSelect={() => {
                  patchPetPrefs({ configUrl: p.configUrl });
                  setCustomUrl("");
                }}
                onRemove={() => removeCustom(p.configUrl)}
              />
            ))}
          </div>
          <div className="bg-muted/50 flex flex-col gap-1 rounded-2xl p-2">
            <SettingRow
              label="添加远程宠物"
              desc="填 https://…/pet.json 地址并添加：切为当前使用，同时入库成一张预览卡片（本地宠物请直接把文件夹放进上面的宠物目录）。"
            >
              <div className="flex min-w-0 max-w-md items-center gap-1.5">
                <Input
                  value={customUrl}
                  onChange={(event) => setCustomUrl(event.target.value)}
                  placeholder="https://…/pet.json（远程宠物清单地址）"
                  className="min-w-0 flex-1"
                />
                <Button variant="outline" disabled={customUrl.trim() === ""} onClick={applyCustom}>
                  添加
                </Button>
              </div>
            </SettingRow>
            <SettingRow
              label="显示尺寸"
              desc="图集是位图（原格 192px）：越接近原始尺寸越锐利，放大会发糊。内嵌与悬浮窗同步生效。"
            >
              <div className="flex w-52 items-center gap-2">
                <Slider
                  min={96}
                  max={288}
                  step={8}
                  value={[prefs.size]}
                  onValueChange={(v) => {
                    const first = Array.isArray(v) ? v[0] : v;
                    if (typeof first === "number") patchPetPrefs({ size: first });
                  }}
                />
                <span className="text-muted-foreground w-10 text-right text-xs tabular-nums">{prefs.size}px</span>
              </div>
            </SettingRow>
          </div>
        </section>
      </div>
    </div>
  );
};
