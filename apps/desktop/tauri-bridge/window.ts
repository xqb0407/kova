/**
 * `@tauri-apps/api/window` 兼容实现（仅 getCurrentWindow 及其被用到的方法）。
 * 成员映射：主进程 BrowserWindow（label 'main'）。
 */
import { invokeBridge } from "./_host";
import { listen, type Event, type UnlistenFn } from "./event";

class KovaWindow {
  readonly label = "main";

  minimize(): Promise<void> {
    return invokeBridge("win_minimize");
  }
  maximize(): Promise<void> {
    return invokeBridge("win_maximize", {});
  }
  unmaximize(): Promise<void> {
    return invokeBridge("win_unmaximize", {});
  }
  toggleMaximize(): Promise<void> {
    return invokeBridge("win_toggle_maximize", {});
  }
  close(): Promise<void> {
    return invokeBridge("win_close", {});
  }
  hide(): Promise<void> {
    return invokeBridge("win_hide", {});
  }
  show(): Promise<void> {
    return invokeBridge("win_show", {});
  }
  isMaximized(): Promise<boolean> {
    return invokeBridge("win_is_maximized", {});
  }
  setFocus(): Promise<void> {
    return invokeBridge("win_set_focus", {});
  }
  isFocused(): Promise<boolean> {
    return invokeBridge("win_is_focused", {});
  }
  setAlwaysOnTop(flag: boolean): Promise<void> {
    return invokeBridge("win_set_always_on_top", { flag });
  }

  async onResized(handler: (e: Event<{ width: number; height: number }>) => void | Promise<void>): Promise<UnlistenFn> {
    return listen<{ width: number; height: number }>("window-resized", (e) => {
      void handler(e);
    });
  }

  async onCloseRequested(
    handler: (e: { payload: { preventClose: (v: boolean) => void } }) => void | Promise<void>,
  ): Promise<UnlistenFn> {
    // Tauri 语义占位：本项目关窗策略全在主进程（托盘/退出），前端不拦。
    void handler;
    return () => {};
  }
}

export function getCurrentWindow(): KovaWindow {
  return new KovaWindow();
}

export function getAllWindows(): Promise<KovaWindow[]> {
  return Promise.resolve([new KovaWindow()]);
}

export { KovaWindow as Window };
