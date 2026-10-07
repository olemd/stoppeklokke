// SPDX-License-Identifier: AGPL-3.0-or-later
/// <reference lib="webworker" />
/**
 * Service worker (§7.2). Hand-written, no Workbox:
 * - precaches the app shell (list injected at build time),
 * - navigations: network first, cached shell offline,
 * - hashed assets: cache first,
 * - GET /api/*: network first with cache fallback ("read last known state"),
 * - push notifications with Stop / Keep going actions (§8).
 *
 * Self-contained on purpose (no imports), so it builds to one classic script.
 */
// `export {}` (end of file) makes this a module so `self` can be re-typed.
declare const self: ServiceWorkerGlobalScope;
declare const __PRECACHE__: string[];
declare const __VERSION__: string;

const SHELL = `shell-${__VERSION__}`;
const API = 'api-v1';
const KEEP_SHELLS = 2; // keep the previous version for tabs still running old JS

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL);
      await cache.addAll(__PRECACHE__);
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const shells = (await caches.keys()).filter((k) => k.startsWith('shell-') && k !== SHELL);
      // caches.keys() is in creation order: drop all but the newest previous one.
      for (const old of shells.slice(0, Math.max(0, shells.length - (KEEP_SHELLS - 1)))) {
        await caches.delete(old);
      }
      await self.clients.claim();
    })(),
  );
});

/**
 * Only the GET endpoints the app needs to show its last known state offline
 * are cached (§7.3). Everything else (passkeys, push subscriptions, tokens,
 * webhooks, exports, reports) honours the API's `no-store` and stays off disk.
 */
const OFFLINE_API =
  /^\/api\/(auth\/status|settings|workspaces|clients|projects|timer|entries|suggestions\/descriptions)\/?$/;

/**
 * Bumped when logout clears the API cache, so a response that was still in
 * flight at logout is never written back afterwards.
 */
let generation = 0;

/** Logout asks the worker to forget cached API responses (personal data). */
self.addEventListener('message', (event) => {
  if (event.data === 'clear-api-cache') {
    generation++;
    event.waitUntil(caches.delete(API));
  }
});

async function networkFirst(
  request: Request,
  cacheName: string,
  fallback?: string,
  keepAlive?: (p: Promise<unknown>) => void,
): Promise<Response> {
  const gen = generation;
  try {
    const res = await fetch(request);
    if (res.ok && request.method === 'GET') {
      const copy = res.clone();
      const store = (async () => {
        if (gen !== generation) return;
        const cache = await caches.open(cacheName);
        await cache.put(request, copy);
        // Logout happened while writing: undo, the data must not persist.
        if (gen !== generation) await cache.delete(request);
      })();
      keepAlive?.(store);
    }
    return res;
  } catch (err) {
    const cached =
      (await caches.match(request)) ?? (fallback ? await caches.match(fallback) : undefined);
    if (cached) return cached;
    throw err;
  }
}

async function cacheFirst(request: Request): Promise<Response> {
  return (await caches.match(request)) ?? fetch(request);
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || request.method !== 'GET') return;
  if (url.pathname.startsWith('/api/')) {
    if (!OFFLINE_API.test(url.pathname)) return;
    event.respondWith(networkFirst(request, API, undefined, (p) => event.waitUntil(p)));
  } else if (request.mode === 'navigate') {
    event.respondWith(networkFirst(request, SHELL, '/', (p) => event.waitUntil(p)));
  } else if (url.pathname.startsWith('/assets/') || url.pathname.startsWith('/icons/')) {
    event.respondWith(cacheFirst(request));
  }
});

// ── Push (§7.2, §8) ────────────────────────────────────────────────────────

interface PushPayload {
  title: string;
  body: string;
  tag?: string;
  entry_id?: number;
  actions?: { stop: string; keep: string };
  stopped?: { title: string; body: string };
}

self.addEventListener('push', (event) => {
  const data = (event.data?.json() ?? { title: 'Stoppeklokke', body: '' }) as PushPayload;
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      tag: data.tag ?? 'stoppeklokke',
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      data,
      ...(data.actions
        ? {
            actions: [
              { action: 'stop', title: data.actions.stop },
              { action: 'keep', title: data.actions.keep },
            ],
          }
        : {}),
    } as NotificationOptions),
  );
});

self.addEventListener('notificationclick', (event) => {
  const data = (event.notification.data ?? {}) as PushPayload;
  event.notification.close();
  if (event.action === 'keep') return;
  if (event.action === 'stop') {
    // Same-origin POST from the worker: the session cookie and Origin are sent.
    event.waitUntil(
      (async () => {
        const res = await fetch('/api/timer/stop', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
          credentials: 'same-origin',
        });
        if (res.ok && data.stopped) {
          await self.registration.showNotification(data.stopped.title, {
            body: data.stopped.body,
            tag: 'stoppeklokke-stopped',
            icon: '/icons/icon-192.png',
          });
        }
        for (const c of await self.clients.matchAll({ type: 'window' }))
          c.postMessage('timer-changed');
      })(),
    );
    return;
  }
  // Plain click: focus or open the app.
  event.waitUntil(
    (async () => {
      const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const win = wins[0];
      if (win) await win.focus();
      else await self.clients.openWindow('/');
    })(),
  );
});
export {};
