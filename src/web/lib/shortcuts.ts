// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Desktop keyboard shortcuts (§7.4): `n` new manual entry, `/` focus the
 * project picker, `Esc` close the open form. (`s` start/stop lives on the
 * timer screen, next to the button it presses.) Ignored while typing.
 */
import { navigate, route } from './router';

/** Screens listen for this to close inline forms on Esc. */
export const ESCAPE_EVENT = 'stoppeklokke:escape';

function typing(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return !!el?.closest('input, textarea, select, [contenteditable], dialog');
}

export function installShortcuts(): () => void {
  const onKey = (e: KeyboardEvent) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === 'Escape') {
      // Native <dialog> handles Esc itself; this closes inline forms.
      if (!document.querySelector('dialog[open]')) dispatchEvent(new Event(ESCAPE_EVENT));
      return;
    }
    if (typing(e.target)) return;
    if (e.key === 'n') {
      e.preventDefault();
      navigate('/log?new=1');
    } else if (e.key === '/') {
      e.preventDefault();
      const focus = () => document.getElementById('project')?.focus();
      if (route.value === '/') focus();
      else {
        navigate('/');
        setTimeout(focus, 50);
      }
    }
  };
  addEventListener('keydown', onKey);
  return () => removeEventListener('keydown', onKey);
}
