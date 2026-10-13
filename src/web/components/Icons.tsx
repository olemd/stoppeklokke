// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Navigation icons for the mobile bottom bar and header: inline SVG strokes
 * in `currentColor` (no icon font or library). Always decorative: the link
 * text or aria-label carries the name.
 */

const PATHS = {
  timer: (
    <>
      <circle cx="12" cy="13" r="8" />
      <path d="M12 13V9M10 2h4M12 2v3" />
    </>
  ),
  log: <path d="M9 6h12M9 12h12M9 18h12M4 6h.01M4 12h.01M4 18h.01" />,
  reports: <path d="M3 20h18M6 20v-6M12 20V8M18 20v-9" />,
  catalog: <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />,
  settings: (
    <>
      <path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1" />
      <circle cx="15" cy="6" r="2" />
      <circle cx="9" cy="12" r="2" />
      <circle cx="17" cy="18" r="2" />
    </>
  ),
};

export type IconName = keyof typeof PATHS;

export function Icon({ name, class: cls = 'icon' }: { name: IconName; class?: string }) {
  return (
    <svg
      class={cls}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {PATHS[name]}
    </svg>
  );
}
