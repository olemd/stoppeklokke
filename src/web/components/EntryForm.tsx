// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Edit or add a completed entry (§7.1 log): date, start and end (or
 * duration), description, project, billable. Times are typed as HH:MM in the
 * configured time zone.
 */
import { useState } from 'preact/hooks';
import { formatHM, parseDuration } from '../../core/time/duration';
import { dateOf, parseDate, zonedToEpoch } from '../../core/time/tz';
import type { Entry } from '../../shared/schemas';
import { t } from '../lib/i18n';
import { settings } from '../lib/store';
import { DescriptionInput } from './DescriptionInput';
import { ProjectPicker, type Refs } from './ProjectPicker';
import { TimeInput } from './TimeInput';

export interface EntryDraft {
  refs: Refs;
  description: string;
  start_at: number;
  end_at: number;
  billable?: boolean;
}

function clockOf(epoch: number, tz: string) {
  const p = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    hour: 'numeric',
    minute: 'numeric',
    hourCycle: 'h23',
  }).formatToParts(epoch * 1000);
  return {
    hour: Number(p.find((x) => x.type === 'hour')!.value),
    minute: Number(p.find((x) => x.type === 'minute')!.value),
  };
}

interface Props {
  idPrefix: string;
  entry?: Entry;
  defaultDate: string;
  defaultRefs: Refs;
  onSubmit: (d: EntryDraft) => Promise<void>;
  onCancel: () => void;
  onDelete?: () => void;
}

export function EntryForm({
  idPrefix,
  entry,
  defaultDate,
  defaultRefs,
  onSubmit,
  onCancel,
  onDelete,
}: Props) {
  const tz = settings.value!.timezone;
  const [day, setDay] = useState(entry ? dateOf(entry.start_at, tz) : defaultDate);
  const [start, setStart] = useState(entry ? clockOf(entry.start_at, tz) : null);
  const [end, setEnd] = useState(entry?.end_at ? clockOf(entry.end_at, tz) : null);
  const [useDuration, setUseDuration] = useState(false);
  const [duration, setDuration] = useState(
    entry?.end_at ? formatHM(entry.end_at - entry.start_at) : '',
  );
  const [refs, setRefs] = useState<Refs>(
    entry
      ? {
          workspace_id: entry.workspace_id,
          client_id: entry.client_id,
          project_id: entry.project_id,
        }
      : defaultRefs,
  );
  const [description, setDescription] = useState(entry?.description ?? '');
  const [billable, setBillable] = useState<boolean | undefined>(entry?.billable);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: Event) => {
    e.preventDefault();
    setError('');
    if (!start) return setError(t('common.invalidTime'));
    const { year, month, day: d } = parseDate(day);
    const startAt = zonedToEpoch(year, month, d, start.hour, start.minute, tz);
    let endAt: number;
    if (useDuration) {
      const secs = parseDuration(duration);
      if (!secs) return setError(t('common.invalidDuration'));
      endAt = startAt + secs;
    } else {
      if (!end) return setError(t('common.invalidTime'));
      endAt = zonedToEpoch(year, month, d, end.hour, end.minute, tz);
      if (endAt <= startAt) endAt = zonedToEpoch(year, month, d + 1, end.hour, end.minute, tz); // past midnight
    }
    setBusy(true);
    try {
      await onSubmit({ refs, description, start_at: startAt, end_at: endAt, billable });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form class="entry-form stack" onSubmit={submit}>
      <div class="grid-3">
        <div class="field">
          <label for={`${idPrefix}-date`}>{t('log.date')}</label>
          <input
            id={`${idPrefix}-date`}
            type="date"
            required
            value={day}
            onInput={(e) => setDay(e.currentTarget.value)}
          />
        </div>
        <TimeInput
          id={`${idPrefix}-start`}
          label={t('log.start')}
          value={start}
          onChange={setStart}
          required
        />
        {useDuration ? (
          <div class="field">
            <label for={`${idPrefix}-dur`}>{t('log.duration')}</label>
            <input
              id={`${idPrefix}-dur`}
              inputMode="numeric"
              placeholder="H:MM"
              value={duration}
              onInput={(e) => setDuration(e.currentTarget.value)}
            />
          </div>
        ) : (
          <TimeInput
            id={`${idPrefix}-end`}
            label={t('log.end')}
            value={end}
            onChange={setEnd}
            required
          />
        )}
      </div>
      <label class="check">
        <input
          type="checkbox"
          checked={useDuration}
          onChange={(e) => setUseDuration(e.currentTarget.checked)}
        />
        {t('log.useDuration')}
      </label>
      <DescriptionInput
        id={`${idPrefix}-desc`}
        label={t('timer.descriptionLabel')}
        value={description}
        projectId={refs.project_id}
        onChange={setDescription}
        onPick={(s) =>
          refs.project_id === null &&
          refs.client_id === null &&
          setRefs({
            workspace_id: s.workspace_id,
            client_id: s.client_id,
            project_id: s.project_id,
          })
        }
      />
      <ProjectPicker
        id={`${idPrefix}-project`}
        label={t('timer.project')}
        value={refs}
        onChange={setRefs}
      />
      {entry && (
        <label class="check">
          <input
            type="checkbox"
            checked={billable}
            onChange={(e) => setBillable(e.currentTarget.checked)}
          />
          {t('timer.billable')}
        </label>
      )}
      {error && (
        <p class="notice error" role="alert">
          {error}
        </p>
      )}
      <div class="actions">
        {onDelete && (
          <button type="button" class="btn danger-plain" onClick={onDelete}>
            {t('common.delete')}
          </button>
        )}
        <span class="spacer" />
        <button type="button" class="btn plain" onClick={onCancel}>
          {t('common.cancel')}
        </button>
        <button class="btn primary" disabled={busy}>
          {t('common.save')}
        </button>
      </div>
    </form>
  );
}
