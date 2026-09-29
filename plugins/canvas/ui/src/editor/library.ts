/**
 * 图形库：架构图/流程图常用图形（SVG 源码预设，插入为 svg 元素）。
 * 条目 body 用 currentColor 占位——插入/预览时按宿主主题解析成具体墨色，
 * 落档后即普通 svg 源码（用户可在属性面板继续改）。
 */

export type LibraryItem = {
  name: string;
  /** 24 网格的 SVG 内部源码（不含 <svg> 根；stroke 用 currentColor） */
  body: string;
  /** 插入尺寸（px），缺省 96×96 */
  w?: number;
  h?: number;
};

export type LibraryCategory = {
  id: string;
  name: string;
  items: LibraryItem[];
};

const S = 'fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"';

export const LIBRARY: LibraryCategory[] = [
  {
    id: "service",
    name: "服务与存储",
    items: [
      { name: "数据库", body: `<ellipse cx="12" cy="5" ${S} rx="8" ry="3"/><path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5"/><path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/>` },
      { name: "缓存", body: `<ellipse cx="12" cy="5" ${S} rx="8" ry="3"/><path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5"/><path d="M13 8l-3 4h4l-3 4"/>` },
      { name: "消息队列", body: `<rect x="3" y="4" ${S} width="18" height="4" rx="1.5"/><rect x="3" y="10" ${S} width="18" height="4" rx="1.5"/><rect x="3" y="16" ${S} width="18" height="4" rx="1.5"/><path d="M12 8v2m0 4v2"/>` },
      { name: "对象存储", body: `<path d="M4 7l8-4 8 4-8 4-8-4z" ${S}/><path d="M4 12l8 4 8-4" ${S}/><path d="M4 17l8 4 8-4" ${S}/>`, w: 96, h: 110 },
      { name: "服务器", body: `<rect x="4" y="4" ${S} width="16" height="7" rx="1.5"/><rect x="4" y="13" ${S} width="16" height="7" rx="1.5"/><path d="M8 7.5h.01M8 16.5h.01"/><path d="M12 7.5h4M12 16.5h4"/>` },
      { name: "云服务", body: `<path d="M7 18a4.5 4.5 0 1 1 .6-8.96A6 6 0 0 1 19 11a3.5 3.5 0 0 1-1 7H7z" ${S}/>` },
      { name: "定时任务", body: `<circle cx="12" cy="13" ${S} r="7"/><path d="M12 10v3l2 2"/><path d="M9 3h6"/><path d="M19 5l1.5 1.5"/>` },
    ],
  },
  {
    id: "client",
    name: "客户端与用户",
    items: [
      { name: "浏览器", body: `<rect x="3" y="4" ${S} width="18" height="16" rx="2"/><path d="M3 9h18"/><path d="M6 6.5h.01M9 6.5h.01"/>` },
      { name: "手机", body: `<rect x="7" y="3" ${S} width="10" height="18" rx="2.5"/><path d="M11 18h2"/>` },
      { name: "桌面", body: `<rect x="3" y="4" ${S} width="18" height="12" rx="2"/><path d="M9 20h6m-3-4v4"/>` },
      { name: "用户", body: `<circle cx="12" cy="6" ${S} r="3"/><path d="M12 9v6"/><path d="M12 10l-5 2m5-2l5 2"/><path d="M12 15l-3.5 6m3.5-6l3.5 6"/>`, w: 96, h: 110 },
      { name: "多用户", body: `<circle cx="9" cy="8" ${S} r="3"/><path d="M3 20c0-3 2.7-5 6-5s6 2 6 5"/><path d="M16 5.5a3 3 0 0 1 0 5.4M17 15.2c2.4.6 4 2.3 4 4.8"/>` },
    ],
  },
  {
    id: "network",
    name: "网络与网关",
    items: [
      { name: "防火墙", body: `<rect x="3" y="5" ${S} width="18" height="14"/><path d="M3 10h18M3 15h18M9 5v5m6 0v5m-6 5v-5"/>` },
      { name: "负载均衡", body: `<path d="M12 3v6" ${S}/><path d="M12 9c0 3-6 3-6 7v2m0 0h-2m2 0h2m6-9c0 3 6 3 6 7v2m0 0h-2m2 0h2" ${S}/>` },
      { name: "网关", body: `<circle cx="12" cy="12" ${S} r="8"/><path d="M4 12h16M12 4c2.5 2.5 2.5 13.5 0 16-2.5-2.5-2.5-13.5 0-16z" ${S}/>` },
      { name: "CDN", body: `<circle cx="6" cy="6" ${S} r="2.5"/><circle cx="18" cy="6" ${S} r="2.5"/><circle cx="6" cy="18" ${S} r="2.5"/><circle cx="18" cy="18" ${S} r="2.5"/><circle cx="12" cy="12" ${S} r="3"/><path d="M8 8l2 2m6-2l-2 2M8 16l2-2m6 2l-2-2"/>` },
      { name: "监控告警", body: `<path d="M3 12h4l2-6 4 12 2-6h6" ${S}/>` },
    ],
  },
  {
    id: "flow",
    name: "流程与标注",
    items: [
      { name: "便签", body: `<path d="M4 4h16v10l-6 6H4V4z" ${S}/><path d="M14 20v-6h6" ${S}/>` },
      { name: "起止", body: `<rect x="3" y="8" ${S} width="18" height="8" rx="4"/>` },
      { name: "文档", body: `<path d="M5 3h10l4 4v14H5V3z" ${S}/><path d="M15 3v4h4" ${S}/><path d="M8 12h8m-8 4h6"/>` },
      { name: "人工操作", body: `<path d="M4 7h16l-4 5 4 5H4l4-5-4-5z" ${S}/>` },
      { name: "延迟", body: `<circle cx="12" cy="12" ${S} r="8"/><path d="M12 7v5l3.5 2"/><path d="M12 4v2"/>` },
    ],
  },
  {
    id: "uml",
    name: "UML 与组织",
    items: [
      { name: "包", body: `<path d="M3 7l2-3h6l2 3h8v13H3V7z" ${S}/><path d="M3 11h18"/>` },
      { name: "组件", body: `<rect x="4" y="5" ${S} width="16" height="14" rx="1.5"/><path d="M9 5v14"/><circle cx="6.8" cy="8.4" ${S} r="1"/><circle cx="6.8" cy="13" ${S} r="1"/>` },
      { name: "团队", body: `<circle cx="8" cy="7" ${S} r="2.5"/><circle cx="16" cy="7" ${S} r="2.5"/><path d="M3 19c0-3 2.2-5 5-5s5 2 5 5m3-9c2.3.3 4 2 4 4.5"/><path d="M13.5 14.4c.8-.3 1.6-.4 2.5-.4 2.8 0 5 2 5 5"/>` },
      { name: "数据流", body: `<rect x="3" y="9" ${S} width="6" height="6"/><rect x="15" y="9" ${S} width="6" height="6"/><path d="M9 12h6m0 0l-2-2m2 2l-2 2" ${S}/>` },
    ],
  },
];

/** 组装成完整 svg 源码（currentColor → 具体墨色） */
export function librarySvg(item: LibraryItem, ink: string): { code: string; w: number; h: number } {
  const w = item.w ?? 96;
  const h = item.h ?? 96;
  const code =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none">` +
    item.body.replaceAll("currentColor", ink) +
    `</svg>`;
  return { code, w, h };
}

/** 预览用 data-url（currentColor → 指定色） */
export function libraryPreviewUrl(item: LibraryItem, ink: string): string {
  const { code } = librarySvg(item, ink);
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(code)}`;
}
