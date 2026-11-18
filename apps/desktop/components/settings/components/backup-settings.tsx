"use client";

import { useEffect, useState, type FC } from "react";
import { listen } from "@/desktop-bridge/event";
import { open as openDialog, save as saveDialog } from "@/desktop-bridge/plugin-dialog";
import {
  CloudIcon,
  DownloadIcon,
  HardDriveDownloadIcon,
  Loader2Icon,
  PlugZapIcon,
  PlusIcon,
  RefreshCwIcon,
  RotateCcwIcon,
  Trash2Icon,
  UploadIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { SettingRow } from "@/components/custom-ui/setting-row";
import { toast } from "@/components/ui/toast";
import {
  BACKUP_PROGRESS_EVENT,
  backupDeleteRemote,
  backupDownload,
  backupListRemote,
  backupPeekHeader,
  backupRestartApp,
  backupRestore,
  backupRun,
  backupTest,
  formatBackupBytes,
  formatBackupTime,
  saveBackupConfig,
  useBackupConfig,
  type BackupConfigSetInput,
  type BackupProgress,
  type BackupProvider,
  type BackupRunResult,
  type RemoteBackup,
  type RestoreStagedResult,
} from "@/lib/settings/backup-config";
import { useT } from "@/lib/i18n";

/**
 * 备份与恢复设置页（设置 → 系统 → 备份）。
 * 数据范围：state.db（kv 设置/会话索引/凭据密文/用量）+ sessions/*.jsonl 始终备份；
 * task-workspace、library、个人配置（~/.kova 身份/记忆/MCP/审批 + 桌宠/站点权限/
 * 设计主题）、技能与插件、检查点按开关。备份包 .piabk 支持口令加密。
 * 恢复走「staging + 重启换入」：校验通过后重启应用才生效，只换入包里实际存在的
 * 分区。OS keychain 主密钥不随备份走，换机恢复后需重输 API key，解不开的密文
 * 凭据会被清理（custom_providers 等明文配置保留）。
 */

const PROVIDERS: { id: BackupProvider; labelKey: string }[] = [
  { id: "off", labelKey: "settings.backup.providerOff" },
  { id: "s3", labelKey: "settings.backup.s3" },
  { id: "webdav", labelKey: "settings.backup.webdav" },
];

export const BackupSettings: FC = () => {
  const t = useT();
  const config = useBackupConfig();
  // 秘密字段本地输入（保存即清空，视图不回传值）
  const [s3SecretInput, setS3SecretInput] = useState("");
  const [davPasswordInput, setDavPasswordInput] = useState("");
  const [passphraseInput, setPassphraseInput] = useState("");
  // 操作状态
  const [testing, setTesting] = useState(false);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<BackupProgress | null>(null);
  const [lastRun, setLastRun] = useState<BackupRunResult | null>(null);
  // 远端列表
  const [backups, setBackups] = useState<RemoteBackup[] | null>(null);
  const [listing, setListing] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);
  // 恢复
  const [restorePass, setRestorePass] = useState("");
  const [restoring, setRestoring] = useState<string | null>(null);
  const [staged, setStaged] = useState<RestoreStagedResult | null>(null);
  const [pendingLocalPath, setPendingLocalPath] = useState<string | null>(null);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    listen<BackupProgress>(BACKUP_PROGRESS_EVENT, (e) => setProgress(e.payload)).then(
      (u) => {
        unlisten = u;
      },
    );
    return () => unlisten?.();
  }, []);

  const update = (patch: Partial<BackupConfigSetInput>) => {
    saveBackupConfig({ ...config, ...patch }).catch(() => toast.error(t("settings.backup.saveFailed")));
  };

  /** 秘密字段：传新值保存后清空本地输入；空值不动。
   *  备份口令例外：未开启「记住口令」时值只存在本页，保留输入供本次备份/恢复使用 */
  const updateSecret = (field: "s3SecretAccessKey" | "davPassword" | "passphrase", value: string) => {
    if (!value) return;
    saveBackupConfig({ ...config, [field]: value })
      .then((view) => {
        if (field === "s3SecretAccessKey") setS3SecretInput("");
        if (field === "davPassword") setDavPasswordInput("");
        if (field === "passphrase" && view.rememberPassphrase) setPassphraseInput("");
        toast.success(t("settings.backup.saved"));
      })
      .catch(() => toast.error(t("settings.backup.saveFailed")));
  };

  const test = async () => {
    if (config.provider === "off") {
      toast.error(t("settings.backup.chooseChannelFirst"));
      return;
    }
    setTesting(true);
    try {
      toast.success(await backupTest());
    } catch (e) {
      toast.error(String(e));
    } finally {
      setTesting(false);
    }
  };

  const finishRun = (r: BackupRunResult) => {
    setLastRun(r);
    setProgress(null);
    toast.success(
      r.remote
        ? t("settings.backup.backupSuccessRemote", {
            name: r.fileName,
            count: r.fileCount,
            encrypted: r.encrypted ? t("settings.backup.encryptedSuffix") : "",
          })
        : t("settings.backup.backupSuccessLocal", {
            count: r.fileCount,
            encrypted: r.encrypted ? t("settings.backup.encryptedSuffix") : "",
          }),
    );
    if (r.remote) void refresh();
  };

  /** 个人配置里的 mcp.json 可能是明文 token：未设口令时先确认，再明文备份 */
  const confirmPlaintextPersonal = () => {
    if (!config.includePersonal || config.passphraseSet || passphraseInput) return true;
    return window.confirm(t("settings.backup.plaintextConfirm"));
  };

  const runRemote = async () => {
    if (config.provider === "off") {
      toast.error(t("settings.backup.chooseAndConfigureChannel"));
      return;
    }
    if (!confirmPlaintextPersonal()) return;
    setRunning(true);
    try {
      finishRun(await backupRun("remote", undefined, passphraseInput || undefined));
    } catch (e) {
      setProgress(null);
      toast.error(String(e));
    } finally {
      setRunning(false);
    }
  };

  const runLocal = async () => {
    if (!confirmPlaintextPersonal()) return;
    const path = await saveDialog({
      title: t("settings.backup.saveLocalTitle"),
      defaultPath: `pi-backup-${new Date().toISOString().slice(0, 10)}.piabk`,
      filters: [{ name: t("settings.backup.backupFilter"), extensions: ["piabk"] }],
    });
    if (!path) return;
    setRunning(true);
    try {
      finishRun(await backupRun("local", path, passphraseInput || undefined));
    } catch (e) {
      setProgress(null);
      toast.error(String(e));
    } finally {
      setRunning(false);
    }
  };

  const refresh = async () => {
    if (config.provider === "off") {
      toast.error(t("settings.backup.chooseChannelFirst"));
      return;
    }
    setListing(true);
    try {
      setBackups(await backupListRemote());
    } catch (e) {
      setBackups([]);
      toast.error(String(e));
    } finally {
      setListing(false);
    }
  };

  const doDelete = async (name: string) => {
    setDeleting(name);
    try {
      const msg = await backupDeleteRemote(name);
      setBackups((prev) => prev?.filter((b) => b.name !== name) ?? null);
      toast.success(msg);
    } catch (e) {
      toast.error(String(e));
    } finally {
      setDeleting(null);
    }
  };

  const doDownload = async (name: string) => {
    const path = await saveDialog({
      title: t("settings.backup.downloadTitle"),
      defaultPath: name,
      filters: [{ name: t("settings.backup.backupFilter"), extensions: ["piabk"] }],
    });
    if (!path) return;
    try {
      await backupDownload(name, path);
      toast.success(t("settings.backup.downloaded", { path }));
    } catch (e) {
      toast.error(String(e));
    }
  };

  const applyStaged = (r: RestoreStagedResult) => {
    setStaged(r);
    setPendingLocalPath(null);
    toast.success(t("settings.backup.stagedSuccess"));
  };

  const doRestoreRemote = async (b: RemoteBackup) => {
    if (b.encrypted && !restorePass) {
      toast.error(t("settings.backup.encryptedNeedsPass"));
      return;
    }
    setRestoring(b.name);
    try {
      applyStaged(await backupRestore({ remoteName: b.name, passphrase: restorePass || undefined }));
    } catch (e) {
      toast.error(String(e));
    } finally {
      setRestoring(null);
    }
  };

  const doRestoreLocal = async (path?: string) => {
    const target = path ?? (await openDialog({
      title: t("settings.backup.chooseFileTitle"),
      multiple: false,
      filters: [{ name: t("settings.backup.backupFilter"), extensions: ["piabk"] }],
    }));
    if (!target || typeof target !== "string") return;
    try {
      const header = await backupPeekHeader(target);
      if (header.encrypted && !restorePass) {
        setPendingLocalPath(target);
        toast.error(t("settings.backup.encryptedNeedsPassRetry"));
        return;
      }
      setRestoring(target);
      try {
        applyStaged(await backupRestore({ localPath: target, passphrase: restorePass || undefined }));
      } finally {
        setRestoring(null);
      }
    } catch (e) {
      setPendingLocalPath(null);
      toast.error(String(e));
    }
  };

  const progressPct =
    progress && progress.total > 0 ? Math.min(100, Math.round((progress.done / progress.total) * 100)) : null;

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <div className="flex w-full max-w-5xl flex-col gap-8 self-center px-8 py-8">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-bold tracking-tight">{t("settings.backup.title")}</h1>
        </div>

        {staged && (
          <div className="bg-muted/50 flex items-center justify-between gap-3 rounded-2xl p-3">
            <div className="min-w-0 text-sm">
              <div>
                {t("settings.backup.stagedTitle", {
                  count: staged.header.fileCount,
                  device: staged.header.device,
                  date: staged.header.createdAt,
                })}
              </div>
              {staged.libraryRootHint && (
                <div className="text-muted-foreground mt-1 text-xs leading-5">
                  {t("settings.backup.stagedLibraryHint", {
                    path: staged.libraryRootHint,
                  })}
                </div>
              )}
            </div>
            <Button size="sm" className="h-8 shrink-0 gap-1.5" onClick={() => void backupRestartApp()}>
              <RotateCcwIcon className="size-3.5" />
              {t("settings.backup.restartNow")}
            </Button>
          </div>
        )}

        <section className="flex flex-col gap-3">
          <h2 className="text-base font-semibold">{t("settings.backup.sectionContent")}</h2>
          <div className="bg-muted/50 flex flex-col gap-1 rounded-2xl p-2">
            <SettingRow
              label={t("settings.backup.coreData")}
              desc={t("settings.backup.coreDataDesc")}
            >
              <span className="text-muted-foreground text-[13px] leading-5">{t("settings.backup.alwaysBackedUp")}</span>
            </SettingRow>
            <SettingRow
              label={t("settings.backup.includeWorkspace")}
              desc={t("settings.backup.includeWorkspaceDesc")}
            >
              <Switch
                checked={config.includeWorkspace}
                onCheckedChange={(v) => update({ includeWorkspace: v })}
              />
            </SettingRow>
            <SettingRow
              label={t("settings.backup.includeLibrary")}
              desc={t("settings.backup.includeLibraryDesc")}
            >
              <Switch
                checked={config.includeLibrary}
                onCheckedChange={(v) => update({ includeLibrary: v })}
              />
            </SettingRow>
            <SettingRow
              label={t("settings.backup.includePersonal")}
              desc={t("settings.backup.includePersonalDesc")}
            >
              <Switch
                checked={config.includePersonal}
                onCheckedChange={(v) => update({ includePersonal: v })}
              />
            </SettingRow>
            <SettingRow
              label={t("settings.backup.includeSkillsPlugins")}
              desc={t("settings.backup.includeSkillsPluginsDesc")}
            >
              <Switch
                checked={config.includeSkillsPlugins}
                onCheckedChange={(v) => update({ includeSkillsPlugins: v })}
              />
            </SettingRow>
            <SettingRow
              label={t("settings.backup.includeCheckpoints")}
              desc={t("settings.backup.includeCheckpointsDesc")}
            >
              <Switch
                checked={config.includeCheckpoints}
                onCheckedChange={(v) => update({ includeCheckpoints: v })}
              />
            </SettingRow>
            <SettingRow label={t("settings.backup.deviceName")} desc={t("settings.backup.deviceNameDesc")}>
              <Input
                value={config.deviceName}
                onChange={(e) => update({ deviceName: e.target.value })}
                placeholder="desktop"
                className="h-8 max-w-48 text-sm bg-background"
              />
            </SettingRow>
            <SettingRow
              label={t("settings.backup.passphrase")}
              desc={t("settings.backup.passphraseDesc")}
            >
              <div className="flex w-full max-w-md items-center gap-2">
                <Input
                  type="password"
                  value={passphraseInput}
                  onChange={(e) => setPassphraseInput(e.target.value)}
                  onBlur={() => updateSecret("passphrase", passphraseInput)}
                  placeholder={config.passphraseSet ? t("settings.backup.passphraseSetPlaceholder") : t("settings.backup.passphraseUnsetPlaceholder")}
                  className="h-8 text-sm bg-background"
                />
                <div className="flex shrink-0 items-center gap-1.5">
                  <span className="text-muted-foreground text-[13px] leading-5">{t("settings.backup.rememberPassphrase")}</span>
                  <Switch
                    checked={config.rememberPassphrase}
                    onCheckedChange={(v) => update({ rememberPassphrase: v })}
                  />
                </div>
              </div>
            </SettingRow>
          </div>
          <p className="text-muted-foreground/70 text-[13px] leading-5">
            {t("settings.backup.notBackedUp")}
          </p>
        </section>

        <section className="flex flex-col gap-3">
          <h2 className="text-base font-semibold">{t("settings.backup.sectionTarget")}</h2>
          <div className="bg-muted/50 flex flex-col gap-1 rounded-2xl p-2">
            <SettingRow label={t("settings.backup.channel")} desc={t("settings.backup.channelDesc")}>
              <div className="flex items-center gap-1">
                {PROVIDERS.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => update({ provider: p.id })}
                    className={config.provider === p.id ? "bg-background shadow-sm rounded-lg px-3 py-1 text-sm font-medium" : "text-muted-foreground hover:text-foreground rounded-lg px-3 py-1 text-sm"}
                  >
                    {t(p.labelKey)}
                  </button>
                ))}
              </div>
            </SettingRow>

            {config.provider === "s3" && (
              <>
                <SettingRow label={t("settings.backup.endpoint")} desc={t("settings.backup.endpointDesc")}>
                  <Input
                    value={config.s3Endpoint}
                    onChange={(e) => update({ s3Endpoint: e.target.value })}
                    placeholder="https://s3.us-east-1.amazonaws.com"
                    className="h-8 max-w-md text-sm bg-background"
                  />
                </SettingRow>
                <SettingRow label={t("settings.backup.region")} desc={t("settings.backup.regionDesc")}>
                  <Input
                    value={config.s3Region}
                    onChange={(e) => update({ s3Region: e.target.value })}
                    className="h-8 max-w-48 text-sm bg-background"
                  />
                </SettingRow>
                <SettingRow label={t("settings.backup.bucket")} desc={t("settings.backup.bucketDesc")}>
                  <Input
                    value={config.s3Bucket}
                    onChange={(e) => update({ s3Bucket: e.target.value })}
                    className="h-8 max-w-48 text-sm bg-background"
                    placeholder={t("settings.backup.bucketPlaceholder")}
                  />
                </SettingRow>
                <SettingRow label={t("settings.backup.prefix")} desc={t("settings.backup.prefixDesc")}>
                  <Input
                    value={config.s3Prefix}
                    onChange={(e) => update({ s3Prefix: e.target.value })}
                    className="h-8 max-w-48 text-sm bg-background"
                    placeholder={t("settings.backup.prefixPlaceholder")}
                  />
                </SettingRow>
                <SettingRow label={t("settings.backup.accessKeyId")}>
                  <Input
                    value={config.s3AccessKeyId}
                    onChange={(e) => update({ s3AccessKeyId: e.target.value })}
                    className="h-8 max-w-md font-mono text-sm bg-background"
                    placeholder="Access Key ID "
                  />
                </SettingRow>
                <SettingRow
                  label={t("settings.backup.secretAccessKey")}
                  desc={config.s3SecretAccessKeySet ? t("settings.backup.secretSaved") : t("settings.backup.secretUnset")}
                >
                  <Input
                    type="password"
                    value={s3SecretInput}
                    onChange={(e) => setS3SecretInput(e.target.value)}
                    onBlur={() => updateSecret("s3SecretAccessKey", s3SecretInput)}
                    className="h-8 max-w-md font-mono text-sm bg-background"
                    placeholder="Secret Access Key"
                  />
                </SettingRow>
                <SettingRow
                  label={t("settings.backup.pathStyle")}
                  desc={t("settings.backup.pathStyleDesc")}
                >
                  <Switch
                    checked={config.s3PathStyle}
                    onCheckedChange={(v) => update({ s3PathStyle: v })}
                  />
                </SettingRow>
              </>
            )}

            {config.provider === "webdav" && (
              <>
                <SettingRow label={t("settings.backup.serverUrl")} desc={t("settings.backup.serverUrlDesc")}>
                  <Input
                    value={config.davUrl}
                    onChange={(e) => update({ davUrl: e.target.value })}
                    placeholder="https://dav.example.com/dav/"
                    className="h-8 max-w-md text-sm bg-background"
                  />
                </SettingRow>
                <SettingRow label={t("settings.backup.username")}>
                  <Input
                    value={config.davUsername}
                    onChange={(e) => update({ davUsername: e.target.value })}
                    autoComplete="off"
                    placeholder={t("settings.backup.username")}
                    className="h-8 max-w-48 text-sm bg-background"
                  />
                </SettingRow>
                <SettingRow
                  label={t("settings.backup.password")}
                  desc={config.davPasswordSet ? t("settings.backup.secretSaved") : t("settings.backup.secretUnset")}
                >
                  <Input
                    type="password"
                    value={davPasswordInput}
                    onChange={(e) => setDavPasswordInput(e.target.value)}
                    onBlur={() => updateSecret("davPassword", davPasswordInput)}
                    className="h-8 max-w-md text-sm bg-background"
                    placeholder={t("settings.backup.password")}
                  />
                </SettingRow>
                <SettingRow label={t("settings.backup.subdir")} desc={t("settings.backup.subdirDesc")}>
                  <Input
                    value={config.davSubdir}
                    onChange={(e) => update({ davSubdir: e.target.value })}
                    placeholder="home/pi-backups"
                    className="h-8 max-w-48 text-sm bg-background"

                  />
                </SettingRow>
              </>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void test()}
              disabled={testing || config.provider === "off"}
              className="bg-primary text-primary-foreground hover:bg-primary/90 inline-flex h-8 items-center gap-1.5 rounded-lg px-3 text-[13px] leading-5 font-medium disabled:opacity-60"
            >
              {testing ? <Loader2Icon className="size-3.5 animate-spin" /> : <PlugZapIcon className="size-3.5" />}
              {t("settings.backup.testConnection")}
            </button>
            <span className="text-muted-foreground text-[13px] leading-5">
              {t("settings.backup.testConnectionDesc")}
            </span>
          </div>
        </section>

        <section className="flex flex-col gap-3">
          <h2 className="text-base font-semibold">{t("settings.backup.sectionBackupNow")}</h2>
          <div className="bg-muted/50 flex flex-col gap-1 rounded-2xl p-2">
            <SettingRow
              label={t("settings.backup.backupToRemote")}
              desc={config.provider === "off"
                ? t("settings.backup.backupToRemoteDescOff")
                : t("settings.backup.backupToRemoteDesc", { provider: config.provider.toUpperCase() })}
            >
              <button
                type="button"
                onClick={() => void runRemote()}
                disabled={running || config.provider === "off"}
                className="bg-primary text-primary-foreground hover:bg-primary/90 inline-flex h-8 items-center gap-1.5 rounded-lg px-3 text-[13px] leading-5 font-medium disabled:opacity-60"
              >
                {running ? <Loader2Icon className="size-3.5 animate-spin" /> : <UploadIcon className="size-3.5" />}
                {t("settings.backup.backupNow")}
              </button>
            </SettingRow>
            <SettingRow label={t("settings.backup.backupToLocal")} desc={t("settings.backup.backupToLocalDesc")}>
              <button
                type="button"
                onClick={() => void runLocal()}
                disabled={running}
                className="bg-background border-border hover:bg-muted inline-flex h-8 items-center gap-1.5 rounded-lg border px-3 text-[13px] leading-5 font-medium disabled:opacity-60"
              >
                <HardDriveDownloadIcon className="size-3.5" />
                {t("settings.backup.chooseLocation")}
              </button>
            </SettingRow>
            {progress && (
              <div className="flex flex-col gap-1 px-3 py-2">
                <div className="text-muted-foreground flex items-center justify-between text-[13px] leading-5">
                  <span>
                    {t("settings.backup.progressLine", {
                      phase: t(
                        progress.phase === "db"
                          ? "settings.backup.phaseDb"
                          : progress.phase === "pack"
                            ? "settings.backup.phasePack"
                            : progress.phase === "encrypt"
                              ? "settings.backup.phaseEncrypt"
                              : progress.phase === "upload"
                                ? "settings.backup.phaseUpload"
                                : progress.phase === "download"
                                  ? "settings.backup.phaseDownload"
                                  : progress.phase === "save"
                                    ? "settings.backup.phaseSave"
                                    : "settings.backup.phaseUnpack",
                      ),
                      message: progress.message,
                    })}
                  </span>
                  <span className="tabular-nums">
                    {progressPct !== null ? `${progressPct}%` : ""}
                  </span>
                </div>
                <div className="bg-background h-1.5 overflow-hidden rounded-full">
                  <div
                    className="bg-foreground h-full rounded-full transition-[width]"
                    style={{ width: `${progressPct ?? 0}%` }}
                  />
                </div>
              </div>
            )}
            {lastRun && !progress && (
              <div className="text-muted-foreground px-3 py-2 text-[13px] leading-5">
                {t("settings.backup.lastBackup", {
                  name: lastRun.fileName,
                  size: formatBackupBytes(lastRun.size),
                  count: lastRun.fileCount,
                  encrypted: lastRun.encrypted ? t("settings.backup.encryptedSuffix") : "",
                })}
              </div>
            )}
          </div>
        </section>

        <section className="flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <h2 className="text-base font-semibold">{t("settings.backup.sectionRemote")}</h2>
            <button
              type="button"
              onClick={() => void refresh()}
              disabled={listing || config.provider === "off"}
              className="text-muted-foreground hover:text-foreground inline-flex h-8 items-center gap-1.5 text-[13px] leading-5 disabled:opacity-60"
            >
              <RefreshCwIcon className={listing ? "size-3.5 animate-spin" : "size-3.5"} />
              {t("settings.backup.refresh")}
            </button>
          </div>
          <SettingRow
            label={t("settings.backup.restorePassphrase")}
            desc={t("settings.backup.restorePassphraseDesc")}
          >
            <Input
              type="password"
              value={restorePass}
              onChange={(e) => setRestorePass(e.target.value)}
              placeholder={t("settings.backup.restorePassphrasePlaceholder")}
              className="h-8 max-w-48 text-sm "
            />
          </SettingRow>
          {config.provider === "off" ? (
            <div className="bg-muted/50 text-muted-foreground flex min-h-24 items-center justify-center gap-2 rounded-2xl text-sm">
              <CloudIcon className="size-4" />
              {t("settings.backup.noChannel")}
            </div>
          ) : backups === null ? (
            <div className="bg-muted/50 text-muted-foreground flex min-h-24 items-center justify-center gap-2 rounded-2xl text-sm">
              {t("settings.backup.clickRefresh")}
            </div>
          ) : backups.length === 0 ? (
            <div className="bg-muted/50 text-muted-foreground flex min-h-24 items-center justify-center gap-2 rounded-2xl text-sm">
              <PlusIcon className="size-4" />
              {t("settings.backup.noRemoteBackups")}
            </div>
          ) : (
            <div className="bg-muted/50 flex flex-col gap-1 rounded-2xl p-2">
              {backups.map((b) => (
                <BackupRow
                  key={b.name}
                  item={b}
                  restoring={restoring === b.name}
                  deleting={deleting === b.name}
                  onRestore={() => void doRestoreRemote(b)}
                  onDownload={() => void doDownload(b.name)}
                  onDelete={() => void doDelete(b.name)}
                />
              ))}
            </div>
          )}
        </section>

        <section className="flex flex-col gap-3">
          <h2 className="text-base font-semibold">{t("settings.backup.sectionRestoreLocal")}</h2>
          <div className="bg-muted/50 flex flex-col gap-1 rounded-2xl p-2">
            <SettingRow
              label={t("settings.backup.choosePackage")}
              desc={
                pendingLocalPath
                  ? t("settings.backup.choosePackageDescPending")
                  : t("settings.backup.choosePackageDesc")
              }
            >
              <button
                type="button"
                onClick={() => void doRestoreLocal(pendingLocalPath ?? undefined)}
                disabled={restoring !== null}
                className="bg-background border-border hover:bg-muted inline-flex h-8 items-center gap-1.5 rounded-lg border px-3 text-[13px] leading-5 font-medium disabled:opacity-60"
              >
                {restoring ? <Loader2Icon className="size-3.5 animate-spin" /> : <HardDriveDownloadIcon className="size-3.5" />}
                {t("settings.backup.chooseFile")}
              </button>
            </SettingRow>
          </div>
          <p className="text-muted-foreground/70 text-[13px] leading-5">
            {t("settings.backup.restoreFooter")}
          </p>
        </section>
      </div>
    </div>
  );
};

const BackupRow: FC<{
  item: RemoteBackup;
  restoring: boolean;
  deleting: boolean;
  onRestore: () => void;
  onDownload: () => void;
  onDelete: () => void;
}> = ({ item, restoring, deleting, onRestore, onDownload, onDelete }) => {
  const t = useT();
  const [confirming, setConfirming] = useState(false);

  const del = () => {
    // 两步确认：首次点击进入确认态，3 秒不点自动退出
    if (!confirming) {
      setConfirming(true);
      setTimeout(() => setConfirming(false), 3000);
      return;
    }
    setConfirming(false);
    onDelete();
  };

  return (
    <div className="flex min-h-11 items-center justify-between gap-4 rounded-xl px-3 py-2">
      <div className="min-w-0">
        <div className="flex items-center gap-1.5 truncate text-sm font-medium">
          <span className="truncate">{item.name}</span>
          {item.encrypted && (
            <span className="bg-muted text-muted-foreground shrink-0 rounded px-1 py-0.5 text-2xs">
              {t("settings.backup.encryptedBadge")}
            </span>
          )}
        </div>
        <div className="text-muted-foreground text-[13px] leading-5">
          {formatBackupBytes(item.size)} · {formatBackupTime(item.modified)}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <Button
          variant="ghost"
          size="sm"
          className="h-7 gap-1.5 px-2 text-[13px] leading-5"
          onClick={onDownload}
        >
          <DownloadIcon className="size-3.5" />
          {t("settings.backup.download")}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 gap-1.5 px-2 text-[13px] leading-5"
          onClick={onRestore}
          disabled={restoring}
        >
          {restoring ? (
            <Loader2Icon className="size-3.5 animate-spin" />
          ) : (
            <RotateCcwIcon className="size-3.5" />
          )}
          {t("settings.backup.restore")}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className={confirming
            ? "h-7 gap-1.5 bg-destructive/10 px-2 text-[13px] leading-5 text-destructive hover:bg-destructive/15 hover:text-destructive"
            : "text-muted-foreground hover:text-destructive h-7 gap-1.5 px-2 text-[13px] leading-5 hover:bg-destructive/10"}
          onClick={del}
        >
          <Trash2Icon className="size-3.5" />
          {deleting
            ? t("settings.backup.deleting")
            : confirming
              ? t("settings.backup.confirmDelete")
              : t("settings.backup.delete")}
        </Button>
      </div>
    </div>
  );
};
