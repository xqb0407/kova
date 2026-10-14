/**
 * macOS 应用菜单（对齐 menu.rs 全 40 行）：在系统默认菜单的「窗口」里加
 * 「资源管理器」，事件走 resource::resource_open_window。
 */
import { app, Menu, type MenuItemConstructorOptions } from "electron";
import { resourceOpenWindow } from "./resource";
import { logError } from "./logging";

export const MENU_RESOURCE_ID = "resource-manager";

export function install(): void {
  if (process.platform !== "darwin") return;
  const template: MenuItemConstructorOptions[] = [
    { role: "appMenu" },
    { role: "fileMenu" },
    { role: "editMenu" },
    {
      label: "窗口",
      submenu: [
        { role: "minimize" },
        { role: "zoom" },
        { type: "separator" },
        {
          label: "资源管理器",
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
