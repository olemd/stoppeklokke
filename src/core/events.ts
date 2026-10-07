// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * In-process domain event bus (§15.2).
 *
 * Push notifications and webhooks are just listeners, so integrations never
 * touch timer or entry code. Listeners run in the background (via the
 * scheduler) and their failures are logged, never surfaced to the request.
 */
import type { Logger, Scheduler } from './ports';

export type DomainEvent =
  | { type: 'timer.started'; entry: Record<string, unknown> }
  | { type: 'timer.stopped'; entry: Record<string, unknown> }
  | { type: 'entry.created'; entry: Record<string, unknown> }
  | { type: 'entry.updated'; entry: Record<string, unknown> }
  | { type: 'entry.deleted'; id: number }
  | { type: 'lock.created'; lock: Record<string, unknown> }
  | { type: 'lock.deleted'; id: number }
  | { type: 'rate.changed'; level: string; id: number | null; mode: string; locked: number }
  | { type: 'alert.sent'; entry_id: number; kind: 'alert' | 'tick'; seq: number };

export type DomainEventType = DomainEvent['type'];
export const DOMAIN_EVENT_TYPES: readonly DomainEventType[] = [
  'timer.started',
  'timer.stopped',
  'entry.created',
  'entry.updated',
  'entry.deleted',
  'lock.created',
  'lock.deleted',
  'rate.changed',
  'alert.sent',
];

export type Listener = (e: DomainEvent) => Promise<void>;

export class EventBus {
  private listeners: Listener[] = [];

  constructor(
    private scheduler: Scheduler,
    private log: Logger,
  ) {}

  on(listener: Listener): void {
    this.listeners.push(listener);
  }

  emit(e: DomainEvent): void {
    for (const l of this.listeners) {
      this.scheduler.waitUntil(
        l(e).catch((err: unknown) =>
          this.log.error('event listener failed', { event: e.type, err: String(err) }),
        ),
      );
    }
  }
}
