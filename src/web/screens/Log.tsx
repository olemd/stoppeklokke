// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Log (§7.1): one ISO week, entries per day, inline editing, manual entry,
 * lock indicators and overlap flags.
 */
import { useEffect, useState } from 'preact/hooks';
import { addDays, dateOf, isoWeek, startOfWeek } from '../../core/time/tz';
import { formatCalendarDate } from '../../core/time/format';
import type { Entry } from '../../shared/schemas';
import { confirmAction } from '../components/Dialog';
import { EntryForm, type EntryDraft } from '../components/EntryForm';
import { showError, toast } from '../components/Toast';
import { del, get, patch, post, qs } from '../lib/api';
import { entryColor, entryLabel, hm, rate, time } from '../lib/fmt';
import { withConflicts } from '../lib/flows';
import { t, translator } from '../lib/i18n';
import { navigate, query } from '../lib/router';
import { ESCAPE_EVENT } from '../lib/shortcuts';
import {
  activeWorkspaceId,
  filterWorkspaceId,
  multiWorkspace,
  settings,
  workspaceById,
} from '../lib/store';

export function LogScreen() {
  const tz = settings.value!.timezone;
  const today = dateOf(Math.floor(Date.now() / 1000), tz);
  const week = startOfWeek(query.value.get('week') ?? today);
  const days = Array.from({ length: 7 }, (_, i) => addDays(week, i));
  const [entries, setEntries] = useState<Entry[] | null>(null);
  // `n` opens the add form via /log?new=1 (§7.4).
  const [editing, setEditing] = useState<number | 'new' | null>(
    query.value.get('new') ? 'new' : null,
  );
  useEffect(() => {
    if (query.value.get('new')) setEditing('new');
  }, [query.value]);
  useEffect(() => {
    const close = () => setEditing(null);
    addEventListener(ESCAPE_EVENT, close);
    return () => removeEventListener(ESCAPE_EVENT, close);
  }, []);
  const [locks, setLocks] = useState<Map<number, string>>(new Map());
  const [selected, setSelected] = useState<Set<number>>(new Set());

  const reload = async () => {
    try {
      const list = await get<Entry[]>(
        `/entries${qs({ from: week, to: addDays(week, 6), workspace_id: filterWorkspaceId.value })}`,
      );
      setEntries(list);
      if (list.some((e) => e.period_lock_id !== null)) {
        const ls = await get<{ id: number; note: string }[]>('/locks').catch(() => []);
        setLocks(new Map(ls.map((l) => [l.id, l.note])));
      }
    } catch (err) {
      showError(err);
    }
  };
  useEffect(() => void reload(), [week, filterWorkspaceId.value]);

  const save = async (id: number | null, d: EntryDraft) => {
    const body = {
      ...d.refs,
      description: d.description,
      start_at: d.start_at,
      end_at: d.end_at,
      billable: d.billable,
    };
    const r = await withConflicts((x) =>
      id ? patch(`/entries/${id}`, { ...body, ...x }) : post('/entries', { ...body, ...x }),
    );
    if (r) {
      setEditing(null);
      toast(t('common.saved'));
      await reload();
    }
  };

  /** Bulk rate lock/release of the selected entries (§4.1). */
  const bulk = async (action: 'rate-lock' | 'rate-unlock') => {
    try {
      const r = await post<{ locked?: number; released?: number; skipped_period_locked?: number }>(
        `/entries/${action}`,
        { ids: [...selected] },
      );
      if (action === 'rate-lock') toast(t('bulk.locked', { count: r.locked ?? 0 }));
      else {
        toast(t('bulk.released', { count: r.released ?? 0 }));
        if (r.skipped_period_locked) toast(t('bulk.skipped', { count: r.skipped_period_locked }));
      }
      setSelected(new Set());
      await reload();
    } catch (err) {
      showError(err);
    }
  };

  const remove = async (id: number) => {
    if (!(await confirmAction(t('log.deleteConfirm'), t('common.delete'), true))) return;
    try {
      await del(`/entries/${id}`);
      setEditing(null);
      toast(t('common.deleted'));
      await reload();
    } catch (err) {
      showError(err);
    }
  };

  const weekTotal = (entries ?? []).reduce(
    (a, e) => a + ((e.end_at ?? Math.floor(Date.now() / 1000)) - e.start_at),
    0,
  );
  const wk = isoWeek(week);
  const loc = { locale: translator.value.locale };

  return (
    <div class="log-screen stack">
      <div class="page-head">
        <h1 tabIndex={-1}>{t('log.week', { week: wk.week })}</h1>
        <nav class="week-nav" aria-label={t('log.title')}>
          <button
            type="button"
            class="btn plain small"
            onClick={() => navigate(`/log?week=${addDays(week, -7)}`)}
          >
            <span aria-hidden="true">‹ </span>
            {t('log.prevWeek')}
          </button>
          {week !== startOfWeek(today) && (
            <button type="button" class="btn plain small" onClick={() => navigate('/log')}>
              {t('log.thisWeek')}
            </button>
          )}
          <button
            type="button"
            class="btn plain small"
            onClick={() => navigate(`/log?week=${addDays(week, 7)}`)}
          >
            {t('log.nextWeek')}
            <span aria-hidden="true"> ›</span>
          </button>
        </nav>
        <button
          type="button"
          class="btn primary"
          aria-keyshortcuts="n"
          onClick={() => setEditing('new')}
        >
          {t('log.add')}
        </button>
      </div>
      <p class="week-total">{t('log.weekTotal', { total: hm(weekTotal) })}</p>
      {selected.size > 0 && (
        <div
          class="bulk-bar"
          role="region"
          aria-label={t('bulk.selected', { count: selected.size })}
        >
          <span>{t('bulk.selected', { count: selected.size })}</span>
          <button type="button" class="btn plain small" onClick={() => bulk('rate-lock')}>
            {t('bulk.rateLock')}
          </button>
          <button type="button" class="btn plain small" onClick={() => bulk('rate-unlock')}>
            {t('bulk.rateUnlock')}
          </button>
          <button type="button" class="btn plain small" onClick={() => setSelected(new Set())}>
            {t('common.cancel')}
          </button>
        </div>
      )}

      {editing === 'new' && (
        <section class="panel" aria-label={t('log.addTitle')}>
          <EntryForm
            idPrefix="new"
            defaultDate={days.includes(today) ? today : week}
            defaultRefs={{
              workspace_id: filterWorkspaceId.value ?? activeWorkspaceId.value,
              client_id: null,
              project_id: null,
            }}
            onSubmit={(d) => save(null, d)}
            onCancel={() => setEditing(null)}
          />
        </section>
      )}

      {entries === null ? (
        <p>{t('app.loading')}</p>
      ) : entries.length === 0 ? (
        <p class="empty">{t('log.empty')}</p>
      ) : (
        days.map((day) => {
          const list = entries
            .filter((e) => dateOf(e.start_at, tz) === day)
            .sort((a, b) => a.start_at - b.start_at);
          if (!list.length) return null;
          const total = list.reduce(
            (a, e) => a + ((e.end_at ?? Math.floor(Date.now() / 1000)) - e.start_at),
            0,
          );
          return (
            <section class="day" key={day} aria-labelledby={`day-${day}`}>
              <div class="day-head">
                <h2 id={`day-${day}`}>{formatCalendarDate(day, loc)}</h2>
                <span>{t('log.dayTotal', { total: hm(total) })}</span>
              </div>
              <ul class="entry-list">
                {list.map((e) =>
                  editing === e.id ? (
                    <li key={e.id} class="entry-row editing">
                      <EntryForm
                        idPrefix={`e${e.id}`}
                        entry={e}
                        defaultDate={day}
                        defaultRefs={{
                          workspace_id: e.workspace_id,
                          client_id: e.client_id,
                          project_id: e.project_id,
                        }}
                        onSubmit={(d) => save(e.id, d)}
                        onCancel={() => setEditing(null)}
                        onDelete={() => remove(e.id)}
                      />
                    </li>
                  ) : (
                    <li key={e.id} class={`entry-row selectable ${e.overlaps ? 'overlaps' : ''}`}>
                      <input
                        type="checkbox"
                        class="select"
                        disabled={e.end_at === null}
                        checked={selected.has(e.id)}
                        aria-label={t('bulk.select', {
                          description: e.description || t('timer.untitled'),
                        })}
                        onChange={(ev) => {
                          const next = new Set(selected);
                          if (ev.currentTarget.checked) next.add(e.id);
                          else next.delete(e.id);
                          setSelected(next);
                        }}
                      />
                      <span
                        class="swatch"
                        style={{ backgroundColor: entryColor(e) ?? 'transparent' }}
                        aria-hidden="true"
                      />
                      <div class="entry-main">
                        <span class="entry-desc">{e.description || t('timer.untitled')}</span>
                        <span class="entry-meta">
                          {entryLabel(e, t('timer.uncategorised'))}
                          {multiWorkspace.value && filterWorkspaceId.value === null && (
                            <span class="tag">{workspaceById.value.get(e.workspace_id)?.name}</span>
                          )}
                          {!e.billable && (
                            <span class="tag muted">
                              {t('timer.billable')}: {t('common.no')}
                            </span>
                          )}
                        </span>
                      </div>
                      <span class="entry-flags">
                        {e.period_lock_id !== null && (
                          <span
                            class="flag"
                            role="img"
                            aria-label={t('log.periodLocked', {
                              note: locks.get(e.period_lock_id) || '–',
                            })}
                            title={t('log.periodLocked', {
                              note: locks.get(e.period_lock_id) || '–',
                            })}
                          >
                            🔒
                          </span>
                        )}
                        {e.period_lock_id === null && e.rate_locked_at !== null && (
                          <span
                            class="flag"
                            role="img"
                            aria-label={
                              e.locked_rate === null
                                ? t('log.rateLockedNone')
                                : t('log.rateLocked', { rate: rate(e.locked_rate, e.currency) })
                            }
                            title={
                              e.locked_rate === null
                                ? t('log.rateLockedNone')
                                : t('log.rateLocked', { rate: rate(e.locked_rate, e.currency) })
                            }
                          >
                            ⚓
                          </span>
                        )}
                        {e.overlaps && (
                          <span
                            class="flag warn"
                            role="img"
                            aria-label={t('log.overlaps')}
                            title={t('log.overlaps')}
                          >
                            ⚠
                          </span>
                        )}
                      </span>
                      <span class="entry-time">
                        {time(e.start_at)}–{e.end_at ? time(e.end_at) : t('log.running')}
                      </span>
                      <span class="entry-dur">
                        {hm((e.end_at ?? Math.floor(Date.now() / 1000)) - e.start_at)}
                      </span>
                      {e.period_lock_id === null && e.end_at !== null && (
                        <button
                          type="button"
                          class="btn plain small"
                          aria-label={`${t('common.edit')}: ${e.description || t('timer.untitled')}`}
                          onClick={() => setEditing(e.id)}
                        >
                          {t('common.edit')}
                        </button>
                      )}
                    </li>
                  ),
                )}
              </ul>
            </section>
          );
        })
      )}
    </div>
  );
}
