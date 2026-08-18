import { createHash } from 'node:crypto';
import type { ContentHash } from './types.js';

export function canonicalJson(value: unknown): string {
  const result = JSON.stringify(sortValue(value, new Set(), '$'));
  if (result === undefined) throw new TypeError('Value is not JSON-safe at $');
  return result;
}

export function sha256(value: string | Uint8Array): ContentHash {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

export function hashObject(value: unknown): ContentHash {
  return sha256(canonicalJson(value));
}

function sortValue(value: unknown, ancestors: Set<object>, path: string): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`Value is not JSON-safe at ${path}`);
    return value;
  }
  if (typeof value !== 'object') throw new TypeError(`Value is not JSON-safe at ${path}`);
  if (ancestors.has(value)) throw new TypeError(`Value is not JSON-safe at ${path}: circular reference`);

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const keys = Object.keys(value);
      if (Object.getOwnPropertySymbols(value).length > 0 ||
          keys.some((key, index) => key !== String(index)) ||
          keys.length !== value.length ||
          Object.getOwnPropertyNames(value).length !== value.length + 1) {
        throw new TypeError(`Value is not JSON-safe at ${path}`);
      }
      return keys.map((key, index) => {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor || !('value' in descriptor)) throw new TypeError(`Value is not JSON-safe at ${path}[${index}]`);
        return sortValue(descriptor.value, ancestors, `${path}[${index}]`);
      });
    }

    const prototype = Object.getPrototypeOf(value) as object | null;
    if ((prototype !== Object.prototype && prototype !== null) || Object.getOwnPropertySymbols(value).length > 0) {
      throw new TypeError(`Value is not JSON-safe at ${path}`);
    }
    const objectValue = value as Record<string, unknown>;
    const keys = Object.keys(objectValue);
    if (Object.getOwnPropertyNames(objectValue).length !== keys.length) {
      throw new TypeError(`Value is not JSON-safe at ${path}`);
    }
    return Object.fromEntries(keys
      .sort(compareCodeUnits)
      .map((key) => {
        const descriptor = Object.getOwnPropertyDescriptor(objectValue, key);
        if (!descriptor || !('value' in descriptor)) throw new TypeError(`Value is not JSON-safe at ${path}.${key}`);
        return [key, sortValue(descriptor.value, ancestors, `${path}.${key}`)];
      }));
  } finally {
    ancestors.delete(value);
  }
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
