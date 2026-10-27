/* THE CLI SPECIAL KEYS, ONE LIST [ipad keys] Owner 2026-10-05. The solo page's keypad (solo.js buildTouchKeypad) draws
 * these from its own markup; the ROOM page's rail "Keys" block (touch tablet, room.js) draws them from here and
 * postMessages the sequence to the open seat's solo frame, which sends it only if it is one of THESE (a same-origin
 * parent is trusted, but a message is not a licence to type anything into a shell). Same set as the keypad, minus the
 * two keys that are about the page rather than the CLI (paste, text size). */
/* `arrow` = a rotation in degrees of the ONE arrow SVG (up = 0), so all four match; `icon: 'newline'` = shift + return, `icon: 'tick'` = the
   backtick, drawn as SVG (the font glyphs are too small to read at a key's size); `label` is text. */
export const KEYS = [
  /* the ROOM RAIL lays these out as a numeric keypad, three columns, in THIS order (Owner 2026-10-05):
       Esc   up   Tab
       left  down right
       `     newline  Enter */
  { seq: '\x1b', label: 'esc', aria: 'Escape', cls: 'kp-wide' },
  { seq: '\x1b[A', arrow: 0, aria: 'Up', cls: '' },
  { seq: '\t', label: 'tab', aria: 'Tab', cls: 'kp-wide' },
  { seq: '\x1b[D', arrow: 270, aria: 'Left', cls: '' },
  { seq: '\x1b[B', arrow: 180, aria: 'Down', cls: '' },
  { seq: '\x1b[C', arrow: 90, aria: 'Right', cls: '' },
  { seq: '`', icon: 'tick', aria: 'Backtick', cls: '' },
  { seq: '\x1b\r', icon: 'newline', aria: 'Newline (ctrl+enter)', cls: '' },
  { seq: '\r', label: 'Enter', aria: 'Enter', cls: 'kp-wide' },
];

export const isKeypadSeq = (s) => typeof s === 'string' && KEYS.some((k) => k.seq === s);
