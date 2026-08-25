import {
  FileEventStore,
  type ExecutionMaterializedState,
  type ReplayRequest,
  type TransitionRequest,
} from './event-store.js';
import type { SettledResult } from './types.js';

export interface ExecutionBackend {
  transition<TState extends ExecutionMaterializedState>(request: TransitionRequest<TState>): Promise<TState>;
  loadAndRepair<TState extends ExecutionMaterializedState>(request: ReplayRequest<TState>): Promise<TState>;
  runBounded<T, R>(
    items: readonly T[],
    limit: number,
    worker: (item: T, index: number) => Promise<R>,
  ): Promise<SettledResult<R>[]>;
  waitUntil(deadlineMs: number, signal?: AbortSignal): Promise<void>;
  wake(worksetId: string): void;
}

export class LocalExecutionBackend implements ExecutionBackend {
  private readonly waiters = new Set<() => void>();

  constructor(readonly eventStore = new FileEventStore()) {}

  transition<TState extends ExecutionMaterializedState>(request: TransitionRequest<TState>): Promise<TState> {
    return this.eventStore.transition(request);
  }

  loadAndRepair<TState extends ExecutionMaterializedState>(request: ReplayRequest<TState>): Promise<TState> {
    return this.eventStore.loadAndRepair(request);
  }

  async runBounded<T, R>(
    items: readonly T[],
    limit: number,
    worker: (item: T, index: number) => Promise<R>,
  ): Promise<SettledResult<R>[]> {
    if (!Number.isInteger(limit) || limit <= 0) {
      throw new RangeError(`INVALID_CONCURRENCY_LIMIT: limit=${limit}`);
    }
    if (items.length === 0) return [];

    const results: SettledResult<R>[] = new Array(items.length);
    let nextIndex = 0;
    const runWorker = async (): Promise<void> => {
      while (nextIndex < items.length) {
        const index = nextIndex;
        nextIndex += 1;
        try {
          results[index] = { status: 'fulfilled', value: await worker(items[index]!, index) };
        } catch (error) {
          results[index] = { status: 'rejected', reason: normalizeRejection(error) };
        }
      }
    };
    const workerCount = Math.min(limit, items.length);
    await Promise.all(Array.from({ length: workerCount }, () => runWorker()));
    return results;
  }

  waitUntil(deadlineMs: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(abortError());
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.waiters.delete(onWake);
        signal?.removeEventListener('abort', onAbort);
        if (error) reject(error);
        else resolve();
      };
      const onWake = (): void => finish();
      const onAbort = (): void => finish(abortError());
      const timer = setTimeout(onWake, Math.max(0, deadlineMs - Date.now()));
      this.waiters.add(onWake);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  wake(_worksetId: string): void {
    for (const waiter of [...this.waiters]) waiter();
  }
}

function normalizeRejection(error: unknown): { name: string; message: string; code?: string } {
  if (!(error instanceof Error)) {
    return { name: 'Error', message: typeof error === 'string' ? error : 'Unknown callback rejection' };
  }
  const code = 'code' in error && typeof error.code === 'string' ? error.code : undefined;
  return code === undefined
    ? { name: error.name || 'Error', message: error.message }
    : { name: error.name || 'Error', message: error.message, code };
}

function abortError(): Error {
  const error = new Error('The wait was aborted');
  error.name = 'AbortError';
  return error;
}
