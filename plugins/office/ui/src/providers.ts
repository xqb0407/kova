/**
 * embed 地址解析（纯函数，零网络）：URL → 白名单 provider 的 embed 地址。
 * 与 tldraw 的 embed 表同思路——客户端正则匹配 + 拼 embed URL；未命中 provider
 * 的 URL 原样作为 iframe src 兜底（frame 友好的站点直接活，被 X-Frame-Options
 * 拒绝的由浏览器在 iframe 内显示拒绝页，元素角标始终可见 URL）。
 * 不做 oEmbed/标题抓取：面板是沙箱不透明源，无网络能力（connect-src 锁死）。
 */

export type EmbedProvider =
  | "youtube"
  | "bilibili"
  | "vimeo"
  | "gmaps"
  | "spotify"
  | "codepen"
  | "codesandbox"
  | "figma"
  | "excalidraw"
  | "generic";

/** 角标与导出占位用的显示名 */
export const PROVIDER_LABELS: Record<EmbedProvider, string> = {
  youtube: "YouTube",
  bilibili: "哔哩哔哩",
  vimeo: "Vimeo",
  gmaps: "Google 地图",
  spotify: "Spotify",
  codepen: "CodePen",
  codesandbox: "CodeSandbox",
  figma: "Figma",
  excalidraw: "Excalidraw",
  generic: "网页",
};

export type EmbedTarget = { provider: EmbedProvider; embedUrl: string };

/** b23.tv 短链需要网络跳转解析，客户端拼不出 player 地址 → 走 generic 兜底 */
const YT_ID = "[\\w-]{6,}";

const RULES: readonly { provider: EmbedProvider; build: (url: string) => string | null }[] = [
  {
    provider: "youtube",
    build: (url) => {
      let m =
        new RegExp(`youtu\\.be/(${YT_ID})`).exec(url) ??
        new RegExp(`youtube\\.com/(?:watch\\?[^\\s]*v=|shorts/|live/|embed/)(${YT_ID})`).exec(url);
      if (m) return `https://www.youtube.com/embed/${m[1]}`;
      m = /youtube\.com\/playlist\?[^\s]*list=([\w-]+)/.exec(url);
      if (m) return `https://www.youtube.com/embed/videoseries?list=${m[1]}`;
      return null;
    },
  },
  {
    provider: "bilibili",
    build: (url) => {
      const m = /bilibili\.com\/video\/(BV\w+)/i.exec(url);
      if (!m) return null;
      return `https://player.bilibili.com/player.html?bvid=${m[1]}&autoplay=0`;
    },
  },
  {
    provider: "vimeo",
    build: (url) => {
      const m = /vimeo\.com\/(?:video\/)?(\d{6,})/.exec(url);
      if (!m) return null;
      return `https://player.vimeo.com/video/${m[1]}`;
    },
  },
  {
    provider: "gmaps",
    build: (url) => {
      if (!/google\.[\w.]+\/maps/i.test(url)) return null;
      const q = /[?&]q=([^&\s]+)/.exec(url)?.[1];
      // 有 q 参数才有意义的 embed 形态；纯坐标/短链解析不动，兜底原样 iframe
      return q ? `https://maps.google.com/maps?q=${q}&output=embed` : null;
    },
  },
  {
    provider: "spotify",
    build: (url) => {
      const m = /open\.spotify\.com\/(?:intl-\w+\/)?(track|album|playlist|episode|show|artist)\/(\w+)/.exec(url);
      if (!m) return null;
      return `https://open.spotify.com/embed/${m[1]}/${m[2]}`;
    },
  },
  {
    provider: "codepen",
    build: (url) => {
      const m = /codepen\.io\/([\w.-]+)\/pen\/([\w]+)/.exec(url);
      if (!m) return null;
      return `https://codepen.io/${m[1]}/embed/${m[2]}?default-tab=result`;
    },
  },
  {
    provider: "codesandbox",
    build: (url) => {
      const m = /codesandbox\.io\/s\/([\w-]+)/.exec(url);
      if (!m) return null;
      return `https://codesandbox.io/embed/${m[1]}`;
    },
  },
  {
    provider: "figma",
    build: (url) => {
      if (!/figma\.com\/(?:file|design|proto|board)\//.test(url)) return null;
      return `https://www.figma.com/embed?embed_host=office&url=${encodeURIComponent(url)}`;
    },
  },
  {
    provider: "excalidraw",
    build: (url) => {
      // excalidraw 分享页本身可被 iframe
      return /^https:\/\/excalidraw\.com\/#json=/i.test(url) ? url : null;
    },
  },
];

export function resolveEmbed(url: string): EmbedTarget {
  for (const rule of RULES) {
    try {
      const embedUrl = rule.build(url);
      if (embedUrl) return { provider: rule.provider, embedUrl };
    } catch {
      // 正则异常不应打断渲染；落到 generic
    }
  }
  return { provider: "generic", embedUrl: url };
}
