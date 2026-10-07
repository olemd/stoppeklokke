// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Home screen (§7.1): the stopwatch. Running time ticks locally from start_at
 * (never polled). The running entry's project, description and start time are
 * editable in place while it runs.
 */
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { formatHMS, splitByDay } from '../../core/time/duration';
import { addDays, dateOf, parseDate, zonedToEpoch } from '../../core/time/tz';
import type { Entry } from '../../shared/schemas';
import { confirmAction } from '../components/Dialog';
import { DescriptionInput } from '../components/DescriptionInput';
import { ProjectPicker, type Refs } from '../components/ProjectPicker';
import { TimeInput } from '../components/TimeInput';
import { showError, toast } from '../components/Toast';
import { get, patch, post, qs } from '../lib/api';
import { entryColor, entryLabel, hm, time } from '../lib/fmt';
import { stopFlow, withConflicts } from '../lib/flows';
import { t } from '../lib/i18n';
import { activeWorkspaceId, activeWorkspaces, settings, timer, workspaceById } from '../lib/store';

const nowSec = () => Math.floor(Date.now() / 1000);

function useNow(intervalMs: number) {
  const [now, setNow] = useState(nowSec());
  useEffect(() => {
    const id = setInterval(() => setNow(nowSec()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

/** The crown: elapsed time, the start/stop pusher and the day-target ring. */
function Crown({
  running,
  elapsed,
  progress,
  onToggle,
  busy,
}: {
  running: boolean;
  elapsed: number;
  progress: number;
  onToggle: () => void;
  busy: boolean;
}) {
  const r = 46;
  const c = 2 * Math.PI * r;
  return (
    <div class={`crown ${running ? 'is-running' : ''}`}>
      <p class="elapsed" aria-hidden="true">
        {formatHMS(elapsed)}
      </p>
      <span class="visually-hidden" role="status">
        {running ? t('timer.running') : t('timer.idle')}
      </span>
      <div class="pusher-wrap">
        <svg class="ring" viewBox="0 0 100 100" aria-hidden="true">
          <circle class="ring-track" cx="50" cy="50" r={r} />
          {progress > 0 && (
            <circle
              class="ring-fill"
              cx="50"
              cy="50"
              r={r}
              stroke-dasharray={`${c * Math.min(progress, 1)} ${c}`}
              transform="rotate(-90 50 50)"
            />
          )}
        </svg>
        <button
          type="button"
          class="pusher"
          disabled={busy}
          aria-label={running ? t('timer.stopLabel') : t('timer.startLabel')}
          aria-keyshortcuts="s"
          onClick={onToggle}
        >
          <span class="pusher-icon" aria-hidden="true">
            {running ? '■' : '▶'}
          </span>
          <span>{running ? t('timer.stop') : t('timer.start')}</span>
        </button>
      </div>
    </div>
  );
}

export function TimerScreen() {
  const s = settings.value!;
  const tz = s.timezone;
  const running = timer.value;
  const now = useNow(running ? 1000 : 30_000);
  const today = dateOf(now, tz);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [busy, setBusy] = useState(false);
  // Fields for the NEXT timer while idle; mirrors the running entry otherwise.
  const [draft, setDraft] = useState<{ refs: Refs; description: string }>({
    refs: { workspace_id: activeWorkspaceId.value, client_id: null, project_id: null },
    description: '',
  });

  const reload = async () => {
    try {
      // Two weeks: today's list plus "recently used" ordering for the picker.
      setEntries(await get<Entry[]>(`/entries${qs({ from: addDays(today, -14), to: today })}`));
    } catch (err) {
      showError(err);
    }
  };
  useEffect(() => void reload(), [today, running?.id, running?.end_at]);

  const recent = useMemo(() => {
    const seen: number[] = [];
    for (const e of entries)
      if (e.project_id !== null && !seen.includes(e.project_id)) seen.push(e.project_id);
    return seen;
  }, [entries]);

  // Today's time per entry (entries crossing midnight count only today's part).
  const todays = useMemo(
    () =>
      entries
        .map((e) => {
          const end = e.end_at ?? now;
          const part = splitByDay(e.start_at, Math.max(end, e.start_at), tz).find(
            (p) => p.date === today,
          );
          return { e, seconds: part?.seconds ?? 0 };
        })
        .filter(
          (x) => x.seconds > 0 || (x.e.end_at === null && dateOf(x.e.start_at, tz) === today),
        ),
    [entries, now, today, tz],
  );
  const total = todays.reduce((a, x) => a + x.seconds, 0);
  const targetSec = s.daily_target_min * 60;
  const elapsed = running ? now - running.start_at : 0;

  const toggle = async () => {
    setBusy(true);
    try {
      if (running) {
        const done = await stopFlow((x) => post('/timer/stop', x), running.start_at);
        if (done) timer.value = null;
      } else {
        const r = await withConflicts((x) =>
          post<{ entry: Entry }>('/timer/start', {
            ...draft.refs,
            description: draft.description,
            ...x,
          }),
        );
        if (r) {
          timer.value = r.entry;
          setDraft({ ...draft, description: '' });
        }
      }
    } catch (err) {
      showError(err);
    } finally {
      setBusy(false);
    }
  };

  // Keyboard shortcut `s` (§7.4) toggles the timer when not typing.
  const toggleRef = useRef(toggle);
  toggleRef.current = toggle;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (e.key !== 's' || e.ctrlKey || e.metaKey || e.altKey) return;
      if (el.closest('input, textarea, select, [contenteditable], dialog')) return;
      e.preventDefault();
      void toggleRef.current();
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, []);

  const patchRunning = async (body: Record<string, unknown>) => {
    try {
      const r = await withConflicts((x) => patch<Entry>('/timer', { ...body, ...x }));
      if (r) timer.value = r;
    } catch (err) {
      showError(err);
    }
  };

  const refs: Refs = running
    ? {
        workspace_id: running.workspace_id,
        client_id: running.client_id,
        project_id: running.project_id,
      }
    : draft.refs;
  const [desc, setDesc] = useState(running?.description ?? draft.description);
  useEffect(
    () => setDesc(running ? running.description : draft.description),
    [running?.id, running?.description],
  );

  const startClock = running
    ? (() => {
        const p = new Intl.DateTimeFormat('en-GB', {
          timeZone: tz,
          hour: 'numeric',
          minute: 'numeric',
          hourCycle: 'h23',
        }).formatToParts(running.start_at * 1000);
        return {
          hour: Number(p.find((x) => x.type === 'hour')!.value),
          minute: Number(p.find((x) => x.type === 'minute')!.value),
        };
      })()
    : null;

  const workspaceTargets = activeWorkspaces.value.filter((w) => w.daily_target_min);

  return (
    <div class="timer-screen">
      <h1 class="visually-hidden" tabIndex={-1}>
        {t('timer.title')}
      </h1>
      <section class="timer-hero" aria-label={t('timer.title')}>
        <Crown
          running={!!running}
          elapsed={elapsed}
          progress={targetSec ? total / targetSec : 0}
          onToggle={toggle}
          busy={busy}
        />
        {running && <p class="started">{t('timer.startedAt', { time: time(running.start_at) })}</p>}
        <div class="timer-fields">
          <DescriptionInput
            id="desc"
            label={t('timer.descriptionLabel')}
            placeholder={t('timer.description')}
            value={desc}
            projectId={refs.project_id}
            onChange={(v) => {
              setDesc(v);
              if (!running) setDraft({ ...draft, description: v });
            }}
            onBlur={() =>
              running && desc !== running.description && void patchRunning({ description: desc })
            }
            onPick={(sug) => {
              const picked =
                refs.project_id === null && refs.client_id === null
                  ? {
                      workspace_id: sug.workspace_id,
                      client_id: sug.client_id,
                      project_id: sug.project_id,
                    }
                  : null;
              if (running) void patchRunning({ description: sug.description, ...(picked ?? {}) });
              else setDraft({ description: sug.description, refs: picked ?? draft.refs });
            }}
            onEnter={() => !running && void toggle()}
          />
          <ProjectPicker
            id="project"
            label={t('timer.project')}
            value={refs}
            recent={recent}
            onChange={(v) =>
              running ? void patchRunning({ ...v }) : setDraft({ ...draft, refs: v })
            }
          />
          {running && (
            <TimeInput
              id="start-time"
              label={t('timer.startTime')}
              value={startClock}
              required
              onChange={(v) => {
                if (!v) return;
                const { year, month, day } = parseDate(dateOf(running.start_at, tz));
                let at = zonedToEpoch(year, month, day, v.hour, v.minute, tz);
                if (at > nowSec() + 300) at -= 86400; // "23:50" typed just after midnight means yesterday
                if (at !== running.start_at) void patchRunning({ start_at: at });
              }}
            />
          )}
          {running && (
            <button
              type="button"
              class="btn plain"
              onClick={async () => {
                if (!(await confirmAction(t('timer.discardConfirm'), t('timer.discard'), true)))
                  return;
                try {
                  await post('/timer/discard');
                  timer.value = null;
                  toast(t('timer.discarded'));
                } catch (err) {
                  showError(err);
                }
              }}
            >
              {t('timer.discard')}
            </button>
          )}
        </div>
      </section>

      <section class="today" aria-labelledby="today-title">
        <div class="today-head">
          <h2 id="today-title">{t('timer.today')}</h2>
          <p class="today-total">
            {targetSec
              ? t('timer.target', { done: hm(total), target: hm(targetSec) })
              : t('timer.todayTotal', { total: hm(total) })}
          </p>
        </div>
        {targetSec > 0 && (
          <progress
            class="bar"
            max={targetSec}
            value={Math.min(total, targetSec)}
            aria-label={t('timer.targetLabel')}
          />
        )}
        {workspaceTargets.length > 1 &&
          workspaceTargets.map((w) => {
            const done = todays
              .filter((x) => x.e.workspace_id === w.id)
              .reduce((a, x) => a + x.seconds, 0);
            const tgt = (w.daily_target_min ?? 0) * 60;
            return (
              <div class="ws-target" key={w.id}>
                <span>
                  {w.name}: {t('timer.target', { done: hm(done), target: hm(tgt) })}
                </span>
                <progress
                  class="bar small"
                  max={tgt}
                  value={Math.min(done, tgt)}
                  aria-label={w.name}
                />
              </div>
            );
          })}
        {todays.length === 0 ? (
          <p class="empty">{t('timer.nothingToday')}</p>
        ) : (
          <ul class="entry-list">
            {todays.map(({ e, seconds }) => (
              <li key={e.id} class="entry-row">
                <span
                  class="swatch"
                  style={{ backgroundColor: entryColor(e) ?? 'transparent' }}
                  aria-hidden="true"
                />
                <div class="entry-main">
                  <span class="entry-desc">{e.description || t('timer.untitled')}</span>
                  <span class="entry-meta">
                    {entryLabel(e, t('timer.uncategorised'))}
                    {activeWorkspaces.value.length > 1 && (
                      <span class="tag">{workspaceById.value.get(e.workspace_id)?.name}</span>
                    )}
                  </span>
                </div>
                <span class="entry-time">
                  {time(e.start_at)}–{e.end_at ? time(e.end_at) : t('log.running')}
                </span>
                <span class="entry-dur">{hm(seconds)}</span>
                {e.end_at !== null && (
                  <button
                    type="button"
                    class="btn plain small"
                    aria-label={t('timer.continueLabel', {
                      description: e.description || t('timer.untitled'),
                    })}
                    onClick={async () => {
                      try {
                        const r = await withConflicts(() =>
                          post<{ entry: Entry }>(`/entries/${e.id}/continue`),
                        );
                        if (r) timer.value = r.entry;
                      } catch (err) {
                        showError(err);
                      }
                    }}
                  >
                    {t('timer.continue')}
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
