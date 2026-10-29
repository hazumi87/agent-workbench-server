/*
 * The panel: GET /rooms/:roomId/view — the Asset Studio cell BODY, per Aurora's mockup
 * room-asset-studio-v1 (http://127.0.0.1/styleguide/mockups/room-asset-studio-v1.html,
 * task) on the room-cells .ap-* kit.
 *
 *   - VIEW ONLY: nothing here changes a setting (the frame proxy is GET-only). The user
 *     talks to the agent; the pressable things are result thumbnails (the host's preview
 *     column) and the Studio · Favorites · Recycle switcher (which folder you LOOK at —
 *     moving an image between folders is the agent's move_image, on the user's word).
 *   - served through the engine's panel proxy (sandboxed, NO same-origin), so every link,
 *     asset and fetch is RELATIVE: tokens.css, view.js, panel.json, thumb/<id>, file/<id>.
 *   - colours are Aurora tokens only (tokens.css, vendored verbatim, v31) — no hex.
 *   - view.js renders everything from panel.json with textContent only; this page is the
 *     shell (+ a message when the room is not the bound one).
 *   - WIDTH TIERS (Aurora wide-panel reflow): the room's left column is user-resizable
 *     (~272 px up to ~1200), so every layout follows the FRAME's own width. The table below is
 *     the one place the breakpoints live: it goes on <html data-tiers>, view.js / review.js put
 *     t-<tier> + ge-<tier> classes on <html> from it (ResizeObserver), and the CSS keys off those.
 *     Grow by ADDING columns, never by scaling type or icons.
 *   - the Review tab's large view is rendered IN the panel document by view.js — the frame never
 *     navigates (the host's action port is handed over once, on first load; addendum 3).
 *   - reviewPage: GET /rooms/:roomId/review/:n — one review item large, the tool.json `links`
 *     target the host opens in its preview column.
 */
import { MODEL_CSS } from './model-css.mjs';
export const POLL_S = 10;

// min frame width (px) of each tier: S < 360 · M 360–639 · L 640–999 · XL ≥ 1000
export const TIERS = { m: 360, l: 640, xl: 1000 };
const TIERS_ATTR = Object.entries(TIERS).map(([k, v]) => `${k}:${v}`).join(' ');

export function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const CSS = `
/* Light / dark and the palette: the room's tokens arrive as {host:'theme'} and are set on
   <html>; html[data-mode] carries the mode. Surfaces you JUDGE ART ON stay neutral grey (never palette-tinted). */
:root{color-scheme:dark;--stage:oklch(.16 0 0);--checker-a:oklch(.22 0 0);--checker-b:oklch(.26 0 0);--viewer:oklch(.24 0 0)}
html[data-mode=light]{color-scheme:light;--stage:oklch(.94 0 0);--checker-a:oklch(.90 0 0);--checker-b:oklch(.96 0 0);--viewer:oklch(.86 0 0)}
/* Before the host sends {host:'theme'}: a light room still reads light. The host page sets color-scheme, which
   the frame sees as prefers-color-scheme — then Aurora light (briefing-table palette.mjs tokens('aurora',null,'light'),
   copied) and the light art surfaces. Once a theme message lands, data-mode and the tokens win. */
@media (prefers-color-scheme:light){html:not([data-mode]){color-scheme:light;--ink:oklch(0.985 0.012 250);--surface:oklch(0.965 0.012 250);--surface2:oklch(0.940 0.012 250);--surface3:oklch(0.910 0.012 250);--border:oklch(0.870 0.012 250);--border2:oklch(0.800 0.012 250);--text:oklch(0.250 0.007 250);--dim:oklch(0.470 0.012 250);--dim2:oklch(0.580 0.012 250);--nav:oklch(0.975 0.012 250);--sky:oklch(0.520 0.130 232);--amber:oklch(0.500 0.150 82);--coral:oklch(0.500 0.190 29);--lime:oklch(0.520 0.170 128);--magenta:oklch(0.520 0.210 356);--indigo:oklch(0.520 0.150 272);--id-cobalt:oklch(0.600 0.160 258);--id-green:oklch(0.600 0.160 150);--id-orchid:oklch(0.600 0.160 322);--id-violet:oklch(0.600 0.160 295);--id-orange:oklch(0.600 0.160 55);--teal:oklch(0.500 0.120 182);--cap-hover:rgba(0,0,0,.07);--ghost-fill:rgba(0,0,0,.03);--stage:oklch(.94 0 0);--checker-a:oklch(.90 0 0);--checker-b:oklch(.96 0 0);--viewer:oklch(.86 0 0)}}
*{box-sizing:border-box}
html,body{margin:0;background:var(--surface);color:var(--text);font:400 12.5px/1.4 var(--font)}
.ap{background:var(--surface)}
.ap-sec{padding:10px 12px 10px 14px;border-top:1px solid var(--border)} .ap-sec:first-child{border-top:0}
.ap-lbl{display:flex;align-items:baseline;gap:8px;font:700 .6rem var(--display);letter-spacing:.1em;text-transform:uppercase;color:var(--dim2);margin-bottom:7px}
.ap-lbl .r{margin-left:auto;font:500 10.5px var(--mono);letter-spacing:0;text-transform:none;color:var(--dim)}
.job{display:flex;align-items:center;gap:8px;font-size:12.5px}
.job .dot{width:8px;height:8px;border-radius:50%;background:var(--sky);flex:none;animation:pulse 1.4s ease-in-out infinite}
@keyframes pulse{50%{opacity:.35}}
.job .pct{margin-left:auto;font:500 11px var(--mono);color:var(--dim)}
.meter{height:3px;border-radius:2px;background:var(--surface3);margin-top:7px;overflow:hidden}
.meter i{display:block;height:100%;background:var(--sky);border-radius:2px}
.meter.indet i{width:30%;animation:slide 1.3s ease-in-out infinite}
@keyframes slide{0%{transform:translateX(-100%)}100%{transform:translateX(340%)}}
.gen{margin-bottom:10px} .gen:last-child{margin-bottom:0}
.gen-h{font:500 10.5px var(--mono);color:var(--dim);margin-bottom:5px;display:flex;gap:6px}
.gen-h .draft{color:var(--dim2)}
.fail{font-size:11.5px;color:var(--dim)}
/* the room column resizes 272-560px (Aurora room-rail-resize-v1): grow by ADDING tiles, not
   stretching them — ~72-96px squares; type and icons never scale with width */
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(96px,1fr));gap:5px}
.th{position:relative;aspect-ratio:1;border-radius:var(--corner);border:1px solid var(--border);overflow:hidden;cursor:pointer;background:var(--surface2)}
.th:hover{border-color:var(--border2)} .th.sel{outline:2px solid var(--text);outline-offset:1px}
.th:focus-visible{outline:2px solid var(--teal);outline-offset:1px}
.th img,.ref img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;display:block}
.th.pending{border-style:dashed;border-color:var(--border2);display:grid;place-items:center;cursor:default}
.th.pending span{width:14px;height:14px;border-radius:50%;border:2px solid var(--border2);border-top-color:var(--sky);animation:spin .8s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
.prompt{font-size:12.5px;line-height:1.45;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;overflow-wrap:anywhere}
.prompt.none{color:var(--dim)}
.neg{font-size:11.5px;color:var(--dim);margin-top:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.neg b{font-weight:500;color:var(--dim)}
.facts{display:grid;grid-template-columns:auto 1fr auto 1fr;gap:3px 8px;margin:8px 0 0;font-size:11.5px}
.facts dt{color:var(--dim2)} .facts dd{margin:0;font-family:var(--mono);font-size:11px;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.refs{display:flex;gap:6px}
.ref{position:relative;width:52px;height:52px;border-radius:var(--corner);border:1px solid var(--border);overflow:hidden;background:var(--surface2)}
.ref .tag{position:absolute;left:3px;top:3px;font:600 9px var(--mono);color:var(--text);background:color-mix(in srgb,var(--ink) 72%,transparent);padding:0 4px;border-radius:3px}
.ref-note{font-size:11px;color:var(--dim);align-self:center;line-height:1.35}
.budget{display:flex;align-items:baseline;gap:6px;font-size:12px} .budget .n{font:600 12px var(--mono)} .budget .of{color:var(--dim)}
.budget + .meter i{background:var(--dim)} .low .budget .n{color:var(--amber)} .low .budget + .meter i{background:var(--amber)}
.empty{padding:16px 14px;color:var(--dim);font-size:12.5px;line-height:1.5}
.empty b{display:block;color:var(--text);font-weight:600;margin-bottom:3px}
.off{display:flex;gap:10px;align-items:flex-start;padding:14px}
.off svg{width:18px;height:18px;flex:none;fill:none;stroke:var(--dim);stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round;margin-top:1px}
.off .t{font-size:12.5px;line-height:1.45;color:var(--dim)} .off .t b{color:var(--text);font-weight:600;display:block}
.msg{padding:12px 14px;color:var(--dim);font-size:12px}
/* the folder switcher: a segmented control with the LIFTED selection (Aurora, .hwb-lift) —
   never an underline or accent line (; no bars estate-wide) */
.tabs{display:flex;gap:4px;padding:7px 10px;border-bottom:1px solid var(--border)}
.tab{height:28px;border:1px solid transparent;border-radius:8px;background:none;padding:0 9px;font:600 11px var(--font);color:var(--dim);cursor:pointer}
.tab:hover{background:var(--surface2)} .tab.on{background:var(--surface3);border-color:var(--border2);color:var(--text)}
.tab .c{font:500 10.5px var(--mono);color:var(--dim2);margin-left:4px}
.tab:focus-visible{outline:2px solid var(--teal);outline-offset:1px}
.th .star{position:absolute;right:3px;top:2px;font:600 11px var(--font);color:var(--text);text-shadow:0 0 3px var(--ink)}
.gen-h .lbl{color:var(--text)}
@media (max-width:600px){html,body{font-size:14px}.ap-sec{padding:12px 14px}.grid{gap:6px}.tab{height:36px}}
/* iOS zooms the page when focus lands on a text field under 16px and never zooms back (the user, review #8 on
   iPhone: the room page stayed zoomed, Send off-screen) — every field is 16px on a phone or a touch screen */
@media (max-width:600px),(pointer:coarse){input,textarea,select{font-size:16px !important}}
/* the rail's click list : one row per tab, the full app opens in the preview column */
.railnav{display:flex;flex-direction:column;gap:4px;padding:8px}
.rrow{display:flex;align-items:center;gap:8px;min-height:40px;padding:0 12px;border:1px solid var(--border2);border-radius:8px;background:none;color:var(--text);font:600 13px var(--font);cursor:pointer;text-align:left}
.rrow:hover{background:var(--surface2)} .rrow.on{border-color:var(--teal);background:var(--surface2)} .rrow:focus-visible{outline:2px solid var(--teal);outline-offset:1px}
.rrow .rl{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
/* Asset Studio's rail rows (, Room Tasks' look without the expand): a title over a stats line */
.railnav .rrow{flex-direction:column;align-items:flex-start;justify-content:center;gap:2px;min-height:56px;padding:8px 12px;border-color:transparent}
.railnav .rrow .rl{width:100%;font:600 14px var(--font)}
.rst{font:500 11.5px/1.35 var(--mono);color:var(--dim)} .rst .go{color:var(--sky)} .rst .ok{color:var(--lime)} .rst .fav{color:var(--amber)} .rst .down{color:var(--coral)}
@media (pointer:coarse){.rrow{min-height:44px}}
/* tab labels: full from M up; at S Favorites/Recycle shorten to ★ / ⟲ */
.tab .short{display:none} .t-s .tab .full{display:none} .t-s .tab .short{display:inline}
/* Asset Studio's two rows (DESIGN.md): Images · Models · Review, then that domain's own tabs, lighter */
.tabset{border-bottom:1px solid var(--border)} .tabset .tabs{border-bottom:0}
.tabs.sub{padding-top:0;gap:2px} .tabs.sub .tab{height:24px;padding:0 8px;font-weight:500}
.tabs.sub .tab.on{background:none;border-color:transparent;color:var(--text);box-shadow:inset 0 -2px 0 var(--teal);border-radius:0}
/* ---- wide reflow (tiers: TIERS above). L+: Studio = settings column 300px (job + budget on
   top) | results. XL: a picked image opens in a right column (360px). */
.split{display:grid;grid-template-columns:300px minmax(0,1fr);align-items:start}
.split.det{grid-template-columns:300px minmax(0,1fr) 360px}
.split.fold{grid-template-columns:minmax(0,1fr)} .split.fold.det{grid-template-columns:minmax(0,1fr) 360px}
.split > .col-l{border-right:1px solid var(--border)}   /* no vh cap: the frame is already the scroller (see .cur img) */
.split > .col-d{position:sticky;top:0;border-left:1px solid var(--border)}
.split .col-r > .ap-sec:first-child,.split .col-l > .ap-sec:first-child{border-top:0}
.ge-l .grid{grid-template-columns:repeat(auto-fill,minmax(120px,1fr))}
.ge-l .fold .grid{grid-template-columns:repeat(auto-fill,minmax(140px,180px))}
.det-img{display:block;border-radius:var(--corner);overflow:hidden;background:var(--stage);border:1px solid var(--border)}
.det-img img{display:block;width:100%;height:auto;max-height:420px;object-fit:contain}
.det-h{display:flex;align-items:center;gap:8px;margin-bottom:8px}
.det-h b{font:600 13px var(--font);flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.det-ex{font-size:12.5px;line-height:1.45;margin:8px 0 0;overflow-wrap:anywhere;white-space:pre-wrap}
.det .facts{grid-template-columns:auto 1fr}
.acts{display:flex;flex-wrap:wrap;gap:6px;margin-top:10px}
.btn{height:28px;display:inline-flex;align-items:center;padding:0 10px;border-radius:8px;border:1px solid var(--border2);background:none;color:var(--text);font:600 11px var(--font);text-decoration:none;cursor:pointer}
.btn:hover{background:var(--surface2)} .btn:focus-visible,.x:focus-visible{outline:2px solid var(--teal);outline-offset:1px}
.x{width:28px;height:28px;border:0;border-radius:8px;background:none;color:var(--dim);font:500 16px var(--font);cursor:pointer;flex:none} .x:hover{background:var(--surface2);color:var(--text)}
/* ---- Review tab (Aurora): cards, full width; 1 column <~720, 2 ≥~720, 3 ≥~1080 (auto-fill, capped at 3) */
.rlist{display:grid;gap:8px;grid-template-columns:repeat(auto-fill,minmax(min(100%,max(340px,calc((100% - 16px) / 3))),1fr));align-items:start}
.card{display:flex;flex-direction:column;gap:8px;width:100%;text-align:left;padding:10px;border-radius:8px;border:1px solid var(--border);background:var(--surface);color:var(--text);font:inherit;cursor:pointer}
.mode{display:inline-flex;align-items:center;flex:none;height:20px;padding:0 8px;border:1px solid var(--border2);border-radius:999px;font:600 11px var(--font);color:var(--text);white-space:nowrap}   /* the mode: a plain outline, no color per mode (Aurora) */
.cm{display:flex;align-items:center;gap:8px;min-width:0} .cask{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font:500 12.5px var(--font);color:var(--text)}
.ask{margin:0 0 14px;padding:10px 12px;border:1px solid var(--border2);border-radius:var(--corner);background:var(--surface);color:var(--text)}
.ask .asks{margin:0 0 8px;font:500 13.5px/1.4 var(--font)} .ask .asks:last-child{margin-bottom:0}
.ask .sbar2{padding:0;border:0;background:none}
/* heading tones (Aurora, the room rail's recipe, mode-free form): a heading sets ONE variable, --hc; its ink and wash are mixed from it
   and the panel's own --text / --surface, so they follow whatever ground the host gives — no switch on the mode to get wrong.
   Level 1 = a bar (group headings, fold headers); level 2 = a label, ink only. Tones are for headings only: not rows, chips, text or what is selected. */
.hbar,.sum-lbl{--hc:var(--id-orchid,var(--indigo));--hink:color-mix(in oklab,var(--hc) 60%,var(--text));--hwash:color-mix(in oklab,var(--hc) 24%,var(--surface))}
.hbar{display:flex;align-items:center;gap:8px;width:100%;margin:0 0 8px;padding:6px 10px;border:0;border-radius:var(--corner);background:linear-gradient(90deg,var(--hwash),var(--surface) 78%);color:var(--hink);text-align:left;font:600 12px var(--font);letter-spacing:.03em}
.hbar .n{margin-left:auto;font:500 11px var(--mono)} .hbar .caret{flex:none;width:10px}
button.hbar{cursor:pointer} button.hbar:focus-visible{outline:2px solid var(--teal);outline-offset:1px}
.hbar.needs{--hc:var(--coral)} .hbar.agent{--hc:var(--sky)}   /* a state: needs you / someone is working */
.rv .sum-lbl,.sum-lbl{color:var(--hink)}
.fold{margin:0 0 14px} .fold>.hbar{margin-bottom:6px}
.dlrows{display:flex;flex-direction:column;border:1px solid var(--border);border-radius:var(--corner);overflow:hidden}
.dl{display:flex;align-items:center;gap:10px;padding:8px 10px;border-bottom:1px solid var(--border)} .dl:last-child{border-bottom:0}
.dl .dtx{flex:1;min-width:0} .dl .dpur{font:600 13px var(--font);color:var(--text)} .dl .dnm{font:400 11.5px var(--mono);color:var(--dim);overflow-wrap:anywhere}
.dl .btn{flex:none;text-decoration:none;display:inline-flex;align-items:center;justify-content:center}
.alts{display:flex;gap:6px;overflow-x:auto;margin:0 0 8px;padding-bottom:2px}
.alt{flex:none;height:32px;padding:0 12px;border:1px solid var(--border2);border-radius:999px;background:none;color:var(--dim);font:600 12px var(--font);cursor:pointer;white-space:nowrap} .alt.on{background:var(--surface3);border-color:var(--teal);color:var(--text)} .alt:focus-visible,.pk:focus-visible,.sd:focus-visible,.vt:focus-visible{outline:2px solid var(--teal);outline-offset:1px}
.vstrip{display:flex;gap:8px;overflow-x:auto;padding:2px 0 8px} @media (min-width:520px){.vstrip{flex-wrap:wrap;overflow:visible}}
.vt{flex:none;width:96px;display:flex;flex-direction:column;gap:4px;padding:0;border:0;background:none;color:inherit;text-align:left;cursor:pointer;font:inherit} .vt .ith{width:96px;height:72px} .vt .vmk{position:absolute;right:3px;bottom:3px;display:inline-flex}
.vt .vcap{min-height:15px;font:500 11.5px/1.3 var(--font);color:var(--text);overflow:hidden;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow-wrap:anywhere}
.ph3d{display:flex;align-items:center;justify-content:center;width:100%;height:100%;font:700 15px var(--font);letter-spacing:.06em;color:var(--dim);background:repeating-linear-gradient(45deg,var(--surface2) 0 8px,var(--surface3) 8px 16px)}
.pickbox{margin:0 0 10px} .pickrow{display:flex;flex-wrap:wrap;gap:6px;margin:0 0 8px}
.pk{height:36px;padding:0 12px;border:1px solid var(--border2);border-radius:999px;background:none;color:var(--text);font:600 12.5px var(--font);cursor:pointer} .pk.on{background:var(--surface3);border-color:var(--teal)} .pk:disabled,.sd:disabled{cursor:default;opacity:.7}
.pkc{display:block;box-sizing:border-box;width:100%;min-height:44px;padding:8px 10px;border:1px solid var(--border2);border-radius:8px;background:var(--surface2);color:var(--text);font:400 13px/1.4 var(--font);resize:none} .pkc:disabled{opacity:.6}
.scopes{display:flex;flex-direction:column;border:1px solid var(--border);border-radius:var(--corner);overflow:hidden}
.scope{display:flex;align-items:center;gap:8px;padding:6px 10px;border-bottom:1px solid var(--border)} .scope:last-child{border-bottom:0} .scope .sn{flex:1;min-width:0;font:600 13px var(--font);text-transform:capitalize}
.sd{height:32px;padding:0 10px;border:1px solid var(--border2);border-radius:8px;background:none;color:var(--text);font:600 12px var(--font);cursor:pointer} .sd.on{background:var(--surface3);border-color:var(--teal)}
@media (pointer:coarse){.alt,.pk,.sd{min-height:44px}.vt{width:104px}.vt .ith{width:104px;height:78px}}
.mdl .mv .mv-pins{position:absolute;inset:0;pointer-events:none;overflow:hidden} .mdl .mv .mv-pstems{position:absolute;inset:0;width:100%;height:100%;overflow:visible}
.mdl .mv .mv-pstems line{stroke:#fff;stroke-width:1.5px} .mdl .mv .mv-pstems line.occ{stroke-dasharray:3 3;opacity:.5}
.mdl .mv .mv-pdot{position:absolute;left:-4px;top:-4px;width:8px;height:8px;border-radius:50%;background:#000;box-shadow:0 0 0 1.5px #fff} .mdl .mv .mv-pdot.occ{opacity:.5}
.mdl .mv .mv-pin{position:absolute;left:-12px;top:-12px;width:24px;height:24px;padding:0;border:0;border-radius:50%;background:#000;color:#fff;box-shadow:0 0 0 1.5px #fff;font:700 12px/24px var(--font);text-align:center;cursor:pointer;pointer-events:auto;touch-action:none}   /* black with a thin white ring, as the image marks: seen on any model */
.mdl .mv .mv-pmenu{position:absolute;left:0;top:0;z-index:4;display:flex;flex-direction:column;gap:4px;padding:4px;border-radius:8px;border:1px solid var(--border2);background:var(--surface3);pointer-events:auto;white-space:nowrap;touch-action:none} .mdl .mv .mv-pmenu .btn{text-align:left}
@media (pointer:coarse){.mdl .mv .mv-pmenu .btn{min-height:44px}}
.mdl .mv .mv-pin::after{content:'';position:absolute;inset:-10px}   /* a 44 px hit area on a 24 px tag */
.mdl .mv .mv-pin.occ{opacity:.5} .mdl .mv .mv-pin.sel{box-shadow:0 0 0 3px #fff} .mdl .mv .mv-pin.draft{background:#fff;color:#000;box-shadow:0 0 0 1.5px #000}
.pinbar{margin:8px 0 0} .pintray{display:flex;flex-wrap:wrap;align-items:center;gap:8px}
.pinarm{height:32px;padding:0 12px;border:1px solid var(--border2);border-radius:8px;background:none;color:var(--text);font:600 12px var(--font);cursor:pointer} .pinarm.on{background:var(--surface3);border-color:var(--teal)} .pinarm:disabled{cursor:default;opacity:.7}
.pinchips{position:relative;display:flex;flex-wrap:wrap;gap:6px;margin:8px 0 0} .pinmenu{position:absolute;z-index:4;top:calc(100% + 4px);left:0;display:flex;flex-wrap:wrap;gap:4px;padding:4px;border-radius:8px;border:1px solid var(--border2);background:var(--surface3);max-width:100%} @media (pointer:coarse){.pinmenu .btn{min-height:44px}} .pinchip{min-width:32px;height:32px;padding:0 8px;border:1.5px solid var(--border2);border-radius:999px;background:none;color:var(--text);font:700 12px var(--font);cursor:pointer} .pinchip.on{background:#000;color:#fff;border-color:#fff}
.pinsel{margin:8px 0 0;padding:10px 12px;border:1px solid var(--border2);border-radius:var(--corner);background:var(--surface)} .pinttl{margin:0 0 6px;font:600 12.5px var(--font);color:var(--text)} .pinacts{display:flex;flex-wrap:wrap;gap:8px;margin-top:8px}
.partrows{display:flex;flex-direction:column;gap:2px} .partrows>.btn{align-self:flex-start;margin-bottom:6px} .partrow{display:flex;align-items:center;gap:8px;min-height:32px} .partrow.off .ptn{color:var(--dim);text-decoration:line-through} .ptn{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font:500 12.5px var(--font)}
.pteye,.ptiso{min-width:32px;height:30px;padding:0 8px;border:1px solid var(--border2);border-radius:8px;background:none;color:var(--text);font:600 12px var(--font);cursor:pointer}
.mdl .mv .mv-arm{position:absolute;inset:0;z-index:5;pointer-events:none;outline:2px dashed var(--teal);outline-offset:-3px}   /* only a cue: the model underneath stays live */ .mdl .mv.arming canvas{cursor:crosshair}
@media (pointer:coarse){.pinarm,.pinchip,.pteye,.ptiso{min-height:44px}.pinchip{min-width:44px}}
.mdl .mv.failed canvas,.mdl .mv.failed .mv-st,.mdl .mv.failed .mv-anim{display:none}
.mdl .mv .mfail{position:absolute;inset:0;overflow:auto;display:flex;flex-direction:column;gap:8px;align-items:flex-start;padding:16px 14px;justify-content:center;box-sizing:border-box}   /* fills the stage whatever else is in the box */
.mfail h3{margin:0;font:600 14px var(--font);color:var(--text)} .mfail p{margin:0;font:400 12.5px/1.45 var(--font);color:var(--dim)} .mfail .mfa{display:flex;flex-wrap:wrap;gap:8px;margin-top:4px} .mfail .btn{text-decoration:none;display:inline-flex;align-items:center}
.cubeb{position:absolute;left:3px;top:3px;z-index:1;display:flex;align-items:center;justify-content:center;width:22px;height:22px;border-radius:5px;background:rgba(0,0,0,.62);pointer-events:none} .cubeb svg{display:block}
.card:hover{background:var(--surface2)} .card:focus-visible{outline:2px solid var(--teal);outline-offset:1px}
.card.cur{background:var(--surface3);border-color:var(--border2);outline:2px solid var(--teal);outline-offset:1px}   /* the item you opened*/
.card.flash{animation:flash .9s ease-out}
@keyframes flash{0%{background:var(--surface3);box-shadow:0 0 0 1px var(--dim2)}100%{box-shadow:0 0 0 1px transparent}}
.c1{display:flex;align-items:center;gap:8px;min-width:0}
.c1 .num{font:500 11px var(--mono);color:var(--dim);flex:none}
.c1 .ttl{font:600 14px/1.3 var(--font);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.chip{font:500 11px var(--mono);color:var(--dim);border:1px solid var(--border2);border-radius:999px;padding:0 6px;flex:none}
.state{margin-left:auto;display:inline-flex;align-items:center;gap:5px;font:500 11px var(--font);color:var(--dim);flex:none;white-space:nowrap}
.state i{width:7px;height:7px;border-radius:50%;background:var(--dim)}
.state.waiting i{background:var(--amber)} .state.resolved i{background:var(--lime)}
.c2{font-size:12.5px;line-height:1.4;color:var(--dim);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;overflow-wrap:anywhere}
/* one row: up to 4 squares, 64px (80 at XL, 56 at S), shrinking a little rather than wrapping */
.c3{display:flex;gap:6px}
.c3 img{flex:0 1 64px;   /* one size at every width (the user: the tier snaps felt abrupt); shrinks only if 4 don't fit */
  min-width:0;width:64px;height:auto;aspect-ratio:1;object-fit:cover;border:1px solid var(--border2);border-radius:4px;display:block;background:var(--surface2)}
.c3 .c3m{position:relative;flex:0 1 64px;min-width:0;width:64px;aspect-ratio:1;display:block} .c3 .c3m img,.c3 .c3m .ph3d{position:absolute;inset:0;flex:none;width:100%;height:100%;aspect-ratio:auto;border:1px solid var(--border2);border-radius:4px;object-fit:cover;display:flex;box-sizing:border-box}
.c3 .c3ph{flex:0 1 64px;min-width:0;width:64px;height:auto;aspect-ratio:1;border:1px solid var(--border2);border-radius:4px}
.c4{font:400 11px var(--font);color:var(--dim2)}
.more{display:flex;align-items:center;gap:6px;height:32px;border:0;background:none;color:var(--dim);font:600 11px var(--font);cursor:pointer;padding:0 4px;margin-top:6px}
.more:hover{color:var(--text)} .more:focus-visible{outline:2px solid var(--teal);outline-offset:1px}
.gone{font-size:12px;color:var(--dim);padding:6px 2px 8px}
.toast{position:fixed;left:50%;bottom:12px;transform:translateX(-50%);background:var(--surface3);border:1px solid var(--border2);color:var(--text);font:500 12px var(--font);padding:7px 12px;border-radius:8px;pointer-events:none}
@media (pointer:coarse){.card{min-height:44px}.more,.btn,.x{min-height:44px}}
/* ---- the Review large view, IN this document (never a frame navigation: the action port would
   be lost). the user's rules, as on review/<n>: stacked below 520 with the image locked to 188 px
   (the strip + the note's first line stay above the fold); image | note side by side from 520;
   width caps only, never vh; transparent art with dark ink gets the light backdrop. */
.rv{padding:8px 12px 14px}
.rv-h{display:flex;align-items:center;gap:8px;min-height:36px;margin-bottom:8px;min-width:0}
.rv .back{flex:none;display:inline-flex;align-items:center;height:28px;padding:0 8px;border:0;border-radius:8px;background:none;color:var(--dim);font:600 12px var(--font);cursor:pointer}
.rv .back:hover{background:var(--surface2);color:var(--text)}
.rv h1{flex:1;min-width:0;margin:0;font:600 14px/1.3 var(--font);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rv h1 .num{font:500 12px var(--mono);color:var(--dim)}
.vers{flex:none;display:flex;gap:2px;padding:2px;border:1px solid var(--border);border-radius:9px}
.ver{display:inline-flex;align-items:center;height:24px;padding:0 7px;border:1px solid transparent;border-radius:7px;background:none;font:500 11px var(--mono);color:var(--dim);cursor:pointer}
.ver:hover{background:var(--surface2)} .ver.on{background:var(--surface3);border-color:var(--border2);color:var(--text)}
.rv .back:focus-visible,.ver:focus-visible,.st:focus-visible,.rv .cur:focus-visible{outline:2px solid var(--teal);outline-offset:1px}
.rv-b{display:flex;flex-direction:column;gap:12px}
.fcap{margin:6px 0 0;font:600 13px var(--font);color:var(--text);overflow-wrap:anywhere}
.idrow{margin:6px 0 0;display:flex;align-items:center;gap:6px;min-width:0;font:400 11px var(--mono);color:var(--dim2)} .idrow code{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font:inherit;color:var(--text)}
.cp{flex:none;width:24px;height:24px;display:inline-flex;align-items:center;justify-content:center;padding:0;border:1px solid var(--border2);border-radius:6px;background:none;color:var(--text);cursor:pointer} .cp:hover{background:var(--surface2)} .cp:focus-visible{outline:2px solid var(--teal);outline-offset:1px}
@media (pointer:coarse){.cp{width:36px;height:36px}}
.facts dd.idd{display:flex;align-items:center;gap:6px;overflow:visible} .facts dd.idd span{min-width:0;overflow:hidden;text-overflow:ellipsis}
.rstage{min-width:0}
/* the image's box is RESERVED before it loads (the page jumped while a picture loaded): the
   width, the image's aspect (--ar, from its thumb) and a height cap. While it loads, the thumb fills it
   blurred, and "Loading…" shows only if it takes longer than about half a second. */
.rv .cur{position:relative;display:block;width:100%;aspect-ratio:var(--ar,1);max-height:300px;background:var(--stage);border-radius:var(--corner);overflow:hidden;touch-action:pan-y}
.rv .cur.light{background:repeating-conic-gradient(oklch(.90 0 0) 0 25%,oklch(.96 0 0) 0 50%) 0 0/16px 16px}   /* dark ink on transparent: the light checker in either mode */
.rv .cur img{position:absolute;inset:0;display:block;width:100%;height:100%;object-fit:contain}
.rv .cur .ph{filter:blur(6px);opacity:.75}
.rv .cur .big{opacity:0;transition:opacity .12s}
.rv .cur.loaded .big{opacity:1} .rv .cur.loaded .ph{display:none}
.rv .cur .ld{position:absolute;right:8px;bottom:8px;padding:1px 8px;border-radius:999px;background:color-mix(in srgb,var(--ink) 75%,transparent);font:500 11px/18px var(--font);color:var(--text);opacity:0;transition:opacity .2s;pointer-events:none}
.rv .cur:not(.loaded) .ld{opacity:1;transition-delay:.5s}
.strip{display:flex;flex-wrap:wrap;gap:6px;margin:0 0 8px}
.st{position:relative;display:block;width:48px;height:48px;padding:0;border-radius:4px;border:1px solid var(--border2);overflow:hidden;background:var(--surface2);cursor:pointer}
.st img{display:block;width:100%;height:100%;object-fit:cover}
.st.on{outline:2px solid var(--teal);outline-offset:1px}
.st.cmp{border-color:var(--amber)} .st.cmp.on{outline-color:var(--amber)}
/* comparing with the Original : the mode toggle sits left of the Original thumb, both at the strip's end */
.cmpmode{margin-left:auto;display:inline-flex;align-self:center;border:1px solid var(--border2);border-radius:8px;overflow:hidden}
.cmb{height:32px;min-width:40px;padding:0 8px;border:0;background:none;color:var(--dim);font:600 11px var(--font);cursor:pointer}
.cmb.on{background:var(--surface3);color:var(--text)} .cmb:focus-visible{outline:2px solid var(--teal);outline-offset:-2px}
@media (pointer:coarse){.cmb{height:40px;min-width:44px}}
.rv .cur.has-orig{cursor:pointer;-webkit-touch-callout:none;-webkit-user-select:none;user-select:none}
.rv .cur .orig{background:var(--stage);opacity:0;pointer-events:none;transition:opacity .08s}
.rv .cur.mode-hold.peek .orig{opacity:1}
.rv .cur.mode-slider{touch-action:none;cursor:ew-resize}
.rv .cur.mode-slider .orig{opacity:1;clip-path:inset(0 0 0 var(--split,50%))}
.rv .cur .split{position:absolute;top:0;bottom:0;left:var(--split,50%);width:2px;margin-left:-1px;background:var(--amber);pointer-events:none}
.rv .cur .knob{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);padding:2px 6px;border-radius:999px;background:var(--amber);color:var(--ink);font:700 11px/16px var(--font);white-space:nowrap}
.rv .cur .tag{position:absolute;top:6px;padding:1px 6px;border-radius:999px;background:color-mix(in srgb,var(--ink) 75%,transparent);font:600 10.5px/16px var(--font);color:var(--text);pointer-events:none}
.rv .cur .tag.tl{left:6px} .rv .cur .tag.tr{right:6px;color:var(--amber)}
.rv .cur .tag.hint{left:6px;top:auto;bottom:6px;opacity:.85} .rv .cur.peek .tag.hint{opacity:0}
.idrow .pop{margin-left:auto;text-decoration:none}
.idrow .focusbtn{width:auto;padding:0 8px;font:600 11px var(--font)}
/* the focus page: one column like Studio's image view — title, tabs, the image, the tab's pane */
.rv.focus .cur{max-height:560px}
.rv .cur.mesh{aspect-ratio:auto;max-height:none;background:none;overflow:visible} .rv .cur.mesh .mv{height:360px} .rv.focus .cur.mesh .mv{height:480px}
@media (max-width:519.98px){.rv .cur.mesh .mv{height:300px}}
/* focus page layout pass : ONE header line (‹ Back · title · tabs; tabs wrap under on a
   narrow frame), the image's label line ABOVE it (pager · Image #k · id), the mark bar alone below it,
   the rating row with its heading, then a tall comment box; the agent's note in its own labelled box */
.rv.focus .rv-h{flex-wrap:wrap;row-gap:4px}
.rv.focus .rv-h h1{flex:1 1 160px}
.rv.focus .rv-h .ftabs{margin:0;padding:0;border:0;flex:0 0 auto}
@media (max-width:519.98px){.rv.focus .rv-h .ftabs{flex:1 1 100%;border-top:1px solid var(--border);padding-top:6px}}
.flabel{display:flex;align-items:center;gap:8px;min-width:0;margin:4px 0 6px} .flabel .idrow{flex:1;margin:0}
.flabel .fnav .ver{width:28px}
/* v3 review (Aurora 13f29fb): the summary (an overview, no rating controls), the focus page, chips */
.rv.sum .rv-h,.rv.focus .rv-h{min-height:44px}
.rv .back{color:var(--sky)}
.sum-sec{margin:0 0 14px} .sum-lbl{margin:0 0 6px;font:600 11px/1.3 var(--font);letter-spacing:.04em;text-transform:uppercase;color:var(--dim)}
.rnote.clamp2{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.more-link{border:0;padding:0;margin-top:2px;background:none;color:var(--sky);font:600 12px var(--font);cursor:pointer}
.irows{display:flex;flex-direction:column;border:1px solid var(--border);border-radius:var(--corner);overflow:hidden}
.irow{display:flex;align-items:center;gap:10px;min-height:64px;padding:6px 10px;border:0;border-bottom:1px solid var(--border);background:none;color:var(--text);text-align:left;cursor:pointer;font:inherit}
.irow-open{flex:1;min-width:0;display:flex;align-items:center;gap:10px;padding:0;border:0;background:none;color:inherit;text-align:left;cursor:pointer;font:inherit} .irow-open:focus-visible{outline:2px solid var(--teal);outline-offset:2px;border-radius:6px}
.ivote{flex:none;display:flex;gap:4px} .fbv.sm{width:34px;height:32px;padding:0;display:grid;place-items:center}
.irow:last-child{border-bottom:0} .irow:hover{background:var(--surface2)} .irow:focus-visible{outline:2px solid var(--teal);outline-offset:-2px}
.ith{position:relative;flex:none;width:52px;height:52px;border-radius:6px;overflow:hidden;background:var(--stage)} .ith img{display:block;width:100%;height:100%;object-fit:cover}
.itx{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}
.imk{font:600 12px var(--font);color:var(--text)} .imk.none{font-weight:500;color:var(--dim)}
.icm{font:400 12.5px/1.35 var(--font);color:var(--dim);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.igo{flex:none;color:var(--dim);font:600 16px var(--font)}
.onote{display:block;width:100%;min-height:44px;resize:none;overflow:hidden;padding:8px 10px;border:1px solid var(--border2);border-radius:8px;background:var(--surface2);color:var(--text);font:400 13px/1.5 var(--font)}
.onote::placeholder{color:var(--dim2)} .onote:focus-visible{outline:2px solid var(--teal);outline-offset:1px}
.sbar2{display:flex;flex-wrap:wrap;align-items:center;gap:8px 12px;padding:10px 12px;border:1px solid var(--border);border-radius:var(--corner);background:var(--surface)}
.sb-msg{flex:1 1 160px;display:flex;flex-direction:column;gap:1px;min-width:0} .sb-msg b{font:600 13px var(--font);color:var(--text)} .sb-msg b.warn{color:var(--amber)}
.sb-sub{font:400 11.5px var(--font);color:var(--dim)} .sb-acts{display:flex;gap:6px;flex:none}
.sbar2 .sbs{flex:1 1 100%;font:500 12px var(--font);color:var(--lime)} .sbar2 .sbs.bad{color:var(--coral)}
.pg{width:34px;height:32px;border:1px solid var(--border2);border-radius:8px;background:none;color:var(--text);font:600 15px var(--font);cursor:pointer}
.pg:hover:not(:disabled){background:var(--surface2)} .pg:disabled{opacity:.35;cursor:default} .pg:focus-visible{outline:2px solid var(--teal);outline-offset:1px}
.dashes{display:flex;justify-content:center;gap:6px;padding:8px 0 2px} .dashes i{width:22px;height:3px;border-radius:2px;background:var(--border2)} .dashes i.r{background:var(--dim2)} .dashes i.on{background:var(--teal)}
.refcell{position:relative;display:inline-flex} .refcell .pop{position:absolute;right:-4px;top:-6px;width:22px;height:22px;display:grid;place-items:center;border-radius:6px;border:1px solid var(--border2);background:var(--surface);color:var(--text);cursor:pointer;padding:0}
.btn.sm{height:24px;padding:0 8px;font-size:11px;align-self:center}
.finfo{margin:4px 0 0;border-top:1px solid var(--border);padding-top:8px} .finfo>summary{cursor:pointer;font:600 11px var(--mono);color:var(--dim);list-style-position:inside}
.finfo[open]>summary{margin-bottom:8px}
.chips{display:flex;flex-wrap:wrap;gap:6px;margin:0 0 10px}
/* v3 nav: one header row per part; the switcher only where no rail is beside the panel; chips, not sub-tabs */
.tabset{padding:6px 12px 0} .tabset .chips{margin:6px 0 8px}
.partsw{display:flex;gap:2px;padding:2px;border:1px solid var(--border2);border-radius:10px;margin:2px 0 4px}
.partsw .psw{flex:1;height:32px;border-radius:8px} .partsw .psw .c{margin-left:6px}
.parthead{display:flex;align-items:center;gap:8px;min-height:44px} .parthead h2{margin:0;font:600 15px var(--font);color:var(--text)}
.pchip{font:500 11px var(--mono);color:var(--dim);border:1px solid var(--border2);border-radius:999px;padding:1px 8px} .pchip.go{color:var(--sky);border-color:var(--sky)} .pchip.down{color:var(--coral);border-color:var(--coral)}
.tabset .chipf.tab{height:28px;padding:0 10px;border:1px solid var(--border2);border-radius:999px;font:600 12px var(--font)} .tabset .chipf.tab.on{background:var(--surface3);border-color:var(--teal);color:var(--text)}
.railnav .rrow.on{border-color:transparent;border-left:3px solid var(--teal);background:var(--surface2)}
.vk{display:inline-flex;align-items:center;vertical-align:-2px} .vk svg{width:15px;height:15px;fill:currentColor} .vk.up{color:var(--lime)} .vk.down{color:var(--coral)}
html[data-mode=light] .vk.up{color:color-mix(in oklab,var(--lime) 55%,var(--text))} html[data-mode=light] .vk.down{color:color-mix(in oklab,var(--coral) 55%,var(--text))}   /* light: the glyphs keep their hue but take the text's weight, so they hold 3:1 on the button even when a light palette sends no lime / coral */ .vk.note{font:500 11px var(--font);color:var(--dim)}
.fbv .vk svg{width:17px;height:17px} .tally{display:inline-flex;align-items:center;gap:3px} .tally .tn{font:500 11px var(--mono);color:var(--dim);margin-right:4px}
.imk{display:inline-flex;align-items:center;gap:6px}
.ith .nb{position:absolute;left:3px;bottom:3px;padding:0 4px;border-radius:4px;background:rgba(0,0,0,.62);font:600 9.5px/14px var(--font);color:#fff}
.irow.job .igo{font:600 12px var(--font);color:var(--sky);white-space:nowrap} .irow.job{cursor:default} button.irow.job{cursor:pointer} .jdot{flex:none;width:8px;height:8px;border-radius:50%;background:var(--border2)} .jdot.on{background:var(--sky)} .icm.bad{color:var(--coral)}
.mdl .wt-job,.mdl .wt-jobname{display:none}   /* v3: the job is chosen on the Models list; Watch is that job's page */
.setfold{border:0} .setfold>summary{cursor:pointer;font:400 12.5px var(--font);color:var(--dim);list-style-position:inside} .setfold>summary b{color:var(--text);font-weight:600} .setfold[open]>summary{margin-bottom:8px}
.chipf{height:28px;padding:0 10px;border:1px solid var(--border2);border-radius:999px;background:none;color:var(--dim);font:600 12px var(--font);cursor:pointer}
.chipf .n{font:500 11px var(--mono);color:var(--dim2)} .chipf.on{background:var(--surface3);border-color:var(--teal);color:var(--text)} .chipf:focus-visible{outline:2px solid var(--teal);outline-offset:1px}
.flabel .idrow>span{white-space:nowrap}
.rv.focus .mkbar{margin:8px 0 0;padding-bottom:10px;border-bottom:1px solid var(--border)}
.rv.focus .fb{margin-top:0} .rv.focus .fbr .fbt{margin-right:4px}
.rv.focus .fbc{min-height:150px;font-size:13px;line-height:1.5}
.fnote{margin-top:14px;padding:10px 12px;border:1px solid var(--border);border-radius:var(--corner);background:var(--surface)} .fnote .fbt{margin-bottom:4px;color:var(--dim)}
.fnav{display:flex;align-items:center;gap:4px} .fpos{font:600 11px var(--mono);color:var(--dim);min-width:36px;text-align:center}
.ftabs{display:flex;gap:4px;margin:8px 0 10px;border-bottom:1px solid var(--border);padding-bottom:6px}
.ftab{height:32px;border:1px solid transparent;border-radius:8px;background:none;padding:0 12px;font:600 12px var(--font);color:var(--dim);cursor:pointer}
.ftab:hover{color:var(--text)} .ftab.on{background:var(--surface3);border-color:var(--border2);color:var(--text)} .ftab:focus-visible{outline:2px solid var(--teal);outline-offset:1px}
@media (pointer:coarse){.ftab{height:40px}}
.fpane{margin-top:10px}
.facts{display:grid;grid-template-columns:auto 1fr;gap:4px 12px;margin:0 0 10px;font-size:12.5px} .facts dt{color:var(--dim)} .facts dd{margin:0;color:var(--text);overflow-wrap:anywhere}
.fprompt{margin:0 0 10px;font-size:12.5px;line-height:1.5;color:var(--dim);white-space:pre-wrap;overflow-wrap:anywhere}
.facts-acts{display:flex;flex-wrap:wrap;gap:6px}
.frefhead{display:flex;align-items:center;gap:8px;margin-bottom:6px} .frefhead .cmpmode{margin-left:auto}
.frefs .st{width:64px;height:64px}
.st .cmpl{position:absolute;left:0;right:0;bottom:0;padding:1px 0;background:color-mix(in srgb,var(--ink) 75%,transparent);font:600 9px/12px var(--font);color:var(--text);text-align:center}
/* numbers on every image of a review, and the user's marks (task, ) */
.st .nb{position:absolute;left:0;top:0;padding:0 4px;border-bottom-right-radius:4px;background:color-mix(in srgb,var(--ink) 75%,transparent);font:600 9.5px/14px var(--font);color:var(--text)}
.rv .cur .mks{position:absolute;left:0;top:0;width:100%;height:100%;pointer-events:none}
.mk{position:absolute;width:0;height:0;pointer-events:auto;touch-action:none;cursor:grab}
.mk i{position:absolute;left:-5px;top:-5px;width:10px;height:10px;border-radius:50%;background:#000;box-shadow:0 0 0 1.5px #fff}   /* black, a thin white ring: seen on any image */
.mk i::after{content:'';position:absolute;inset:-10px}   /* a finger-sized grip on a 10 px dot */
.mk b{position:absolute;left:7px;bottom:5px;padding:0 5px;border-radius:999px;background:#000;color:#fff;font:700 11px/16px var(--font);white-space:nowrap;box-shadow:0 0 0 1px #fff}
.mks.v-dots .mk b{display:none} .mks.v-hidden .mk,.mks.v-hidden .mkmenu{display:none}
.mk.temp,.mk.moving{opacity:.45}
/* aiming a mark : a precision cursor — crosshair, a ring at its centre, nothing under it;
   on touch the same crosshair is drawn above the finger (TOUCH_LIFT in the panel script) */
html.marking,html.marking *{cursor:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='32' height='32'%3E%3Cg fill='none' stroke='%23fff' stroke-width='3'%3E%3Ccircle cx='16' cy='16' r='5'/%3E%3Cpath d='M16 1v9M16 22v9M1 16h9M22 16h9'/%3E%3C/g%3E%3Cg fill='none' stroke='%23000' stroke-width='1'%3E%3Ccircle cx='16' cy='16' r='5'/%3E%3Cpath d='M16 1v9M16 22v9M1 16h9M22 16h9'/%3E%3C/g%3E%3C/svg%3E") 16 16,crosshair!important}
.aimx{position:fixed;z-index:50;width:32px;height:32px;margin:-16px 0 0 -16px;pointer-events:none;background:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='32' height='32'%3E%3Cg fill='none' stroke='%23fff' stroke-width='3'%3E%3Ccircle cx='16' cy='16' r='5'/%3E%3Cpath d='M16 1v9M16 22v9M1 16h9M22 16h9'/%3E%3C/g%3E%3Cg fill='none' stroke='%23000' stroke-width='1'%3E%3Ccircle cx='16' cy='16' r='5'/%3E%3Cpath d='M16 1v9M16 22v9M1 16h9M22 16h9'/%3E%3C/g%3E%3C/svg%3E") center/32px 32px no-repeat}
.aimx.mouse,.aimx.still{display:none} .aimx.off{opacity:.5}
/* zoom (Ctrl + scroll): the image and its marks scale together; labels and menus keep their size */
.rv .cur .zw{position:absolute;inset:0;transform-origin:0 0}
.zw .mk{transform:scale(var(--iz,1))} .zw .mkmenu{transform:scale(var(--iz,1));transform-origin:0 0}
.rv .cur.zoomed{touch-action:none;cursor:grab} .rv .cur.zoomed.panning{cursor:grabbing}
.rv .cur .big.pixels{image-rendering:pixelated}
.pxgrid{position:absolute;pointer-events:none;background-image:linear-gradient(to right,color-mix(in srgb,var(--text) 14%,transparent) 1px,transparent 1px),linear-gradient(to bottom,color-mix(in srgb,var(--text) 14%,transparent) 1px,transparent 1px)}
.zm{position:absolute;top:6px;right:6px;display:flex;align-items:center;gap:6px;padding:2px 2px 2px 8px;border-radius:999px;background:color-mix(in srgb,var(--ink) 80%,transparent);font:600 11px/20px var(--mono);color:var(--text)}
.zm[hidden],.pxgrid[hidden]{display:none}   /* the hidden attribute loses to display:flex otherwise */
.zmr{height:20px;padding:0 8px;border:0;border-radius:999px;background:var(--surface3);color:var(--text);font:600 11px var(--font);cursor:pointer}
.mkmenu{position:absolute;z-index:3;display:flex;gap:4px;margin:10px 0 0 -10px;padding:4px;border-radius:8px;border:1px solid var(--border2);background:var(--surface3);pointer-events:auto;white-space:nowrap}
.mkbar{display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin:6px 0 0} .mkbar .cmpmode{margin-left:auto}
.mkadd{height:28px;padding:0 10px;border-radius:8px;border:1px dashed var(--text);background:none;color:var(--text);font:600 11px var(--font);cursor:grab;touch-action:none;-webkit-user-select:none;user-select:none}
.mkadd:focus-visible{outline:2px solid var(--teal);outline-offset:1px}
.mkhint{font-size:11.5px;color:var(--dim)}
.mkview{margin-left:auto;width:32px;height:28px;display:inline-flex;align-items:center;justify-content:center;padding:0;border-radius:8px;border:1px solid var(--border2);background:none;color:var(--text);cursor:pointer}
.mkview svg{width:20px;height:20px} .mkview:hover{background:var(--surface2)} .mkview:focus-visible{outline:2px solid var(--teal);outline-offset:1px}
@media (pointer:coarse){.mkview{width:40px;height:36px}}
@media (pointer:coarse){.mkadd{height:36px}}
.addref{margin-top:12px} .addref .fbh{margin:0 0 6px}
html.dropping .rv.focus{outline:2px dashed var(--teal);outline-offset:-2px}
.rv .side{min-width:0}
.rnote{margin:0;font-size:13.5px;line-height:1.5;color:var(--text);white-space:pre-wrap;overflow-wrap:anywhere} .rnote.none{color:var(--dim)}
.rv .sup{margin:6px 0 0;font-size:12px;color:var(--dim2)}
.rv .meta{margin:8px 0 0;font:400 11px var(--font);color:var(--dim2)}
.rv .acts{margin-top:12px}
@media (min-width:520px){.rv-b{flex-direction:row;align-items:flex-start}.rstage{flex:1}.rv .side{flex:0 0 220px}.rv .cur{max-height:260px}}
/* stacked (a phone, a narrow rail): the strip and the image, the rating form right under it, then the
   description, then the note + Send () — the side column's parts join the one column */
@media (max-width:519.98px){.rv-b{gap:0}.rv .side{display:contents}.rv-b>.rstage{order:1}.rv .side>*{order:3}.rv .side>.fbl,.rv .side>.fbh,.rv .side>.fb{order:2}.rv .side>.sendbar{order:4}.rv .side>.rnote,.rv .side>.vban{margin-top:14px}}
.ge-l .rv .side{flex:0 0 300px}
.ge-l .rv .cur{max-height:380px} .ge-l .rv .cur.mesh{max-height:none}   /* a model's stage is as tall as its viewer (it was cut at 380 and the viewer hung over what comes after it) */
.t-xl .rv .side{flex-basis:360px}
.t-xl .rv .cur{max-height:480px}
.t-xl .st{width:64px;height:64px}
@media (pointer:coarse){.rv .back,.ver{min-height:44px;min-width:44px;justify-content:center}}
/* 👍/👎 + comment in the large view (a panel action) and the card marker. Aurora tokens, the .btn
   shape, the teal focus ring; a pressed verdict is the lifted state (no accent bar). */
.fbm{flex:none;font-size:12px;line-height:1;white-space:nowrap}
/* per-image ratings : the form says which image it rates; each strip thumb carries
   its image's mark (+ the amber dot while it is an unsent draft) */
.fbt{margin:0;font:600 12px/1.3 var(--font);color:var(--text)}
.stm{position:absolute;right:2px;bottom:2px;display:inline-flex;align-items:center;gap:2px;padding:1px 3px;border-radius:999px;background:var(--surface);font:400 10px/1 var(--font)}
.stm i{width:6px;height:6px;border-radius:50%;background:var(--amber);flex:none}
/* an older version in view: the amber note with the teal way to the latest */
.vban{margin:0 0 8px;padding:6px 8px;border:1px solid var(--amber);border-radius:8px;font:500 12px/1.4 var(--font);color:var(--amber);overflow-wrap:anywhere}
.vban-go{border:0;padding:0;background:none;color:var(--teal);font:600 12px/1.4 var(--font);text-decoration:underline;cursor:pointer}
.vban-go:focus-visible{outline:2px solid var(--teal);outline-offset:1px;border-radius:2px}
@media (pointer:coarse){.vban-go{min-height:44px}}
.fbl{margin:8px 0 0;font-size:12.5px;line-height:1.45;color:var(--text);overflow-wrap:anywhere}
.fbh{margin:10px 0 0;font-size:12px;color:var(--dim)}
.fb{margin-top:12px;display:flex;flex-direction:column;gap:6px}
.fbr{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.fbv{height:28px;min-width:36px;border:1px solid var(--border2);border-radius:8px;background:none;font:400 14px/1 var(--font);cursor:pointer;opacity:.8}
.fbv:hover{background:var(--surface2);opacity:1} .fbv.on{background:var(--surface3);border-color:var(--dim2);opacity:1}
.fbc{width:100%;min-height:44px;resize:vertical;padding:6px 8px;border:1px solid var(--border2);border-radius:8px;background:var(--surface2);color:var(--text);font:400 12.5px/1.4 var(--font)}
.fbc::placeholder{color:var(--dim2)}
.fbv:focus-visible,.fbc:focus-visible{outline:2px solid var(--teal);outline-offset:1px}
.fbv:disabled,.fbc:disabled,.btn:disabled{opacity:.5;cursor:default}
.fbs{font:500 11.5px var(--font);color:var(--dim)} .fbs.bad{color:var(--coral)}
.btn.pri:not(:disabled){background:var(--teal);border-color:var(--teal);color:var(--ink);font-weight:700}   /* Save rating / Send review: teal primary when it can act */
.btn.pri:not(:disabled):hover{filter:brightness(1.08)}
.btn.pri:disabled{background:var(--surface2);color:var(--dim2);border-color:var(--border);opacity:1}
/* unsent ratings (batched, ): a small amber "unsent" tag on the card / in the large
   view, and the bar "N ratings not sent yet" + "Send review (N)" on the list and in the large view */
.unsent{flex:none;display:inline-block;font:600 10px/15px var(--font);color:var(--amber);border:1px solid var(--amber);border-radius:999px;padding:0 6px;white-space:nowrap;vertical-align:1px}
.sendbar{display:flex;align-items:center;gap:6px 10px;flex-wrap:wrap;margin:0 0 10px;padding:8px 10px;border:1px solid var(--border2);border-radius:8px;background:var(--surface)}
.rv .sendbar{margin:12px 0 0}
.sbt{display:inline-flex;align-items:center;gap:6px;font:600 12px var(--font);color:var(--text)}
.sbt i{width:7px;height:7px;border-radius:50%;background:var(--amber);flex:none}
.sbm{font:500 11.5px var(--font);color:var(--dim)} .sbm:empty{display:none} .sbm.bad{color:var(--coral)}
.sendbar .sbb{margin-left:auto;display:flex;flex-wrap:wrap;justify-content:flex-end;gap:6px}
.sendbar .sbn{flex-basis:100%;min-height:44px;resize:vertical;padding:6px 8px;border:1px solid var(--border2);border-radius:8px;background:var(--surface2);color:var(--text);font:400 12.5px/1.4 var(--font)}
/* held / unregistered (the host's app-status): the view works, actions wait for Approve */
.appr{margin:4px 0 0;font:500 12px/1.4 var(--font);color:var(--amber);overflow-wrap:anywhere}
.sendbar .appr{flex-basis:100%;margin:0}
.appr-go{border:0;padding:0;background:none;color:var(--teal);font:600 12px/1.4 var(--font);text-decoration:underline;cursor:pointer}
.appr-go:focus-visible{outline:2px solid var(--teal);outline-offset:1px;border-radius:2px}
@media (pointer:coarse){.appr-go{min-height:44px}}
@media (pointer:coarse){.fbv{min-height:44px;min-width:44px}}
`;

/* message: shown instead of the app (not the bound room / app error); view.js then does nothing. */
/* The panel. base + open: the same panel served at review/<n> (a room line's link, the host's preview
   column) — every URL one level up (base '../'), opened on that item (open 'review/<n>[/v<k>]'). */
export function page(message = null, { base = '', open = '', mode = '' } = {}) {
  const body = message
    ? `<p class="msg">${esc(message)}</p>`
    : `<p class="msg">Loading…</p>`;
  return (
    // ?mode=light (the host's first-paint hint, Aurora): a light room doesn't flash dark before {host:'theme'}
    `<!doctype html><html lang="en" data-tiers="${TIERS_ATTR}"` + (base ? ` data-base="${esc(base)}"` : '') + (open ? ` data-open="${esc(open)}"` : '') + (mode === 'light' ? ' data-mode="light"' : '') + `><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">` +
    (message ? '' : `<noscript><meta http-equiv="refresh" content="${POLL_S}"></noscript>`) +
    `<title>Asset Studio</title>` +
    `<link rel="stylesheet" href="${base}tokens.css">` +
    `<style>${CSS}${MODEL_CSS}</style></head><body>` +
    `<div class="ap" id="ap"${message ? ' data-off="1"' : ''}>${body}</div>` +
    (message ? '' : `<script src="${base}view.js"></script>`) +
    `</body></html>\n`
  );
}

/* ------------------------------------------------------------------ review -- */

/* One review item, large: GET /rooms/:roomId/review/:n[?v=<version>&i=<image>]. Server-rendered
   (it reads right with no script: every version / image is a plain link); review.js adds the
   keys (← → images, [ ] versions, Esc back), swipe, local times and "Reply in chat". Lives one
   level down, so every link is ../ (tokens.css, file/, thumb/, view) — relative through the
   engine's frame proxy. Stacked below L; image | note side by side from L up. */
const RCSS = `
:root{color-scheme:dark}
*{box-sizing:border-box}
@media (max-width:600px),(pointer:coarse){input,textarea,select{font-size:16px !important}} /* iOS focus zoom, see CSS */
html,body{margin:0;background:var(--surface);color:var(--text);font:400 12.5px/1.4 var(--font)}
.rv{max-width:1200px;margin:0 auto;padding:8px 12px 14px}
.rv-h{display:flex;align-items:center;gap:8px;min-height:36px;margin-bottom:8px}
.back{flex:none;display:inline-flex;align-items:center;height:28px;padding:0 8px;border-radius:8px;color:var(--dim);font:600 12px var(--font);text-decoration:none}
.back:hover{background:var(--surface2);color:var(--text)}
h1{flex:1;min-width:0;margin:0;font:600 14px/1.3 var(--font);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
h1 .num{font:500 12px var(--mono);color:var(--dim)}
.vers{flex:none;display:flex;gap:2px;padding:2px;border:1px solid var(--border);border-radius:9px}
.ver{display:inline-flex;align-items:center;height:24px;padding:0 7px;border:1px solid transparent;border-radius:7px;font:500 11px var(--mono);color:var(--dim);text-decoration:none}
.ver:hover{background:var(--surface2)} .ver.on{background:var(--surface3);border-color:var(--border2);color:var(--text)}
.back:focus-visible,.ver:focus-visible,.st:focus-visible,.cur:focus-visible,.reply:focus-visible{outline:2px solid var(--teal);outline-offset:1px}
.rv-b{display:flex;flex-direction:column;gap:12px}
.idrow{margin:6px 0 0;display:flex;align-items:center;gap:6px;min-width:0;font:400 11px var(--mono);color:var(--dim2)} .idrow code{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font:inherit;color:var(--text)}
.cp{flex:none;width:24px;height:24px;display:inline-flex;align-items:center;justify-content:center;padding:0;border:1px solid var(--border2);border-radius:6px;background:none;color:var(--text);cursor:pointer} .cp:hover{background:var(--surface2)} .cp:focus-visible{outline:2px solid var(--teal);outline-offset:1px}
@media (pointer:coarse){.cp{width:36px;height:36px}}
.facts dd.idd{display:flex;align-items:center;gap:6px;overflow:visible} .facts dd.idd span{min-width:0;overflow:hidden;text-overflow:ellipsis}
.stage{min-width:0}
.cur{display:flex;align-items:center;justify-content:center;background:var(--ink);border-radius:var(--corner);overflow:hidden;touch-action:pan-y}
/* Width-driven caps only, never vh: inside the panel vh IS the frame, whose height we post, so a vh
   size either loops or (with a floor) overflows a capped frame and hides the note (the user, wide rail). */
.cur img{display:block;width:100%;height:auto;max-height:188px;object-fit:contain}   /* stacked: locked to its height at a 315px rail so the note's first line peeks = "scroll for more" */
.strip{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}
.st{position:relative;display:block;width:48px;height:48px;border-radius:4px;border:1px solid var(--border2);overflow:hidden;background:var(--surface2)}
.st img{display:block;width:100%;height:100%;object-fit:cover}
.st.on{outline:2px solid var(--teal);outline-offset:1px}
.side{min-width:0}
.note{margin:0;font-size:13.5px;line-height:1.5;color:var(--text);white-space:pre-wrap;overflow-wrap:anywhere}
.note.none{color:var(--dim)}
.sup{margin:6px 0 0;font-size:12px;color:var(--dim2)}
.meta{margin:8px 0 0;font:400 11px var(--font);color:var(--dim2)}
.reply{margin-top:12px;height:30px;padding:0 12px;border:1px solid var(--border2);border-radius:8px;background:none;color:var(--text);font:600 11.5px var(--font);cursor:pointer}
.reply:hover{background:var(--surface2)}
.msg{padding:12px 2px;color:var(--dim);font-size:12.5px}
.toast{position:fixed;left:50%;bottom:12px;transform:translateX(-50%);background:var(--surface3);border:1px solid var(--border2);color:var(--text);font:500 12px var(--font);padding:7px 12px;border-radius:8px;pointer-events:none}
/* ≥520 (upper M): beside already, note 220px — stacked, a landscape image pushed the note below a
   capped frame's fold (the user's wide rail). L: note 300px; XL: note 360px, 64px strip */
@media (min-width:520px){.rv-b{flex-direction:row;align-items:flex-start}.stage{flex:1}.side{flex:0 0 220px}.cur img{max-height:260px}}
.ge-l .rv-b{flex-direction:row;align-items:flex-start}
.ge-l .stage{flex:1}
.ge-l .side{flex:0 0 300px}
.ge-l .note{max-height:none}
.ge-l .cur img{max-height:380px}
.t-xl .side{flex-basis:360px}
.t-xl .cur img{max-height:480px}
.t-xl .st{width:64px;height:64px}
@media (pointer:coarse){.back,.ver,.reply{min-height:44px;min-width:44px;justify-content:center}}
`;

const utc = (iso) => (iso ? `${String(iso).slice(0, 16).replace('T', ' ')} UTC` : '');
const when = (iso) => `<time datetime="${esc(iso)}">${esc(utc(iso))}</time>`;

function reviewShell(title, body, script) {
  return (
    `<!doctype html><html lang="en" data-tiers="${TIERS_ATTR}"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<title>${esc(title)}</title><link rel="stylesheet" href="../tokens.css"><style>${RCSS}</style></head><body>` +
    `<main class="rv" id="rv">${body}</main>${script ? '<script src="../review.js"></script>' : ''}</body></html>\n`
  );
}

/* {item, v?, i?} → the item at version v (default latest), image i shown large.
   {missing: n} → the 404 page.  {message} → not the bound room. */
export function reviewPage({ item = null, v = null, i = 0, missing = null, message = null } = {}) {
  const back = (n) => `<a class="back" id="back" href="../view#review${n ? `/list/${esc(n)}` : ''}">‹ Review</a>`;
  if (message) return reviewShell('Review', `<p class="msg">${esc(message)}</p>`, false);
  if (!item) {
    return reviewShell('Review', `<header class="rv-h">${back(null)}</header><p class="msg">Review #${esc(missing)} isn't here any more.</p>`, true);
  }
  const V = item.versions.length;
  const ver = item.versions.find((x) => x.v === v) ?? item.versions.at(-1);
  const latest = item.versions.at(-1);
  const idx = Math.min(Math.max(0, i | 0), ver.images.length - 1);
  const q = (vv, ii) => `${item.n}?v=${vv}${ii ? `&amp;i=${ii}` : ''}`;
  const pills = item.versions.map((x) => `<a class="ver${x.v === ver.v ? ' on' : ''}" href="${q(x.v, 0)}"${x.v === ver.v ? ' aria-current="page"' : ''}>v${x.v}</a>`).join('');
  const cur = ver.images[idx];
  const strip = ver.images.length > 1
    ? `<div class="strip" id="strip">${ver.images.map((id, k) =>
      `<a class="st${k === idx ? ' on' : ''}" href="${q(ver.v, k)}" data-i="${k}" data-id="${esc(id)}" aria-label="image ${k + 1} of ${ver.images.length}"><img src="../thumb/${encodeURIComponent(id)}" alt=""></a>`).join('')}</div>`
    : '';
  const body =
    `<header class="rv-h">${back(item.n)}<h1><span class="num">#${item.n}</span> · ${esc(item.title)}</h1>` +
    `<nav class="vers" id="vers" aria-label="Versions">${pills}</nav></header>` +
    `<div class="rv-b" data-n="${item.n}" data-v="${ver.v}" data-count="${ver.images.length}">` +
    `<section class="stage"><a class="cur" id="cur" href="../file/${encodeURIComponent(cur)}" target="_blank" rel="noopener" title="Open the full image">` +
    `<img id="curimg" crossorigin="anonymous" src="../file/${encodeURIComponent(cur)}" alt="#${item.n} image ${idx + 1} of ${ver.images.length}"></a>` +
    `<p class="idrow"><span>Image id</span><code id="curid">${esc(cur)}</code><button class="cp" id="cpid" type="button" aria-label="Copy the image id" title="Copy the image id"><svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><rect x="5" y="5" width="9" height="9" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M3 11V3.5A1.5 1.5 0 0 1 4.5 2H11" fill="none" stroke="currentColor" stroke-width="1.5"/></svg></button></p>${strip}</section>` +
    `<aside class="side"><p class="note${ver.note ? '' : ' none'}">${esc(ver.note || 'No note.')}</p>` +
    (ver.v < latest.v ? `<p class="sup">superseded by v${latest.v}</p>` : '') +
    `<p class="meta">${item.agent ? `@${esc(item.agent)} · ` : ''}${when(ver.at)} · v${ver.v} of ${V}</p>` +
    `<button class="reply" id="reply" type="button" data-text="#${item.n} v${ver.v}: ">Reply in chat</button></aside></div>`;
  return reviewShell(`#${item.n} · ${item.title} — Review`, body, true);
}
