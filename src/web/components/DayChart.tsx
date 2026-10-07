// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Hours per day as an inline SVG bar chart (no chart library, §7.1 #3).
 * One series → one colour, no legend (the heading names it). Each bar has a
 * full-height hover target with a tooltip; the summary table is the table view.
 */
import { useState } from 'preact/hooks';
import { formatCalendarDate } from '../../core/time/format';
import { hm } from '../lib/fmt';
import { t, translator } from '../lib/i18n';

const W = 720;
const H = 160;
const PAD_L = 36;
const PAD_B = 22;

export function DayChart({ days }: { days: { date: string; seconds: number }[] }) {
  const [hover, setHover] = useState<number | null>(null);
  if (!days.length) return null;
  const loc = { locale: translator.value.locale };
  const maxHours = Math.max(1, Math.ceil(Math.max(...days.map((d) => d.seconds)) / 3600));
  const plotW = W - PAD_L;
  const plotH = H - PAD_B;
  const slot = plotW / days.length;
  const gap = slot >= 6 ? 2 : 0;
  const barW = Math.max(1, slot - gap);
  const y = (secs: number) => plotH - (secs / (maxHours * 3600)) * plotH;
  const total = days.reduce((a, d) => a + d.seconds, 0);
  const first = days[0]!.date;
  const last = days[days.length - 1]!.date;
  const hd = hover !== null ? days[hover] : null;

  return (
    <figure class="chart">
      <figcaption class="chart-title">{t('reports.chartTitle')}</figcaption>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={t('reports.chartLabel', {
          from: formatCalendarDate(first, loc),
          to: formatCalendarDate(last, loc),
          total: hm(total),
        })}
        onMouseLeave={() => setHover(null)}
      >
        <line class="chart-axis" x1={PAD_L} x2={W} y1={plotH} y2={plotH} />
        <line class="chart-grid" x1={PAD_L} x2={W} y1={0.5} y2={0.5} />
        <text class="chart-tick" x={PAD_L - 6} y={10} text-anchor="end">
          {maxHours}h
        </text>
        <text class="chart-tick" x={PAD_L - 6} y={plotH} text-anchor="end">
          0
        </text>
        {days.map((d, i) => {
          const x = PAD_L + i * slot + gap / 2;
          const top = y(d.seconds);
          const h = plotH - top;
          // Rounded top (up to 4px), square at the baseline.
          const r = Math.min(4, barW / 2, h);
          const path =
            h <= 0
              ? ''
              : `M${x},${plotH}V${top + r}Q${x},${top} ${x + r},${top}H${x + barW - r}Q${x + barW},${top} ${x + barW},${top + r}V${plotH}Z`;
          return (
            <g key={d.date} onMouseEnter={() => setHover(i)}>
              <rect class="chart-hit" x={PAD_L + i * slot} y={0} width={slot} height={plotH} />
              {path && <path class={`chart-bar ${hover === i ? 'is-hover' : ''}`} d={path} />}
            </g>
          );
        })}
        <text class="chart-tick" x={PAD_L} y={H - 4}>
          {formatCalendarDate(first, loc)}
        </text>
        <text class="chart-tick" x={W} y={H - 4} text-anchor="end">
          {formatCalendarDate(last, loc)}
        </text>
      </svg>
      <p class="chart-tooltip" aria-hidden="true">
        {hd ? `${formatCalendarDate(hd.date, loc)}: ${hm(hd.seconds)}` : ' '}
      </p>
    </figure>
  );
}
