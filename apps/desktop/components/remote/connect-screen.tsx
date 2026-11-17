"use client";

import { useEffect, useState } from "react";
import { OTPInput, REGEXP_ONLY_DIGITS } from "input-otp";
import {
  ArrowRight,
  CircleAlert,
  CircleCheck,
  ClipboardPaste,
  LoaderCircle,
  Server,
  ShieldCheck,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group";
import { cn } from "@/lib/utils";
import {
  decodePairPayload,
  setRemoteConfig,
  type PairPayload,
  type RemoteConfig,
} from "@/lib/remote";
import { t as i18nT, useT } from "@/lib/i18n";

/**
 * 远程连接屏：输入桌面网关地址 + 6 位配对码，换取长效 token 后进入远程运行时。
 * 地址示例：ws://192.168.x.x:8787/ws（局域网/Tailscale）或 wss://xxx.trycloudflare.com/ws（隧道）。
 * 支持扫码直达：链接带 #h=（或 ?h=）参数时自动填入；地址框粘贴配置 JSON 也可解析。
 * 页面从网关直接打开时（http 访问）自动推导同源 WS 地址，通常无需手输。
 *
 * 版面是左右两栏的「品牌 + 表单」：宽屏下左栏负责交代这是什么、连接有什么
 * 代价（长期凭据），右栏只放输入与动作；窄屏（手机浏览器是主要场景）两栏
 * 竖着叠，插画收起，标题与表单之间不留断层。
 *
 * 配对码用六格 OTP 而不是单个输入框：手机上数字键盘、粘贴整串、系统短信
 * 自动填充（autocomplete="one-time-code"）都能直接落位，也比「6 位数字」
 * 的占位符更清楚地表达「这里只差六个数字」。
 */
export function ConnectScreen({
  onConnected,
}: {
  onConnected: (config: RemoteConfig) => void;
}) {
  const t = useT();
  const [url, setUrl] = useState("ws://127.0.0.1:8787/ws");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [scanned, setScanned] = useState(false);
  /** 地址是否由页面自身推导（同源网关场景）；仅用于显示一行说明 */
  const [autoAddress, setAutoAddress] = useState(false);

  // 扫码直达：解析 #h= / ?h= 参数自动填入；无参数时同源推导（页面由网关 serve 的场景）
  useEffect(() => {
    const hash = window.location.hash;
    const raw = hash.startsWith("#h=")
      ? hash.slice(3)
      : (new URLSearchParams(window.location.search).get("h") ?? "");
    const payload = raw ? decodePairPayload(raw) : null;
    if (payload) {
      setUrl(payload.host);
      setCode(payload.code);
      setScanned(true);
      return;
    }
    if (/^https?:$/.test(window.location.protocol)) {
      const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
      setUrl(`${proto}//${window.location.host}/ws`);
      setAutoAddress(true);
    }
  }, []);

  const applyPasted = (raw: string): boolean => {
    const trimmed = raw.trim();
    // 粘贴配置 JSON：{"v":1,"host":"ws://...","code":"483920"}
    if (trimmed.startsWith("{")) {
      try {
        const parsed = JSON.parse(trimmed) as Partial<PairPayload>;
        if (typeof parsed.host === "string" && typeof parsed.code === "string") {
          setUrl(parsed.host);
          setCode(parsed.code);
          setScanned(true);
          setAutoAddress(false);
          return true;
        }
      } catch {
        // 非配置 JSON，按普通地址处理
      }
    }
    // 粘贴带 #h= 的完整网页链接
    const match = /[?#]h=([^&\s]+)/.exec(trimmed);
    if (match) {
      const payload = decodePairPayload(match[1]);
      if (payload) {
        setUrl(payload.host);
        setCode(payload.code);
        setScanned(true);
        setAutoAddress(false);
        return true;
      }
    }
    return false;
  };

  const submit = async () => {
    const trimmedUrl = url.trim().replace(/\/+$/, "");
    const trimmedCode = code.trim();
    if (!/^wss?:\/\//.test(trimmedUrl)) {
      setError(t("remote.connect.invalidUrl"));
      return;
    }
    if (!/^\d{6}$/.test(trimmedCode)) {
      setError(t("remote.connect.invalidCode"));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const token = await pair(trimmedUrl, trimmedCode);
      const config = { url: trimmedUrl, token };
      setRemoteConfig(config);
      onConnected(config);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="relative flex min-h-dvh flex-col items-center justify-center overflow-x-hidden bg-background px-4 py-8 sm:px-6 sm:py-12">
      {/* 背景：一层从顶部压下来的淡蓝光晕 + 中央点阵。只负责把视线收进卡片，
          不做任何动效——这是连接流程的入口页，不是开屏。 */}
      <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className="absolute -top-40 left-1/2 h-[520px] w-[840px] -translate-x-1/2 rounded-full bg-[#dfe8fc] opacity-60 blur-3xl dark:bg-[#3357c9] dark:opacity-15" />
        <div
          className="absolute inset-0 opacity-50 dark:opacity-35"
          style={{
            backgroundImage: "radial-gradient(var(--border) 1px, transparent 1px)",
            backgroundSize: "24px 24px",
            maskImage:
              "radial-gradient(ellipse 58% 52% at 50% 45%, black, transparent)",
            WebkitMaskImage:
              "radial-gradient(ellipse 58% 52% at 50% 45%, black, transparent)",
          }}
        />
      </div>

      <div className="relative w-full max-w-[940px]">
        <div className="grid overflow-hidden rounded-2xl border border-border/70 bg-card shadow-2xl shadow-black/[0.06] lg:grid-cols-[1.04fr_0.96fr] dark:shadow-black/40">
          {/* 左栏：品牌与说明。窄屏只留标题段，插画让位给表单 */}
          <section className="relative flex flex-col gap-6 bg-muted/30 p-6 sm:p-8 lg:gap-0 lg:p-10">
            <div
              aria-hidden
              className="pointer-events-none absolute -top-28 -left-24 size-72 rounded-full bg-[#dfe8fc] opacity-45 blur-3xl dark:bg-[#3357c9] dark:opacity-10"
            />

            <div className="relative flex items-center gap-2.5">
              {/* 与新手引导同一枚品牌图标。图标是带透明留白的整枚 app icon
                  （macOS 图标网格，内容 824/1024），圆角已烘焙在图里——不要再叠
                  CSS 圆角/ring，否则描边会画在留白外圈、脱离方块 */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src="/favicon/icon.png"
                alt=""
                width={36}
                height={36}
                className="size-9"
                draggable={false}
              />
              <div className="flex min-w-0 flex-col">
                <span className="text-sm leading-none font-semibold tracking-tight">
                  Kova
                </span>
                <span className="mt-1.5 text-3xs leading-none text-muted-foreground">
                  {t("remote.connect.brandTag")}
                </span>
              </div>
            </div>

            <div className="relative mt-6 lg:mt-12">
              <h1 className="text-2xl font-semibold tracking-tight text-balance sm:text-3xl">
                {t("remote.connect.title")}
              </h1>
              <p className="mt-3 max-w-[38ch] text-sm leading-relaxed text-muted-foreground">
                {t("remote.connect.desc")}
              </p>
            </div>

            <div className="relative hidden flex-1 items-end justify-center pt-8 lg:flex">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src="/illustrations/remote-team.svg"
                alt=""
                className="h-auto w-full max-w-[330px] opacity-95 select-none dark:opacity-80"
                draggable={false}
              />
            </div>

            <p className="relative mt-2 flex items-start gap-2 text-2xs leading-relaxed text-muted-foreground/80">
              <ShieldCheck className="mt-px size-3.5 shrink-0" strokeWidth={1.8} />
              <span>{t("remote.connect.securityNote")}</span>
            </p>
          </section>

          {/* 右栏：表单。窄屏用顶边线与左栏分开，宽屏换成左边线。
              宽屏下表单垂直居中：左栏比它高，不居中会在按钮下面空一大截 */}
          <section className="flex flex-col justify-center border-t border-border/70 p-6 sm:p-8 lg:border-t-0 lg:border-l lg:p-10">
            <form
              className="mx-auto flex w-full max-w-[380px] flex-col gap-5"
              onSubmit={(e) => {
                e.preventDefault();
                void submit();
              }}
            >
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-semibold">
                  {t("remote.connect.formTitle")}
                </h2>
                <span className="rounded-md border border-border/70 px-1.5 py-0.5 font-mono text-3xs tracking-wide text-muted-foreground/70">
                  ws / wss
                </span>
              </div>

              <Field className="gap-2">
                <FieldLabel htmlFor="connect-url" className="text-[13px]">
                  {t("remote.connect.addressLabel")}
                </FieldLabel>
                <InputGroup className="h-11 rounded-xl border border-border/70 bg-muted/40 px-0 focus-within:border-ring/50 focus-within:bg-background focus-within:ring-3 focus-within:ring-ring/10">
                  <InputGroupAddon
                    align="inline-start"
                    className="pr-0 pl-3.5 text-muted-foreground/80"
                  >
                    <Server className="size-4" strokeWidth={1.8} />
                  </InputGroupAddon>
                  <InputGroupInput
                    id="connect-url"
                    value={url}
                    onChange={(e) => {
                      const next = e.target.value;
                      setError(null);
                      if (applyPasted(next)) return;
                      setUrl(next);
                      setAutoAddress(false);
                      setScanned(false);
                    }}
                    placeholder={t("remote.connect.addressPlaceholder")}
                    autoCapitalize="off"
                    autoCorrect="off"
                    spellCheck={false}
                    dir="ltr"
                    className="h-full pr-3.5 font-mono text-[13px]"
                  />
                </InputGroup>
                <FieldDescription className="min-h-4 text-2xs leading-4 text-muted-foreground/80">
                  {autoAddress ? t("remote.connect.autoFilled") : ""}
                </FieldDescription>
              </Field>

              <Field className="gap-2">
                <div className="flex items-baseline justify-between gap-3">
                  <FieldLabel className="text-[13px]">
                    {t("remote.connect.pairCode")}
                  </FieldLabel>
                  <span className="text-3xs text-muted-foreground/70">
                    {t("remote.connect.codePlaceholder")}
                  </span>
                </div>
                <PairCode
                  value={code}
                  label={t("remote.connect.pairCode")}
                  onChange={(next) => {
                    setCode(next.replace(/\D/g, "").slice(0, 6));
                    setScanned(false);
                    setError(null);
                  }}
                />
              </Field>

              {scanned && (
                <p className="flex items-start gap-2 rounded-lg bg-emerald-500/10 px-3 py-2 text-xs leading-relaxed text-emerald-700 dark:text-emerald-400">
                  <CircleCheck className="mt-px size-3.5 shrink-0" strokeWidth={1.8} />
                  <span>{t("remote.connect.scannedHint")}</span>
                </p>
              )}

              {error && (
                <p
                  role="alert"
                  className="flex items-start gap-2 rounded-lg bg-destructive/8 px-3 py-2 text-xs leading-relaxed text-destructive"
                >
                  <CircleAlert className="mt-px size-3.5 shrink-0" strokeWidth={1.8} />
                  <span>{error}</span>
                </p>
              )}

              <Button
                type="submit"
                disabled={busy}
                className="group/cta h-11 w-full rounded-xl text-sm font-medium"
              >
                {busy ? (
                  <LoaderCircle className="size-4 animate-spin" strokeWidth={2} />
                ) : null}
                <span>
                  {busy
                    ? t("remote.connect.connecting")
                    : t("remote.connect.connect")}
                </span>
                {!busy && (
                  <ArrowRight
                    className="size-4 transition-transform duration-200 group-hover/button:translate-x-0.5"
                    strokeWidth={1.8}
                  />
                )}
              </Button>

              <p className="flex items-start gap-1.5 border-t border-border/60 pt-4 text-3xs leading-relaxed text-muted-foreground/70">
                <ClipboardPaste className="mt-px size-3.5 shrink-0" strokeWidth={1.8} />
                <span>{t("remote.connect.pasteHint")}</span>
              </p>
            </form>
          </section>
        </div>

        <p className="mt-5 text-center font-mono text-3xs tracking-[0.3em] text-muted-foreground/45 uppercase">
          Kova Remote
        </p>
      </div>
    </div>
  );
}

/**
 * 六格配对码。input-otp 负责隐藏输入、逐格分配、整串粘贴与系统自动填充；
 * 这里只决定每格长什么样。格高与地址框对齐（44px），聚焦只换描边与底色，
 * 不改尺寸，避免输入时整行跳动。
 */
function PairCode({
  value,
  onChange,
  label,
}: {
  value: string;
  onChange: (next: string) => void;
  label: string;
}) {
  return (
    <OTPInput
      value={value}
      onChange={onChange}
      maxLength={6}
      pattern={REGEXP_ONLY_DIGITS}
      inputMode="numeric"
      autoComplete="one-time-code"
      aria-label={label}
      containerClassName="flex w-full items-center gap-1.5 sm:gap-2"
      render={({ slots }) => (
        <div aria-hidden className="contents">
          {slots.map((slot, index) => (
            <div
              key={index}
              data-active={slot.isActive || undefined}
              data-filled={slot.char ? "" : undefined}
              className={cn(
                "relative flex h-11 min-w-0 flex-1 items-center justify-center rounded-xl border border-border/70 bg-muted/40 text-lg font-medium text-foreground tabular-nums transition-[background-color,border-color,box-shadow]",
                "data-[filled]:border-border/90 data-[filled]:bg-background",
                "data-[active]:border-ring/50 data-[active]:bg-background data-[active]:ring-3 data-[active]:ring-ring/10",
              )}
            >
              {slot.char}
              {slot.hasFakeCaret && (
                <span className="pointer-events-none absolute inset-0 flex items-center justify-center">
                  <span className="h-4 w-px animate-caret-blink bg-foreground/70" />
                </span>
              )}
            </div>
          ))}
        </div>
      )}
    />
  );
}

/** 临时 WS 连接完成配对，成功返回 token */
function pair(url: string, code: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      ws.close();
      reject(new Error(i18nT("remote.connect.timeout")));
    }, 15000);
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ws.close();
      fn();
    };

    ws.onopen = () => {
      ws.send(JSON.stringify({ type: "pair", code }));
    };
    ws.onmessage = (ev) => {
      let v: Record<string, unknown>;
      try {
        v = JSON.parse(String(ev.data)) as Record<string, unknown>;
      } catch {
        return;
      }
      if (v.type === "paired" && typeof v.token === "string") {
        finish(() => resolve(v.token as string));
      } else if (v.type === "error") {
        const text = String(v.errorText ?? i18nT("remote.connect.pairFailed"));
        const left = v.attemptsLeft;
        finish(() =>
          reject(
            new Error(
              typeof left === "number"
                ? i18nT("remote.connect.attemptsLeft", { message: text, left })
                : text,
            ),
          ),
        );
      }
    };
    ws.onerror = () => {
      finish(() => reject(new Error(i18nT("remote.connect.connectFailed"))));
    };
    ws.onclose = () => {
      finish(() => reject(new Error(i18nT("remote.connect.closed"))));
    };
  });
}
