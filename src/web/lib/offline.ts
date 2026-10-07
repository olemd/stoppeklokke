// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Offline stopwatch (§7.3): start/stop while offline are queued in IndexedDB
 * with client timestamps and replayed in order when back online. Replays that
 * fail (e.g. 409 for a locked period) are kept as "sync problems" and shown
 * to the user until dismissed — never dropped silently.
 */
import { signal } from '@preact/signals';
import type { Entry } from '../../shared/schemas';
import { ApiError, NetworkError, post } from './api';
import { timer } from './store';

export interface QueuedOp {
  id?: number;
  kind: 'start' | 'stop';
  body: Record<string, unknown>;
  queued_at: number;
}
export interface FailedOp extends QueuedOp {
  error: string;
  message: string;
}

const DB = 'stoppeklokke';
const QUEUE = 'queue';
const FAILED = 'failed';

export const pendingCount = signal(0);
export const failedOps = signal<FailedOp[]>([]);

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(QUEUE, { keyPath: 'id', autoIncrement: true });
      req.result.createObjectStore(FAILED, { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx<T>(
  store: string,
  mode: IDBTransactionMode,
  fn: (s: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const r = fn(db.transaction(store, mode).objectStore(store));
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

async function refreshCounts() {
  pendingCount.value = (await tx(QUEUE, 'readonly', (s) => s.count())) as number;
  failedOps.value = (await tx(FAILED, 'readonly', (s) => s.getAll())) as FailedOp[];
}

export async function enqueue(op: Omit<QueuedOp, 'queued_at'>) {
  await tx(QUEUE, 'readwrite', (s) => s.add({ ...op, queued_at: Math.floor(Date.now() / 1000) }));
  await refreshCounts();
}

export async function dismissFailed(id: number) {
  await tx(FAILED, 'readwrite', (s) => s.delete(id));
  await refreshCounts();
}

let replaying = false;

/** Replay queued operations in order. Stops at the first network failure. */
export async function replay(onDone?: () => void) {
  if (replaying) return;
  replaying = true;
  try {
    const ops = (await tx(QUEUE, 'readonly', (s) => s.getAll())) as QueuedOp[];
    for (const op of ops) {
      try {
        await post(op.kind === 'start' ? '/timer/start' : '/timer/stop', op.body);
      } catch (err) {
        if (err instanceof NetworkError) break; // still offline: keep the rest queued
        const e =
          err instanceof ApiError
            ? err
            : new ApiError(0, { error: 'unknown', message: String(err) });
        await tx(FAILED, 'readwrite', (s) => s.put({ ...op, error: e.code, message: e.message }));
      }
      await tx(QUEUE, 'readwrite', (s) => s.delete(op.id!));
    }
  } finally {
    replaying = false;
    await refreshCounts();
    onDone?.();
  }
}

/** Start the timer, queueing it when offline (optimistic local state). */
export async function startTimerOfflineAware(body: Record<string, unknown>): Promise<Entry | null> {
  const start_at = Math.floor(Date.now() / 1000);
  try {
    return (await post<{ entry: Entry }>('/timer/start', body)).entry;
  } catch (err) {
    if (!(err instanceof NetworkError)) throw err;
    await enqueue({ kind: 'start', body: { ...body, start_at } });
    // A local stand-in for the running entry (id < 0 = not yet synced).
    return {
      id: -start_at,
      workspace_id: (body.workspace_id as number) ?? 0,
      client_id: (body.client_id as number | null) ?? null,
      project_id: (body.project_id as number | null) ?? null,
      description: (body.description as string) ?? '',
      start_at,
      end_at: null,
      billable: true,
      rate_locked_at: null,
      locked_rate: null,
      locked_currency: null,
      period_lock_id: null,
      created_at: start_at,
      updated_at: start_at,
      rate: null,
      currency: '',
      rate_source: null,
    };
  }
}

/** Stop the timer; when offline, queue the stop with the client's end time. */
export async function stopTimerOfflineAware(
  body: Record<string, unknown>,
): Promise<'stopped' | 'queued'> {
  const end_at = Math.floor(Date.now() / 1000);
  try {
    await post('/timer/stop', body);
    return 'stopped';
  } catch (err) {
    if (!(err instanceof NetworkError)) throw err;
    await enqueue({ kind: 'stop', body: { ...body, end_at: (body.end_at as number) ?? end_at } });
    timer.value = null;
    return 'queued';
  }
}

export function initOffline(onSynced: () => void) {
  void refreshCounts().then(() => replay(onSynced));
  // The `online` event is unreliable (flaky networks, captive portals), so
  // also retry while something is pending and whenever the app regains focus.
  addEventListener('online', () => void replay(onSynced));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && pendingCount.value > 0) void replay(onSynced);
  });
  setInterval(() => pendingCount.value > 0 && void replay(onSynced), 30_000);
}
