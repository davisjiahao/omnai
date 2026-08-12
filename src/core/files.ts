import { access, appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import YAML from 'yaml';
import type { ZodType } from 'zod';

export async function ensureDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (isNotFound(error)) return false;
    throw error;
  }
}

export async function readText(path: string): Promise<string> {
  return readFile(path, 'utf8');
}

export async function readTextIfExists(path: string): Promise<string | null> {
  try {
    return await readText(path);
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

export async function writeTextAtomic(path: string, content: string): Promise<void> {
  await ensureDir(dirname(path));
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, content, 'utf8');
  await rename(temporaryPath, path);
}

export async function appendJsonLine(path: string, value: unknown): Promise<void> {
  await ensureDir(dirname(path));
  await appendFile(path, `${JSON.stringify(value)}\n`, 'utf8');
}

export async function readYaml<T>(path: string, schema: ZodType<T>): Promise<T> {
  const raw = await readText(path);
  return schema.parse(YAML.parse(raw));
}

export async function writeYaml(path: string, value: unknown): Promise<void> {
  await writeTextAtomic(path, YAML.stringify(value, { lineWidth: 100 }));
}

export async function readJsonLines<T>(path: string): Promise<T[]> {
  const raw = await readTextIfExists(path);
  if (!raw) return [];

  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}
