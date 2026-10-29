// Model Studio as a Library full-page app (task; Aurora model-studio-fullpage-v1, on the
// fullpage-apps v1.2 §3 frame). ?app=model-studio[&edit=<source id>] over the still-mounted
// Library; ← = leaveApp(); "Change source…" = pickAsset() with the source's kind preset, and a
// REPLACE of the history entry. User-driven: source → operation → parameters → Run → jobs → result.
// Laid out by the app's own width (container queries in model-studio.css), never by vh.
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Asset } from '../types';
import type { StageInfo } from '../components/MeshViewer';
import { pickAsset } from '../picker/AssetPicker';
import { leaveApp, pushRecent, readRecents, replaceApp, type AppRoute } from '../shell/appRoute';
import { IconBack, IconCube, IconSearch } from '../icons';
import { CoreDown, LIB, fetchOps, fmtEst, getAsset, gpuGb, isActive, isEvalOnly, loadHistory, nameOf, noteLabels, opKey, providerName,
  setCoreState, sortOps, startRun, stateOf, useJobs, type InputDecl, type Op } from './api';
import { ParamsForm, defaultsOf, rawProblem, validate, type Draft } from './ParamsForm';
import { JobsPanel, type ShowResult } from './Jobs';
import './model-studio.css';

const MeshViewer = lazy(() => import('../components/MeshViewer'));
const VIEWABLE = ['glb', 'gltf', 'fbx', 'obj', 'stl', 'ply'];
const KINDS = ['mesh', 'image'];
const ROLES = ['front', 'back', 'left', 'right'] as const;
type Role = typeof ROLES[number];
const OPS_REFRESH_MS = 30000;

const fmtOf = (a: Asset) => (a.format || a.filename?.split('.').pop() || '').toLowerCase();
const fmtBytes = (n?: number | null) => (n == null ? '' : n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1e3))} KB`);
/** An output chip's word: GLB · meshopt · FBX · preview. */
const outWord = (a: Asset) => a.category === 'image' ? 'preview' : /meshopt/i.test(`${a.filename} ${a.label}`) ? 'meshopt' : fmtOf(a).toUpperCase() || a.category;
/** The result to show first: the meshopt GLB (small, web-ready), then any GLB, then anything viewable. */
function preferred(list: Asset[]): Asset | undefined {
  const rank = (a: Asset) => a.category !== 'mesh' || !VIEWABLE.includes(fmtOf(a)) ? 9 : outWord(a) === 'meshopt' ? 0 : ['glb', 'gltf'].includes(fmtOf(a)) ? 1 : 2;
  return [...list].sort((a, b) => rank(a) - rank(b))[0];
}

function arity(d: InputDecl): [number, number] {
  const m = String(d.arity ?? '1').match(/^(\d+)(?:\.\.(\d+|n))?$/);
  if (!m) return [1, 1];
  return [Number(m[1]), m[2] === undefined ? Number(m[1]) : m[2] === 'n' ? Infinity : Number(m[2])];
}

/** The op's inputs from the source (mesh) or the four role slots (images), or why Run can't go. */
function inputsFor(op: Op, source: Asset, roles: Partial<Record<Role, Asset>>): { inputs: Record<string, string>; problem: string | null } {
  const inputs: Record<string, string> = {};
  let used = false;
  for (const d of op.inputs) {
    const name = d.name ?? d.category ?? '';
    const required = d.required !== false;
    if (d.kind !== 'asset') { if (required) return { inputs, problem: `This operation needs a "${name}" text input, which this app can't give yet.` }; continue; }
    const [min] = arity(d);
    const id: string | undefined = source.category === 'image' && (ROLES as readonly string[]).includes(name)
      ? (name === 'front' ? source.id : roles[name as Role]?.id)
      : !used && d.category === source.category && min <= 1 ? source.id : undefined;
    if (id) { inputs[name] = id; used = used || id === source.id; continue; }
    if (required) return { inputs, problem: (ROLES as readonly string[]).includes(name) ? `Add the ${name} view.` : `This operation takes ${d.arity ?? 1} ${d.category ?? 'asset'}s; pick it from a room for now.` };
  }
  return { inputs, problem: null };
}

export default function ModelStudioApp({ route, onOpenAsset }: { route: AppRoute; onOpenAsset: (id: string) => void }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const jobsRef = useRef<HTMLElement>(null);
  const [source, setSource] = useState<Asset | null | 'missing'>(null);
  const [roles, setRoles] = useState<Partial<Record<Role, Asset>>>({});
  const [ops, setOps] = useState<Op[] | null>(null);
  const [opsErr, setOpsErr] = useState<'down' | string | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft>({});
  const [raw, setRaw] = useState('');
  const [busy, setBusy] = useState(false);
  const [runErr, setRunErr] = useState<string | null>(null);
  const [tab, setTab] = useState<'setup' | 'jobs'>('setup');
  const [result, setResult] = useState<{ jobId: string; assets: Asset[]; shown: string } | null>(null);
  const [view, setView] = useState<'source' | 'result'>('source');
  const [info, setInfo] = useState<StageInfo | null>(null);
  const [morphVals, setMorphVals] = useState<Record<string, number>>({});
  const [srcTris, setSrcTris] = useState<number | null>(null);
  const jobs = useJobs();
  const active = jobs.tracked.filter(t => isActive(stateOf(t))).length;

  const src = source && source !== 'missing' ? source : null;
  const kind = src && KINDS.includes(src.category) ? src.category : null;

  // ── source (the route's &edit=) ──
  useEffect(() => {
    setResult(null); setView('source'); setSrcTris(null); setRunErr(null);
    if (!route.edit) { setSource(null); return; }
    let dead = false;
    getAsset(route.edit).then(a => {
      if (dead) return;
      setSource(a || 'missing');
      if (a) { pushRecent(a); document.title = `Model Studio · ${nameOf(a)} — Asset Library`; }
      if (a?.category !== 'image') setRoles({});
    });
    return () => { dead = true; };
  }, [route.edit]);
  useEffect(() => {
    const prev = document.title;
    document.title = 'Model Studio — Asset Library';
    loadHistory();
    return () => { document.title = prev; };
  }, []);
  useEffect(() => {
    rootRef.current?.querySelector<HTMLElement>(route.edit ? '[data-testid="ms-back"]' : '[data-testid="ms-choose"]')?.focus();
  }, [route.edit]);

  // ── operations for the source's category, re-read every 30 s (availability changes) ──
  const loadOps = useCallback(() => {
    if (!kind) return;
    fetchOps(kind).then(list => { setOps(sortOps(list)); setOpsErr(null); noteLabels(list); setCoreState('up'); })
      .catch(e => { setOps(null); setOpsErr(e instanceof CoreDown ? 'down' : e.message); if (e instanceof CoreDown) setCoreState('down'); });
  }, [kind]);
  useEffect(() => {
    setOps(null); setOpsErr(null);
    loadOps();
    const t = setInterval(loadOps, OPS_REFRESH_MS);
    return () => clearInterval(t);
  }, [loadOps]);
  const op = ops?.find(o => opKey(o) === sel) ?? null;
  // Keep the choice while it exists and isn't offline; otherwise the first selectable row.
  useEffect(() => {
    if (!ops) return;
    if (op && op.availability !== 'offline') return;
    const first = ops.find(o => o.availability !== 'offline');
    setSel(first ? opKey(first) : null);
  }, [ops]);   // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    setDraft(defaultsOf(op?.params ?? null));
    setRaw(op?.params_unrenderable ? JSON.stringify(Object.fromEntries(Object.entries(op.params?.properties || {}).filter(([, s]) => s && typeof s === 'object' && 'default' in s).map(([k, s]) => [k, s.default])), null, 2) : '');
    setRunErr(null);
  }, [sel]);   // eslint-disable-line react-hooks/exhaustive-deps

  // ── validation → the Run bar ──
  const checked = useMemo(() => (op && !op.params_unrenderable ? validate(op.params, draft) : { params: {}, errors: {} }), [op, draft]);
  const rawErr = op?.params_unrenderable ? rawProblem(raw) : null;
  const invalid = Object.keys(checked.errors).length > 0 || !!rawErr;
  const need = op && src ? inputsFor(op, src, roles) : null;

  const narrow = () => (rootRef.current?.clientWidth ?? 1000) < 640;
  const run = async () => {
    if (!op || !need || need.problem || invalid) return;
    setBusy(true); setRunErr(null);
    try {
      const params = op.params_unrenderable ? (raw.trim() ? JSON.parse(raw) : {}) : checked.params;
      await startRun({ provider: op.provider, id: op.id, inputs: need.inputs, params });
      if (narrow()) setTab('jobs');
    } catch (e) {
      setRunErr((e as Error).message);
      if (e instanceof CoreDown) { setCoreState('down'); setOpsErr('down'); }
    } finally { setBusy(false); }
  };

  // ── source / role picking ──
  const choose = (opener?: HTMLElement) => {
    const accept = kind === 'image' ? ['image', 'mesh'] : ['mesh', 'image'];   // the preset follows the source kind
    pickAsset({ accept, title: 'Choose a source…', opener }).then(a => { if (a) replaceApp(a.id); });
  };
  const pickRole = (role: Role, opener: HTMLElement) => pickAsset({ accept: ['image'], title: `Choose the ${role} view…`, opener }).then(a => {
    if (!a) return;
    if (role === 'front') replaceApp(a.id); else setRoles(r => ({ ...r, [role]: a }));
  });

  // ── result ──
  const showResult = async (r: ShowResult) => {
    const assets = (await Promise.all(r.assetIds.map(getAsset))).filter((a): a is Asset => !!a);
    const first = preferred(assets);
    if (!first) return;
    setResult({ jobId: r.jobId, assets, shown: first.id });
    setView('result');
  };
  const viewed = view === 'result' && result ? result.assets.find(a => a.id === result.shown) ?? null : src;
  useEffect(() => { setInfo(null); setMorphVals({}); }, [viewed?.id]);
  const onInfo = useCallback((i: StageInfo) => {
    setInfo(i);
    if (i && view === 'source') setSrcTris(i.tris);
  }, [view]);
  const setMorph = (k: string, v: number) => { setMorphVals(m => ({ ...m, [k]: v })); info?.setMorph(k, v); };

  const jumpToJobs = () => {
    if (narrow()) setTab('jobs');
    requestAnimationFrame(() => jobsRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }));
  };

  // ── the frame ──
  const header = (
    <header className="ms-hdr">
      <button className="ms-back" onClick={leaveApp} data-testid="ms-back" aria-label="Back to the Library"><IconBack /><span className="ms-back-lbl">Library</span></button>
      <span className="ms-ttl">Model Studio{src && <span> · {nameOf(src)}</span>}</span>
      <span className="sp" />
      {active > 0 && <button className="ms-jobsdot" onClick={jumpToJobs} data-testid="ms-jobsdot" title="Show the jobs"><i />{active} running</button>}
      {src && <button className="ms-btn ms-hdr-change" onClick={e => choose(e.currentTarget)} data-testid="ms-change">Change source…</button>}
    </header>
  );

  if (!src || !kind) {
    const recents = readRecents().filter(r => KINDS.includes(r.category)).slice(0, 3);
    const loading = route.edit && source === null;
    return (
      <div className="fp-app" data-testid="fp-app" ref={rootRef}>
        <div className="ms-app">
          {header}
          <div className="fp-empty">
            {!loading && (
              <div className="fp-empty-box">
                <IconCube style={{ fontSize: 30 }} />
                <h4>{source === 'missing' ? "That asset isn't in the Library" : src ? 'Model Studio works on meshes and images' : 'Choose a source'}</h4>
                <p>A mesh to rig, decimate or convert, or images (front, back, left, right) to turn into a mesh. Results land in the Library.</p>
                <button className="fp-btn teal" onClick={e => choose(e.currentTarget)} data-testid="ms-choose"><IconSearch style={{ fontSize: 15 }} />Choose a source…</button>
                {recents.length > 0 && (
                  <div className="fp-recents">
                    {recents.map(r => <button key={r.id} className="fp-chip" onClick={() => replaceApp(r.id)}>{r.label || r.filename || r.id.slice(0, 8)}</button>)}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  const selectable = (ops || []).filter(o => o.availability !== 'offline');
  const onOpsKey = (e: React.KeyboardEvent) => {
    if (!['ArrowDown', 'ArrowUp', 'ArrowRight', 'ArrowLeft'].includes(e.key) || !selectable.length) return;
    e.preventDefault();
    const i = selectable.findIndex(o => opKey(o) === sel);
    const next = selectable[(i + (e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1 : -1) + selectable.length) % selectable.length];
    setSel(opKey(next));
    requestAnimationFrame(() => rootRef.current?.querySelector<HTMLElement>(`[data-op="${opKey(next)}"]`)?.focus());
  };

  // Run bar: teal = go; waiting-gpu = a teal outline (accepted, not yet running); offline = disabled + the Harbor hint.
  const evalOnly = !!op && isEvalOnly(op.license);
  const est = op ? fmtEst(op.est) : null;
  let runLabel = 'Choose an operation', runNote: string = opsErr === 'down' ? "Model Studio isn't running yet" : '', outline = false;
  if (op) {
    runLabel = `Run · ${op.label}${est ? ` · ${est}` : ''}`;
    if (op.availability === 'offline') runNote = `${providerName(op.provider)} isn't running · start it in Harbor`;
    else if (op.availability === 'waiting-gpu') { runLabel = 'Queue · waits for the GPU'; outline = true; runNote = `${op.provider} · ${gpuGb(op.gpu_need_mb)} · starts when the GPU is free`; }
    else runNote = `${op.provider} · ${op.gpu_need_mb > 0 ? gpuGb(op.gpu_need_mb) : 'CPU'} · the result lands in the Library`;
    if (op.availability !== 'offline' && need?.problem) runNote = need.problem;
    else if (op.availability !== 'offline' && invalid) runNote = 'Fix the highlighted parameters first';
  }
  if (busy) runLabel = 'Starting…';
  const canRun = !!op && op.availability !== 'offline' && !need?.problem && !invalid && !busy;

  const showingResult = view === 'result' && !!result;
  const morphs = info?.morphs ?? [];
  const keys = (where: string) => morphs.length > 0 && <ShapeKeys where={where} morphs={morphs} vals={morphVals} onVal={setMorph} />;
  const viewedFmt = viewed ? fmtOf(viewed) : '';

  return (
    <div className="fp-app" data-testid="fp-app" ref={rootRef}>
      <div className="ms-app" data-testid="model-studio">
        {header}
        <div className="ms-body" data-tab={tab}>
          <section className="ms-setup" aria-label="Setup">
            <div className="ms-scroll">
              <div className="ms-lbl">Source</div>
              {kind === 'image' ? (
                <div className="ms-roles" data-testid="ms-roles">
                  {ROLES.map(r => {
                    const a = r === 'front' ? src : roles[r];
                    return (
                      <div key={r} className="ms-role-wrap">
                        <button className={`ms-role${a ? ' set' : ''}`} onClick={e => pickRole(r, e.currentTarget)} data-testid={`ms-role-${r}`}
                          aria-label={a ? `${r} view: ${nameOf(a)} (change)` : `Add the ${r} view${r === 'front' ? ' (required)' : ''}`}>
                          {a && <img src={`${LIB}/api/assets/${a.id}/thumb`} alt="" draggable={false} />}
                          <span>{r}{r === 'front' && !a ? ' *' : ''}</span>
                        </button>
                        {a && r !== 'front' && <button className="ms-role-x" aria-label={`Clear the ${r} view`} onClick={() => setRoles(x => ({ ...x, [r]: undefined }))}>✕</button>}
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div className="ms-src">
                  <span className="th"><img src={`${LIB}/api/assets/${src.id}/thumb`} alt="" draggable={false} onError={e => { e.currentTarget.style.display = 'none'; }} />3D</span>
                  <div className="nfo"><div className="nm">{nameOf(src)}</div>
                    <div className="mt">{[fmtOf(src) || 'mesh', srcTris != null && `${srcTris.toLocaleString()} tris`, fmtBytes(src.bytes)].filter(Boolean).join(' · ')}</div></div>
                  <button className="ms-btn" onClick={e => choose(e.currentTarget)}>Change…</button>
                </div>
              )}

              <div className="ms-lbl">Operation<span className="sp" /><span className="ms-lbl-note">{ops ? `${kind} · ${ops.length}` : ''}</span></div>
              {opsErr === 'down' ? (
                <div className="ms-down" data-testid="ms-core-down">
                  <b>Model Studio isn't running yet</b>
                  <p>Its service hasn't been loaded on the server, so there are no operations to offer. Nothing is lost; try again in a while.</p>
                  <button className="ms-btn" onClick={loadOps}>Try again</button>
                </div>
              ) : opsErr ? <div className="ms-err-box">{opsErr}</div>
                : !ops ? <p className="ms-quiet">Loading operations…</p>
                : !ops.length ? <p className="ms-quiet">No operation takes {kind === 'image' ? 'images' : 'a mesh'} yet.</p>
                : (
                  <div className="ms-ops" role="radiogroup" aria-label="Operation" onKeyDown={onOpsKey} data-testid="ms-ops">
                    {ops.map(o => {
                      const k = opKey(o), on = k === sel, off = o.availability === 'offline';
                      const e = fmtEst(o.est);
                      return (
                        <button key={k} data-op={k} className={`ms-op ${o.availability}`} role="radio" aria-checked={on} aria-disabled={off || undefined}
                          tabIndex={on || (!sel && o === selectable[0]) ? 0 : -1} onClick={() => { if (!off) setSel(k); }}>
                          <span className="l">{o.label}</span><span className="pv">{o.provider}</span>
                          <span className="meta">{e}{o.gpu_need_mb > 0 && <span className="ms-badge gpu">{gpuGb(o.gpu_need_mb)}</span>}
                            {isEvalOnly(o.license) && <span className="ms-badge eval">Evaluation only</span>}</span>
                          {o.availability === 'waiting-gpu' && <span className="avail"><i />Waits for the GPU (in use)</span>}
                          {off && <span className="avail"><i />{providerName(o.provider)} isn't running · start it in Harbor</span>}
                        </button>
                      );
                    })}
                  </div>
                )}

              {op && (op.params_unrenderable ? (
                <>
                  <div className="ms-lbl">Parameters<span className="sp" /><span className="ms-badge gpu">Raw JSON</span></div>
                  <div className={`ms-fld${rawErr ? ' bad' : ''}`}>
                    <label htmlFor="ms-raw">This operation's options can't be shown as a form</label>
                    <textarea id="ms-raw" className="ms-in ms-raw" rows={6} spellCheck={false} value={raw} onChange={e => setRaw(e.target.value)} data-testid="ms-raw" />
                    {rawErr ? <div className="ms-err" role="alert">{rawErr}</div> : op.params_problem && <div className="ms-hint">{op.params_problem}</div>}
                  </div>
                </>
              ) : Object.keys(op.params?.properties || {}).length > 0 ? (
                <>
                  <div className="ms-lbl">Parameters<span className="sp" /><button className="ms-link" onClick={() => setDraft(defaultsOf(op.params))} data-testid="ms-reset">Reset to defaults</button></div>
                  <ParamsForm schema={op.params!} draft={draft} onDraft={setDraft} errors={checked.errors} />
                </>
              ) : <><div className="ms-lbl">Parameters</div><p className="ms-quiet">This operation has no options.</p></>)}
            </div>

            <div className="ms-runbar" data-testid="ms-runbar">
              <button className={`ms-btn ${outline ? 'out' : 'teal'}`} disabled={!canRun} onClick={run} data-testid="ms-run">{runLabel}</button>
              <small>{runNote}{evalOnly && <span className="ms-badge eval">Evaluation only</span>}</small>
              {runErr && <div className="ms-err" role="alert" data-testid="ms-run-err">{runErr}</div>}
            </div>
          </section>

          <section className="ms-view" aria-label="Viewer">
            {result && <div className="ms-vhead">
              {(
                <div className="ms-seg ms-vseg" role="group" aria-label="Show">
                  <button aria-pressed={view === 'source'} onClick={() => setView('source')} data-testid="ms-view-source">Source</button>
                  <button aria-pressed={view === 'result'} onClick={() => setView('result')} data-testid="ms-view-result">Result</button>
                </div>
              )}
              <span className="sp" />
              {showingResult && <button className="ms-btn ms-wide-only" onClick={() => onOpenAsset(result!.shown)} data-testid="ms-show-lib">Show in Library</button>}
            </div>}
            <div className="ms-vwrap" data-testid="ms-viewer">
              {viewed && viewed.category === 'mesh' && VIEWABLE.includes(viewedFmt) ? (
                <Suspense fallback={<div className="mesh-stage-msg">Loading the viewer…</div>}>
                  <MeshViewer key={viewed.id} asset={viewed} stage={{ onInfo }} />
                </Suspense>
              ) : viewed && viewed.category === 'image' ? (
                <img className="ms-vimg" src={`${LIB}/api/assets/${viewed.id}/file`} alt={nameOf(viewed)} />
              ) : <div className="mesh-stage-msg">No 3D preview for {viewedFmt ? `.${viewedFmt}` : 'this file'}. Show it in the Library to download it.</div>}
              {info && <span className="ms-cap" data-testid="ms-cap">{info.tris.toLocaleString()} tris{info.clip ? ` · ${info.clip} ▸` : ''}</span>}
              {keys('in')}
            </div>
            {(showingResult || morphs.length > 0) && (
              <div className="ms-outs" data-testid="ms-outs">
                {showingResult && <>Outputs {result!.assets.map(a => (
                  <button key={a.id} className="o" aria-pressed={a.id === result!.shown} title={nameOf(a)} onClick={() => setResult({ ...result!, shown: a.id })}>{outWord(a)}</button>
                ))}</>}
                <span className="sp" />
                {keys('out')}
                {showingResult && <button className="ms-btn ms-phone-only" onClick={() => onOpenAsset(result!.shown)}>Show in Library</button>}
              </div>
            )}
          </section>

          <div className="ms-tabs" role="tablist" aria-label="Panels">
            <button role="tab" aria-selected={tab === 'setup'} onClick={() => setTab('setup')} data-testid="ms-tab-setup">Setup</button>
            <button role="tab" aria-selected={tab === 'jobs'} onClick={() => setTab('jobs')} data-testid="ms-tab-jobs">Jobs{active ? ` ${active}` : ''}</button>
          </div>

          <section className="ms-jobs" aria-label="Jobs" ref={jobsRef} data-testid="ms-jobs">
            <JobsPanel onShowResult={showResult} shown={showingResult ? result!.jobId : null} />
          </section>
        </div>
      </div>
    </div>
  );
}

// "Shape keys (n)": a ghost button opening a small popover of 0–1 sliders. Rendered twice (in the
// viewer, and in the outputs row); CSS shows the viewer one ≥ 640 px and the outputs one below.
function ShapeKeys({ where, morphs, vals, onVal }: { where: string; morphs: string[]; vals: Record<string, number>; onVal: (k: string, v: number) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('pointerdown', away);
    return () => document.removeEventListener('pointerdown', away);
  }, [open]);
  return (
    <div className={`ms-keys ${where}`} ref={ref} onKeyDown={e => { if (e.key === 'Escape') setOpen(false); }}>
      <button className="ms-btn" aria-expanded={open} onClick={() => setOpen(!open)} data-testid={`ms-keys-${where}`}>Shape keys ({morphs.length})</button>
      {open && (
        <div className="ms-keys-pop" role="dialog" aria-label="Shape keys">
          {morphs.map(k => (
            <label key={k}><span>{k}</span>
              <input type="range" min={0} max={1} step={0.01} value={vals[k] ?? 0} onChange={e => onVal(k, Number(e.target.value))} />
              <span className="v">{(vals[k] ?? 0).toFixed(2)}</span></label>
          ))}
        </div>
      )}
    </div>
  );
}
