// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * HH:MM text input. <input type="time"> follows the browser locale and can
 * show a 12-hour clock, which §3 forbids; this always uses the stored
 * clock setting and validates on blur.
 */
import { useEffect, useState } from 'preact/hooks';
import { parseClock } from '../../core/time/format';
import { t } from '../lib/i18n';

interface Props {
  id: string;
  label: string;
  value: { hour: number; minute: number } | null;
  onChange: (v: { hour: number; minute: number } | null) => void;
  required?: boolean;
}

const show = (v: Props['value']) =>
  v ? `${String(v.hour).padStart(2, '0')}:${String(v.minute).padStart(2, '0')}` : '';

export function TimeInput({ id, label, value, onChange, required }: Props) {
  const [text, setText] = useState(show(value));
  const [invalid, setInvalid] = useState(false);
  useEffect(() => setText(show(value)), [value?.hour, value?.minute]);

  const commit = () => {
    if (!text.trim() && !required) {
      setInvalid(false);
      return onChange(null);
    }
    const parsed = parseClock(text);
    setInvalid(!parsed);
    if (parsed) {
      setText(show(parsed));
      onChange(parsed);
    }
  };

  return (
    <div class="field">
      <label for={id}>{label}</label>
      <input
        id={id}
        class="time-input"
        inputMode="numeric"
        autoComplete="off"
        placeholder="HH:MM"
        value={text}
        required={required}
        aria-invalid={invalid}
        aria-describedby={invalid ? `${id}-err` : undefined}
        onInput={(e) => setText(e.currentTarget.value)}
        onBlur={commit}
        onKeyDown={(e) => e.key === 'Enter' && commit()}
      />
      {invalid && (
        <span id={`${id}-err`} class="field-error">
          {t('common.invalidTime')}
        </span>
      )}
    </div>
  );
}
