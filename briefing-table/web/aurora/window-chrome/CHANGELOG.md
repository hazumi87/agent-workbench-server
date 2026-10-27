# window-chrome — changelog

Versions are the aurora `VERSION` integer at publish time. Compatibility is
stated explicitly per release (architecture §5.1). `BREAKING` headings mark
changes that require consumer action.

## v35 — 2026-10-06 — the Workbench; .ghost scoped

**Additive except one rename. Drop-in over v34.**
- The home tab is the **Workbench** (owner ruling 2026-10-06; it was the CLI Manager). Its name, tooltip and the + button's
  tooltip come from `hwbRenderTabs(root, { hubName })`, default `'Workbench'`. Pass `hubName: 'CLI Manager'` to keep
  the old label during a migration.
- `.ghost` (the terminal's ghosted project logo) is now `.hwb .ghost`. Unscoped, it repositioned any consumer element
  that also used a `.ghost` class (the host app's account page Sign out button) wherever the bundle was loaded.
  Inside a window nothing changes.

## v34 — 2026-10-05 — light mode, decided per tab (the owner)

**Additive, not breaking. Drop-in over v33.** A consumer that sets no `data-mode` anywhere sees no change.
- **Light mode**: when the host sets `html[data-mode=light]` (the host app's palette.mjs already does), tabs, the
  session bar / `.hwb-barwash` and ring plates take light recipes. Same oklch derivations, only L moves:
  - inactive tab .885, selected tab .965 → .93 (S9: the selected tab stays the lightest);
  - the bar .93 → .96, so the S10 join stays seamless (`--p-mid` = `--sb-mid`);
  - inks .25 / .42; the tab watermark .45; glow .80.
- **Per tab**: `hwbRenderTabs` tabs take `mode: 'light'|'dark'` (the room's own Dark/Light override). Omit it to follow
  the shell. A dark tab in a light strip (or the reverse) carries its own ink: tabs and the bar never borrow the
  page's `--text` again. `hwbRenderSessionBar` takes `s.mode` (pass the SELECTED tab's mode).
- **Ring brand plate** follows the mode it sits in, through an inherited `--lt` (0 dark | 1 light): a light plate
  with a deeper mark in light.
- Unselected tab names: `--text` at 72% in light (about 5:1 on the .885 wash) vs 58% in dark.
- Replaces the host app's interim `web/light-mode.css` `.hwb-tab` block (ui/light-tabs e5ea314). Drop it when
  you adopt v34.

## v33 — 2026-09-30 — "blocked on you, seen"

**Additive, not breaking. Drop-in over v32.** A new chrome state `waiting-seen` (ring state
`attention-seen`) for an agent blocked on a question the human has SEEN but not answered.
Before, an acked block dropped to plain idle. Now:
- the ring = attention's coral, with the halo FROZEN into a still outer hairline (a double ring;
  identifiable with color removed), no motion;
- rank: attention > alert > attention-seen > streaming (an unseen block and a transport fault
  both outrank a block the human already knows about; any block outranks work);
- a tab in `waiting-seen` gets a static coral hairline, no demand flash; the pip is hollow coral;
- the window's "N blocked" count includes seen blocks (they're still blocked).
Label: "needs you, seen". Pairs with the CLI Manager's coral-outline "needs you: <reason>" chip.

## v32 — 2026-09-28 — watermarks draw with the art's own style; the bar wash is reusable (the owner)

**Additive, not breaking. Drop-in over v31.** the owner: now that art is used as a watermark (not
an icon), it gets the art's fill style and glow wherever it appears.
- `hwbRenderTabs` tabs take an optional `logoStyle: {line, backlit}` (the art library's own
  style blob) and `hwbRenderSessionBar` takes `project.markStyle`. The mark then draws with the
  pane watermark's classes (`.wm-line-outline|blueprint|hatch|engrave|halftone`, `.wm-backlit`),
  the glow in the tab's or bar's own hue. Omit them and the mark is today's solid fill.
- `hwbMarkClass(style)` is exported, so other surfaces (the CLI Manager's agent-card mark, a
  room header mark) apply exactly the same classes.
- `hwb-chrome.css` now `@import`s `hwb-watermark.css` (the line styles + backlight), so a tab
  strip needs no extra link.
- `.hwb-barwash`: the session bar's wash as a class, for any title bar that should read like
  the bar (a room page header). Set `--pc`, and `--bar-wash-x` / `--bar-wash-core` from
  `hwbPositionBarWash` so it fans out from the tab.

## v31 — 2026-09-28 — selection without bars (the owner: no accent bars, tool-wide)

**Additive, not breaking. Drop-in over v30.** New shared class `.hwb-lift` for any
selectable row or card: selected (`.is-sel`, `[aria-selected=true]`, `[aria-pressed=true]`)
= a lifted ground (`--surface3`) + a 1px `--border2` hairline all round, 8px radius; hover
`--surface2`; keyboard focus a teal ring. `--lift-bg` / `--lift-edge` let an identity
(e.g. a room's tint) replace the neutral ground. It replaces the retired left-spine
selection that rooms, the CLI Manager and the Assemble modal copied from the styleguide.
The styleguide's own rows, data table and alerts moved off their bars in the same change.

## v30 — 2026-09-27 — the bar's project mark behind the title (the owner's round 3)

**Visual change, no API change. Drop-in over v29.** The session bar's 28px project mark
becomes a watermark BEHIND the project name and title, at the unselected tab's ruled scale:
72px, top −16px, 14%, anchored left (6px); the title gets the tab label's halo. Line-art
marks read poorly at 28px and well at 72px. Tabs are unchanged. Guidance:
the design page §4.

## v29 — 2026-09-26 — MCP indicator: older long calls stay compact

**Fix, not breaking. Drop-in over v28.** The once-a-second elapsed repaint of a long call
rewrote the chip's classes and dropped `is-compact`, so an older running dispatch showed
written out beside the newest. Found in the Playwright review of cli-manager's wiring.

## v28 — 2026-09-26 — MCP indicator: reconnect replay + the engine's event shape

**Fix, not breaking. Drop-in over v27.** Matches the room-app team's settled `pane.mcp` shape:
- `start()` honours the event's `ts`: a reconnecting window replays in-flight starts,
  so elapsed = now − ts, a replayed long call shows as long at once, its timeout counts
  from ts, and there's no second out packet. Pass the whole event to `start()`/`end()`.
- `why` accepts the engine's closed enum and reads as words in the tooltip
  (isError → "returned an error", denied → "denied by permission", interrupted, failed).

## v27 — 2026-09-25 — MCP-call indicator in the session bar

**Additive, not breaking. Drop-in over v26.**
- **New:** `hwbMcpIndicator(bar, opts?)` (in `hwb-mcp.js`, re-exported from
  `hwb-chrome.js`) → `{ start(id, call), end(id, result), clear(), destroy(), el }`.
  - `call = { server, label?, verb, caller?: {kind:'agent'|'sub', name?}, expectEnd?: boolean }`
  - `result = { result: 'ok'|'warn'|'error', ms?, why? }`
  - opts: `longAfterMs` 3000, `timeoutMs` 30000 (only when `expectEnd:false`), `staleMs`
    30 min, `holdMs` 4000, `dimMs` 8000, `maxChips` 3.
  The ruled design (owner ruling 2026-09-25, M1 wire + C2 strip): "title ──── [MCP · Server · verb]"
  in the bar's spacer. The wire ends flush on the chip; the out packet runs agent → MCP and
  the back packet runs MCP → agent in the result color; long calls use the AB·B relay with
  elapsed time; newest chip first and written out, older ones compact, the rest in +N
  colored by the loudest hidden call, and hovering/focusing +N lists them, failures first.
  A source that can't report an end grays out as "no reply signal", never as ok. Hidden at
  ≤600px. Reduced motion: color only. `hwbRenderSessionBar` keeps an attached indicator
  across re-renders.
- **Tokens (VERSION 27):** `--mcp-out/-ok/-warn/-err/-none` aliases (P1: sky / teal / amber /
  magenta / dim2). P2 (Showcase-literal) is `--mcp-ok:var(--lime); --mcp-err:var(--coral)`.

## v26 — 2026-09-25 — `restorable` in the chrome vocabulary

**Additive, not breaking. Drop-in over v25.**
- `HWB_RANK` gains `restorable` between `idle` and `ended` (the same place the ring's
  rank has it); `HWB_CHROME_ALIAS.restorable = 'restorable'`; `hwbSetState(root,
  'restorable')` no longer throws. A session tab with `state: 'restorable'` draws the
  restorable ring (amber dashed inner ring), the same as a room member tab.
- **Consumer action (recommended):** stop folding restorable into `ended`. A
  dehydrated session isn't ended, and a "restorable" state is what tells people they can
  bring it back.
- Deprecated pip fallback: `.hwb-pip.st-restorable` (dashed amber square).

## v25-note — logo presets
`hwb-logo-presets.js` in this bundle is the example's 5-preset subset. The production
set of 8 is cli-arrangement-v6 `LOGO_PRESETS`, which the host app pins at
`web/vendor/aurora-logo-presets.js`. Don't replace the engine copy with this file.

## v25 — 2026-09-25 — plate-only glyph for never-started seats

**Additive, not breaking. Drop-in over v24.**
- **New:** `hwbRing(el, null, size, { brand, markPath, primary? })` (or spec
  `{state:'none'}`) draws the brand plate + logo with **no ring**, in the ended
  dimming (plate fill 55%, logo 40%), aria "not started". the room-app team's ruling on
  the room-app plan §4.4: a never-started seat shows identity, not lifecycle. B5 still
  works: the gold edge is the plate's stroke and stays full strength, so a
  never-started lead reads as the lead. The same element grows its ring back when
  you call it again with a real state.
- **Tabs:** `state: 'none'` on a tab object (with a `brand`) renders plate-only; its
  tooltip says "not started". It ranks lowest for the aggregate, so it's never the lead glyph.
- Needs a brand plate; without `brand`, `null` falls back to the default ring.

## v24 — 2026-09-25 — level 2: the in-workroom tab row (N3/F1/B5/A2); manila tokens

**Additive, not breaking. Drop-in over v23.** Without the new option nothing changes.
- **New:** `hwbRenderTabs(root, { …, room: { name, chat: {id, active}, onBack, onAdd } })`
  renders the ruled row from workroom-nav-v2: **‹ back** (replaces the hub chip; a
  bare control with a hairline, never a tab) · **F1 folder chat** (manila tab with a
  vertical wash, a step darker unselected; no ring, no watermark, no refresh/close;
  selects through the usual `onSelect(chat.id)`) · the member tabs (`tabs[]`, in your
  order: lead first with `primary: true` = B5) · **A2** (an empty dashed seat with a +,
  replaces the `+`; calls `onAdd`, never `onNew`). A4 holds: each member shows its own
  state; there is no aggregate at this level.
- The back control's label moved into F1: the v2 row has no name on the crumb (N3's
  folder + name is superseded by F1 carrying the room name). Tooltips: `HWB_TIPS.roomBack`,
  `roomChat`, `roomAdd`.
- **Tokens (VERSION 24):** the manila family `--wr-manila`, `--wr-manila-edge`,
  `--wr-manila-ear`, `--wr-tab-top/-bot`, `--wr-tab-on-top/-on-bot`, `--wr-tab-ink/-ink-on`.
  The WR1-B plate now reads them (same values, no visual change).
- `HWB_WR_FOLDER` / `HWB_WR_EAR` exported from `hwb-ring.js`.

## v23 — 2026-09-25 — B5 primary-agent badge; token --lead-gold

**Additive, not breaking. Drop-in over v22.**
- **New:** `hwbRing(el, spec, size, { brand, primary: true })` marks the primary
  (lead) agent per ruling B5 (2026-09-19, workroom-nav-v2): the brand plate's
  OUTER edge, solid, 1.7px, in old gold. Tabs: pass `primary: true` on the tab
  object to `hwbRenderTabs`; it stays on when the tab is selected. Only brand
  plates carry it (no plate edge on a workroom or bare ring).
- **Token:** `--lead-gold` (oklch .74 .12 95), tokens VERSION 23. Use it ONLY as
  that plate outline. Never as a pill, card border or text color: the rule is
  that the lead never reads as amber restorable, and a gold box beside a gold
  outline does exactly that.

## v22 — 2026-09-25 — P3 new-workroom control; tokens v22

**Additive, not breaking. Drop-in over v21.1.**
- **New:** `HWB_NEW_WORKROOM_SVG` and `hwbNewWorkroomButton(label?)` in
  `hwb-chrome.js`, plus `.hwb-ico-newroom` / `.hwb-newroom` in `hwb-chrome.css`.
  The ruled P3 glyph (2026-09-19, workroom-nav-v1): an outlined folder with a +
  in the ink color, not the manila WR1-B plate and no ring, so it reads as a
  button. Sized 1em, colored by `currentColor`, so it drops into a `.btn`, a
  hub list or the tab row. Tooltip `HWB_TIPS.newWorkroom`. N3 (back crumb) and
  A2 (add agent) ship when their surfaces exist.
- **Tokens:** the bundled `tokens.css` is Aurora VERSION 22 (adds the `--ce-*`
  clip-editor family). No existing token changed.

## v21.1 — 2026-09-19 — project-mark tint fix

**Fix, not breaking. Drop-in over v21.** The session bar's project mark
(`.sb-mark`) and the tab watermark (`.tlogo`) tinted only `path`, `circle`,
`rect` and `polygon`. A mark built from `<use>`, `ellipse`, `polyline` or
`line` painted **black** instead of the ruled project tint (3a). Every stored
project logo and preset shipped today uses paths, so they were unaffected;
a user-stored SVG could hit it. The tint is now set on the `<svg>` itself and
the element list covers all six shapes plus `use`. Harness gates added.

Also: the 1d popover now listens for Escape and click-away **immediately**
on opening (v21 attached them one tick later, so an Escape pressed straight
after the click could be missed).

## v21 — 2026-09-19 — the signed-off chrome: brand, session bar, 1d close

**BREAKING (visual + one behavior).** Signed off by owner ruling 2026-09-19. Every
ruling, with a link to the page that shows it:
the design page design decisions page.html`. Reference implementation:
the design page. Pin together with
**brand-marks v1** (`dist/brand-marks/`, new, separate bundle).

### Consumer action required
- **Tab ✕ no longer closes directly (1d).** It opens a popover under the ✕ with
  **End session** and a 3s countdown. Timeout, Escape or a click elsewhere call
  `onClose(id, reason)` and emit `hwb:close-view {id, reason}` — close the view,
  keep the session. **End session** calls the new `onEndSession(id)` and emits
  `hwb:end-session {id}` — wire it to the manager's ✕ End path. End session
  never takes focus. `hwbClosePopover()` is exported if you need it elsewhere.
- **New session bar** `<div class="hwb-sbar">` after `.hwb-bar`, rendered with
  `hwbRenderSessionBar(bar, {project:{name,mark,color}, title, brand, brandColor,
  brandMarkPath, messages, handoff, links})`. It has no close. Its icons emit
  `hwb:messages` / `hwb:handoff` / `hwb:links`.
- **Tabs take brand data:** `brand` (a brandMark key), `brandColor` (the designed
  hue from /api/brands), optional `markPath`; or pass `brandMarkPath(key)` in
  `hwbRenderTabs` opts (import it from brand-marks). `exit` (ok|fail) on ended tabs.
- **New stylesheet** `hwb-watermark.css` for the terminal pane (see below).

### What changed
- Sizes: tab row **40px**, caption buttons **46×40** (the caps follow
  `--hwb-bar-h`; `maxRect.x === W − 92` and the 154px reserve still hold).
- The design system's **square tabs**, 150–240px. **S9 lift + S10 join**: the selected tab
  is lighter and 1px taller and runs into the session bar. **No accent strokes**
  anywhere (the active tab's inset lines and the rail under the row are gone).
- Unselected tabs sit on their **own project's dark tone** (L .20).
- The status glyph is **28px on every tab** — treatment-16 brand plate + logo,
  no viewer dot, **ended dimming**, and the new **active-background** state
  (AB·B segment relay). Chrome states gain `background`; `busy` is accepted as
  `streaming`. `hwbRing(el, spec, size, {brand, markPath, workroom, label})`.
- The project mark is the **tab watermark** on unselected tabs only: 72px,
  top −16px, 28px in from the right, 14%, no fade. The label runs over it with
  a halo in its tab's color.
- **Per-tab refresh** (`onRefresh(id)`, `hwb:refresh`).
- **Tooltips on every icon** (`HWB_TIPS`), including what an icon does NOT do.
- The session bar's wash centers on the **selected tab**:
  `hwbPositionBarWash(root)` sets `--bar-wash-x` / `--bar-wash-core`, measured
  against the window (not offsetLeft), on render, scroll and resize.
- `hwb-watermark.css`: `.wm-pane` (project wash, origin `.wm-at-*`, default
  **ll-mid**), `.wm` + `.wm-line-{outline,blueprint,hatch,engrave,halftone}`,
  `.wm-backlit` (uniform glow). Inject the stored SVG inline.
- **Workrooms:** the WR1-B glyph ships (`hwbRing(..., {workroom:true})`) and a
  tab with `kind:'workroom'` uses it. With no workroom rows **nothing
  workroom-specific renders**; the N3 / P3 / A2 navigation controls ship when
  workroom data exists.

Harness: 113 → see `node tools/verify-window-chrome.cjs` (v21 gates added;
v20 checks whose rulings changed were updated, not deleted).

## v20 — 2026-09-07 — tab notices, copy fields, and the pip/ring ruling

**Behavioural, not breaking.** Two new files (`hwb-copy.css`/`.js`), one new tab
component, and **one visual change a consumer will see without asking for it**:
the tab's state glyph is now `.ring`, not `.hwb-pip`. Existing markup, classes,
attributes and exports all survive; `hwbRenderTabs(root, {glyph:'pip'})` restores
the previous glyph in one word. `hwb-chrome.js` now imports `hwb-ring.js` — both
already ship in this bundle, so it costs a consumer nothing, but the file's old
"no dependencies" claim is no longer true and has been corrected in its header.

Brief: the host app. Surface: the design page.

### The rule the whole release is built to protect

**A NOTICE IS NOT AN ASK.** `.hwb-tab.st-waiting` demand-flashes because an agent
is blocked on you and nothing proceeds until you answer. A stale sudo credential
and "3 fields are waiting" are neither urgent nor answerable-by-looking. If
either borrowed the demand treatment, the flash would stop meaning "someone is
waiting for you" and start meaning "something is off somewhere" — which is how
both signals die. **And a notice is never cleared by being seen:** the credential
note is a projection of the tool's own state, so it clears when the tool renews,
never because the user looked at the tab.

Three guarantees, mechanical rather than conventional, each a gate in the harness:

1. **No motion** — `animation:none !important` on `.hwb-note`.
2. **No coral** — `--coral` *is* the demand hue (`--act-attention`) and is
   unreachable from every notice variant. A notice cannot be painted to look
   like a demand even by mistake.
3. **Square, not round** — state marks in this system are circles (pip, ring,
   ring center). Notices are rounded rectangles at every size, down to the 7px
   collapsed form. Shape says which register you are reading, before color and
   before text.

A fourth is asserted negatively: no `:hover`, `:focus`, `.is-read` or `.is-seen`
rule may exist on a notice.

### A + B are ONE component — `.hwb-notes` / `.hwb-note`

Not because a tool status and an item count are the same fact, but because the
surface is 96–240px and has room for one more slot, not two, **and because both
answer the same question** — *is this session carrying something I should know
about?* That is the test for whether two things are one component.

They share a rail, and when both are present the rail resolves it the way this
bundle already resolves N-signals-on-one-surface everywhere else (`hwbAggregate`,
`hwbRingLead`): **the lead renders in full, the rest collapse to dots.** Rank is
`cold > warn > items`.

**Loudness tracks severity, and nothing in the rail outranks a demand.** The
first cut painted `warn` as solid amber and it came out the brightest thing on
the titlebar — louder than the coral demand two tabs away. *That is the
load-bearing rule broken by luminance instead of by motion*, which is the version
of the mistake no "don't animate it" gate would have caught. Only the fault tier
is solid now:

| variant | treatment | why that hue |
|---|---|---|
| `.n-items` | neutral ground, `--teal` ink | content addressed to you, not a fault. `--teal` is the one function color no session state uses. |
| `.n-warn` | amber-tinted ground, amber ink | a deadline is coming — amber already means this (the ring's `restorable`) |
| `.n-cold` | solid `--magenta` | `--act-severed` already means "this is broken". An expired credential is a fault, not a question. |

**`kind:'ok'` renders nothing.** A badge saying nothing is wrong is not a notice,
it is clutter on a 96px chip — and on a strip of ten tabs it is ten pieces of
clutter. Dropped in `hwbTabNotices()` *and* in CSS (`.n-ok{display:none}`), so a
hand-built chip cannot reintroduce it.

**The mark is mandatory, the text is opportunistic.** The tab measures itself
with a size container — no host obligation on resize, because upkeep a consumer
can forget is not upkeep (the `hwbUpdateOverflow` argument). Thresholds are
**content-box** widths and `.hwb-tab` has 8px of padding a side, so the CSS says
154/108 for a 170px/124px tab. The first cut used the tab numbers and every tier
fired 16px early.

| tab width | status note | items note |
|---|---|---|
| > 170px | dot + countdown (`4h12m` → `EXPIRED`) | count |
| 124–170px | 7px square, countdown on hover | count |
| < 124px | 7px square | 7px square |

With five tabs in a 1000px window the middle row is the ordinary case, and it is
the right one: at that width a readable session name and a five-character
countdown cannot both be true.

**The countdown costs no polling.** `expiresAt` is an epoch-ms number the engine
passes through unread; `hwbNoticeClock()` ticks locally and re-renders *text
only*, so a tab is never rebuilt under the pointer.

**Expiry escalation is arithmetic, not invention.** A `warn` whose own
`expiresAt` has passed renders as `cold`/`EXPIRED`. That conclusion comes from
the number the tool published, not from the client deciding something about the
tool — and an amber badge reading `0m` on a dead credential is the exact failure
this was asked to fix. An engine that does not want it publishes `kind:'cold'`
itself, or `expiresAt:null`.

New exports: `hwbTabNotices` · `hwbNotesHTML` · `hwbNoteCountdown` ·
`hwbNoticeClock` · `HWB_NOTE_RANK` · `HWB_NOTE_KINDS`.

### C · copy fields — `.copyfields` (`hwb-copy.css` / `hwb-copy.js`)

Promoted from the host app's hand-rolled `.handoff-*`. Named `.copyfields`
rather than `.hwb-copy` for the same reason `.ring` is not `.hwb-ring`: it ships
in this bundle but it is not window chrome, and a public class name should not
lie about what it is.

- **The value wraps and never ellipsises.** A truncated credential still *looks*
  like a value and is not one. `overflow-wrap:anywhere`, because tokens have no
  spaces to break at. The **label** may truncate; the value may not.
- **A masked secret copies while still masked.** Masking is
  `-webkit-text-security` — presentational only, so the real characters stay in
  the DOM and `cfCopy()` reads `textContent`. **There is no code path in which
  the clipboard receives dots.** A JS mask that swapped the string would have
  exactly that path. The `@supports` fallback (transparent + text-shadow) keeps
  the same property.
- **The actions are the panel's own buttons**, at `.btn.sm`'s metrics, on the
  *label* line — so the value is the largest thing in the row at every width.
- **320px to desktop with no breakpoint.** `hwb-copy.css` declares zero media
  queries; a layout that cannot switch cannot switch wrongly.

**BREAKING FOR NOBODY, BUT READ IT — a class collision consumers can hit.**
The design system's button modifier `.ghost` and window-chrome's watermark `.ghost`
(`position:absolute`, 46% wide, max 330px) are the same class name. They never
met in the styleguide; inside this bundle they do. The first cut wrote
`class="btn sm ghost cf-act"` and the Copy button was laid out **130px above its
own row and 330px wide** — while every computed-style assertion passed, because
the paint was right and only the position was wrong. `.cf-act` is self-contained
so this markup needs no shared button class. **If your host UI uses
`.btn.ghost` inside a `.hwb` subtree, scope it.**

### D · pip and ring converge — the ring wins

the owner saw his tabs showing `-`, did not know what it meant, and asked. That is
`.hwb-pip.st-idle`: an 8×2px bar. He has ruled on this shape of question once
already (2026-09-01, solo titlebar dot vs manager ring): *"while defensible, the
difference is more cognitive load on the user."*

The pip's vocabulary has no through-line — a dot, a dash, a hollow square, an arc
— so each glyph must be learned separately and `-` cannot be guessed. The ring is
one shape whose silhouette varies, it is already a public component with a
documented size ladder and a stated 10px floor, and `HWB_CHROME_ALIAS` already
maps every chrome state onto it. **The bridge was already built; the tab was not
using it.** The tab ring is viewer-less (a tab is the window *you* are looking
at) and renders at 12px.

Three things came with the convergence rather than being paid for:

- **No blinking wall.** The strip is an aggregate surface, so it takes the rule
  the ring already ships for manager lists: exactly one glyph animates.
  `.is-lead` now lands on the winning **tab** as well as its ring, so the tab's
  own background demand animation obeys it too
  (`.hwb-tabs.ctx-aggregate .hwb-tab:not(.is-lead){animation:none}`). Five
  waiting tabs used to demand-flash five times over, and a demand permanently on
  the screen somewhere is a demand nobody reads. Scarcity is what makes the
  treatment worth anything — which is the same argument as the notice rule above,
  approached from the other side.
- **The tooltip names the state in words** (`hwbRingLabel`, state clause only).
  It existed for screen readers and was not reaching the pointer, which is the
  literal answer to "I didn't know what it meant".
- **`watching` stops being a special case** — it aliases to `active-idle` on the
  tab exactly as in the manager. The alias table's own reasoning ("a manager list
  summarising twenty sessions has no use for it") applies to a tab strip too,
  because a tab strip is also an aggregate.

`.hwb-pip` is **retained and still works** — `glyph:'pip'` — but it is deprecated
and will not gain features.

### Harness: 75 → 113 assertions

Three of the new ones exist because they caught this release's own bugs, and all
three are the file's founding lesson restated — *a green check is not a check on
the failing path*:

- **"the pill is a rounded rectangle"** was reading a *collapsed* note, because
  at five tabs every note is collapsed. It asserted 3px against an element that
  is 2px by design.
- **"the items pill is opaque"** parsed the last number before `)` as the alpha
  and was reading the **blue channel**. It failed an opaque color, and would
  have passed a translucent one whose blue happened to be 1.
- **"the actions are not 44px touch targets"** passed against a *completely
  unstyled* native button, because `.btn` is not in this bundle. A size bound
  alone cannot tell a correct button from an absent stylesheet — the check now
  pins radius, padding, font size, *and containment inside its own row*, which
  is what caught the `.ghost` collision.

Every notice check also read `textContent`, which survives `display:none` — so
all of them would have passed on a tab where the countdown is invisible. There is
now a check that closes two tabs to reach the width where the full form is meant
to appear and asserts it is actually on the screen.

## v19 — 2026-08-09 — tear-off ghost + dock drop-preview ( complete)

**Not breaking.** Two new files, `hwb-drag.css` + `hwb-drag.js`. A host that
never imports them is unaffected. ** is now complete** — chevrons landed
in v18; these are 2 and 3.

They ship **together on purpose.** Specifying one without the other leaves a host
guessing at the transition between them, and the transition is most of the
interaction: the ghost is the question, the caret is the answer.

### Drop preview — `.is-droptarget` + `.hwb-dropcaret`

The **band** lights, not the window. A full-window overlay would obscure the very
content the user is deciding about, and the decision is *which window*, which the
bar identifies on its own.

The caret is a **2px bar at the insertion point, not a gap opening between tabs**.
A gap re-lays-out the strip on every pointer move — which changes the very rects
the host is hit-testing mid-drag, and costs a reflow per frame.

**`--teal`, and it is not an exception to color=function.** A drop preview is an
answer to an action in flight — "release here and this is what happens". That is
a function, so it takes a function color; it is not a session state, so it takes
one no session state uses. Sky, coral, magenta and amber are spoken for by the
ring. Teal is what is left, which is exactly why a drop preview can never be
misread as a session having become urgent mid-drag.

`hwbDropIndex()` resolves from tab **midpoints, not edges** — edges make the
target flip only when you fully cross a tab, which feels sticky and lands one
slot from where the user aimed.

### Tear-off ghost — `.hwb-ghost`

A miniature **window**, not a floating tab chip, because a window is what dropping
it in open space produces: the ghost should predict the outcome, not describe the
gesture. Flat, never rotated — Aurora has no 3D tumble and a tilted ghost would be
the only thing in the tools that leans.

Its colors derive from the **torn tab's** base, not the source window's. The thing
being carried is the session, and it keeps its identity across whatever frame it
lands in.

**Motion is frozen on the ghost, deliberately.** The live window is still on screen
behind the drag, still animating its own state. A ghost that also animates doubles
the motion for one session while adding no information, and the user's attention
during a drag belongs to *where it will land*.

### Two bugs caught before shipping, both the same shape as earlier ones

**The caret went stale on layout change.** It is a pixel derived from a layout, and
both things that invalidate it happen during a normal drag: the window resizes, and
the strip autoscrolls when you drag toward its edge. A caret at a stale offset points
at the wrong gap *while looking perfectly confident*. The **index** is now the stored
truth and the pixel is re-derived from it, on scroll and on resize. Third time this
bundle has learned it: anything a consumer would have to remember to refresh,
refresh here instead.

**The ghost rendered off-screen and the harness said it was fine.** `hwbMoveGhost`
positions with `transform`, and without `top/left:0` the translate is measured from
the element's static position — below all page content for a node appended to
`<body>`. No error, no ghost. The assertion had checked that a transform was *set*,
not that the ghost was *where it was put*; it now measures the rect against the
requested point and that it is on screen. Third weak assertion of the same kind in
one session — the check existing is not the same as the check being on the path
that fails.

### Harness

61 → **75 assertions**, twelve on drag, including that a drag in flight does not
move the caption geometry or the 154px reserve.

## v18 — 2026-08-09 — the alias table (as code) · overflow chevrons · exit verdict

**Not breaking.** Additive exports plus an internal DOM change inside
`.hwb-tabs`, which the component renders — no consumer markup changes. One
caveat: anything selecting `.hwb-tabs > .hwb-tab` as a **direct** child now needs
a descendant selector. Nothing in the bundle did; check host overrides.

### The alias table ships as CODE, not prose

Three state vocabularies grew independently — the desktop host's shipped
chrome, the host app's brief (which the ring implements), and the host app's
production `/api/table`. The engine's wins. `HWB_CHROME_ALIAS` and
`hwbRingFromChrome()` are exported so the bridge implements nothing: **an alias
table copied into two codebases is two alias tables.**

| chrome | engine | |
|---|---|---|
| `streaming` | `active-streaming` | rename |
| `idle` | `active-idle` | rename |
| `waiting` | `attention` | rename — same fact, better name |
| `disconnected` | `alert` | rename |
| `ended` | `ended` | — |
| `watching` | `active-idle` | **design call, below** |
| — | `restorable` | **no chrome analogue; must be added, not aliased** |

**`watching` is the one with no obvious image.** A watcher is armed: something
*may* happen, nothing is happening now. That sits between idle and streaming and
the temptation is a seventh engine state.

It should not be one. The ring answers "what is the state of this session and
what can I do about it", and for watcher-wait the answer is: nothing, it is
alive, something may happen. That **is** `active-idle`. "A watcher is armed" is
informational, not actionable, and color encodes function. Mapping it to
`active-streaming` would be worse — the streaming ring says output is flowing,
which would be a lie, and a lying status glyph costs more than a missing nuance.

So the engine vocabulary stays at six and the distinction moves down a layer. The
chrome need not lose the affordance it shipped: keep the pip spinner as a
**modifier** (`data-watch="armed"`), which decorates without claiming a state.
The ring never shows it — a manager list summarising twenty sessions has no use
for it.

`hwbRingFromChrome()` also folds in the host app's production `attached`
boolean: it says *someone* is there without saying which device, which renders a
neutral filled center and gains device hue with no rework when a viewer registry
lands.

### Exit verdict reaches the ring

`ended` no longer discards a failed exit. `data-exit="fail"` tints the ended ring
toward the fault hue at low chroma — history does not get to shout, but history
you may want to look at should not read identical to a clean exit. The label
becomes "ended with an error".

### Overflow chevrons

Tabs stop shrinking at `min-width:96px`, so past a certain count they overflowed
and `overflow:hidden` simply ate them. **A tab you cannot reach is a session you
cannot get back to.**

Session chips now live in a `.hwb-scroll` inside `.hwb-scrollwrap`; the hub and
the `+` are pinned **outside** it, because they are controls rather than content
and must stay hittable however far the strip is scrolled. Chevrons are
**absolutely positioned over the scroller's ends**, so they consume no flex width
— which is what keeps the 154px drag reserve and the caption geometry untouched
by overflow. Both are asserted at a 620px viewport.

**The component observes its own width.** The first cut made recomputing the
host's job, and the harness caught it immediately at 620px: a widening window
removes overflow without firing a scroll event, so a chevron stayed lit with
nowhere to go. A control that lies is worse than no control, and upkeep a
consumer can forget is not upkeep. A `ResizeObserver` on the scroller now does
it, and `hwbUpdateOverflow(root)` remains exported for hosts that want it.

Hosts must add `app-region:no-drag` to `.hwb-chev` alongside `.hwb-tab` and
`.hwb-newtab`, or the OS eats the click as a caption drag.

### Harness

41 → **61 assertions**. Thirteen on the alias contract (asserted against the
module, not the DOM — it is the one artifact whose drift breaks live integration
between two peers) and seven on overflow, including that overflow does **not**
move `maxRect.x` and the 154px reserve survives it.

## v17 — 2026-08-09 — the viewer-less rule holds on every path

**Not breaking.** One new export, one behavior tightened toward what v16 already
claimed. Found within the hour by the host app reading the v16 API — which is
what a second consumer is for.

### `hwbRingNormalise()` — enforcement a caller cannot route around

v16 applied the viewer-less rule inside `hwbRingSpec()` only. A caller handing a
ready-made spec straight to `hwbRing()` bypassed it and could render an ended
session carrying a live viewer — an assertion that cannot be true, which is the
exact thing v16's changelog said the renderer prevents.

That bypass is not hypothetical. It is precisely the entry point a consumer uses
before a viewer registry exists: the host app's `/api/table` reports `attached`
as a boolean today and cannot yet say *which* device, so the honest rendering is
`{ viewer: null, presence: 'active' }` — a neutral filled center meaning "someone
is there, device unknown". That is a legitimate spec, it must keep working, and
it arrives by the unguarded path.

`hwbRingNormalise(spec)` is now applied on **every** path, including `hwbRing()`
and `hwbRingAggregate()`. It also closes a smaller inconsistency: `presence:
'parked'` now always clears `viewer`, since a device with nobody home is not a
device.

The example page demonstrates the interim rendering, and two assertions guard it
(41 total): "attached, device unknown" stays neutral-and-filled rather than
collapsing to parked, and a hand-built `{state:'ended', viewer:'laptop',
presence:'active'}` comes out `ended/parked/-`.

**Enforcement that a legitimate caller routes around is not enforcement** — that
is the lesson, and it is the same shape as the weak-assertion habit: the check
existed, it just was not on the path anyone would actually take.

## v16 — 2026-08-09 — dual-ring session status ships

**Not breaking.** Purely additive: two new files, no change to any existing
class, attribute, property or export. A consumer that never imports
`hwb-ring.js` is unaffected, and the chrome above does not depend on the ring.

Approved by owner ruling 2026-08-09. Design record: the design record.
Engine model: the design record (the host app).

### New: `hwb-ring.css` + `hwb-ring.js`

The glyph carries **two independent axes** — outer ring = session state, center
dot = viewer device + presence. 30 valid states fall out of the two axes rather
than being thirty bespoke marks.

**Zero new hex values.** The ring uses the function seven — and specifically the
titlebar's *existing* state colors, so a session in alert shows the same hue on
its ring, its tab chip and its window wash, because they are the same fact. The
center uses the extended identity palette. `tokens.css` is untouched.

Public surface, additive to §6 of the integration architecture:

| added | kind |
|---|---|
| `.ring` | class — glyph root; usable anywhere, inside `.hwb` or not |
| `data-viewer` | attribute — `laptop \| laptop \| phone \| console`; omit for none/aggregate |
| `data-presence` | attribute — `active \| away \| parked` |
| `--s` | property — **consumer sets**; rendered size, the only geometry input |
| `.ctx-aggregate` / `.is-lead` | classes — the motion context rule |
| `hwbRingSpec` `hwbRing` `hwbRingLabel` `hwbRingLead` `hwbRingAggregate` `hwbRingApplyContext` `hwbRingClearContext` | exports |
| `HWB_RING_STATES` `HWB_RING_RANK` `HWB_PRESENCE_RANK` `HWB_DEVICES` | constants |

`data-state` gains the six ring values alongside the six chrome values. The
spellings overlap in concept and differ in wording; aligning them is an open
question, not a v16 change.

### Two behaviors that will surprise a literal reading of the engine brief

Both are the owner's decisions and both are enforced in code, not left to the caller.

- **`attention` outranks `alert`.** Alert is a transport fault: frequently
  transient, very often self-healing. Attention is a hard block only a human can
  clear. With alert on top, the loudest slot spends its time showing conditions
  that fix themselves and the user learns to discount it. `hwbRingLead` sorts
  over the **pair** `(state, presence)` — sorting on state and then filtering by
  presence produces the wrong lead.
- **`alert` keeps its motion.** The brief's "blinking red wall of panic" is the
  right diagnosis aimed at the wrong variable — the wall is glyph *count*. The
  context rule fixes it directly: in `.ctx-aggregate` only the highest-priority
  glyph animates, so N sessions in alert produce **one** animating glyph, not N.

### The renderer enforces, it does not trust

`hwbRingSpec()` **discards a supplied viewer** on `restorable` and `ended`. No
live pty means no viewer can exist, and a center dot would assert something
impossible. The example page feeds a restorable session a live viewer on purpose
so the harness can prove the discard happens.

### Other

- Every glyph carries an `aria-label`. Color, silhouette and motion all carry
  this design and none of the three reaches a screen reader.
- **The Google Fonts `<link>` is removed from `hwb-example.html`.** The bundle
  has self-hosted its typefaces since v14; leaving the link in implied the CDN
  was a requirement, which is the exact misreading that had the tools rendering
  in fallbacks.
- Harness: 28 → **39 assertions**, nine of them on the ring — including that
  alert and restorable have genuinely different silhouettes, that filled/hollow/
  absent are three distinct renderings rather than three names for one dot, and
  that the lead glyph in an aggregate is `attention`, not `alert`.

## v15 — 2026-08-09 — tab close placement · tabbed body identity

**Not breaking.** Two visual fixes and no API change. Both were reported by
the desktop host against v14; neither needs consumer code.

### The tab close × now pins to the chip edge at every title length

`.hwb-tab .tname` had `min-width:0` but no `flex`, so it took content width. With
a long title the name truncated at the 240px cap and the × landed at the right
edge — correct in every render the example page and the harness produced. With a
**short** title the × hugged the name and the chip's slack sat after it. Edge pins
the × regardless of title length, and the owner read the difference immediately on the
live demo.

Fixed with `flex:1 1 auto` on `.tname` rather than `margin-left:auto` on `.tclose`:
growing the name also makes the slack part of the tab's click target, which is
what a user expects to hit.

The example page now carries one deliberately **short** tab title (`clips`), and
the harness asserts the close × sits within 12px of the chip's right edge **on the
shortest title present**. The old suite would have passed this defect forever —
it only ever rendered long titles, so "× at the edge" was true in every case it
saw and false in the first case a user saw.

### A tabbed window's body derives from the active tab, not the neutral root

`--d-termbg` and `--d-ghost` were declared only on `.hwb`, so in a tabbed window
they resolved from the neutral container base. Consequence, which the desktop host
demonstrated side-by-side: **the ghost watermark never appeared in a tabbed window
at all**, and the terminal ground was gray rather than the active session's tint.

A tabbed window's **bar** is a container and stays neutral. Its **body** is not —
there is exactly one active tab and the body below shows exactly that session. Both
properties now derive from `--rail-base`, which already means "the active tab's
base" and which the consumer already sets. No new API, no host code.

Harness asserts both resolve the active tab's base specifically — not merely that
they look derived, which the `--dim2` fallback would also satisfy.

## v14 — 2026-08-08 — first published bundle

First release under the Design Integration Architecture (the design record).
Content is what the desktop host already runs; what is new is the *packaging* —
versioned, hashed, self-contained, and built rather than hand-assembled.

**Not breaking.** A consumer already vendoring the loose files can adopt this
bundle as a straight replacement.

### Typefaces are now part of the bundle

Until now `tokens.css` **named** Inter, Space Grotesk and JetBrains Mono but
shipped no `@font-face` for any of them; the styleguide resolved them from a
per-page Google Fonts `<link>`. Any consumer that vendored tokens received three
font names it could not resolve and rendered the whole design language in system
fallbacks — silently. Found by the desktop host.

- All three now ship in `fonts/`, SIL OFL 1.1, license texts included.
- They are **variable** fonts: one file per family covering a weight *range*.
  Google serves a byte-identical file for every weight requested, so per-weight
  files would ship the same binary N times. Do not add per-weight files.
- Every `@font-face` path is **relative**, so `tokens.css` resolves identically
  at `/aurora/tokens.css` and inside a vendored bundle. **`fonts/` must stay
  beside `tokens.css`.**

### Component fixes carried in

- per-tab derivation: `--d-*` re-declared on `.hwb-tab`, so each tab's `--base`
  is live and active/inactive are no longer inverted
- caption cell `:hover` / `.is-hover` / `.is-pressed` states
- blocked-count chip moved out of `.hwb-title` (hidden while tabbed)
- `data-exit="fail"` now drives the verdict seam
- `hwbAssertInvariants` gates the 154px reserve on `.is-tabbed`
- tab width capped at 240px (Edge behavior); the remainder is drag region

### Known gap

The styleguide mockup still carries its own copy of the component inline; it is
an exploration surface and is **not** the contract. Closing that duplication is
the next build-step task. Until then `dist/` is authoritative and is gated by
`tools/verify-window-chrome.cjs`, which asserts the design's claims — including
per-tab color, the property whose absence made the first bundle look verified
while it was broken.
