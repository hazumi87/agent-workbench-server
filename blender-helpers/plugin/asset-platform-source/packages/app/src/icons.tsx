// One icon set for the Asset Library. Aurora-owned: 24px viewBox,
// stroke = currentColor, one stroke weight, round caps/joins. Size comes from
// CSS (`.icon` → 1em by default); colour follows the button's text colour.
// Decorative by default (aria-hidden) — the BUTTON carries the aria-label.
//
// Size rules (Aurora):
//   desktop toolbar button: icon 16px, hit area ≥ 28px
//   phone toolbar button:   icon 20px, hit area ≥ 44px (min-width + min-height)
//   phone tab bar:          icon 22px, hit area = the whole tab (≥ 56px tall)
//   inline with text (↻ Reload, ＋ Use as reference, Copy): 1em, gap 6px
//
// Suggested CSS (asset-platform owns App.css):
//   .icon { width: 1em; height: 1em; flex: none; display: inline-block; vertical-align: -0.125em; }
//   .av-tbtn .icon, .ctrl-btn .icon { font-size: 16px; }
//   @media (max-width: 720px) { .av-tbtn .icon, .ctrl-btn .icon { font-size: 20px; } }
import type { ReactNode, SVGProps } from 'react';

export type IconProps = Omit<SVGProps<SVGSVGElement>, 'children'> & {
  /** Accessible name. Set it only for an icon that stands alone with no labelled parent. */
  title?: string;
};

export const ICON_STROKE = 1.8;

function Icon({ title, className, children, ...rest }: IconProps & { children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={ICON_STROKE}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className ? `icon ${className}` : 'icon'}
      aria-hidden={title ? undefined : true}
      role={title ? 'img' : undefined}
      focusable="false"
      {...rest}
    >
      {title && <title>{title}</title>}
      {children}
    </svg>
  );
}

const make = (name: string, body: ReactNode) => {
  const C = (p: IconProps) => <Icon {...p}>{body}</Icon>;
  C.displayName = name;
  return C;
};

// ── viewer toolbar ──
export const IconEdit = make('IconEdit', <><path d="M4 20h4L19 9l-4-4L4 16z" /><path d="M13.5 6.5l4 4" /></>);
export const IconDownload = make('IconDownload', <><path d="M12 4v11" /><path d="M7 10l5 5 5-5" /><path d="M5 20h14" /></>);
export const IconTrash = make('IconTrash', <><path d="M4 7h16" /><path d="M9 7V4h6v3" /><path d="M6 7l1 13h10l1-13" /><path d="M10 11v6M14 11v6" /></>);
export const IconMusic = (p: IconProps) => <Icon {...p}><path d="M9 18V5l11-2v13" /><circle cx="6" cy="18" r="3" /><circle cx="17" cy="16" r="3" /></Icon>;
export const IconSearch = (p: IconProps) => <Icon {...p}><circle cx="11" cy="11" r="6.5" /><path d="M16 16l4.5 4.5" /></Icon>;
export const IconCheck = (p: IconProps) => <Icon {...p}><path d="M5 12.5l4.5 4.5L19 7.5" /></Icon>;
export const IconClose = make('IconClose', <path d="M6 6l12 12M18 6L6 18" />);
export const IconScissors = make('IconScissors', <><circle cx="6" cy="7" r="2.5" /><circle cx="6" cy="17" r="2.5" /><path d="M8.2 8.3L20 18M8.2 15.7L20 6" /></>);
// Model Studio: an isometric cube, the mesh verbs' glyph.
export const IconCube = make('IconCube', <><path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z" /><path d="M4 7.5l8 4.5 8-4.5M12 12v9" /></>);

// ── navigation ──
export const IconBack = make('IconBack', <><path d="M20 12H5" /><path d="M11 6l-6 6 6 6" /></>);
export const IconChevronLeft = make('IconChevronLeft', <path d="M15 5l-7 7 7 7" />);
export const IconChevronRight = make('IconChevronRight', <path d="M9 5l7 7-7 7" />);
export const IconChevronDown = make('IconChevronDown', <path d="M5 9l7 7 7-7" />);
export const IconMenu = make('IconMenu', <path d="M4 6h16M4 12h16M4 18h16" />);

// ── library controls ──
export const IconFilter = make('IconFilter', <path d="M4 5h16l-6 7.5V19l-4-2v-4.5z" />);
export const IconSort = make('IconSort', <><path d="M8 4v16M4 16l4 4 4-4" /><path d="M16 20V4M12 8l4-4 4 4" /></>);
export const IconLayout = make('IconLayout', <><rect x="4" y="4" width="7" height="7" rx="1" /><rect x="13" y="4" width="7" height="7" rx="1" /><rect x="4" y="13" width="7" height="7" rx="1" /><rect x="13" y="13" width="7" height="7" rx="1" /></>);
export const IconPlus = make('IconPlus', <path d="M12 5v14M5 12h14" />);
export const IconPlay = make('IconPlay', <path d="M8 5l11 7-11 7z" fill="currentColor" />);
export const IconPause = make('IconPause', <path d="M8 5v14M16 5v14" />);

// ── preview actions ──
export const IconReload = make('IconReload', <><path d="M20 12a8 8 0 1 1-2.3-5.7" /><path d="M20 4v5h-5" /></>);
export const IconLink = make('IconLink', <><path d="M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1.5 1.5" /><path d="M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 0 0 5.66 5.66l1.5-1.5" /></>);
export const IconCopy = make('IconCopy', <><rect x="8" y="8" width="12" height="12" rx="1.5" /><path d="M16 8V5.5A1.5 1.5 0 0 0 14.5 4h-9A1.5 1.5 0 0 0 4 5.5v9A1.5 1.5 0 0 0 5.5 16H8" /></>);
export const IconStar = make('IconStar', <path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z" />);
/** Filled star for the favourited state — same outline, filled with currentColor. */
export const IconStarFilled = make('IconStarFilled', <path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z" fill="currentColor" />);
export const IconArrowUp = make('IconArrowUp', <path d="M12 4l7 8h-4v8H9v-8H5z" />);
export const IconArrowDown = make('IconArrowDown', <path d="M12 20l-7-8h4V4h6v8h4z" />);

// ── image generation ──
export const IconPower = make('IconPower', <><path d="M12 3v9" /><path d="M6.3 6.3a8 8 0 1 0 11.4 0" /></>);
export const IconSparkle = make('IconSparkle', <path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8zM18.5 15.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z" />);

// ── phone tabs ──
export const IconLibrary = make('IconLibrary', <><rect x="4" y="4" width="7" height="7" rx="1" /><rect x="13" y="4" width="7" height="7" rx="1" /><rect x="4" y="13" width="7" height="7" rx="1" /><rect x="13" y="13" width="7" height="7" rx="1" /></>);
export const IconImage = make('IconImage', <><rect x="3.5" y="4.5" width="17" height="15" rx="1.5" /><circle cx="9" cy="10" r="1.8" /><path d="M20.5 16l-5-5-8.5 8.5" /></>);

/** Spinner — the one icon that animates; needs `@keyframes icon-spin { to { transform: rotate(360deg) } }` and `.icon-spin { animation: icon-spin .9s linear infinite }`. */
export const IconSpinner = make('IconSpinner', <path d="M12 3a9 9 0 1 1-9 9" />);
