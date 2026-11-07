/**
 * macOS 应用菜单（对齐 menu.rs 全 40 行）：在系统默认菜单的「窗口」里加
 * 「资源管理器」，事件走 resource::resource_open_window。
 *
 * 语言：主进程读不到 renderer 的 localStorage，这里按系统语言（app.getLocale）
 * 取标签——中文系统出中文，其余出英文。应用内切语言只影响渲染层，原生菜单
 * 要重启后跟随（系统菜单 role 项由 macOS 自行本地化，不需要处理）。
 */
import { app, Menu, type MenuItemConstructorOptions } from "electron";
import { resourceOpenWindow } from "./resource";
import { logError } from "./logging";

export const MENU_RESOURCE_ID = "resource-manager";

const isZh = (): boolean => app.getLocale().toLowerCase().startsWith("zh");

export function install(): void {
  if (process.platform !== "darwin") return;
  const zh = isZh();
  const template: MenuItemConstructorOptions[] = [
    { role: "appMenu" },
    { role: "fileMenu" },
    { role: "editMenu" },
    {
      label: zh ? "窗口" : "Window",
      submenu: [
        { role: "minimize" },
        { role: "zoom" },
        { type: "separator" },
        {
          label: zh ? "资源管理器" : "Resource Manager",
          id: MENU_RESOURCE_ID,
          click: () => {
            void resourceOpenWindow().catch((e) => logError(`[resource] open window failed: ${e?.message ?? e}`));
          },
        },
        { type: "separator" },
        { role: "front" },
      ] as MenuItemConstructorOptions[],
    },
    { role: "windowMenu" },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  app.on("browser-window-focus", () => void 0); // 保持系统默认行为
}
