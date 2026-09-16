/**
 * Mood Mates（云宝 Nimbo）引擎加载器 —— 第三方素材，社区许可（禁止商业用途），
 * 许可全文见 public/mood-mates/LICENSE，分发/上线前需确认授权场景。
 *
 * 引擎是零依赖 IIFE 脚本（挂 window.MoodMates），不能走打包（无模块导出、
 * 加载顺序有依赖），故放 public/ 下按序动态注入 <script>：
 *   geometry → render → features → fx → emotions → engine → nimbo
 * 模块级缓存保证 StrictMode 双挂载 / HMR 下只注入一次。
 */

export interface MoodMate {
  setEmotion(id: string): boolean;
  on(evt: "change" | "tips" | "error", cb: (payload: unknown) => void): MoodMate;
  setActive(on: boolean): void;
  destroy(): void;
}

interface MoodMatesGlobal {
  create(el: Element, opts: Record<string, unknown>): MoodMate;
}

declare global {
  interface Window {
    MoodMates?: MoodMatesGlobal;
  }
}

const SCRIPT_ORDER = [
  "geometry",
  "render",
  "features",
  "fx",
  "emotions",
  "engine",
  "nimbo",
];

function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const el = document.createElement("script");
    el.src = src;
    el.async = false; // 保持注入顺序（防御 onload 乱序）
    el.onload = () => resolve();
    el.onerror = () => {
      el.remove();
      reject(new Error(`mood-mates 脚本加载失败: ${src}`));
    };
    document.head.appendChild(el);
  });
}

let loading: Promise<void> | null = null;

export function loadMoodMates(): Promise<void> {
  loading ??= Promise.resolve()
    .then(async () => {
      for (const name of SCRIPT_ORDER) {
        await loadScript(`/mood-mates/${name}.js`);
      }
    })
    .catch((err) => {
      loading = null; // 失败可重试（如离线启动后恢复网络）
      throw err;
    });
  return loading;
}

/** 在容器内创建一个睡眠态云宝（emotion '00'：闭眼、zzz 漂浮、缓慢呼吸） */
export async function createSleepingMate(el: Element): Promise<MoodMate> {
  await loadMoodMates();
  const MM = window.MoodMates;
  if (!MM) throw new Error("window.MoodMates 未挂载");
  return MM.create(el, { character: "nimbo", emotion: "00" });
}
