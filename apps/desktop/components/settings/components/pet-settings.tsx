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
import { clearPreviewFrameCache, loadPreviewFrame } from "@/lib/pet/preview-frame";
import { openPetsDir } from "@/desktop-bridge/pet";
import {
  patchPetPrefs,
  usePetPrefs,
  type PetMode,
} from "@/lib/settings/pet-prefs";
import { isDesktop } from "@/lib/desktop-env";
import { useT } from "@/lib/i18n";

/** 预览动画显示宽（px）；条带解码目标按它 × dpr 取整。 */
const PREVIEW_SIZE = 92;

/**
 * 预览卡片：滚入视口才加载，渲染 **idle 首帧静图**（2026-11 用户决策：非动图
 * 渲染开销最小）——不播动画、零定时器，位图 ~0.2MB/张；帧图从 preview.webp
 * 缩微图或图集裁出（见 lib/pet/preview-frame.ts）。静帧不可用（动图/static 宠）
 * 回退整装 <Pet> 老路径。观察是**双向**的：滚出视口卸载图片（位图随挂载释放），
 * 滚回秒续（帧图缓存命中）。自定义卡片右上角可移除。
 */
const PreviewCard: FC<{
  configUrl: string;
  name: string;
  selected: boolean;
  removable: boolean;
  onSelect: () => void;
  onRemove: () => void;
}> = ({ configUrl, name, selected, removable, onSelect, onRemove }) => {
  const t = useT();
  const boxRef = useRef<HTMLSpanElement | null>(null);
  const [inView, setInView] = useState(false);
  // undefined=未加载 / null=静帧不可用（回退整装）/ string=帧图 objectURL
  const [frameUrl, setFrameUrl] = useState<string | null | undefined>(undefined);

  useEffect(() => {
    const el = boxRef.current;
    if (!el) return undefined;
    const observer = new IntersectionObserver(
      (entries) => setInView(entries.some((entry) => entry.isIntersecting)),
      { rootMargin: "160px" },
    );
    observer.observe(el);
    return () => {
      observer.disconnect();
    };
  }, []);

  useEffect(() => {
    if (!inView || frameUrl !== undefined) return undefined;
    let cancelled = false;
    // 帧图按显示尺寸 × dpr 解码（封顶 2x，避免 3x 屏把帧图翻三倍）
    const frameTarget = Math.ceil(PREVIEW_SIZE * Math.min(window.devicePixelRatio || 1, 2));
    void loadPreviewFrame(configUrl, frameTarget).then((url) => {
      if (!cancelled) setFrameUrl(url);
    });
    return () => {
      cancelled = true;
    };
  }, [configUrl, frameUrl, inView]);

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
        <span className="absolute right-2 top-2 rounded-full bg-primary px-2 py-0.5 text-[13px] leading-5 font-medium leading-none whitespace-nowrap text-primary-foreground">
          {t("settings.pet.inUse")}
        </span>
      )}
      {removable && !selected && (
        <span
          aria-label={t("settings.pet.removeCustom")}
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
          className="absolute right-2 top-2 flex size-5 cursor-pointer items-center justify-center rounded-full border border-border/60 bg-background/80 text-[13px] leading-none hover:bg-muted"
        >
          ×
        </span>
      )}
      <span ref={boxRef} className="flex h-28 w-full items-end justify-center overflow-hidden rounded-xl bg-muted/70">
        {inView && frameUrl !== undefined ? (
          frameUrl !== null ? (
            <img
              src={frameUrl}
              alt={name}
              draggable={false}
              style={{ width: PREVIEW_SIZE, height: "auto" }}
            />
          ) : (
            <Pet manifest={configUrl} size={PREVIEW_SIZE} motion="idle" lookAtPointer={false} />
          )
        ) : null}
      </span>
      <span className="line-clamp-2 text-center text-sm leading-snug font-medium">{name}</span>
    </button>
  );
};

export const PetSettings: FC = () => {
  const t = useT();
  const prefs = usePetPrefs();
  const desktop = isDesktop();
  const [customUrl, setCustomUrl] = useState("");
  // 宠物库：放文件夹进 pets 目录即出现（对齐 Codex 的 ~/.codex/pets 模型）
  const [librarySeq, setLibrarySeq] = useState(0);
  const library = usePetLibrary(librarySeq);
  const refreshLibrary = () => {
    invalidatePetLibrary();
    // 静帧缓存跟着失效：目录可能增删过，旧的帧图/清单地址不再可信
    clearPreviewFrameCache();
    setLibrarySeq((seq) => seq + 1);
  };

  /** 应用自定义地址：切过去，并入库为一张预览卡片（重复添加只更新位置） */
  const applyCustom = () => {
    const url = customUrl.trim();
    if (url === "") return;
    const name = decodeURIComponent(url.split("/").pop() ?? url).replace(/\.jsonc?$/i, "") || t("settings.pet.customPet");
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
          <h1 className="text-2xl font-bold tracking-tight">{t("settings.pet.title")}</h1>
        </div>

        <section className="flex flex-col gap-3">
          <h2 className="text-base font-semibold">{t("settings.pet.enableSection")}</h2>
          <div className="bg-muted/50 flex flex-col gap-1 rounded-2xl p-2">
            <SettingRow label={t("settings.pet.enable")} desc={t("settings.pet.enableHint")}>
              <Switch
                checked={prefs.mode !== "off"}
                onCheckedChange={(checked) => patchPetPrefs({ mode: checked === true ? "inline" : "off" })}
              />
            </SettingRow>
            {prefs.mode !== "off" && (
              <SettingRow
                label={t("settings.pet.position")}
                desc={
                  desktop
                    ? t("settings.pet.positionDescDesktop")
                    : t("settings.pet.positionDescWeb")
                }
              >
                <Select
                  value={prefs.mode}
                  items={[
                    { value: "inline", label: t("settings.pet.positionInline") },
                    ...(desktop ? [{ value: "floating", label: t("settings.pet.positionFloating") }] : []),
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
                    <SelectItem value="inline">{t("settings.pet.positionInline")}</SelectItem>
                    {desktop && <SelectItem value="floating">{t("settings.pet.positionFloating")}</SelectItem>}
                  </SelectContent>
                </Select>
              </SettingRow>
            )}
          </div>
        </section>

        <section className="flex flex-col gap-3">
          <h2 className="text-base font-semibold">{t("settings.pet.appearance")}</h2>
          <p className="text-muted-foreground text-sm leading-relaxed">
            {t("settings.pet.appearanceDesc")}
          </p>
          {desktop && (
            <div className="flex flex-wrap items-center gap-2 text-[13px] leading-5 text-muted-foreground">
              <span>
                {t("settings.pet.petDir", {
                  dir: library.dir === "" ? t("settings.pet.scanning") : library.dir,
                })}
                {library.dir !== "" && library.pets.length === 0 ? t("settings.pet.empty") : ""}
              </span>
              <Button variant="outline" size="sm" onClick={refreshLibrary}>
                {t("settings.pet.rescan")}
              </Button>
              <Button variant="outline" size="sm" onClick={() => void openPetsDir().catch(() => {})}>
                {t("settings.pet.openDir")}
              </Button>
            </div>
          )}
          {library.pets.length === 0 && prefs.customPets.length === 0 && (
            <p className="rounded-xl bg-muted/50 px-3 py-2 text-[13px] leading-5 text-muted-foreground">
              {t("settings.pet.emptyList")}
            </p>
          )}
          <div className="flex flex-wrap gap-3">
            {library.pets.map((pet) => (
              <PreviewCard
                // key 带扫描代次：重扫描会 revoke 全部帧图缓存（含显示中的），
                // 卡片必须重挂让 frameUrl 归零重载，否则显示中的卡片永久坏图
                key={`lib:${pet.id}:${librarySeq}`}
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
                key={`custom:${p.configUrl}:${librarySeq}`}
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
              label={t("settings.pet.addRemote")}
              desc={t("settings.pet.addRemoteDesc")}
            >
              <div className="flex min-w-0 max-w-md items-center gap-1.5">
                <Input
                  value={customUrl}
                  onChange={(event) => setCustomUrl(event.target.value)}
                  placeholder={t("settings.pet.remotePlaceholder")}
                  className="min-w-0 flex-1"
                />
                <Button variant="outline" disabled={customUrl.trim() === ""} onClick={applyCustom}>
                  {t("settings.pet.add")}
                </Button>
              </div>
            </SettingRow>
            <SettingRow
              label={t("settings.pet.size")}
              desc={t("settings.pet.sizeDesc")}
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
                <span className="text-muted-foreground w-10 text-right text-[13px] leading-5 tabular-nums">{prefs.size}px</span>
              </div>
            </SettingRow>
          </div>
        </section>
      </div>
    </div>
  );
};
