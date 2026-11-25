/**
 * UHP subsystem entry: lifecycle, settings, and desktop commands.
 */
import { app } from "electron";
import type { UhpHarness } from "uhp-protocol";
import { logError, logInfo } from "../logging";
import { PiUhpBridge } from "./bridge";
import { UhpServer, type UhpServerStatus } from "./server";
import {
  ensureUhpApiKey,
  getUhpApiKey,
  hasUhpApiKey,
  loadUhpConfig,
  maskApiKey,
  rotateUhpApiKey,
  saveUhpConfig,
  ensureUhpDirs,
} from "./settings";
import { isUhpApprovalLevel } from "./config";
import type { UhpServerConfig } from "./types";
import {
  listEnabledHarnesses,
  removeHarnessProfile,
  saveHarnessProfile,
  toWireHarness,
} from "./harness-registry";
import {
  deleteUhpClientServer,
  discoverUhpClientServer,
  listUhpClientServers,
  saveUhpClientServer,
} from "./client-registry";

let server: UhpServer | null = null;
let quitHooked = false;

function getServer(): UhpServer {
  if (!server) {
    server = new UhpServer({
      bridge: new PiUhpBridge(),
      getToken: () => getUhpApiKey(),
      getConfig: () => loadUhpConfig(),
    });
  }
  return server;
}

export type UhpSettingsView = UhpServerConfig & {
  hasApiKey: boolean;
  apiKeyMasked: string | null;
};

export function uhpSettingsView(): UhpSettingsView {
  const config = loadUhpConfig();
  const token = getUhpApiKey(config);
  return {
    ...config,
    apiKeyCipher: null,
    hasApiKey: hasUhpApiKey(config),
    apiKeyMasked: maskApiKey(token),
  };
}

export async function startUhpServer(port?: number | null): Promise<UhpServerStatus> {
  ensureUhpDirs();
  ensureUhpApiKey();
  const status = await getServer().start(port);
  if (!quitHooked) {
    quitHooked = true;
    app.once("before-quit", () => {
      void stopUhpServer().catch(() => undefined);
    });
  }
  return status;
}

export async function stopUhpServer(): Promise<UhpServerStatus> {
  if (!server) return { running: false, port: null, url: null, conformanceClass: "extended" };
  const status = server.status();
  await server.stop();
  return { ...status, running: false, port: null, url: null };
}

export async function autoStartUhpServer(): Promise<void> {
  const config = loadUhpConfig();
  if (!config.enabled) return;
  try {
    await startUhpServer(config.port);
    logInfo(`[uhp] auto-started on port ${config.port}`);
  } catch (error) {
    logError(`[uhp] auto-start failed: ${String(error)}`);
  }
}

export function uhpServerStatus(): UhpServerStatus & {
  settings: UhpSettingsView;
  harnesses: UhpHarness[];
  apiKeyMasked: string | null;
} {
  const status = server?.status() ?? {
    running: false,
    port: null,
    url: null,
    conformanceClass: "extended" as const,
  };
  return {
    ...status,
    settings: uhpSettingsView(),
    harnesses: listEnabledHarnesses().map(toWireHarness),
    apiKeyMasked: uhpSettingsView().apiKeyMasked,
  };
}

export function uhpListHarnesses(): UhpHarness[] {
  return listEnabledHarnesses().map(toWireHarness);
}

export function uhpSaveHarness(input: Record<string, unknown>): UhpHarness {
  const id = typeof input.id === "string" ? input.id : undefined;
  const profile = saveHarnessProfile({
    ...(id ? { id } : {}),
    name: typeof input.name === "string" ? input.name : undefined,
    base: typeof input.base === "string" ? input.base : undefined,
    defaultModel: typeof input.defaultModel === "string" ? input.defaultModel : undefined,
    systemPrompt: typeof input.systemPrompt === "string" ? input.systemPrompt : undefined,
    approvalLevel: isUhpApprovalLevel(input.approvalLevel)
      ? input.approvalLevel
      : undefined,
    workspace: typeof input.workspace === "string" ? input.workspace : undefined,
    maxStep: typeof input.maxStep === "number" ? input.maxStep : undefined,
    timeoutSeconds: typeof input.timeoutSeconds === "number" ? input.timeoutSeconds : undefined,
    enabled: typeof input.enabled === "boolean" ? input.enabled : undefined,
  });
  return toWireHarness(profile);
}

export function uhpDeleteHarness(id: string): boolean {
  return removeHarnessProfile(id);
}

export function setupUhpCommands(
  register: (name: string, fn: (args: any) => unknown) => void,
): void {
  register("uhp_get_settings", () => uhpSettingsView());
  register("uhp_status", () => uhpServerStatus());
  register("uhp_start", async (args: any) => {
    const config = loadUhpConfig();
    const port = typeof args?.port === "number" ? args.port : config.port;
    saveUhpConfig({ enabled: true, port });
    try {
      const { token } = ensureUhpApiKey();
      const status = await startUhpServer(port);
      return { ...status, ...(token ? { apiKey: token } : {}) };
    } catch (error) {
      // Do not leave the persisted switch enabled when the listener failed
      // (most commonly EADDRINUSE); the next app start would retry silently.
      saveUhpConfig({ enabled: false });
      throw error;
    }
  });
  register("uhp_stop", async () => {
    saveUhpConfig({ enabled: false });
    return stopUhpServer();
  });
  register("uhp_set_settings", async (args: any) => {
    const patch: Partial<UhpServerConfig> = {};
    if (typeof args?.enabled === "boolean") patch.enabled = args.enabled;
    if (args?.port !== undefined) patch.port = Number(args.port);
    if (typeof args?.workspaceRoot === "string") patch.workspaceRoot = args.workspaceRoot;
    if (typeof args?.approvalLevel === "string") patch.approvalLevel = args.approvalLevel;
    if (args?.maxConcurrentTasks !== undefined) patch.maxConcurrentTasks = Number(args.maxConcurrentTasks);
    if (args?.responseRetentionDays !== undefined) patch.responseRetentionDays = Number(args.responseRetentionDays);
    if (typeof args?.defaultHarnessId === "string") patch.defaultHarnessId = args.defaultHarnessId;

    const before = loadUhpConfig();
    const wasRunning = server?.status().running === true;
    const next = saveUhpConfig(patch);
    if (!next.enabled) {
      if (wasRunning) await stopUhpServer();
      return uhpSettingsView();
    }
    try {
      const { token } = ensureUhpApiKey();
      // Workspace/approval changes are read per task and do not need a restart.
      // Only the port (or a stopped server) requires starting the listener.
      if (!wasRunning || before.port !== next.port) {
        if (wasRunning) await stopUhpServer();
        await startUhpServer(next.port);
      }
      return { ...uhpSettingsView(), ...(token ? { apiKey: token } : {}) };
    } catch (error) {
      saveUhpConfig({ enabled: false });
      throw error;
    }
  });
  register("uhp_rotate_key", () => {
    const { token, config } = rotateUhpApiKey();
    return {
      apiKey: token,
      settings: { ...config, apiKeyCipher: null, hasApiKey: true, apiKeyMasked: maskApiKey(token) },
    };
  });
  register("uhp_list_harnesses", () => uhpListHarnesses());
  register("uhp_save_harness", (args: any) => uhpSaveHarness(args ?? {}));
  register("uhp_delete_harness", (args: any) => uhpDeleteHarness(String(args?.id ?? "")));
  register("uhp_client_list_servers", () => listUhpClientServers());
  register("uhp_client_save_server", (args: any) => saveUhpClientServer(args ?? {}));
  register("uhp_client_delete_server", (args: any) =>
    deleteUhpClientServer(String(args?.id ?? "")),
  );
  register("uhp_client_discover", (args: any) =>
    discoverUhpClientServer(String(args?.id ?? "")),
  );
}
