// VENDOR: 见本目录 index.ts 溯源头；与上游一致。
import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

export async function readJsonFile<T>(filePath: string, fallback: T): Promise<T> {
  const backupPath = jsonBackupPath(filePath);
  try {
    return await readJsonFileStrict<T>(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return fallback;
    }
    if (error instanceof SyntaxError) {
      try {
        return await readJsonFileStrict<T>(backupPath);
      } catch {
        return fallback;
      }
    }
    throw error;
  }
}

export async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${randomUUID()}.tmp`;
  const backupPath = jsonBackupPath(filePath);
  await copyFile(filePath, backupPath).catch((error) => {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  });
  try {
    await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`);
    await rename(tempPath, filePath);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

function readJsonFileStrict<T>(filePath: string): Promise<T> {
  return readFile(filePath, 'utf8').then((content) => JSON.parse(content) as T);
}

function jsonBackupPath(filePath: string): string {
  return `${filePath}.bak`;
}
