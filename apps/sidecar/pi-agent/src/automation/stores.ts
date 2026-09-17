// VENDOR: 见本目录 index.ts 溯源头；仅调整相对导入风格，逻辑与上游一致。
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  matchesScheduledTaskScope,
  normalizeScheduledTask,
  type ScheduledTask,
  type ScheduledTaskStore,
  type SchedulerLock,
  type TaskSchedulerScope,
} from './index';
import { readJsonFile, writeJsonFile } from './json-file';

export class JsonScheduledTaskStore implements ScheduledTaskStore {
  private loaded = false;
  private readonly tasks = new Map<string, ScheduledTask>();
  private writeTail: Promise<unknown> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async list(scope: TaskSchedulerScope = {}): Promise<ScheduledTask[]> {
    await this.load();
    return Array.from(this.tasks.values()).filter((task) => matchesScheduledTaskScope(task, scope));
  }

  async get(taskId: string, scope: TaskSchedulerScope = {}): Promise<ScheduledTask | undefined> {
    await this.load();
    const task = this.tasks.get(taskId);
    return task && matchesScheduledTaskScope(task, scope) ? task : undefined;
  }

  async create(task: ScheduledTask): Promise<ScheduledTask> {
    const normalized = normalizeScheduledTask(task);
    await this.updateState(() => {
      this.tasks.set(normalized.id, normalized);
    });
    return normalized;
  }

  async update(
    taskId: string,
    task: ScheduledTask,
    scope: TaskSchedulerScope = {},
  ): Promise<ScheduledTask | undefined> {
    const normalized = normalizeScheduledTask(task);
    const updated = await this.updateState(() => {
      const existing = this.tasks.get(taskId);
      if (!existing || !matchesScheduledTaskScope(existing, scope)) {
        return false;
      }
      this.tasks.set(taskId, normalized);
      return true;
    });
    if (!updated) {
      return undefined;
    }
    return normalized;
  }

  async delete(taskId: string, scope: TaskSchedulerScope = {}): Promise<boolean> {
    return await this.updateState(() => {
      const existing = this.tasks.get(taskId);
      if (!existing || !matchesScheduledTaskScope(existing, scope)) {
        return false;
      }
      return this.tasks.delete(taskId);
    });
  }

  private async load(): Promise<void> {
    if (this.loaded) {
      return;
    }
    const tasks = await readJsonFile<ScheduledTask[]>(this.filePath, []);
    this.tasks.clear();
    for (const rawTask of tasks) {
      const task = normalizeScheduledTask(rawTask);
      this.tasks.set(task.id, task);
    }
    this.loaded = true;
  }

  private async save(): Promise<void> {
    await writeJsonFile(this.filePath, Array.from(this.tasks.values()));
  }

  private async updateState<T>(mutator: () => T): Promise<T> {
    const pending = this.writeTail.then(async () => {
      await this.load();
      const result = mutator();
      await this.save();
      return result;
    });
    this.writeTail = pending.catch(() => undefined);
    return await pending;
  }
}

export class FileSchedulerLock implements SchedulerLock {
  private acquired = false;

  constructor(readonly path: string) {}

  acquire(): boolean {
    mkdirSync(path.dirname(this.path), { recursive: true });
    const holder = this.holderPid();
    if (holder && holder !== process.pid) {
      return false;
    }
    try {
      unlinkSync(this.path);
    } catch {
      // Lock did not exist or was already removed between checks.
    }
    try {
      writeFileSync(this.path, String(process.pid), { flag: 'wx' });
      this.acquired = true;
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        this.acquired = false;
        return false;
      }
      throw error;
    }
  }

  release(): void {
    if (!this.acquired) {
      return;
    }
    try {
      const pid = Number(readFileSync(this.path, 'utf8').trim());
      if (pid === process.pid) {
        unlinkSync(this.path);
      }
    } catch {
      // Lock was already gone; the scheduler is stopping anyway.
    }
    this.acquired = false;
  }

  isAcquired(): boolean {
    return this.acquired;
  }

  holderPid(): number | undefined {
    try {
      const pid = Number(readFileSync(this.path, 'utf8').trim());
      if (Number.isInteger(pid) && pid > 0 && isProcessAlive(pid)) {
        return pid;
      }
      unlinkSync(this.path);
      return undefined;
    } catch {
      return undefined;
    }
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
