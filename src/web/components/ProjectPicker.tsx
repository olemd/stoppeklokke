// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Searchable client/project picker (§7.1), an ARIA 1.2 combobox.
 * Recently used first; the active workspace's options come first, then other
 * workspaces in groups, so a timer can be started in another role without
 * switching (§4.4).
 */
import { useMemo, useRef, useState } from 'preact/hooks';
import { t } from '../lib/i18n';
import {
  activeWorkspaceId,
  activeWorkspaces,
  clientById,
  clients,
  multiWorkspace,
  projects,
} from '../lib/store';

export interface Refs {
  workspace_id: number | null;
  client_id: number | null;
  project_id: number | null;
}

interface Option {
  key: string;
  label: string;
  workspaceId: number;
  color?: string;
  refs: Refs;
}

interface Props {
  id: string;
  label: string;
  value: Refs;
  onChange: (refs: Refs) => void;
  /** Project ids, most recently used first. */
  recent?: number[];
  /** Show workspace-level "No project" options (uncategorised). */
  allowNone?: boolean;
}

export function refsLabel(v: Refs): string {
  if (v.project_id !== null) {
    const p = projects.value.find((x) => x.id === v.project_id);
    const c = p?.client_id ? clientById.value.get(p.client_id) : null;
    return p ? (c ? `${p.name} (${c.name})` : p.name) : '';
  }
  if (v.client_id !== null) {
    const c = clientById.value.get(v.client_id);
    return c ? t('timer.clientOnly', { client: c.name }) : '';
  }
  return t('timer.noProject');
}

export function ProjectPicker({
  id,
  label,
  value,
  onChange,
  recent = [],
  allowNone = true,
}: Props) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const groups = useMemo(() => {
    const rank = (pid: number) => {
      const i = recent.indexOf(pid);
      return i === -1 ? Infinity : i;
    };
    const activeId = activeWorkspaceId.value;
    const wss = [...activeWorkspaces.value].sort((a, b) =>
      a.id === activeId ? -1 : b.id === activeId ? 1 : 0,
    );
    const q = query.trim().toLowerCase();
    return wss
      .map((w) => {
        const opts: Option[] = [];
        if (allowNone) {
          opts.push({
            key: `w${w.id}`,
            label: t('timer.noProject'),
            workspaceId: w.id,
            refs: { workspace_id: w.id, client_id: null, project_id: null },
          });
        }
        const ps = projects.value
          .filter((p) => p.workspace_id === w.id && !p.archived)
          .sort((a, b) => rank(a.id) - rank(b.id) || a.name.localeCompare(b.name));
        for (const p of ps) {
          const c = p.client_id ? clientById.value.get(p.client_id) : null;
          opts.push({
            key: `p${p.id}`,
            label: c ? `${p.name} (${c.name})` : p.name,
            workspaceId: w.id,
            color: p.color,
            refs: { workspace_id: w.id, client_id: p.client_id, project_id: p.id },
          });
        }
        for (const c of clients.value.filter((x) => x.workspace_id === w.id && !x.archived)) {
          opts.push({
            key: `c${c.id}`,
            label: t('timer.clientOnly', { client: c.name }),
            workspaceId: w.id,
            refs: { workspace_id: w.id, client_id: c.id, project_id: null },
          });
        }
        return {
          workspace: w,
          options: q ? opts.filter((o) => o.label.toLowerCase().includes(q)) : opts,
        };
      })
      .filter((g) => g.options.length);
  }, [query, recent.join(','), projects.value, clients.value, activeWorkspaces.value, allowNone]);

  const flat = groups.flatMap((g) => g.options);
  const choose = (o: Option) => {
    onChange(o.refs);
    setOpen(false);
    setQuery('');
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setOpen(true);
      setActive((a) => Math.min(a + 1, flat.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === 'Enter' && open && flat[active]) {
      e.preventDefault();
      choose(flat[active]!);
    } else if (e.key === 'Escape' && open) {
      e.stopPropagation();
      setOpen(false);
      setQuery('');
    }
  };

  const listId = `${id}-list`;
  const activeKey = open ? flat[active]?.key : undefined;
  return (
    <div class="field combo">
      <label for={id}>{label}</label>
      <input
        ref={inputRef}
        id={id}
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={activeKey ? `${id}-${activeKey}` : undefined}
        autoComplete="off"
        placeholder={t('timer.searchProjects')}
        value={open ? query : refsLabel(value)}
        onFocus={() => {
          setOpen(true);
          setActive(0);
        }}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onInput={(e) => {
          setQuery(e.currentTarget.value);
          setActive(0);
          setOpen(true);
        }}
        onKeyDown={onKeyDown}
      />
      {open && (
        <div id={listId} role="listbox" class="listbox" aria-label={label}>
          {flat.length === 0 && <div class="listbox-empty">{t('timer.noMatches')}</div>}
          {groups.map((g) => (
            // biome-ignore lint/a11y/useSemanticElements: role="group" inside a listbox (ARIA 1.2); a <fieldset> is not valid there.
            <div
              role="group"
              key={g.workspace.id}
              aria-label={multiWorkspace.value ? g.workspace.name : undefined}
            >
              {multiWorkspace.value && (
                <div class="listbox-group" aria-hidden="true">
                  {g.workspace.name}
                </div>
              )}
              {g.options.map((o) => (
                // biome-ignore lint/a11y/useFocusableInteractive: ARIA 1.2 combobox: options are not focusable; the keyboard stays in the input and moves aria-activedescendant.
                // biome-ignore lint/a11y/useKeyWithClickEvents: ARIA 1.2 combobox: options are not focusable; the keyboard stays in the input and moves aria-activedescendant.
                <div
                  key={o.key}
                  id={`${id}-${o.key}`}
                  role="option"
                  aria-selected={o.key === activeKey}
                  class="option"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => choose(o)}
                >
                  {o.color && (
                    <span class="swatch" style={{ backgroundColor: o.color }} aria-hidden="true" />
                  )}
                  {o.label}
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
