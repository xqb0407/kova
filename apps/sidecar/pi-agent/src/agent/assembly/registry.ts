/**
 * 能力注册表：生命周期、安装窗口、开关与两级装配。
 *
 * 三条不变量：
 * - 注册只能在 `install()` 执行期间发生；安装结束后再调 host 的注册方法直接抛错。
 * - 装配开始前先快照所有开关，await 贡献期间不读取可能变化的状态。
 * - 单个能力安装失败只隔离该能力（记入 failedCapabilities，注册表仍 ready）；
 *   只有遍历层面的意外错误才整体失败。两种失败都不保留半套贡献。
 */
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { logErr } from "../../log";
import type {
  AssemblyDiagnostics,
  Capability,
  CapabilityHost,
  CapabilityState,
  HookEntry,
  Reminder,
  ReminderContributor,
  SessionPlan,
  SessionSnapshot,
  SystemTextContributor,
  ToolAfterHandler,
  ToolBeforeHandler,
  ToolFactory,
  TurnEndHandler,
  TurnPlan,
  TurnSnapshot,
  UserTextContributor,
} from "./contracts";

type RegistryState = "new" | "installing" | "ready" | "failed";

type LoadedCapability = {
  readonly capability: Capability;
  readonly tools: ToolFactory[];
  readonly systemTexts: SystemTextContributor[];
  readonly userTexts: UserTextContributor[];
  readonly reminders: ReminderContributor[];
  readonly toolBefore: HookEntry<ToolBeforeHandler>[];
  readonly toolAfter: HookEntry<ToolAfterHandler>[];
  readonly turnEnd: HookEntry<TurnEndHandler>[];
  settingsEnabled?: boolean;
};

type EnablementSnapshot = readonly {
  readonly loaded: LoadedCapability;
  readonly enabled: boolean;
}[];

const EMPTY_DIAGNOSTICS: AssemblyDiagnostics = { enabled: [], disabled: [] };

function createEmptyCapability(capability: Capability): LoadedCapability {
  return {
    capability,
    tools: [],
    systemTexts: [],
    userTexts: [],
    reminders: [],
    toolBefore: [],
    toolAfter: [],
    turnEnd: [],
  };
}

function normalizeOrder(order: number | undefined): number {
  return typeof order === "number" && Number.isFinite(order) ? order : 100;
}

function sortHooks<T>(entries: readonly HookEntry<T>[]): HookEntry<T>[] {
  return [...entries].sort((left, right) => left.order - right.order);
}

function dedupeReminders(
  entries: readonly { reminder: Reminder; capabilityId: string }[],
): Reminder[] {
  const sorted = [...entries].sort(
    (left, right) => (right.reminder.priority ?? 0) - (left.reminder.priority ?? 0),
  );
  const seen = new Set<string>();
  const output: Reminder[] = [];
  for (const entry of sorted) {
    const key = entry.reminder.key?.trim();
    if (key) {
      if (seen.has(key)) continue;
      seen.add(key);
    }
    output.push(entry.reminder);
  }
  return output;
}

export class CapabilityRegistry {
  private readonly loaded = new Map<string, LoadedCapability>();
  private readonly sessionOverrides = new Map<string, Map<string, boolean>>();
  private readonly failed = new Map<string, unknown>();
  private state: RegistryState = "new";
  private activeOwner: LoadedCapability | null = null;
  private failure: unknown;

  register(capability: Capability): void {
    this.assertState("new", "register");
    if (this.loaded.has(capability.id)) {
      throw new Error(`CapabilityRegistry: duplicate capability id "${capability.id}"`);
    }
    this.loaded.set(capability.id, createEmptyCapability(capability));
  }

  /**
   * 安装全部已注册能力。单个能力安装失败只隔离该能力（记入 failures），
   * 其余能力照常工作；注册表仍进入 ready，诊断面能看到失败原因。
   */
  async installAll(
    paramsByCapability: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {},
  ): Promise<void> {
    this.assertState("new", "installAll");
    this.state = "installing";
    try {
      for (const loaded of [...this.loaded.values()]) {
        this.activeOwner = loaded;
        try {
          await loaded.capability.install(
            this.createHost(loaded, paramsByCapability[loaded.capability.id] ?? {}),
          );
        } catch (error) {
          this.failure = error;
          this.failed.set(loaded.capability.id, error);
          this.loaded.delete(loaded.capability.id);
          logErr(
            `capability-registry: ${loaded.capability.id} install failed; ` +
              "capability disabled for this process:",
            error,
          );
        } finally {
          this.activeOwner = null;
        }
      }
      this.state = "ready";
    } catch (error) {
      // 兜底：遍历/注册表层面的意外错误仍然整体失败。
      this.failure = error;
      this.state = "failed";
      this.loaded.clear();
      this.sessionOverrides.clear();
      logErr("capability-registry: install failed:", error);
      throw error;
    }
  }

  lifecycleState(): RegistryState {
    return this.state;
  }

  /**
   * 整体安装失败的兜底诊断（lifecycle === "failed" 时才有值）。
   * 单能力安装失败不进这里——用 failedCapabilities()，那类失败注册表仍是 ready。
   */
  failureReason(): unknown {
    return this.state === "failed" ? this.failure : undefined;
  }

  /** 安装失败被隔离的能力及原因（诊断用）。 */
  failedCapabilities(): readonly { id: string; message: string }[] {
    return [...this.failed.entries()].map(([id, error]) => ({
      id,
      message: error instanceof Error ? error.message : String(error),
    }));
  }

  setEnabled(capabilityId: string, enabled: boolean, sessionId?: string): void {
    const loaded = this.loaded.get(capabilityId);
    if (!loaded) {
      throw new Error(`CapabilityRegistry: unknown capability id "${capabilityId}"`);
    }
    if (sessionId) {
      let overrides = this.sessionOverrides.get(sessionId);
      if (!overrides) {
        overrides = new Map();
        this.sessionOverrides.set(sessionId, overrides);
      }
      overrides.set(capabilityId, enabled);
      return;
    }
    loaded.settingsEnabled = enabled;
  }

  /** 清掉全部全局设置开关，回落到各自的 defaultEnabled；会话级覆盖不动。 */
  clearSettingsEnablement(): void {
    for (const loaded of this.loaded.values()) loaded.settingsEnabled = undefined;
  }

  isEnabled(capabilityId: string, sessionId?: string): boolean {
    const loaded = this.loaded.get(capabilityId);
    if (!loaded) return false;
    return this.resolveEnabled(loaded, sessionId);
  }

  disposeSession(sessionId: string): void {
    this.sessionOverrides.delete(sessionId);
    for (const loaded of this.loaded.values()) {
      try {
        loaded.capability.disposeSession?.(sessionId);
      } catch (error) {
        logErr(
          `capability-registry: ${loaded.capability.id}.disposeSession failed:`,
          error,
        );
      }
    }
  }

  list(sessionId?: string): CapabilityState[] {
    return [...this.loaded.values()].map((loaded) => ({
      id: loaded.capability.id,
      ...(loaded.capability.title ? { title: loaded.capability.title } : {}),
      enabled: this.resolveEnabled(loaded, sessionId),
      contributions: {
        tools: loaded.tools.length,
        systemTexts: loaded.systemTexts.length,
        userTexts: loaded.userTexts.length,
        reminders: loaded.reminders.length,
        toolBefore: loaded.toolBefore.length,
        toolAfter: loaded.toolAfter.length,
        turnEnd: loaded.turnEnd.length,
      },
    }));
  }

  async assembleSession(
    snapshot: SessionSnapshot,
    seedTools: readonly AgentTool[],
  ): Promise<SessionPlan> {
    this.assertAssemblyReady("assembleSession");
    const enablement = this.snapshotEnablement(snapshot.sessionId);
    if (enablement.length === 0) {
      return { tools: [...seedTools], systemSuffix: "", diagnostics: EMPTY_DIAGNOSTICS };
    }

    const tools = [...seedTools];
    const toolNames = new Set(tools.map((tool) => tool.name));
    const systemBlocks: string[] = [];
    const enabledIds: string[] = [];
    const disabledIds: string[] = [];

    for (const { loaded, enabled } of enablement) {
      if (!enabled) {
        disabledIds.push(loaded.capability.id);
        continue;
      }
      enabledIds.push(loaded.capability.id);

      for (const factory of loaded.tools) {
        const contribution = factory(snapshot);
        if (!contribution) continue;
        const catalog = Array.isArray(contribution) ? contribution : [contribution];
        for (const tool of catalog) {
          if (toolNames.has(tool.name)) {
            throw new Error(
              `CapabilityRegistry: capability "${loaded.capability.id}" contributed ` +
                `duplicate tool "${tool.name}"`,
            );
          }
          toolNames.add(tool.name);
          tools.push(tool);
        }
      }

      for (const contributor of loaded.systemTexts) {
        const text = await contributor(snapshot);
        if (text && text.trim()) systemBlocks.push(text);
      }
    }

    return {
      tools,
      systemSuffix: systemBlocks.join("\n\n"),
      diagnostics: { enabled: enabledIds, disabled: disabledIds },
    };
  }

  async assembleTurn(snapshot: TurnSnapshot): Promise<TurnPlan> {
    this.assertAssemblyReady("assembleTurn");
    const enablement = this.snapshotEnablement(snapshot.sessionId);
    const userBlocks: string[] = [];
    const reminders: { reminder: Reminder; capabilityId: string }[] = [];
    const toolBefore: HookEntry<ToolBeforeHandler>[] = [];
    const toolAfter: HookEntry<ToolAfterHandler>[] = [];
    const turnEnd: HookEntry<TurnEndHandler>[] = [];
    const enabledIds: string[] = [];
    const disabledIds: string[] = [];

    for (const { loaded, enabled } of enablement) {
      if (!enabled) {
        disabledIds.push(loaded.capability.id);
        continue;
      }
      enabledIds.push(loaded.capability.id);

      for (const contributor of loaded.userTexts) {
        const text = await contributor(snapshot);
        if (text && text.trim()) userBlocks.push(text);
      }
      for (const contributor of loaded.reminders) {
        const reminder = await contributor(snapshot);
        if (reminder && reminder.text.trim()) {
          reminders.push({ reminder, capabilityId: loaded.capability.id });
        }
      }
      toolBefore.push(...loaded.toolBefore);
      toolAfter.push(...loaded.toolAfter);
      turnEnd.push(...loaded.turnEnd);
    }

    return {
      snapshot,
      userPrefix: userBlocks.join("\n\n"),
      reminders: dedupeReminders(reminders),
      hooks: {
        toolBefore: sortHooks(toolBefore),
        toolAfter: sortHooks(toolAfter),
        turnEnd: sortHooks(turnEnd),
      },
      diagnostics: { enabled: enabledIds, disabled: disabledIds },
    };
  }

  private createHost(
    owner: LoadedCapability,
    params: Readonly<Record<string, unknown>>,
  ): CapabilityHost {
    return {
      params,
      tool: (factory) => {
        this.assertActiveOwner(owner, "tool");
        owner.tools.push(factory);
      },
      systemText: (contributor) => {
        this.assertActiveOwner(owner, "systemText");
        owner.systemTexts.push(contributor);
      },
      userText: (contributor) => {
        this.assertActiveOwner(owner, "userText");
        owner.userTexts.push(contributor);
      },
      reminder: (contributor) => {
        this.assertActiveOwner(owner, "reminder");
        owner.reminders.push(contributor);
      },
      onToolBefore: (handler, order) => {
        this.assertActiveOwner(owner, "onToolBefore");
        owner.toolBefore.push({
          capabilityId: owner.capability.id,
          order: normalizeOrder(order),
          handler,
        });
      },
      onToolAfter: (handler, order) => {
        this.assertActiveOwner(owner, "onToolAfter");
        owner.toolAfter.push({
          capabilityId: owner.capability.id,
          order: normalizeOrder(order),
          handler,
        });
      },
      onTurnEnd: (handler, order) => {
        this.assertActiveOwner(owner, "onTurnEnd");
        owner.turnEnd.push({
          capabilityId: owner.capability.id,
          order: normalizeOrder(order),
          handler,
        });
      },
    };
  }

  private snapshotEnablement(sessionId: string): EnablementSnapshot {
    const overrides = this.sessionOverrides.get(sessionId);
    return [...this.loaded.values()].map((loaded) => ({
      loaded,
      enabled: this.resolveEnabled(loaded, sessionId, overrides),
    }));
  }

  private resolveEnabled(
    loaded: LoadedCapability,
    sessionId?: string,
    overrides = sessionId ? this.sessionOverrides.get(sessionId) : undefined,
  ): boolean {
    const override = overrides?.get(loaded.capability.id);
    if (override !== undefined) return override;
    if (loaded.settingsEnabled !== undefined) return loaded.settingsEnabled;
    return loaded.capability.defaultEnabled ?? false;
  }

  private assertState(expected: RegistryState, method: string): void {
    if (this.state !== expected) {
      throw new Error(
        `CapabilityRegistry.${method} requires state "${expected}"; current state is "${this.state}"`,
      );
    }
  }

  private assertActiveOwner(owner: LoadedCapability, method: string): void {
    if (this.state !== "installing" || this.activeOwner !== owner) {
      throw new Error(
        `CapabilityRegistry.${method}: capability "${owner.capability.id}" ` +
          "registered outside its install() window",
      );
    }
  }

  private assertAssemblyReady(method: string): void {
    if (this.state === "installing") {
      throw new Error(`CapabilityRegistry.${method} called during installAll()`);
    }
  }
}
