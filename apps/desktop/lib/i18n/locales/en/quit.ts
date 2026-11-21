import type { zhQuit } from "../zh/quit";

/** 英文词典：与 zh/quit.ts 逐键镜像 */
export const enQuit: typeof zhQuit = {
  hold: "Hold {shortcut} to quit · release to cancel",
  stopping: "Quitting · stopping task {done}/{total}",
  stoppingNoTasks: "Quitting…",
  finalizing: "Shutting down background services…",
  cancel: "Cancel",
  cancelled: "Quit cancelled",
  cancelledPartial: "Quit cancelled · {count} task(s) stopped",
  untitledSession: "Untitled session",
  kind: {
    session: "Session",
    background: "Background command",
    terminal: "Terminal",
    automation: "Automation",
    engine: "AI engine",
    remote: "Remote access",
    im: "Messaging channel",
  },
};
