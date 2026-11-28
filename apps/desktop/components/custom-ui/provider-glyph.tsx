"use client";

/**
 * 外部来源品牌图标：四个平台都用官方 mark（path 数据来自官方图标导出，
 * 用户提供的 GitLab/Jira/GitHub 官方多色/单色 mark + Linear 官方 mark）。
 *
 * 两个形态：
 * - ProviderGlyph：设置页/弹窗里的方形品牌瓦片（品牌色淡底 + 真图标）；
 * - ProviderMark：收件箱 tabs 与列表行内的裸图标（无底色，12–20px）。
 *
 * 颜色：GitLab/Jira 官方 mark 自带品牌色；Linear 单色走品牌色；
 * GitHub 单色跟随主题前景色（深色模式下自动变白，官方黑在暗色不可读）。
 */
import type { FC, SVGProps } from "react";
import { cn } from "@/lib/utils";

export const PROVIDER_META: Record<string, { label: string; color: string }> = {
  github: { label: "GitHub", color: "#24292f" },
  gitlab: { label: "GitLab", color: "#fc6d26" },
  jira: { label: "Jira", color: "#0052cc" },
  linear: { label: "Linear", color: "#5e6ad2" },
};

const GithubMark: FC<SVGProps<SVGSVGElement>> = (props) => (
  <svg viewBox="0 0 1024 1024" fill="currentColor" aria-hidden {...props}>
    <path d="M512 42.666667A464.64 464.64 0 0 0 42.666667 502.186667 460.373333 460.373333 0 0 0 363.52 938.666667c23.466667 4.266667 32-9.813333 32-22.186667v-78.08c-130.56 27.733333-158.293333-61.44-158.293333-61.44a122.026667 122.026667 0 0 0-52.053334-67.413333c-42.666667-28.16 3.413333-27.733333 3.413334-27.733334a98.56 98.56 0 0 1 71.68 47.36 101.12 101.12 0 0 0 136.533333 37.973334 99.413333 99.413333 0 0 1 29.866667-61.44c-104.106667-11.52-213.333333-50.773333-213.333334-226.986667a177.066667 177.066667 0 0 1 47.36-124.16 161.28 161.28 0 0 1 4.693334-121.173333s39.68-12.373333 128 46.933333a455.68 455.68 0 0 1 234.666666 0c89.6-59.306667 128-46.933333 128-46.933333a161.28 161.28 0 0 1 4.693334 121.173333A177.066667 177.066667 0 0 1 810.666667 477.866667c0 176.64-110.08 215.466667-213.333334 226.986666a106.666667 106.666667 0 0 1 32 85.333334v125.866666c0 14.933333 8.533333 26.88 32 22.186667A460.8 460.8 0 0 0 981.333333 502.186667 464.64 464.64 0 0 0 512 42.666667" />
  </svg>
);

const GitlabMark: FC<SVGProps<SVGSVGElement>> = (props) => (
  <svg viewBox="0 0 1024 1024" aria-hidden {...props}>
    <path
      d="M932.317184 567.76704L885.10464 422.46144l-93.57312-287.997952c-4.8128-14.81728-25.776128-14.81728-30.590976 0L667.36128 422.459392H356.62848L263.051264 134.46144c-4.8128-14.81728-25.776128-14.81728-30.593024 0l-93.57312 287.997952-47.210496 145.309696a32.165888 32.165888 0 0 0 11.68384 35.96288l408.6272 296.890368L920.61696 603.734016c11.272192-8.192 15.990784-22.71232 11.68384-35.964928"
      fill="#FC6D26"
    />
    <path d="M512.002048 900.62848l155.365376-478.171136H356.634624z" fill="#E24329" />
    <path d="M512.004096 900.62848L356.63872 422.47168H138.901504z" fill="#FC6D26" />
    <path
      d="M138.891264 422.465536l-47.214592 145.309696a32.16384 32.16384 0 0 0 11.685888 35.96288L511.991808 900.62848z"
      fill="#FCA326"
    />
    <path
      d="M138.893312 422.459392h217.737216L263.053312 134.46144c-4.8128-14.819328-25.778176-14.819328-30.590976 0z"
      fill="#E24329"
    />
    <path d="M512.002048 900.62848l155.365376-478.154752H885.10464z" fill="#FC6D26" />
    <path
      d="M885.11488 422.465536l47.214592 145.309696a32.16384 32.16384 0 0 1-11.685888 35.96288L512.014336 900.62848z"
      fill="#FCA326"
    />
    <path
      d="M885.096448 422.459392H667.36128l93.577216-287.997952c4.814848-14.819328 25.778176-14.819328 30.590976 0z"
      fill="#E24329"
    />
  </svg>
);

const JiraMark: FC<SVGProps<SVGSVGElement>> = (props) => (
  <svg viewBox="0 0 1024 1024" aria-hidden {...props}>
    <path
      d="M493.136842 491.250526a42.792421 42.792421 0 0 1 42.199579 36.001685l0.538947 6.736842V1024a222.585263 222.585263 0 0 1-221.884631-211.375158l-0.269474-11.102316v-87.686737H222.585263A222.585263 222.585263 0 0 1 0.269474 502.352842L0 491.250526h493.136842z m244.089263-245.544421a42.792421 42.792421 0 0 1 42.738527 42.738527v490.010947a222.585263 222.585263 0 0 1-222.585264-222.31579V468.129684H466.620632A222.585263 222.585263 0 0 1 244.143158 245.706105zM981.207579 0c21.827368 0 39.828211 16.330105 42.469053 37.402947l0.323368 5.389474v489.903158a222.585263 222.585263 0 0 1-222.154105-211.321263l-0.323369-11.102316V222.585263h-90.812631A222.585263 222.585263 0 0 1 488.448 12.611368L488.124632 0h493.136842z"
      fill="#2684FF"
    />
  </svg>
);

const LinearMark: FC<SVGProps<SVGSVGElement>> = (props) => (
  <svg viewBox="0 0 48 48" fill="currentColor" aria-hidden {...props}>
    <path
      transform="translate(3 3) scale(0.42)"
      d="M12.927 16.371a1.47 1.47 0 0 0 .061 2.027l68.595 68.594c.555.555 1.446.59 2.026.062 10.058-9.152 16.372-22.348 16.372-37.018C99.98 22.402 77.579 0 49.945 0c-14.67 0-27.866 6.313-37.018 16.371M4.353 29.39a1.47 1.47 0 0 0 .309 1.648L68.943 95.32c.434.434 1.09.562 1.648.308a50 50 0 0 0 4.335-2.227c.834-.482.962-1.62.28-2.3L8.882 24.773c-.68-.68-1.818-.553-2.3.281a50 50 0 0 0-2.228 4.334m-3.9 18.407a1.48 1.48 0 0 1-.432-1.14q.2-2.986.74-5.866c.215-1.15 1.62-1.55 2.448-.722l56.703 56.704c.828.827.429 2.233-.722 2.448a50 50 0 0 1-5.865.74 1.48 1.48 0 0 1-1.14-.433zm3.48 13.963c-1.033-1.033-2.7-.143-2.322 1.268C6.221 80.22 19.761 93.76 36.954 98.37c1.41.379 2.3-1.289 1.268-2.322z"
    />
  </svg>
);

const MARKS: Record<string, FC<SVGProps<SVGSVGElement>>> = {
  github: GithubMark,
  gitlab: GitlabMark,
  jira: JiraMark,
  linear: LinearMark,
};

function markColor(provider: string): string {
  // GitHub 官方 mark 是单色，跟随主题前景色（官方黑在暗色主题不可读）；
  // 其余平台的 mark 自带品牌色或走品牌色
  if (provider === "github") return "var(--foreground)";
  return PROVIDER_META[provider]?.color ?? "var(--muted-foreground)";
}

export const ProviderGlyph: FC<{
  provider: string;
  className?: string;
}> = ({ provider, className }) => {
  const meta = PROVIDER_META[provider];
  const Mark = MARKS[provider];
  return (
    <span
      className={cn(
        "grid shrink-0 place-items-center overflow-hidden",
        className,
      )}
      style={
        meta
          ? {
              backgroundColor: `color-mix(in srgb, ${meta.color} 12%, var(--background))`,
              color: markColor(provider),
            }
          : undefined
      }
      aria-hidden
    >
      <span className="grid size-[52%] place-items-center">
        {Mark ? (
          <Mark className="size-full" />
        ) : (
          <span className="bg-muted-foreground/40 size-full rounded-xs" />
        )}
      </span>
    </span>
  );
};

/**
 * 列表行内联的裸来源标记：不带底色和描边，跟正文同一视觉层级。
 * GitHub 跟随 muted 文本色，其余用品牌色，保证 12px 下仍可辨识。
 */
export const ProviderMark: FC<{
  provider: string;
  className?: string;
}> = ({ provider, className }) => {
  const meta = PROVIDER_META[provider];
  const Mark = MARKS[provider];
  return (
    <span
      className={cn(
        "inline-flex size-3.5 shrink-0 items-center justify-center",
        provider === "github" && "text-muted-foreground",
        className,
      )}
      style={provider === "github" ? undefined : { color: meta?.color }}
      aria-hidden
    >
      {Mark ? (
        <Mark className="size-full" />
      ) : (
        <span className="bg-muted-foreground/40 size-2.5 rounded-xs" />
      )}
    </span>
  );
};
