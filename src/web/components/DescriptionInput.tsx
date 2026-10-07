// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Description field with autocomplete from history (§7.1): debounced 150 ms,
 * max 10 results from the server. Picking a suggestion also selects the
 * client/project last used with it when none is selected.
 */
import { useEffect, useRef, useState } from 'preact/hooks';
import { get, qs } from '../lib/api';
import type { Refs } from './ProjectPicker';

interface Suggestion {
  description: string;
  workspace_id: number;
  client_id: number | null;
  project_id: number | null;
}

interface Props {
  id: string;
  label: string;
  placeholder?: string;
  value: string;
  projectId: number | null;
  onChange: (v: string) => void;
  onPick?: (s: Suggestion) => void;
  onEnter?: () => void;
  onBlur?: () => void;
}

export function DescriptionInput({
  id,
  label,
  placeholder,
  value,
  projectId,
  onChange,
  onPick,
  onEnter,
  onBlur,
}: Props) {
  const [items, setItems] = useState<Suggestion[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const abort = useRef<AbortController>(undefined);

  useEffect(() => {
    if (!open) return;
    clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      abort.current?.abort();
      abort.current = new AbortController();
      try {
        const r = await get<Suggestion[]>(
          `/suggestions/descriptions${qs({ q: value, project_id: projectId })}`,
          abort.current.signal,
        );
        setItems(r.filter((s) => s.description !== value));
        setActive(-1);
      } catch {
        setItems([]);
      }
    }, 150);
    return () => clearTimeout(timer.current);
  }, [value, projectId, open]);

  const pick = (s: Suggestion) => {
    onChange(s.description);
    onPick?.(s);
    setOpen(false);
  };

  const listId = `${id}-list`;
  const showList = open && items.length > 0;
  return (
    <div class="field combo">
      <label for={id}>{label}</label>
      <input
        id={id}
        role="combobox"
        aria-expanded={showList}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={showList && active >= 0 ? `${id}-${active}` : undefined}
        autoComplete="off"
        placeholder={placeholder}
        value={value}
        maxLength={2000}
        onFocus={() => setOpen(true)}
        onBlur={() => {
          setTimeout(() => setOpen(false), 150);
          onBlur?.();
        }}
        onInput={(e) => {
          onChange(e.currentTarget.value);
          setOpen(true);
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' && items.length) {
            e.preventDefault();
            setOpen(true);
            setActive((a) => Math.min(a + 1, items.length - 1));
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setActive((a) => Math.max(a - 1, -1));
          } else if (e.key === 'Enter') {
            if (showList && active >= 0) {
              e.preventDefault();
              pick(items[active]!);
            } else onEnter?.();
          } else if (e.key === 'Escape' && showList) {
            e.stopPropagation();
            setOpen(false);
          }
        }}
      />
      {showList && (
        <div id={listId} role="listbox" class="listbox" aria-label={label}>
          {items.map((s, i) => (
            // biome-ignore lint/a11y/useFocusableInteractive: ARIA 1.2 combobox: options are not focusable; the keyboard stays in the input and moves aria-activedescendant.
            // biome-ignore lint/a11y/useKeyWithClickEvents: ARIA 1.2 combobox: options are not focusable; the keyboard stays in the input and moves aria-activedescendant.
            <div
              key={s.description}
              id={`${id}-${i}`}
              role="option"
              aria-selected={i === active}
              class="option"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => pick(s)}
            >
              {s.description}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export type { Refs };
