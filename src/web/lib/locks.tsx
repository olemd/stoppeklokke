// SPDX-License-Identifier: AGPL-3.0-or-later
/** Lock-period and unlock dialogs (§4.1), shared by Reports and Invoice basis. */
import { formatCalendarDate } from '../../core/time/format';
import { ask } from '../components/Dialog';
import { showError, toast } from '../components/Toast';
import { del, post } from './api';
import { hm, money } from './fmt';
import { t, translator } from './i18n';

export interface LockScope {
  workspace_id: number;
  from_date: string;
  to_date: string;
  client_id?: number | null;
  project_id?: number | null;
}

export interface Lock extends Required<LockScope> {
  id: number;
  note: string;
  entries: number;
  locked_at: number;
}

const cal = (d: string) => formatCalendarDate(d, { locale: translator.value.locale });

/** Preview → note → lock. Returns true when a lock was created. */
export async function lockPeriodFlow(scope: LockScope, defaultNote = ''): Promise<boolean> {
  try {
    const p = await post<{
      count: number;
      seconds: number;
      amounts: Record<string, number>;
      already_locked: number;
      running_excluded: number;
    }>('/locks/preview', scope);
    let note = defaultNote;
    const amounts = Object.entries(p.amounts)
      .map(([cur, v]) => `, ${money(v, cur)}`)
      .join('');
    const ok = await ask(
      t('locks.dialogTitle', { from: cal(scope.from_date), to: cal(scope.to_date) }),
      [
        { label: t('common.cancel'), value: false, variant: 'plain' },
        { label: t('locks.confirm'), value: true, variant: 'primary' },
      ],
      <div class="stack">
        <p>{t('locks.preview', { count: p.count, hours: hm(p.seconds), amounts })}</p>
        {p.already_locked > 0 && <p>{t('locks.alreadyLocked', { count: p.already_locked })}</p>}
        {p.running_excluded > 0 && <p>{t('locks.running')}</p>}
        <div class="field">
          <label for="lock-note">{t('locks.note')}</label>
          <input
            id="lock-note"
            maxLength={500}
            value={note}
            onInput={(e) => (note = e.currentTarget.value)}
          />
        </div>
      </div>,
    );
    if (!ok) return false;
    await post('/locks', { ...scope, note });
    toast(t('locks.created'));
    return true;
  } catch (err) {
    showError(err);
    return false;
  }
}

export async function unlockFlow(lock: Lock): Promise<boolean> {
  const choice = await ask(
    t('locks.unlockTitle', { from: cal(lock.from_date), to: cal(lock.to_date) }),
    [
      { label: t('common.cancel'), value: null, variant: 'plain' },
      { label: t('locks.releaseRates'), value: '1', variant: 'plain' },
      { label: t('locks.keepRates'), value: '0', variant: 'primary' },
    ],
    <p>{t('locks.unlockBody')}</p>,
  );
  if (!choice) return false;
  try {
    await del(`/locks/${lock.id}?release_rates=${choice}`);
    toast(t('locks.unlocked'));
    return true;
  } catch (err) {
    showError(err);
    return false;
  }
}
