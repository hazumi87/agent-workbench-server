import { useCallback, useEffect, useRef, useState } from 'react';
import { IconArrowDown, IconArrowUp, IconChevronDown, IconClose, IconPower, IconTrash } from '../icons';
import type { Asset } from '../types';

// Image generation tool column — Model → Prompt → Reference images → Settings → Generate,
// the Scenario/Maestro layout. Reference images: drag from the library or paste (Ctrl+V).
// Everything here calls the same API an agent would (north star the design notes).

const API = '/asset-management/tools/image-gen/api';
const LIB = '/asset-management/library';

export interface Recipe {
  model_type?: string; prompt?: string; negative_prompt?: string;
  width?: number; height?: number; seed?: number | null;
  num_inference_steps?: number; guidance_scale?: number; refs?: string[];
}

interface Model { model_type: string; name: string; description?: string; refs?: boolean; defaults?: { num_inference_steps?: number; guidance_scale?: number } }
interface Job { state: string; count: number; assets: Asset[]; createdAt?: number; current?: { index: number; state: string; detail?: string | null; since?: number | null; progress?: { step?: number; total?: number; pct?: number } | null } | null; error?: string | null }

interface SysStats { gpu_util: number | null; vram_used_mb: number | null; vram_total_mb: number | null; cpu_pct: number | null; ram_used_mb: number | null; ram_total_mb: number | null }
const gb = (mb: number | null) => (mb == null ? '—' : (mb / 1024).toFixed(1));
function Gauge({ label, pct, text }: { label: string; pct: number | null; text: string }) {
  const p = pct == null ? 0 : Math.max(0, Math.min(100, pct));
  return (
    <div className="ig-gauge">
      <span className="ig-gauge-l">{label}</span>
      <span className="ig-gauge-bar"><span className={p >= 90 ? 'hot' : p >= 70 ? 'warm' : ''} style={{ width: `${p}%` }} /></span>
      <span className="ig-gauge-v">{text}</span>
    </div>
  );
}

const secs = (from?: number | null) => (from ? Math.max(0, Math.round(Date.now() / 1000 - from)) : null);
const fmtSecs = (s: number | null) => (s == null ? '' : s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`);

const ASPECTS: [string, number][] = [['1:1', 1], ['16:9', 16 / 9], ['9:16', 9 / 16], ['4:3', 4 / 3], ['3:4', 3 / 4], ['3:2', 3 / 2], ['2:3', 2 / 3]];
const LAST_MODEL_KEY = 'imagegen.lastModel';
const FINAL = ['done', 'error', 'cancelled'];
interface QItem { id: string; prompt: string; count: number; model: string; at: number; job: Job }

export interface QueueStatus { active: number; label: string; pct: number | null }
export interface RefRequest { asset: Asset; n: number }   // n: a fresh value per request

interface Props {
  onQueueStatus?: (s: QueueStatus) => void;   // phone tab badge + render bar
  refRequest?: RefRequest | null;              // "Use as reference" from the viewer (touch has no drag)
  ratingsVersion?: number;                     // bumps after a vote, to refresh the recents' score chips
  selectedAssets: Asset[];
  onDeselectSlot: (i: number) => void;
  onGenerated: () => void;
  onViewAsset: (a: Asset, list?: Asset[]) => void;
  recipe: Recipe | null;       // set by "Reload parameters" / "Re-use prompt"
}

export function ImageGenTool({ selectedAssets, onDeselectSlot, onGenerated, onViewAsset, recipe, onQueueStatus, refRequest, ratingsVersion }: Props) {
  const [engine, setEngine] = useState<{ ok: boolean; error?: string; engine?: { state?: string; loaded_model?: string | null; free_vram_mb?: number | null; min_free_mb?: number; gpu_users?: string[]; system?: SysStats } } | null>(null);
  const [models, setModels] = useState<Model[]>([]);
  const [modelsErr, setModelsErr] = useState<string | null>(null);
  const [modelType, setModelType] = useState<string>(() => { try { return localStorage.getItem(LAST_MODEL_KEY) || 'krea2_turbo'; } catch { return 'krea2_turbo'; } });
  const [prompt, setPrompt] = useState('');
  const [negative, setNegative] = useState('');
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const [aspect, setAspect] = useState(1);
  // Auto aspect (): with an edit model, adding a MAIN reference flips Aspect to Auto so
  // the render matches the source image's shape; the server resolves it from the ref's pixel size.
  const [autoAspect, setAutoAspect] = useState(false);
  const recipeMainRef = useRef<string | null>(null);   // a recipe reload keeps its exact size
  const [count, setCount] = useState(1);
  const [seed, setSeed] = useState('');
  const [draft, setDraft] = useState(false);
  const [steps, setSteps] = useState<string>('');
  const [cfg, setCfg] = useState<string>('');
  // The render queue: every Generate appends; newest first. Recents = this model
  // family's latest library images, so the list survives a reload and ignores library filters.
  const [queue, setQueue] = useState<QItem[]>([]);
  const [recents, setRecents] = useState<Asset[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [releasing, setReleasing] = useState(false);
  const [sysOpen, setSysOpen] = useState(false);   // phones show the gauges as one line until tapped
  const shown = useRef<Record<string, number>>({});
  const [refs, setRefs] = useState<Asset[]>([]);
  const [refBusy, setRefBusy] = useState(false);
  const [dragOver, setDragOver] = useState(false);

  const addRef = (a: Asset | null) => a && setRefs(rs => (rs.some(r => r.id === a.id) ? rs : [...rs, a].slice(-2)));
  const fetchAsset = (id: string): Promise<Asset | null> =>
    fetch(`${LIB}/api/assets/${id}`).then(r => (r.ok ? r.json() : null)).catch(() => null);
  // Pasted/dropped files go into the library (transient tier) so the job can reference them by id.
  const uploadRef = async (f: File) => {
    if (!f.type.startsWith('image/')) { setErr(`Not an image: ${f.name || f.type}`); return; }
    setRefBusy(true);
    const fd = new FormData(); fd.append('file', f, f.name || `pasted-${Date.now()}.png`);
    const r = await fetch(`${LIB}/api/assets/upload?dedupe=1`, { method: 'POST', body: fd }).then(x => x.json()).catch(e => ({ error: String(e) }));
    setRefBusy(false);
    if (r?.asset) { addRef(r.asset); if (!r.existing) onGenerated(); } else setErr(`Reference upload failed: ${r?.error || 'unknown'}`);
  };
  // Anything already in the library is referenced by id, never re-uploaded ().
  // Tiles send the id; the preview <img> (and a copied library image) carries its library URL,
  // and desktop Chrome ALSO attaches the pixels as a File — so check the URL before the files.
  const libraryId = (dt: DataTransfer) => dt.getData('application/x-asset-id')
    || (dt.getData('text/uri-list') + ' ' + dt.getData('text/html')).match(/\/asset-management\/library\/api\/assets\/([0-9a-f-]{36})\//)?.[1] || '';
  const onDrop = async (e: React.DragEvent) => {
    e.preventDefault(); setDragOver(false);
    const id = libraryId(e.dataTransfer);
    if (id) return addRef(await fetchAsset(id));
    for (const f of Array.from(e.dataTransfer.files).slice(0, 2)) await uploadRef(f);
  };

  // Engine status is re-checked every 10 s, so closing Maestro (freeing VRAM) or starting the
  // service shows up without a reload. Nothing about the engine may fail silently.
  useEffect(() => {
    // The model list needs the engine. If it was offline when the tool opened, keep retrying on
    // each check until it loads; never fall back silently to a one-model dropdown.
    let haveModels = false;
    const loadModels = () => fetch(`${API}/models`).then(r => r.json())
      .then(j => { if (j.ok && j.models?.length) { haveModels = true; setModels(j.models); setModelsErr(null); } else setModelsErr(j.error || 'no models reported'); })
      .catch(e => setModelsErr(String(e)));
    const check = () => {
      fetch(`${API}/health`).then(r => r.json()).then(setEngine).catch(e => setEngine({ ok: false, error: String(e) }));
      if (!haveModels) loadModels();
    };
    check();
    const t = setInterval(check, 5000);
    return () => clearInterval(t);
  }, []);

  const loadRecents = useCallback(() => {
    fetch(`${LIB}/api/assets?source=krea2&category=image&limit=40`).then(r => r.json())
      .then(j => setRecents(j.assets || [])).catch(() => {});
  }, []);
  useEffect(loadRecents, [loadRecents, ratingsVersion]);

  // Rebuild the queue after a reload (or in another tab): the server runs the jobs, the page
  // only mirrors them.
  useEffect(() => {
    fetch(`${API}/jobs`).then(r => r.json()).then(j => {
      if (!j.ok) return;
      const restored: QItem[] = j.jobs.map((x: Job & { id: string; params?: { prompt?: string }; model_name?: string; model_type?: string }) => ({
        id: x.id, prompt: x.params?.prompt || '', count: x.count, model: x.model_name || x.model_type || '', at: x.createdAt || 0, job: x,
      }));
      for (const q of restored) shown.current[q.id] = q.job.assets?.length || 0;
      setQueue(qs => [...qs, ...restored.filter(r => !qs.some(q => q.id === r.id))].sort((a, b) => b.at - a.at));
    }).catch(() => {});
  }, []);

  // Load a recipe ("Reload parameters" / "Re-use prompt") into the form.
  useEffect(() => {
    if (!recipe) return;
    if (recipe.model_type) setModelType(recipe.model_type);
    setPrompt(recipe.prompt || '');
    setNegative(recipe.negative_prompt || '');
    if (recipe.width && recipe.height) setSize({ width: recipe.width, height: recipe.height });
    setSeed(recipe.seed != null ? String(recipe.seed) : '');
    setSteps(recipe.num_inference_steps != null ? String(recipe.num_inference_steps) : '');
    setCfg(recipe.guidance_scale != null ? String(recipe.guidance_scale) : '');
    setDraft(false);
    setRefs([]);
    setAutoAspect(false);
    recipeMainRef.current = recipe.refs?.[0] ?? null;
    Promise.all((recipe.refs || []).map(fetchAsset)).then(as => setRefs(as.filter((a): a is Asset => !!a)));
  }, [recipe]);

  const mainRefId = refs[0]?.id ?? null;
  useEffect(() => {
    if (!mainRefId) { setAutoAspect(false); return; }
    if (mainRefId === recipeMainRef.current) { recipeMainRef.current = null; return; }   // recipe keeps its size
    setAutoAspect(true); setSize(null);
  }, [mainRefId]);
  const mainDims = (() => {
    const m = refs[0]?.meta as { width?: number; height?: number } | undefined;
    return m && m.width && m.height ? `${m.width}×${m.height}` : '';
  })();

  // Poll every unfinished job; refresh the library + recents as each image lands.
  const active = queue.filter(q => !FINAL.includes(q.job.state)).map(q => q.id).join(',');
  useEffect(() => {
    if (!active) return;
    const t = setInterval(async () => {
      for (const id of active.split(',')) {
        const r = await fetch(`${API}/jobs/${id}`).catch(() => null);
        if (r?.status === 404) {   // the gateway restarted and forgot it -- say so, don't spin forever
          setQueue(qs => qs.map(q => (q.id === id ? { ...q, job: { ...q.job, state: 'error', error: 'Lost: the server restarted while this was queued or running. Images already finished are in Recents.' } } : q)));
          continue;
        }
        const j = await r?.json().catch(() => null);
        if (!j?.ok) continue;
        setQueue(qs => qs.map(q => (q.id === id ? { ...q, job: j.job } : q)));
        if (j.job.assets.length > (shown.current[id] || 0)) { shown.current[id] = j.job.assets.length; onGenerated(); loadRecents(); }
      }
    }, 1500);
    return () => clearInterval(t);
  }, [active, onGenerated, loadRecents]);

  // Summarise the queue for the shell (phone tab badge / render bar).
  useEffect(() => {
    if (!onQueueStatus) return;
    const act = queue.filter(q => !FINAL.includes(q.job.state));
    const run = act.find(q => q.job.current && q.job.current.state !== 'queued') || act[act.length - 1];
    const c = run?.job.current, n = run?.job.count || 1, i = Math.min(c?.index ?? 0, n - 1);
    const step = c?.progress?.total ? (c.progress.step ?? 0) / c.progress.total : 0;
    onQueueStatus({
      active: act.length,
      label: !run ? '' : `${n > 1 ? `${i + 1}/${n} · ` : ''}${c?.progress?.total ? `step ${c.progress.step}/${c.progress.total}` : c?.detail || 'starting'}`,
      pct: run && c?.progress?.total ? Math.round(((i + step) / n) * 100) : null,
    });
  }, [queue, onQueueStatus]);
  useEffect(() => () => onQueueStatus?.({ active: 0, label: '', pct: null }), [onQueueStatus]);

  const model = models.find(m => m.model_type === modelType);

  useEffect(() => {
    if (!refRequest) return;
    addRef(refRequest.asset);
    if (!model?.refs) setErr(`${model?.name || 'This model'} doesn't take reference images. Pick an Edit model to use it.`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refRequest]);
  const eng = engine?.engine;
  const sys = eng?.system;
  // The engine refuses to LOAD without enough free VRAM. Only meaningful while it is idle with
  // nothing loaded: once loading/busy/loaded, the memory in use is OUR model, not a problem.
  const vramShort = !!engine?.ok && eng?.state === 'not-loaded' && !active
    && eng?.free_vram_mb != null && eng.min_free_mb != null && eng.free_vram_mb < eng.min_free_mb;

  const generate = async () => {
    setErr(null);
    try { localStorage.setItem(LAST_MODEL_KEY, modelType); } catch { /* per-viewer convenience only */ }
    const body = {
      model_type: modelType, prompt, negative_prompt: negative, count, draft,
      ...(size ? size : { aspect: autoAspect && model?.refs && refs.length ? 'auto' : aspect }),
      ...(seed.trim() ? { seed: seed.trim() } : {}),
      ...(steps ? { num_inference_steps: +steps } : {}),
      ...(cfg !== '' ? { guidance_scale: +cfg } : {}),
      refs: model?.refs ? refs.map(a => a.id) : [], generated_by: 'user',
    };
    const r = await fetch(`${API}/generate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      .then(r => r.json()).catch(e => ({ ok: false, error: String(e) }));
    if (!r.ok) { setErr(r.error); return; }
    setQueue(qs => [{ id: r.jobId, prompt, count, model: model?.name || modelType, at: Date.now(), job: { state: 'running', count, assets: [] } }, ...qs]);
  };

  const pending = queue.filter(q => !FINAL.includes(q.job.state) || q.job.state === 'error');

  return (
    <div className="vf-workspace ig-workspace" data-testid="image-gen-tool">
      <div className={`ig-engine ${engine == null ? 'wait' : engine.ok && !vramShort ? 'on' : 'off'}`} data-testid="ig-engine">
        {engine == null ? 'Checking engine…'
          : !engine.ok ? 'Engine offline — start asset-platform-krea in harbor'
          : vramShort ? `Not enough GPU memory: ${(eng!.free_vram_mb! / 1024).toFixed(1)} GB free, ${(eng!.min_free_mb! / 1024).toFixed(1)} GB needed. Using the GPU: ${eng!.gpu_users?.length ? eng!.gpu_users.join(', ') : 'unknown (check Maestro / harbor GPU services)'}`
          : eng?.state === 'loading' ? 'Engine starting — loading Krea onto the GPU…'
          : eng?.state === 'busy' ? `Engine working${eng.loaded_model ? ` · ${eng.loaded_model}` : ''}`
          : `Engine ready${eng?.loaded_model ? ` · ${eng.loaded_model} loaded` : ` · no model loaded (first image loads it, ~4 min)${eng?.free_vram_mb != null ? ` · ${(eng.free_vram_mb / 1024).toFixed(1)} GB free` : ''}`}`}
      </div>

      <section className="ig-sec">
        <div className="ig-h">Model</div>
        <select value={modelType} onChange={e => setModelType(e.target.value)} data-testid="ig-model">
          {(models.length ? models : [{ model_type: modelType, name: modelType }]).map(m => (
            <option key={m.model_type} value={m.model_type}>{m.name}{m.refs ? ' · Refs' : ''}</option>
          ))}
        </select>
        {!models.length && <div className="ig-note" data-testid="ig-models-missing">Model list not loaded yet{modelsErr ? ` (${modelsErr})` : ''}; retrying every 5 s. Other models appear once the engine answers.</div>}
        {model?.description && <div className="ig-note">{model.description}</div>}
      </section>

      <section className="ig-sec">
        <div className="ig-h ig-h-row">Prompt
          <button className="ig-clear" title="Clear the prompt and negative prompt" aria-label="Clear prompt" data-testid="ig-clear-prompt"
            disabled={!prompt && !negative} onClick={() => { setPrompt(''); setNegative(''); }}><IconTrash /></button>
        </div>
        <textarea rows={6} value={prompt} onChange={e => setPrompt(e.target.value)} placeholder="Describe the image…" data-testid="ig-prompt" />
        <textarea rows={2} value={negative} onChange={e => setNegative(e.target.value)} placeholder="Negative prompt (optional)" className="ig-neg" />
      </section>

      {/* Reference images arrive with an edit model (later slice); Krea 2 Turbo is text-to-image. */}
      {model?.refs && <section className="ig-sec">
        <div className="ig-h ig-h-row">Reference images <span className="ig-dim">{refs.length}/2 · first = main subject</span>
          <button className="ig-clear" title="Remove all reference images (they stay in the library)" aria-label="Clear reference images" data-testid="ig-clear-refs"
            disabled={!refs.length} onClick={() => setRefs([])}><IconTrash /></button>
        </div>
        <div className={`ig-drop${dragOver ? ' over' : ''}`} tabIndex={0} data-testid="ig-drop"
          onDragOver={e => { e.preventDefault(); setDragOver(true); }} onDragLeave={() => setDragOver(false)} onDrop={onDrop}
          onPaste={async e => { const id = libraryId(e.clipboardData); const f = Array.from(e.clipboardData.files).find(x => x.type.startsWith('image/')); if (id || f) e.preventDefault(); if (id) addRef(await fetchAsset(id)); else if (f) uploadRef(f); }}>
          {refs.length === 0 && <span>{refBusy ? 'Uploading…' : 'Drag an image here from the library, paste (Ctrl+V), or use "Use as reference" in the preview'}</span>}
          {refs.map((a, i) => (
            <div key={a.id} className="ig-ref" title={a.label || ''}>
              <img src={`${LIB}/api/assets/${a.id}/thumb`} alt="" />
              <span className="ig-ref-tag">{i === 0 ? 'Main' : 'Inject'}</span>
              <button className="slot-remove" onClick={() => setRefs(rs => rs.filter(r => r.id !== a.id))} title="Remove" aria-label="Remove reference"><IconClose /></button>
            </div>
          ))}
          {refs.length > 0 && refBusy && <span>Uploading…</span>}
        </div>
      </section>}

      <section className="ig-sec">
        <div className="ig-h">Settings</div>
        <div className="vf-param-row">
          <label>Aspect</label>
          <select data-testid="ig-aspect" value={autoAspect && model?.refs && refs.length ? 'auto' : size ? 'custom' : String(aspect)}
            onChange={e => {
              const v = e.target.value;
              if (v === 'auto') { setAutoAspect(true); setSize(null); }
              else if (v !== 'custom') { setAutoAspect(false); setSize(null); setAspect(+v); }
            }}>
            {model?.refs && refs.length > 0 && <option value="auto">Auto · match main{mainDims ? ` (${mainDims})` : ''}</option>}
            {size && <option value="custom">{size.width}×{size.height}</option>}
            {ASPECTS.map(([l, r]) => <option key={l} value={String(r)}>{l}</option>)}
          </select>
        </div>
        <div className="vf-param-row"><label>Images</label><input type="number" min={1} max={16} value={count} onChange={e => setCount(Math.max(1, Math.min(16, +e.target.value || 1)))} data-testid="ig-count" /></div>
        <div className="vf-param-row"><label>Seed (blank = random)</label>
          <span className="ig-input-x"><input type="number" value={seed} onChange={e => setSeed(e.target.value)} data-testid="ig-seed" />
            {seed !== '' && <button title="Clear seed (random)" aria-label="Clear seed" data-testid="ig-clear-seed" onClick={() => setSeed('')}><IconClose /></button>}</span></div>
        <div className="vf-param-row"><label>Steps</label><input type="number" min={1} max={60} value={steps} placeholder={String(model?.defaults?.num_inference_steps ?? '')} onChange={e => setSteps(e.target.value)} /></div>
        <div className="vf-param-row"><label>Guidance</label><input type="number" step={0.5} min={0} max={20} value={cfg} placeholder={String(model?.defaults?.guidance_scale ?? '')} onChange={e => setCfg(e.target.value)} /></div>
        <label className="ig-check"><input type="checkbox" checked={draft} onChange={e => setDraft(e.target.checked)} /> Draft (half size, faster)</label>
      </section>

      <div className="ig-actions">
        <button className="submit-btn" disabled={!prompt.trim() || !engine?.ok || vramShort} onClick={generate} data-testid="ig-generate">
          {active ? 'Add to queue' : 'Generate'}{count > 1 ? ` ${count}` : ''}</button>
      </div>
      {err && <div className="vf-status vf-status-error">{err}</div>}

      <div className="ig-queue" data-testid="ig-queue">
        {pending.length > 0 && <div className="ig-list-h">Queue <span className="ig-dim">{pending.length}</span></div>}
        {pending.map((q, n, arr) => {
          const j = q.job, c = j.current;
          const queuedAhead = arr.length - 1 - n;
          const kind = j.state === 'error' ? 'err' : c?.state === 'queued' || (!c && queuedAhead > 0) ? 'wait' : 'run';
          const status = kind === 'err' ? `Failed: ${j.error}`
            : kind === 'wait' ? 'Queued'
            : `${j.count > 1 ? `${Math.min((c?.index ?? 0) + 1, j.count)}/${j.count} · ` : ''}${c?.progress?.total ? `step ${c.progress.step}/${c.progress.total}` : c?.detail || c?.state || 'starting'}${c?.since ? ` · ${fmtSecs(secs(c.since))}` : ''}`;
          const pct = kind === 'run' && c?.progress?.total ? (100 * (c.progress.step ?? 0)) / c.progress.total : null;
          return (
            <div key={q.id} className={`ig-card ${kind}`} title={q.prompt} data-testid={`ig-card-${kind}`}>
              <div className="ig-card-thumb">{kind === 'run' ? <span className="ig-spin" /> : kind === 'wait' ? <span className="ig-wait" /> : <span className="ig-bang">!</span>}</div>
              <div className="ig-card-text"><div className="ig-card-prompt">{q.prompt}</div><div className="ig-card-status">{status}</div></div>
              {kind === 'err'
                ? <button className="ig-card-x" title="Dismiss" aria-label="Dismiss" onClick={() => { setQueue(qs => qs.filter(x => x.id !== q.id)); fetch(`${API}/jobs/${q.id}`, { method: 'DELETE' }).catch(() => {}); }}><IconClose /></button>
                : <button className="ig-card-x" title="Cancel this job" aria-label="Cancel this job" onClick={() => fetch(`${API}/jobs/${q.id}/cancel`, { method: 'POST' })}><IconClose /></button>}
              {pct != null && <span className="ig-card-prog" style={{ width: `${pct}%` }} />}
            </div>
          );
        })}
        {recents.length > 0 && <div className="ig-list-h">Recents</div>}
        {recents.map(a => {
          const r = (a.derived_op || {}) as { params?: { width?: number; height?: number } };
          return (
            <div key={a.id} className="ig-card done" onClick={() => onViewAsset(a, recents)} title={a.label || ''}>
              <div className="ig-card-thumb"><img src={`${LIB}/api/assets/${a.id}/thumb`} alt="" loading="lazy" /></div>
              <div className="ig-card-text"><div className="ig-card-prompt">{a.label}</div>
                <div className="ig-card-status">{new Date(a.created_at || 0).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}{r.params?.width ? ` · ${r.params.width}×${r.params.height}` : ''}</div></div>
              {!!a.score && <span className={`ig-card-score${a.score < 0 ? ' neg' : ''}`} data-testid="ig-card-score">{a.score > 0 ? <IconArrowUp /> : <IconArrowDown />} {Math.abs(a.score)}</span>}
            </div>
          );
        })}
      </div>

      <div className={`ig-system${sysOpen ? ' open' : ''}`} data-testid="ig-system">
        <button className="ig-system-sum" onClick={() => setSysOpen(o => !o)} aria-expanded={sysOpen} data-testid="ig-system-sum">
          <span className="ig-list-h">System</span>
          <span className="ig-system-sum-v">{sys ? `GPU ${sys.gpu_util ?? '—'}% · VRAM ${gb(sys.vram_used_mb)}/${gb(sys.vram_total_mb)} GB` : engine && !engine.ok ? 'engine offline' : '—'}</span>
          <span className={`ig-dot ${eng?.loaded_model ? 'on' : ''}`} />
          <IconChevronDown className={sysOpen ? 'chev' : 'chev up'} />
        </button>
        <div className="ig-list-h ig-system-title">System</div>
        {sys ? <>
          <Gauge label="GPU" pct={sys.gpu_util} text={sys.gpu_util != null ? `${sys.gpu_util}%` : '—'} />
          <Gauge label="VRAM" pct={sys.vram_total_mb ? (100 * sys.vram_used_mb!) / sys.vram_total_mb : null} text={sys.vram_total_mb ? `${gb(sys.vram_used_mb)} / ${gb(sys.vram_total_mb)} GB` : '—'} />
          <Gauge label="CPU" pct={sys.cpu_pct} text={sys.cpu_pct != null ? `${Math.round(sys.cpu_pct)}%` : '—'} />
          <Gauge label="RAM" pct={sys.ram_total_mb ? (100 * sys.ram_used_mb!) / sys.ram_total_mb : null} text={sys.ram_total_mb ? `${gb(sys.ram_used_mb)} / ${gb(sys.ram_total_mb)} GB` : '—'} />
        </> : <div className="ig-dim">{engine && !engine.ok ? 'engine offline' : 'no data'}</div>}
        <div className="ig-system-foot">
          <span className={`ig-dot ${eng?.loaded_model ? 'on' : ''}`} />{eng?.loaded_model || 'No model loaded'}
          {eng?.loaded_model && <button className="ig-power" title="Unload the model (frees GPU memory)" aria-label="Unload model" disabled={releasing || !!active}
            onClick={async () => { setReleasing(true); const r = await fetch(`${API}/release`, { method: 'POST' }).then(x => x.json()).catch(e => ({ ok: false, error: String(e) })); setReleasing(false); if (!r.ok) setErr(`Unload failed: ${r.error}`); }}><IconPower /></button>}
        </div>
      </div>
    </div>
  );
}
