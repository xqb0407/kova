/**
 * 宿主路径约定（对齐旧桌面壳 identifier com.kova.assistant）：
 * userData 显式指向同一目录，Electron 与 旧桌面壳共享 state.db/sessions/kv（D4）。
 *
 * `app` 惰性解引用（require 时取）：tool-exec 及其依赖在沙箱 e2e / bun test
 * 下也会被加载，那时 Electron 运行时不存在，顶层 import 会让 `import { app }`
 * 直接炸掉整个模块图。
 */
import { join } from "node:path";
import { mkdirSync, readFileSync } from "node:fs";

type ElectronApp = {
  isPackaged: boolean;
  getAppPath: () => string;
  getName: () => string;
  setName: (name: string) => void;
  getPath: (name: "appData" | "userData" | "logs") => string;
  setPath: (name: "userData" | "logs", path: string) => void;
};

function electronApp(): ElectronApp | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require("electron");
    return (mod?.app ?? null) as ElectronApp | null;
  } catch {
    return null;
  }
}

/** 打包渠道：electron-builder 的 extraMetadata.kovaChannel（dev 包 = "dev"）。
 *  asar 内 package.json 随 app 一起打包，运行时读取即可判定。 */
function packagedChannel(app: ElectronApp): string | null {
  try {
    const pkgPath = join(app.getAppPath(), "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    const ch = pkg?.kovaChannel;
    return typeof ch === "string" && ch.length > 0 ? ch : null;
  } catch {
    return null;
  }
}

let dataDir = "";
let logDir = "";

/** 必须在 ready 之前调用（gpu 开关要先读，对齐 gpu.rs 建窗前读配置）。
 *  数据目录三段式（与 旧桌面壳一致）：
 *    - KOVA_DATA_DIR 显式覆盖（e2e/多实例沙箱）；
 *    - dev（未打包，或 --dev）：com.kova.assistant.dev + 显示名 "Kova Dev"
 *      —— 与旧桌面壳的 dev identifier 对齐，dev 数据不污染正式库；
 *    - 打包版：com.kova.assistant（与 旧桌面壳 发布版共享 state.db/会话/密钥）。 */
export function initPaths(): void {
  const app = electronApp();
  if (!app) {
    // 非 Electron 环境（bun test / 沙箱 e2e）：只认 KOVA_DATA_DIR，不碰 Electron 状态
    const override = process.env.KOVA_DATA_DIR;
    dataDir = override && override.length > 0 ? override : "";
    logDir = dataDir ? join(dataDir, "logs") : "";
    return;
  }
  // dev 三态：未打包运行 / --dev / dev 渠道包（Kova Dev.app，identifier 与 旧桌面壳 dev 对齐）
  const isDevRun = !app.isPackaged || process.argv.includes("--dev") || packagedChannel(app) === "dev";
  app.setName(isDevRun ? "Kova Dev" : "Kova");
  const override = process.env.KOVA_DATA_DIR;
  const identifier = isDevRun ? "com.kova.assistant.dev" : "com.kova.assistant";
  dataDir = override && override.length > 0 ? override : join(app.getPath("appData"), identifier);
  logDir = join(dataDir, "logs");
  app.setPath("userData", dataDir);
  app.setPath("logs", logDir);
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(join(dataDir, "sessions"), { recursive: true });
  mkdirSync(join(dataDir, "task-workspace"), { recursive: true });
  // 资料库缺省根（用户改过位置时由 library.ts 的 ensureLibraryRoot 兜住；
  // 此处先建缺省目录，页面首帧即有空树而不是读取失败）
  mkdirSync(join(dataDir, "library"), { recursive: true });
}

/** app data 目录（= 旧桌面壳 app_data_dir） */
export function appDataDir(): string {
  const app = electronApp();
  return dataDir || join(app?.getPath("appData") ?? "", "com.kova.assistant");
}

/** 日志根目录：<dir>/<YYYY-MM-DD>/ 按日分目录（对齐 logging.rs） */
export function appLogDir(): string {
  return logDir || join(appDataDir(), "logs");
}

export function sessionsDir(): string {
  return join(appDataDir(), "sessions");
}

export function dbPath(): string {
  return join(appDataDir(), "state.db");
}
