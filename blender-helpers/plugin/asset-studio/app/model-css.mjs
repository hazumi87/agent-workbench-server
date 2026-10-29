/* Model Studio's panel CSS (its Studio and Watch tabs, the 3D viewer), scoped under .mdl — generated from
   model-studio app/view.mjs (CSS + WATCH_CSS + VIEWER_CSS) when Asset Studio took the model domain in.
   Rules on <html> keep their root part (tiers, the Watch page layout). Edit here from now on.
   The overlays ON the Watch stage (camera numbers, step pill, names, modes, parts) keep a fixed dark ground and
   white text in every mode and palette — they sit on pictures, like the image overlays. */
export const MODEL_CSS = `
@media (max-width:600px),(pointer:coarse){.mdl input,.mdl textarea,.mdl select{font-size:16px !important}}
.mdl .railnav{display:flex;flex-direction:column;gap:4px;padding:8px}
.mdl .rrow{display:flex;align-items:center;gap:8px;min-height:40px;padding:0 12px;border:1px solid var(--border2);border-radius:8px;background:none;color:var(--text);font:600 13px var(--font);cursor:pointer;text-align:left}
.mdl .rrow:hover{background:var(--surface2)}
.mdl .rrow.on{border-color:var(--teal);background:var(--surface2)}
.mdl .rrow:focus-visible{outline:2px solid var(--teal);outline-offset:1px}
.mdl .rrow .rl{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mdl .rrow .rs{font:500 11px var(--font);color:var(--amber)}
.mdl .rrow .rc{min-width:20px;text-align:right;font:600 12px var(--mono);color:var(--dim)}
@media (pointer:coarse){.mdl .rrow{min-height:44px}}
.mdl .ap{background:var(--surface)}
.mdl .ap-sec{padding:10px 12px 10px 14px;border-top:1px solid var(--border)}
.mdl .ap-sec:first-child{border-top:0}
.mdl .ap-lbl{display:flex;align-items:baseline;gap:8px;font:700 .6rem var(--display);letter-spacing:.1em;text-transform:uppercase;color:var(--dim2);margin-bottom:7px;min-width:0}
.mdl .ap-lbl .r{margin-left:auto;font:500 10.5px var(--mono);letter-spacing:0;text-transform:none;color:var(--dim);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}
.mdl .job{display:flex;align-items:center;gap:8px;font-size:12.5px;min-width:0}
.mdl .job .dot{width:8px;height:8px;border-radius:50%;background:var(--sky);flex:none;animation:pulse 1.4s ease-in-out infinite}
.mdl .job .t{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
@keyframes pulse{50%{opacity:.6}
.mdl }   
.job .pct{margin-left:auto;font:500 11px var(--mono);color:var(--dim);flex:none}
.mdl .meter{height:3px;border-radius:2px;background:var(--surface3);margin-top:7px;overflow:hidden}
.mdl .meter i{display:block;height:100%;background:var(--sky);border-radius:2px}
.mdl .meter.indet i{width:30%;animation:slide 1.3s ease-in-out infinite}
@keyframes slide{0%{transform:translateX(-100%)}
.mdl 100%{transform:translateX(340%)}
.mdl }
.stage .mv{aspect-ratio:4/3;min-height:220px;max-height:420px}
.mdl .cap{display:flex;align-items:center;gap:8px;margin-top:7px;min-width:0}
.mdl .cap .n{flex:1;min-width:0;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mdl .cap.note{font-size:11.5px;color:var(--dim)}
.mdl .btn{height:28px;display:inline-flex;align-items:center;padding:0 10px;border-radius:8px;border:1px solid var(--border2);background:none;color:var(--text);font:600 11px var(--font);text-decoration:none;cursor:pointer;flex:none;white-space:nowrap}
.mdl .btn:hover{background:var(--surface2)}
.mdl .btn:focus-visible{outline:2px solid var(--teal);outline-offset:1px}
.mdl .jobs{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:6px}
.mdl .jobs li{display:grid;grid-template-columns:8px minmax(0,1fr) auto;gap:3px 8px;align-items:baseline}
.mdl .jobs .s{width:7px;height:7px;border-radius:50%;background:var(--dim);align-self:center}
.mdl .jobs .s.done{background:var(--lime)}
.mdl .jobs .s.error,.mdl .jobs .s.lost{background:var(--coral)}
.mdl .jobs .s.running,.mdl .jobs .s.queued{background:var(--sky)}
.mdl .jobs .l{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mdl .jobs .w{font:500 10.5px var(--mono);color:var(--dim);white-space:nowrap}
.mdl .jobs .e{grid-column:2 / 4;font-size:11px;color:var(--dim);overflow-wrap:anywhere}
.mdl .ap-sec{container-type:inline-size}
@container (max-width:300px){.jobs li{grid-template-columns:8px minmax(0,1fr)}
.mdl .jobs .l{white-space:normal;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
.mdl .jobs .w{grid-column:2}
.mdl }
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(64px,1fr));gap:5px}
.mdl .th{position:relative;aspect-ratio:1;border-radius:var(--corner);border:1px solid var(--border);overflow:hidden;background:var(--surface2);cursor:pointer;padding:0}
.mdl .th:hover{border-color:var(--border2)}
.mdl .th.sel{outline:2px solid var(--teal);outline-offset:1px}
.mdl .th:focus-visible{outline:2px solid var(--teal);outline-offset:1px}
.mdl .th img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;display:block}
.mdl .th .k{position:absolute;left:3px;top:3px;font:600 9px var(--mono);color:var(--text);background:color-mix(in srgb,var(--ink) 72%,transparent);padding:0 4px;border-radius:3px}
.mdl .budget{display:flex;align-items:baseline;gap:6px;font-size:12px}
.mdl .budget .n{font:600 12px var(--mono)}
.mdl .budget .of{color:var(--dim)}
.mdl .budget + .meter i{background:var(--dim)}
.mdl .low .budget .n{color:var(--amber)}
.mdl .low .budget + .meter i{background:var(--amber)}
.mdl .empty{padding:16px 14px;color:var(--dim);font-size:12.5px;line-height:1.5}
.mdl .empty b{display:block;color:var(--text);font-weight:600;margin-bottom:3px}
.mdl .off{padding:12px 14px;font-size:12.5px;line-height:1.45;color:var(--dim)}
.mdl .off b{color:var(--text);font-weight:600;display:block}
.mdl .msg{padding:12px 14px;color:var(--dim);font-size:12px}
.mdl .more{font-size:11px;color:var(--dim2);margin-top:6px}
.mdl .tabs{display:flex;gap:4px;padding:7px 10px;border-bottom:1px solid var(--border)}
.mdl .tab{height:28px;border:1px solid transparent;border-radius:8px;background:none;padding:0 9px;font:600 11px var(--font);color:var(--dim);cursor:pointer}
.mdl .tab:hover{background:var(--surface2)}
.mdl .tab.on{background:var(--surface3);border-color:var(--border2);color:var(--text)}
.mdl .tab .c{font:500 10.5px var(--mono);color:var(--dim2);margin-left:4px}
.mdl .tab:focus-visible{outline:2px solid var(--teal);outline-offset:1px}
@media (pointer:coarse){.mdl .tab,.mdl .btn{min-height:44px}}
.mdl .split{display:grid;grid-template-columns:minmax(0,1fr) 220px;align-items:start}
.ge-l .mdl .split{grid-template-columns:minmax(0,1fr) 260px}
.t-xl .mdl .split{grid-template-columns:minmax(0,1fr) 320px}
.mdl .split > .col-r{border-left:1px solid var(--border)}
.mdl .split .col-l > .ap-sec:first-child,.mdl .split .col-r > .ap-sec:first-child{border-top:0}
.mdl .rlist{display:grid;gap:8px;grid-template-columns:repeat(auto-fill,minmax(min(100%,max(340px,calc((100% - 16px) / 3))),1fr));align-items:start}
.mdl .card{display:flex;flex-direction:column;gap:8px;width:100%;text-align:left;padding:10px;border-radius:8px;border:1px solid var(--border);background:var(--surface);color:var(--text);font:inherit;cursor:pointer}
.mdl .card:hover{background:var(--surface2)}
.mdl .card:focus-visible{outline:2px solid var(--teal);outline-offset:1px}
.mdl .card.cur{background:var(--surface3);border-color:var(--border2);outline:2px solid var(--teal);outline-offset:1px}
.mdl .card.flash{animation:flash .9s ease-out}
@keyframes flash{0%{background:var(--surface3);box-shadow:0 0 0 1px var(--dim2)}
.mdl 100%{box-shadow:0 0 0 1px transparent}
.mdl }
.c1{display:flex;align-items:center;gap:8px;min-width:0}
.mdl .c1 .num{font:500 11px var(--mono);color:var(--dim);flex:none}
.mdl .c1 .ttl{font:600 14px/1.3 var(--font);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mdl .chip{font:500 11px var(--mono);color:var(--dim);border:1px solid var(--border2);border-radius:999px;padding:0 6px;flex:none}
.mdl .state{margin-left:auto;display:inline-flex;align-items:center;gap:5px;font:500 11px var(--font);color:var(--dim);flex:none;white-space:nowrap}
.mdl .state i{width:7px;height:7px;border-radius:50%;background:var(--dim)}
.mdl .state.waiting i{background:var(--amber)}
.mdl .state.resolved i{background:var(--lime)}
.mdl .c2{font-size:12.5px;line-height:1.4;color:var(--dim);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;overflow-wrap:anywhere}
.mdl .c3{display:flex;gap:6px}
.mdl .c3 img{flex:0 1 64px;min-width:0;width:64px;height:auto;aspect-ratio:1;object-fit:cover;border:1px solid var(--border2);border-radius:4px;display:block;background:var(--surface2)}
.mdl .c4{font:400 11px var(--font);color:var(--dim2)}
.mdl .rmore{display:flex;align-items:center;gap:6px;height:32px;border:0;background:none;color:var(--dim);font:600 11px var(--font);cursor:pointer;padding:0 4px;margin-top:6px}
.mdl .rmore:hover{color:var(--text)}
.mdl .rmore:focus-visible{outline:2px solid var(--teal);outline-offset:1px}
.mdl .gone{font-size:12px;color:var(--dim);padding:6px 2px 8px}
.mdl .toast{position:fixed;left:50%;bottom:12px;transform:translateX(-50%);background:var(--surface3);border:1px solid var(--border2);color:var(--text);font:500 12px var(--font);padding:7px 12px;border-radius:8px;pointer-events:none}
.mdl .rv{padding:8px 12px 14px}
.mdl .rv-h{display:flex;align-items:center;gap:8px;min-height:36px;margin-bottom:8px;min-width:0}
.mdl .rv .back{flex:none;display:inline-flex;align-items:center;height:28px;padding:0 8px;border:0;border-radius:8px;background:none;color:var(--dim);font:600 12px var(--font);cursor:pointer}
.mdl .rv .back:hover{background:var(--surface2);color:var(--text)}
.mdl .rv h1{flex:1;min-width:0;margin:0;font:600 14px/1.3 var(--font);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mdl .rv h1 .num{font:500 12px var(--mono);color:var(--dim)}
.mdl .vers{flex:none;display:flex;gap:2px;padding:2px;border:1px solid var(--border);border-radius:9px}
.mdl .ver{display:inline-flex;align-items:center;height:24px;padding:0 7px;border:1px solid transparent;border-radius:7px;background:none;font:500 11px var(--mono);color:var(--dim);cursor:pointer}
.mdl .ver:hover{background:var(--surface2)}
.mdl .ver.on{background:var(--surface3);border-color:var(--border2);color:var(--text)}
.mdl .rv .back:focus-visible,.mdl .ver:focus-visible,.mdl .st:focus-visible,.mdl .rv .cur:focus-visible{outline:2px solid var(--teal);outline-offset:1px}
.mdl .rv-b{display:flex;flex-direction:column;gap:12px}
.mdl .rstage{min-width:0}
.mdl .rv .cur{display:flex;align-items:center;justify-content:center;background:var(--stage);border-radius:var(--corner);overflow:hidden}
.mdl .rv .cur img{display:block;width:100%;height:auto;max-height:188px;object-fit:contain}
.mdl .rv .rstage .mv,.mdl .rv .rstage .mv-thumb{aspect-ratio:4/3;min-height:220px;max-height:420px}
.mdl .strip{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}
.mdl .st{position:relative;display:block;width:48px;height:48px;padding:0;border-radius:4px;border:1px solid var(--border2);overflow:hidden;background:var(--surface2);cursor:pointer}
.mdl .st img{display:block;width:100%;height:100%;object-fit:cover}
.mdl .st.on{outline:2px solid var(--teal);outline-offset:1px}
.mdl .rv .side{min-width:0}
.mdl .rnote{margin:0;font-size:13.5px;line-height:1.5;color:var(--text);white-space:pre-wrap;overflow-wrap:anywhere}
.mdl .rnote.none{color:var(--dim)}
.mdl .rv .sup{margin:6px 0 0;font-size:12px;color:var(--dim2)}
.mdl .rv .meta{margin:8px 0 0;font:400 11px var(--font);color:var(--dim2);overflow-wrap:anywhere}
.mdl .rv .acts{display:flex;flex-wrap:wrap;gap:6px;margin-top:12px}
@media (min-width:520px){.mdl .rv-b{flex-direction:row;align-items:flex-start}
.mdl .rstage{flex:1}
.mdl .rv .side{flex:0 0 220px}
.mdl .rv .cur img{max-height:260px}}
.ge-l .mdl .rv .side{flex:0 0 300px}
.ge-l .mdl .rv .cur img{max-height:380px}
.t-xl .mdl .rv .side{flex-basis:360px}
.t-xl .mdl .rv .cur img{max-height:480px}
.t-xl .mdl .st{width:64px;height:64px}
@media (pointer:coarse){.mdl .rv .back,.mdl .ver{min-height:44px;min-width:44px;justify-content:center}}
.mdl .wt{padding:10px 12px 12px 14px}
.mdl .wt-head{display:flex;flex-wrap:wrap;align-items:center;gap:6px 8px;margin-bottom:8px}
.mdl .wt-seg{flex:none;display:flex;gap:2px;padding:2px;border:1px solid var(--border);border-radius:9px}
.mdl .wt-sb{height:24px;padding:0 10px;border:1px solid transparent;border-radius:7px;background:none;font:600 11px var(--font);color:var(--dim);cursor:pointer}
.mdl .wt-sb:hover{background:var(--surface2)}
.mdl .wt-sb.on{background:var(--surface3);border-color:var(--border2);color:var(--text)}
.mdl .wt-job{flex:1 1 140px;min-width:0;height:28px;padding:0 6px;border:1px solid var(--border2);border-radius:8px;background:var(--surface2);color:var(--text);font:600 11px var(--font)}
.mdl .wt-jobname{flex:1 1 100px;min-width:0;font:500 11px var(--mono);color:var(--dim);text-align:right;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mdl .wt-sb:focus-visible,.mdl .wt-job:focus-visible,.mdl .wt-scrub:focus-visible,.mdl .wt-cb:focus-visible,.mdl .wt-lk:focus-visible,.mdl .wt-wb:focus-visible{outline:2px solid var(--teal);outline-offset:1px}
.mdl .wt-stage{position:relative}
.mdl .wt-pic{min-height:120px;border-radius:var(--corner);overflow:hidden;background:var(--stage);border:1px solid var(--border)}
.mdl .wt-pic img{display:block;width:100%;height:auto}
.mdl .wt-pic img[hidden]{display:none}
.mdl .wt-none{padding:48px 14px;text-align:center;color:var(--dim);font-size:12.5px;line-height:1.5}
.mdl .wt-cams{position:absolute;top:6px;right:6px;max-width:calc(100% - 12px);display:flex;flex-wrap:wrap;justify-content:flex-end;gap:2px}
.mdl .wt-cb{min-width:24px;height:24px;padding:0 4px;border:1px solid rgba(255,255,255,.22);border-radius:6px;background:rgba(0,0,0,.62);color:#fff;font:600 10.5px var(--mono);cursor:pointer}
.mdl .wt-cb:hover:not(:disabled):not(.on){background:rgba(0,0,0,.85)}
.mdl .wt-cnav{display:none;align-items:stretch;border:1px solid rgba(255,255,255,.22);border-radius:8px;background:rgba(0,0,0,.62);overflow:hidden}
.mdl .wt-cn{width:40px;height:34px;padding:0;border:0;background:transparent;color:#fff;font:600 22px/1 var(--font);cursor:pointer}
.mdl .wt-cn:active{background:rgba(255,255,255,.18)}
.mdl .wt-cn:focus-visible{outline:2px solid var(--teal);outline-offset:-2px}
.mdl .wt-cnsep{width:1px;background:rgba(255,255,255,.28);margin:6px 0}
.t-s .mdl .wt-cb,.t-m .mdl .wt-cb{display:none}   /* a phone: no row of camera numbers over the picture, one ‹ | › at the top right instead */
.t-s .mdl .wt-cnav,.t-m .mdl .wt-cnav{display:flex}
.t-s .mdl .wt-pgc .wt-cnav,.t-m .mdl .wt-pgc .wt-cnav{background:var(--surface2);border-color:var(--border2)}
.t-s .mdl .wt-pgc .wt-cn,.t-m .mdl .wt-pgc .wt-cn{color:var(--text)}
.t-s .mdl .wt-pgc .wt-cnsep,.t-m .mdl .wt-pgc .wt-cnsep{background:var(--border2)}
.mdl .wt-cb.on{background:var(--teal);border-color:var(--teal);color:var(--ink)}
.mdl .wt-cb:disabled{opacity:.4;cursor:default}
.mdl .wt-foot{position:absolute;left:8px;right:8px;bottom:8px;display:flex;flex-wrap:wrap;align-items:flex-end;justify-content:space-between;gap:6px;pointer-events:none}
.mdl .wt-name{min-width:0;flex:0 1 auto;padding:2px 8px;border-radius:6px;background:rgba(0,0,0,.62);font:600 11px/1.5 var(--font);color:#fff;pointer-events:none;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mdl .wt-name:empty{display:none}
.mdl .wt-modes[hidden],.mdl .wt-wide[hidden],.mdl .wt-looks[hidden]{display:none}
.mdl .wt-modes,.mdl .wt-wide,.mdl .wt-vmodes{flex:none;margin-left:auto;max-width:100%;display:flex;flex-wrap:wrap;justify-content:flex-end;gap:2px;pointer-events:auto}
.mdl .wt-mb,.mdl .wt-vb{height:22px;padding:0 6px;border:1px solid rgba(255,255,255,.22);border-radius:6px;background:rgba(0,0,0,.62);color:#fff;font:600 10.5px var(--font);white-space:nowrap;cursor:pointer}
.mdl .wt-mb:hover:not(.on),.mdl .wt-vb:hover:not(.on):not(:disabled){background:rgba(0,0,0,.85)}
.mdl .wt-mb.on,.mdl .wt-vb.on{background:var(--teal);border-color:var(--teal);color:var(--ink)}
.mdl .wt-vb:disabled{opacity:.4;cursor:default}
.mdl .wt-focus{flex:1 1 100%;order:-1;min-width:0;text-align:center}
.mdl .wt-focus[hidden]{display:none}
.mdl .wt-focus span{pointer-events:auto;display:inline-block;max-width:100%;padding:2px 8px;border-radius:6px;background:rgba(0,0,0,.62);font:600 11px/1.5 var(--font);color:#fff;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;vertical-align:bottom}
.mdl .wt-cams-m{max-width:calc(100% - clamp(84px,30%,180px) - 18px)}
.mdl .wt-pw{position:absolute;top:6px;left:6px;width:clamp(84px,30%,180px);max-height:calc(100% - 84px);display:flex;flex-direction:column;align-items:flex-start;gap:2px;pointer-events:none}
.mdl .wt-pt{flex:none;height:24px;padding:0 6px;border:1px solid rgba(255,255,255,.22);border-radius:6px;background:rgba(0,0,0,.62);color:#fff;font:600 10.5px var(--font);white-space:nowrap;cursor:pointer;pointer-events:auto}
.mdl .wt-pt:hover{background:rgba(0,0,0,.85)}
.mdl .wt-pt:focus-visible,.mdl .wt-pr input:focus-visible{outline:2px solid var(--teal);outline-offset:1px}
.mdl .wt-pl{max-width:100%;min-height:0;padding:3px 5px;overflow-y:auto;overscroll-behavior:contain;border:1px solid rgba(255,255,255,.22);border-radius:6px;background:rgba(0,0,0,.72);pointer-events:auto}
.mdl .wt-pl[hidden]{display:none}
.mdl .wt-pr{display:flex;align-items:center;gap:5px;min-height:22px;font:600 10.5px var(--font);color:#fff;cursor:pointer}
.mdl .wt-pr input{flex:none;width:13px;height:13px;margin:0;accent-color:var(--teal)}
.mdl .wt-pr span{min-width:0;flex:0 1 auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mdl .wt-pf{flex:none;margin-left:auto;color:var(--teal);font-style:normal;font-size:9px}
.mdl .wt-pr.focus span{color:var(--teal)}
.mdl .wt-wb{height:22px;padding:0 6px;border:1px solid rgba(255,255,255,.22);border-radius:6px;background:rgba(0,0,0,.62);color:#fff;font:600 10.5px var(--font);white-space:nowrap;cursor:pointer}
.mdl .wt-wb:hover:not(.on){background:rgba(0,0,0,.85)}
.mdl .wt-wb.on{background:var(--teal);border-color:var(--teal);color:var(--ink)}
.mdl .wt-looks{margin-top:8px;min-width:0}
.mdl .wt-lkh{margin:0 0 4px;font:600 11px var(--font);color:var(--dim)}
.mdl .wt-lks{display:flex;gap:4px;max-width:100%;padding:3px;overflow-x:auto;overscroll-behavior-x:contain}
.mdl .wt-lk{flex:none;display:block;min-width:56px;height:60px;padding:0;border:2px solid var(--border2);border-radius:6px;background:var(--stage);overflow:hidden;cursor:pointer}
.mdl .wt-lk img{display:block;height:100%;width:auto}
.mdl .wt-lk:hover:not(.on){border-color:var(--dim)}
.mdl .wt-lk.on{border-color:var(--teal)}
.mdl .wt-mb:focus-visible,.mdl .wt-vb:focus-visible{outline:2px solid var(--teal);outline-offset:1px}
.mdl .wt-ctl{display:flex;align-items:center;gap:8px;margin-top:8px}
.mdl .wt-scrub{flex:1;min-width:0;height:28px;margin:0;accent-color:var(--teal);cursor:pointer}
.mdl .wt-scrub:disabled{cursor:default}
.mdl .wt-now.on{border-color:var(--teal);color:var(--teal)}
.mdl .wt-cap{margin:8px 0 0;font:400 12px/1.45 var(--font);color:var(--text);overflow-wrap:anywhere}
.mdl .wt-cap .from{color:var(--amber)}
.mdl .wt-warn{margin:6px 0 0;font:500 11.5px/1.4 var(--font);color:var(--amber)}
.mdl .wt-msg{margin:0;padding:12px 2px;color:var(--dim);font-size:12.5px;line-height:1.5}
.mdl .wt-mv{aspect-ratio:4/3;min-height:220px;max-height:420px}
.mdl .wt-stage:has(.wt-focus:not([hidden])) .wt-mv .mv-st{bottom:62px}
.mdl .wt-stage .wt-mv .mv-st{bottom:36px}
html[data-fill] .mdl body{height:100%;overflow:hidden}
html[data-fill] .mdl .ap{height:100%;display:flex;flex-direction:column}
html[data-fill] .mdl .tabs{flex:none;align-items:center}
.mdl .tabs .wt-head{flex:0 1 auto;min-width:0;margin:0 0 0 auto;flex-wrap:nowrap}
.mdl .tabs .wt-job{flex:0 1 260px;width:260px}
.mdl .tabs .wt-jobname{flex:0 1 260px;text-align:right}
html[data-fill] .mdl .wt{flex:1 1 0;min-height:0}
.mdl .wt.pg{display:grid;grid-template-columns:minmax(0,1fr) clamp(300px,26%,360px);grid-template-rows:minmax(0,1fr);gap:0 12px}
.mdl .wt-pgm{min-width:0;min-height:0;display:flex;flex-direction:column;justify-content:flex-start;gap:8px}
.mdl .wt-pgc{flex:none;position:static;max-width:none;justify-content:flex-start}
.mdl .wt-pgc .wt-cb{background:var(--surface2);color:var(--text);border-color:var(--border2)}   /* off the stage (page layout): the palette again */
.mdl .wt-pgc .wt-cb:hover:not(:disabled):not(.on){background:var(--surface3)}
.mdl .wt-pgc .wt-cb.on{background:var(--teal)}
.mdl .wt-pgsq{flex:0 1 auto;width:100%;min-height:0;aspect-ratio:2 / 1;display:flex;justify-content:center;align-items:center;gap:8px;container-type:size}
.mdl .wt-pgsq .wt-stage{flex:none;width:min(100cqh,calc((100cqw - 8px) / 2));aspect-ratio:1;border-radius:var(--corner);overflow:hidden}
.mdl .wt-pgsq .wt-pic{position:absolute;inset:0;min-height:0}
.mdl .wt-pgsq .wt-pic img{width:100%;height:100%;object-fit:contain}
.mdl .wt-pgsq .wt-none{padding:0;height:100%;display:grid;place-items:center}
.mdl .wt-pgsq .wt-mv{position:absolute;inset:0;width:100%;height:100%;aspect-ratio:auto;min-height:0;max-height:none}
.mdl .wt-nomodel{border:1px solid var(--border);background:var(--viewer)}
.mdl .wt-ml{position:absolute;top:6px;right:6px;max-width:calc(100% - 76px);padding:2px 8px;border-radius:6px;background:rgba(0,0,0,.62);font:600 11px/1.5 var(--font);color:#fff;text-align:right;pointer-events:none}
.mdl .wt-ml.dim{color:var(--dim)}
.mdl .wt-pgst{min-height:0;display:flex;flex-direction:column;border:1px solid var(--border);border-radius:var(--corner);overflow:hidden}
.mdl .wt-slh{flex:none;display:flex;align-items:baseline;gap:8px;padding:6px 10px;border-bottom:1px solid var(--border);font:700 .6rem var(--display);letter-spacing:.1em;text-transform:uppercase;color:var(--dim2)}
.mdl .wt-slh .r{margin-left:auto;font:500 10.5px var(--mono);letter-spacing:0;text-transform:none;color:var(--dim)}
.mdl .wt-sl{position:relative;flex:1 1 0;min-height:0;overflow-y:auto;overscroll-behavior:contain}
.mdl .wt-sr{display:grid;grid-template-columns:34px minmax(0,1fr) auto;gap:1px 8px;align-items:baseline;width:100%;padding:6px 10px;border:0;border-bottom:1px solid var(--border);border-left:3px solid transparent;background:none;color:var(--text);font:400 12px/1.4 var(--font);text-align:left;cursor:pointer}
.mdl .wt-sr:hover:not(.on){background:var(--surface2)}
.mdl .wt-sr.on{background:var(--surface3);border-left-color:var(--teal)}
.mdl .wt-sr:focus-visible{outline:2px solid var(--teal);outline-offset:-2px}
.mdl .wt-sn{font:500 11px var(--mono);color:var(--dim);text-align:right}
.mdl .wt-sv{display:flex;gap:6px;min-width:0;white-space:nowrap}
.mdl .wt-sv b{flex:none;font-weight:600}
.mdl .wt-sv i{min-width:0;font-style:normal;color:var(--teal);overflow:hidden;text-overflow:ellipsis}
.mdl .wt-st{font:500 10.5px var(--mono);color:var(--dim);white-space:nowrap}
.mdl .wt-so{grid-column:2 / 4;color:var(--dim);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;overflow-wrap:anywhere}
.mdl .wt-sr.on .wt-so{color:var(--text)}
.mdl .wt-pgb{flex:none;min-width:0}
.mdl .wt-pgb .wt-looks{margin-top:0}
.mdl .wt-pgb .wt-ctl{display:grid;grid-template-columns:minmax(160px,1fr) minmax(0,2fr);gap:4px 14px;margin-top:6px}
.mdl .wt-pgb .wt-cap{margin:0;max-height:2.9em;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
@media (pointer:coarse){.mdl .wt-mb,.mdl .wt-vb,.mdl .wt-wb{min-height:34px;padding:0 8px}
.mdl .wt-pt{min-height:34px}
.mdl .wt-pr{min-height:34px}
.mdl .wt-pr input{width:18px;height:18px}
.mdl .wt-sb{min-height:44px;min-width:44px}
.mdl .wt-cb{min-width:34px;height:34px}
.mdl .wt-scrub{height:44px}
.mdl .wt-job{height:44px}}
.mdl .mv{position:relative;width:100%;border-radius:var(--corner);overflow:hidden;background:var(--viewer);border:1px solid var(--border);touch-action:none}
.mdl .mv canvas{display:block;width:100%;height:100%;outline:none}
.mdl .mv .mv-st{position:absolute;left:10px;bottom:8px;right:10px;font:500 11px var(--font);color:var(--dim);pointer-events:none}
.mdl .mv-anim{display:flex;align-items:center;gap:6px}
.mdl .mv-anim[hidden]{display:none}
.mdl .mv>.mv-anim{position:absolute;left:10px;top:10px;right:10px;pointer-events:none}
.mdl .mv>.mv-anim>*{pointer-events:auto}
.mdl .mv-clip{flex:0 1 220px;min-width:0;height:36px;padding:0 8px;border:1px solid var(--border2);border-radius:8px;background:rgba(0,0,0,.55);color:var(--text);font:500 12px var(--font)}
.mdl .mv-play,.mdl .mv-stop{flex:none;width:36px;height:36px;border:0;border-radius:50%;background:rgba(0,0,0,.55);color:var(--coral);font:600 14px var(--font);cursor:pointer;display:grid;place-items:center}
.mdl .mv-stop{color:var(--text)}
.mdl .mv-play:hover,.mdl .mv-stop:hover:not(:disabled){background:rgba(0,0,0,.75)}
.mdl .mv-stop:disabled{opacity:.4;cursor:default}
.mdl .mv-clip:focus-visible,.mdl .mv-play:focus-visible,.mdl .mv-stop:focus-visible{outline:2px solid var(--teal);outline-offset:1px}
.mdl .wt-animhost:not(:empty){margin-top:8px}
.mdl .wt-animhost .mv-clip,.mdl .wt-animhost .mv-play,.mdl .wt-animhost .mv-stop{background:var(--surface2)}
.mdl .wt-animhost .mv-clip{flex:1 1 140px;max-width:260px}
.mdl .mv-thumb{display:grid;place-items:center;background:var(--viewer)}
.mdl .mv-thumb img{display:block;max-width:100%;max-height:100%;object-fit:contain}
@media (pointer:coarse){.mdl .mv-clip{height:44px}.mdl .mv-play,.mdl .mv-stop{width:44px;height:44px}}
`;
