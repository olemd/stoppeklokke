// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Conflict flows shared by screens: the server answers 409 with what it needs
 * (too_long, locked_period, rate_lock_decision, rate_change_required); these
 * helpers ask the user and retry with the right flag. Return null = cancelled.
 */
import { formatHM } from '../../core/time/duration';
import { dateOf, parseDate, zonedToEpoch } from '../../core/time/tz';
import { ask } from '../components/Dialog';
import { TimeInput } from '../components/TimeInput';
import { ApiError } from './api';
import { date, hm, rate as fmtRate } from './fmt';
import { t } from './i18n';
import { settings } from './store';

/** Extra fields the server sends with 409 responses. */
interface ConflictBody {
  duration: number;
  locked_rate: number | null;
  locked_currency: string | null;
  impact: Impact;
  lock?: { note: string };
}

export async function withConflicts<T>(
  run: (extra: Record<string, unknown>) => Promise<T>,
  extra: Record<string, unknown> = {},
): Promise<T | null> {
  try {
    return await run(extra);
  } catch (err) {
    if (!(err instanceof ApiError) || err.status !== 409) throw err;
    const b = err.body as unknown as ConflictBody;
    switch (err.code) {
      case 'too_long': {
        const ok = await ask(t('log.tooLongConfirm', { duration: formatHM(b.duration) }), [
          { label: t('common.cancel'), value: false, variant: 'plain' },
          { label: t('common.save'), value: true, variant: 'primary' },
        ]);
        return ok ? withConflicts(run, { ...extra, force: true }) : null;
      }
      case 'rate_lock_decision': {
        const choice = await ask(
          t('log.rateLockQuestion', {
            rate: fmtRate(b.locked_rate, b.locked_currency ?? '') || '–',
          }),
          [
            { label: t('common.cancel'), value: null, variant: 'plain' },
            { label: t('log.rateLockKeep'), value: 'keep', variant: 'plain' },
            { label: t('log.rateLockRelease'), value: 'release', variant: 'primary' },
          ],
        );
        return choice ? withConflicts(run, { ...extra, rate_lock: choice }) : null;
      }
      case 'rate_change_required': {
        const mode = await askRateChange(b.impact);
        return mode ? withConflicts(run, { ...extra, rate_change: mode }) : null;
      }
      case 'locked_period':
        throw new ApiError(409, {
          error: 'locked_period',
          message: t('log.lockedPeriod', { note: b.lock?.note || '–' }),
        });
      default:
        throw err;
    }
  }
}

interface Impact {
  count: number;
  seconds: number;
  oldest: number | null;
  newest: number | null;
  current_rate: number | null;
  currency: string;
}

/** The §4.2 dialog: lock old time (default), lock only before a date, or update history. */
async function askRateChange(impact: Impact): Promise<{ mode: string; before?: number } | null> {
  const tz = settings.value?.timezone ?? 'UTC';
  let beforeDate = dateOf(Math.floor(Date.now() / 1000), tz);
  const body = (
    <div class="stack">
      <p>
        {t('rateChange.intro', {
          count: impact.count,
          hours: hm(impact.seconds),
          oldest: impact.oldest ? date(impact.oldest) : '–',
          newest: impact.newest ? date(impact.newest) : '–',
          rate: fmtRate(impact.current_rate, impact.currency) || t('catalog.rateNone'),
        })}
      </p>
      <div class="field">
        <label for="rc-before">{t('rateChange.lockBefore')}</label>
        <input
          id="rc-before"
          type="date"
          value={beforeDate}
          onInput={(e) => (beforeDate = e.currentTarget.value)}
        />
      </div>
    </div>
  );
  const choice = await ask(
    t('rateChange.title'),
    [
      { label: t('common.cancel'), value: null, variant: 'plain' },
      { label: t('rateChange.update'), value: 'update', variant: 'plain' },
      { label: t('rateChange.lockBefore'), value: 'lock_before', variant: 'plain' },
      { label: t('rateChange.lock'), value: 'lock', variant: 'primary' },
    ],
    body,
  );
  if (!choice) return null;
  if (choice === 'lock_before') {
    const { year, month, day } = parseDate(beforeDate);
    return { mode: choice, before: zonedToEpoch(year, month, day, 0, 0, tz) };
  }
  return { mode: choice };
}

/** Stopping the timer: handles >24 h (correct end or keep) and locked-while-running (cut). */
export async function stopFlow(
  run: (body: Record<string, unknown>) => Promise<unknown>,
  startAt: number,
): Promise<boolean> {
  try {
    await run({});
    return true;
  } catch (err) {
    if (!(err instanceof ApiError) || err.status !== 409) throw err;
    const b = err.body as unknown as ConflictBody;
    if (err.code === 'locked_period') {
      const ok = await ask(t('timer.lockedWhileRunning', { note: b.lock?.note || '–' }), [
        { label: t('common.cancel'), value: false, variant: 'plain' },
        { label: t('timer.cut'), value: true, variant: 'primary' },
      ]);
      return ok ? stopFlow((x) => run({ ...x, cut_at_lock: true }), startAt) : false;
    }
    if (err.code === 'too_long') {
      const tz = settings.value?.timezone ?? 'UTC';
      let end: { hour: number; minute: number } | null = null;
      const choice = await ask(
        t('timer.tooLong', { duration: formatHM(b.duration) }),
        [
          { label: t('common.cancel'), value: null, variant: 'plain' },
          {
            label: t('timer.keep', { duration: formatHM(b.duration) }),
            value: 'keep',
            variant: 'plain',
          },
          { label: t('common.save'), value: 'end', variant: 'primary' },
        ],
        <TimeInput
          id="stop-end"
          label={t('timer.endTime')}
          value={null}
          onChange={(v) => (end = v)}
        />,
      );
      if (choice === 'keep') return stopFlow((x) => run({ ...x, force: true }), startAt);
      if (choice === 'end' && end) {
        // The end time is on the start's calendar day, or the day after if earlier.
        const { year, month, day } = parseDate(dateOf(startAt, tz));
        const e = end as { hour: number; minute: number };
        let endAt = zonedToEpoch(year, month, day, e.hour, e.minute, tz);
        if (endAt <= startAt) endAt = zonedToEpoch(year, month, day + 1, e.hour, e.minute, tz);
        return stopFlow((x) => run({ ...x, end_at: endAt }), startAt);
      }
      return false;
    }
    throw err;
  }
}
