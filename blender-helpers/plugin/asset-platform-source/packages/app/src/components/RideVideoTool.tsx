// Ride Video tool — task. Turns a library video clip into a derived "ride video"
// (normalized 720p30 mp4 + motion profile + overlay children) via the ride-video
// tool backend (POST /process → poll jobs/:id). UI = three aurora patterns:
//   1. trim scrubber (the design notes) — pick in/out with live frame preview
//   2. two-level job progress + rolling ETA (the design notes)
//   3. results list of existing ride-videos with stats + tool-owned cascade delete
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Asset } from '../types';

const LIB_BASE = '/asset-management/library';
const TOOL_BASE = '/asset-management/tools/ride-video';
const FPS = 30;
const FRAME = 1 / FPS;
const POLL_MS = 2000;

interface Props {
  selectedAssets: Asset[];
  onDeselectSlot: (index: number) => void;
  onProcessDone: (source: Asset, output: Asset | null) => void;
}

interface JobStatus {
  jobId: string;
  state: 'estimate' | 'queued' | 'downloading' | 'normalizing' | 'profiling' | 'registering' | 'done' | 'error';
  step?: number;
  step_total?: number;
  step_pct?: number;
  overall_pct?: number;
  eta_s?: number | null;
  detail?: string;
  error?: string;
  result?: { ride_video: Asset; profile: Asset; overlay: Asset | null };
}

interface RideVideoMeta {
  stats?: { baseline_raw?: number; valid_fraction?: number; segments?: number | unknown[] };
  duration_s?: number | null;
  video?: { width?: number; height?: number; fps?: number; frames?: number };
  profile_ref?: string;
  overlay_ref?: string | null;
}

function assetLabel(a: Asset) {
  return a.label || a.filename || 'asset ' + a.id.slice(0, 8);
}

function parseMeta(a: Asset): RideVideoMeta {
  const m = a.meta;
  if (!m) return {};
  if (typeof m === 'string') { try { return JSON.parse(m); } catch { return {}; } }
  return m as RideVideoMeta;
}

// ── timecode helpers ─────────────────────────────────────────────────────────
function fmtTc(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const ms = Math.round((sec - Math.floor(sec)) * 1000);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(ms).padStart(3, '0')}`;
}
function parseTc(v: string): number | null {
  const m = /^(\d{1,2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?$/.exec(v.trim());
  if (!m) return null;
  return (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]) + (m[4] ? +m[4].padEnd(3, '0') / 1000 : 0);
}
function fmtDur(s: number | null | undefined) {
  if (s == null || isNaN(s)) return '';
  const m = Math.floor(s / 60);
  return m >= 60
    ? `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`
    : `${m}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
}
function fmtTotal(sec: number): string {
  const m = Math.round(sec / 60);
  if (m >= 60) return `~${Math.floor(m / 60)} h ${m % 60} m total`;
  return `~${m} m total`;
}

// ── trim scrubber ────────────────────────────────────────────────────────────
interface TrimProps {
  src: string;
  durationHint: number | null;
  disabled: boolean;
  inT: number; outT: number; dur: number;
  onDur: (d: number) => void;
  onTrim: (inT: number, outT: number) => void;
}

function TrimScrubber({ src, durationHint, disabled, inT, outT, dur, onDur, onTrim }: TrimProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const railRef = useRef<HTMLDivElement>(null);
  const [seeking, setSeeking] = useState(false);
  const [follow, setFollow] = useState<'in' | 'out' | null>(null);
  const [dragging, setDragging] = useState<'in' | 'out' | null>(null);
  const [tcEdit, setTcEdit] = useState<{ field: 'in' | 'out'; value: string } | null>(null);
  // coalesced single-in-flight seek (aurora spec §5)
  const pendingRef = useRef<number | null>(null);
  const busyRef = useRef(false);

  const runSeek = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    if (pendingRef.current === null) { busyRef.current = false; setSeeking(false); return; }
    const target = pendingRef.current;
    pendingRef.current = null;
    busyRef.current = true;
    setSeeking(true);
    video.currentTime = target;
    video.addEventListener('seeked', runSeek, { once: true });
  }, []);
  const requestSeek = useCallback((t: number) => {
    pendingRef.current = t;
    if (!busyRef.current) runSeek();
  }, [runSeek]);

  const clampIn = useCallback((t: number) => Math.min(Math.max(0, t), outT - FRAME), [outT]);
  const clampOut = useCallback((t: number) => Math.max(Math.min(dur, t), inT + FRAME), [dur, inT]);

  // pointer drag
  useEffect(() => {
    if (!dragging) return;
    const move = (e: PointerEvent) => {
      const rail = railRef.current;
      if (!rail || dur <= 0) return;
      const rect = rail.getBoundingClientRect();
      const t = Math.min(Math.max(0, (e.clientX - rect.left) / rect.width), 1) * dur;
      if (dragging === 'in') { const v = clampIn(t); onTrim(v, outT); requestSeek(v); }
      else { const v = clampOut(t); onTrim(inT, v); requestSeek(v); }
    };
    const up = () => { setDragging(null); setFollow(null); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    return () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
  }, [dragging, dur, inT, outT, clampIn, clampOut, onTrim, requestSeek]);

  const startDrag = (which: 'in' | 'out') => (e: React.PointerEvent) => {
    if (disabled) return;
    e.preventDefault();
    setDragging(which);
    setFollow(which);
  };

  const nudge = (which: 'in' | 'out') => (e: React.KeyboardEvent) => {
    if (disabled || dur <= 0) return;
    let delta: number | null = null;
    if (e.key === 'ArrowLeft') delta = e.shiftKey ? -1 : -FRAME;
    else if (e.key === 'ArrowRight') delta = e.shiftKey ? 1 : FRAME;
    let target: number | null = null;
    if (delta !== null) target = (which === 'in' ? inT : outT) + delta;
    else if (e.key === 'Home') target = which === 'in' ? 0 : inT + FRAME;
    else if (e.key === 'End') target = which === 'in' ? outT - FRAME : dur;
    if (target === null) return;
    e.preventDefault();
    if (which === 'in') { const v = clampIn(target); onTrim(v, outT); requestSeek(v); }
    else { const v = clampOut(target); onTrim(inT, v); requestSeek(v); }
  };

  const commitTc = () => {
    if (!tcEdit) return;
    const t = parseTc(tcEdit.value);
    if (t !== null) {
      if (tcEdit.field === 'in') { const v = clampIn(t); onTrim(v, outT); requestSeek(v); }
      else { const v = clampOut(t); onTrim(inT, v); requestSeek(v); }
    }
    setTcEdit(null);
  };

  const pin = dur > 0 ? (inT / dur) * 100 : 0;
  const pout = dur > 0 ? (outT / dur) * 100 : 100;

  return (
    <div className="trim-host" data-testid="rv-trim">
      <div className={`trim-player${seeking ? ' seeking' : ''}${follow ? ' following' : ''}`}>
        <video
          ref={videoRef}
          className="tp-surface"
          src={src}
          preload="metadata"
          onLoadedMetadata={e => {
            const d = (e.target as HTMLVideoElement).duration;
            onDur(isFinite(d) && d > 0 ? d : (durationHint ?? 0));
          }}
        />
        <span className="tp-seeking"><span className="dot" />seeking…</span>
        <span className="tp-follow">{follow === 'out' ? 'OUT ▶' : '◀ IN'}</span>
      </div>

      <div
        className={`trim-scrub${dragging ? ' dragging' : ''}`}
        style={{ ['--pin' as string]: `${pin}%`, ['--pout' as string]: `${pout}%`, ['--pplay' as string]: `${pin}%` }}
        aria-disabled={disabled || dur <= 0}
      >
        <div className="ts-rail" ref={railRef}>
          <div className="ts-track" />
          <div className="ts-excl head" />
          <div className="ts-excl tail" />
          <div className="ts-range" />
          <button
            className={`ts-handle start${dragging === 'in' ? ' grabbing' : ''}`}
            role="slider" aria-label="Trim start"
            aria-valuemin={0} aria-valuemax={outT} aria-valuenow={inT}
            onPointerDown={startDrag('in')} onKeyDown={nudge('in')}
            data-testid="rv-handle-in"
          ><span className="grip" /></button>
          <button
            className={`ts-handle end${dragging === 'out' ? ' grabbing' : ''}`}
            role="slider" aria-label="Trim end"
            aria-valuemin={inT} aria-valuemax={dur} aria-valuenow={outT}
            onPointerDown={startDrag('out')} onKeyDown={nudge('out')}
            data-testid="rv-handle-out"
          ><span className="grip" /></button>
        </div>
      </div>

      <div className="trim-tc">
        <div className="tc-field in">
          <div className="tc-lbl"><span className="swatch" />In point</div>
          <input
            className="tc-val" spellCheck={false} data-testid="rv-tc-in"
            value={tcEdit?.field === 'in' ? tcEdit.value : fmtTc(inT)}
            onChange={e => setTcEdit({ field: 'in', value: e.target.value })}
            onFocus={() => setTcEdit({ field: 'in', value: fmtTc(inT) })}
            onBlur={commitTc}
            onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
          />
        </div>
        <div className="tc-field out">
          <div className="tc-lbl"><span className="swatch" />Out point</div>
          <input
            className="tc-val" spellCheck={false} data-testid="rv-tc-out"
            value={tcEdit?.field === 'out' ? tcEdit.value : fmtTc(outT)}
            onChange={e => setTcEdit({ field: 'out', value: e.target.value })}
            onFocus={() => setTcEdit({ field: 'out', value: fmtTc(outT) })}
            onBlur={commitTc}
            onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
          />
        </div>
        <div className="tc-field dur">
          <div className="tc-lbl"><span className="swatch" />Kept duration</div>
          <input className="tc-val" value={fmtTc(Math.max(0, outT - inT))} readOnly tabIndex={-1} />
        </div>
      </div>
    </div>
  );
}

// ── job progress card (aurora two-level, the design notes) ───────────────
const STEP_OF: Record<string, number> = { normalizing: 1, profiling: 2 };
const STEP_NAME: Record<number, string> = { 1: 'Normalize', 2: 'Optical-flow profile' };
const MINOR_ORDER = ['downloading', 'normalizing', 'profiling', 'registering', 'done'];

function JobCard({ job, title, etaTotalS, onViewResult, onRetry }: {
  job: JobStatus;
  title: string;
  etaTotalS: number;
  onViewResult: () => void;
  onRetry: () => void;
}) {
  // ETA smoothing: coarse buckets + monotonic bias (spec §5)
  const shownEtaRef = useRef(Infinity);
  useEffect(() => { shownEtaRef.current = Infinity; }, [job.jobId]);
  const fmtEta = (sec: number | null | undefined): string => {
    if (sec == null) return 'Estimating…';
    const b = sec > 3600 ? 300 : sec > 60 ? 60 : 10;
    let q = Math.round(sec / b) * b;
    if (q > shownEtaRef.current && q - shownEtaRef.current < b * 1.5) q = shownEtaRef.current;
    shownEtaRef.current = q;
    if (q >= 3600) return `~${Math.floor(q / 3600)} h ${Math.round((q % 3600) / 60)} m`;
    if (q >= 60) return `~${Math.round(q / 60)} min`;
    return `~${Math.max(q, 0)} s`;
  };

  const s = job;
  const cardState = s.state === 'done' ? 'done' : s.state === 'error' ? 'error' : s.state === 'estimate' ? '' : 'working';
  const active = STEP_OF[s.state] || null;
  const indet = s.state === 'queued' || s.state === 'estimate' || s.state === 'downloading' || s.state === 'registering';
  const stepPct = s.step_pct ?? 0;
  const cur = MINOR_ORDER.indexOf(s.state);
  const ariaText = s.state === 'done' ? 'Processing complete'
    : s.state === 'error' ? `Processing failed: ${s.error || s.detail || ''}`
    : s.state === 'estimate' ? `Estimated total ${fmtTotal(etaTotalS)}, not started`
    : active ? `Step ${active} of 2, ${STEP_NAME[active]} — ${stepPct}%, ${fmtEta(s.eta_s)} remaining`
    : `${s.state === 'downloading' ? 'Preparing clip' : 'Registering result'}, ${fmtEta(s.eta_s)} remaining`;

  return (
    <div className={`jobprog ${cardState}`} role="group" aria-label="Ride video processing" data-testid="rv-jobcard">
      <div className="jp-head">
        <div className="jp-title"><span className="jp-dot" /><span>{title}</span></div>
        <div className="jp-overall">
          {s.state === 'done' ? '100%' : s.state === 'error' ? 'failed' : s.state === 'estimate' ? 'estimate' : `${s.overall_pct ?? 0}%`}
        </div>
      </div>

      <div className="jp-minor">
        <span className={`mtick${s.state === 'downloading' || s.state === 'queued' ? ' active' : cur > 0 || s.state === 'done' ? ' done' : ''}`} />
        <span>Prepare</span>
        <span style={{ flex: 1 }} />
        <span className={`mtick${s.state === 'registering' ? ' active' : s.state === 'done' ? ' done' : ''}`} />
        <span>Register</span>
      </div>

      <div className="jp-steps">
        <div className="jp-segrow">
          {[1, 2].map(n => {
            const done = s.state === 'done' || (!!active && n < active);
            const isActive = active === n && s.state !== 'done';
            return (
              <div key={n} className={`jp-seg${done ? ' done' : ''}${isActive ? ' active' : ''}`}
                style={isActive ? { ['--seg-fill' as string]: `${stepPct}%` } : undefined}>
                <span className="jp-sheen" />
              </div>
            );
          })}
        </div>
        <div className="jp-caps">
          {[1, 2].map(n => {
            const done = s.state === 'done' || (!!active && n < active);
            const isActive = active === n && s.state !== 'done';
            return (
              <div key={n} className={`jp-cap${done ? ' done' : ''}${isActive ? ' active' : ''}`}>
                {done && <svg className="ck" viewBox="0 0 24 24"><path d="M5 13l4 4L19 7" /></svg>}
                <span className="n">{STEP_NAME[n]}</span>
              </div>
            );
          })}
        </div>
      </div>

      <div className="jp-within">
        <div className="jp-detail">
          <span className="d">{s.detail || (s.state === 'estimate' ? 'Waiting to start…' : '')}</span>
          <span className="p">{s.state === 'error' ? '✕' : s.state === 'done' ? '100%' : indet ? '…' : `${stepPct}%`}</span>
        </div>
        <div
          className={`jp-bar${indet && s.state !== 'done' ? ' indet' : ''}`}
          role="progressbar" aria-valuemin={0} aria-valuemax={100}
          aria-valuenow={indet ? undefined : (s.state === 'done' ? 100 : stepPct)}
          aria-valuetext={ariaText} aria-label="Current step progress"
        >
          <div className="fill" style={{ ['--within' as string]: `${s.state === 'done' ? 100 : stepPct}%` }}><span className="sheen" /></div>
        </div>
      </div>

      <div className="jp-eta">
        <div className="eta-main">
          <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>
          <span>
            {s.state === 'done' ? 'Complete' : s.state === 'error' ? 'Stopped'
              : s.state === 'estimate' ? <>Estimated <span className="eta-val">{fmtTotal(etaTotalS).replace(' total', '')}</span> — starting…</>
              : <><span className="eta-val">{fmtEta(s.eta_s)}</span> remaining</>}
          </span>
        </div>
        <span className="eta-total">
          {s.state === 'done' || s.state === 'error' || s.state === 'estimate' ? '' : fmtTotal(etaTotalS)}
        </span>
      </div>

      {s.state === 'done' && (
        <div className="jp-term done" style={{ display: 'flex' }}>
          <svg viewBox="0 0 24 24"><path d="M20 6L9 17l-5-5" /></svg>
          <div>
            <span className="tterm-b">Ride video ready.</span>{' '}
            <span>{doneStats(s)}</span><br />
            <button className="jp-cta" onClick={onViewResult} data-testid="rv-view-result">View ride video</button>
          </div>
        </div>
      )}
      {s.state === 'error' && (
        <div className="jp-term error" style={{ display: 'flex' }}>
          <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" /><path d="M12 8v4M12 16h.01" /></svg>
          <div>
            <span className="tterm-b">Processing failed.</span> <span>{s.error || s.detail || 'unknown error'}</span><br />
            <button className="jp-retry" onClick={onRetry} data-testid="rv-retry">Retry</button>
          </div>
        </div>
      )}
    </div>
  );
}

function doneStats(s: JobStatus): string {
  const meta = s.result?.ride_video ? parseMeta(s.result.ride_video) : {};
  const vf = meta.stats?.valid_fraction;
  return vf != null
    ? `Normalized · profiled · ${Math.round(vf * 100)}% of frames cleanly measured.`
    : 'Normalized · profiled · registered.';
}

// ── results list ─────────────────────────────────────────────────────────────
function RideVideoRow({ asset, onDelete, onView, deleting }: {
  asset: Asset; onDelete: () => void; onView: () => void; deleting: boolean;
}) {
  const meta = parseMeta(asset);
  const vf = meta.stats?.valid_fraction;
  const rawSegs = meta.stats?.segments;
  const segs = Array.isArray(rawSegs) ? rawSegs.length : typeof rawSegs === 'number' ? rawSegs : null;
  const v = meta.video || {};
  const dur = meta.duration_s ?? asset.duration_s;
  return (
    <div className="rv-row" data-testid="rv-result-row">
      <div className="rv-row-main">
        <button className="rv-row-label" onClick={onView} title="Open in viewer">{assetLabel(asset)}</button>
        <div className="rv-row-stats">
          {dur != null && <span>{fmtDur(dur)}</span>}
          {v.width && v.height && <span>{v.width}×{v.height}</span>}
          {vf != null && (
            <span title="Fraction of frames whose optical-flow signal was cleanly measured (corner / intrusion / low-confidence frames excluded — held, not dropped)">
              signal {Math.round(vf * 100)}%
            </span>
          )}
          {segs != null && <span>{segs} segment{segs === 1 ? '' : 's'}</span>}
          {meta.stats?.baseline_raw != null && <span>baseline {Number(meta.stats.baseline_raw).toFixed(3)}</span>}
        </div>
      </div>
      <button className="rv-row-del" onClick={onDelete} disabled={deleting} title="Delete ride video">
        {deleting ? '…' : '🗑'}
      </button>
    </div>
  );
}

// ── main tool ────────────────────────────────────────────────────────────────
export function RideVideoTool({ selectedAssets, onDeselectSlot, onProcessDone }: Props) {
  const source = selectedAssets[0] ?? null;

  const [dur, setDur] = useState(0);
  const [inT, setInT] = useState(0);
  const [outT, setOutT] = useState(0);
  const [job, setJob] = useState<JobStatus | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [rideVideos, setRideVideos] = useState<Asset[]>([]);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  // reset trim when the source changes
  useEffect(() => { setDur(0); setInT(0); setOutT(0); setSubmitError(null); }, [source?.id]);
  const handleDur = useCallback((d: number) => { setDur(d); setInT(0); setOutT(d); }, []);
  const handleTrim = useCallback((i: number, o: number) => { setInT(i); setOutT(o); }, []);

  const fetchRideVideos = useCallback(() => {
    fetch(`${LIB_BASE}/api/assets?subtype=ride-video`)
      .then(r => r.json())
      .then(d => setRideVideos(((d.assets ?? []) as Asset[]).filter(a => !a.trashed_at)))
      .catch(() => {});
  }, []);
  useEffect(() => { fetchRideVideos(); }, [fetchRideVideos]);

  // poll loop
  useEffect(() => {
    if (!job || job.state === 'estimate' || job.state === 'done' || job.state === 'error') return;
    const t = setInterval(async () => {
      try {
        const r = await fetch(`${TOOL_BASE}/api/ride-video/jobs/${job.jobId}`);
        const d = await r.json();
        if (!d.ok) throw new Error(d.error || `poll ${r.status}`);
        setJob(prev => prev ? { ...prev, ...d.job } : d.job);
        if (d.job.state === 'done') {
          fetchRideVideos();
          if (source) onProcessDone(source, d.job.result?.ride_video ?? null);
        }
      } catch (e) {
        setJob(prev => prev ? { ...prev, state: 'error', error: (e as Error).message } : prev);
      }
    }, POLL_MS);
    return () => clearInterval(t);
  }, [job?.jobId, job?.state === 'done' || job?.state === 'error' || job?.state === 'estimate']); // eslint-disable-line react-hooks/exhaustive-deps

  // estimate on the KEPT duration (the job only processes the trimmed range)
  const processedS = dur > 0 ? Math.max(0, outT - inT) : (source?.duration_s ?? 0);
  const etaTotalS = processedS * 1.7 * 2;

  const handleProcess = useCallback(async () => {
    if (!source) return;
    setSubmitError(null);
    // pre-start estimate pose; upgrades in place on the first poll (spec §5)
    setJob({ jobId: '', state: 'estimate' });
    const trimmed = dur > 0 && (inT > FRAME / 2 || outT < dur - FRAME / 2);
    try {
      const r = await fetch(`${TOOL_BASE}/api/ride-video/process`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          clip_asset_id: source.id,
          trim: trimmed ? { in_s: inT, out_s: outT } : null,
        }),
      });
      const d = await r.json();
      if (!d.ok) throw new Error(d.error || `process ${r.status}`);
      setJob({ jobId: d.jobId, state: 'queued', step: 1, step_total: 2, step_pct: 0, overall_pct: 0, detail: 'queued' });
    } catch (e) {
      setJob(null);
      setSubmitError((e as Error).message);
    }
  }, [source, dur, inT, outT]);

  const handleDelete = useCallback(async (asset: Asset) => {
    const ok = window.confirm(
      `Delete "${assetLabel(asset)}"?\n\nThis also deletes its motion profile and overlay children — the whole ride-video family. This cannot be undone.`
    );
    if (!ok) return;
    setDeletingId(asset.id);
    try {
      const r = await fetch(`${TOOL_BASE}/api/ride-video/${asset.id}`, { method: 'DELETE' });
      const d = await r.json();
      if (!d.ok) throw new Error(d.error || `delete ${r.status}`);
      fetchRideVideos();
    } catch (e) {
      window.alert(`Delete failed: ${(e as Error).message}`);
    } finally {
      setDeletingId(null);
    }
  }, [fetchRideVideos]);

  const keptDur = Math.max(0, outT - inT);
  const jobActive = !!job && job.state !== 'done' && job.state !== 'error';

  return (
    <div className="vf-workspace rv-workspace" data-testid="rv-workspace">
      {/* Slot: pick one video clip */}
      <div className="workspace-slots">
        {!source ? (
          <div className="slots-empty">Select 1 video clip from the Library rail →</div>
        ) : (
          <div className="slot-row" data-testid="rv-slot">
            <div className="slot-info">
              <span className="slot-label">{assetLabel(source)}</span>
              {source.duration_s != null && <span className="slot-dur">{fmtDur(source.duration_s)}</span>}
            </div>
            <button className="slot-remove" onClick={() => onDeselectSlot(0)} title="Remove">×</button>
          </div>
        )}
      </div>

      {/* Trim + process */}
      {source && (
        <>
          <TrimScrubber
            src={`${LIB_BASE}/api/assets/${source.id}/file`}
            durationHint={source.duration_s ?? null}
            disabled={jobActive}
            inT={inT} outT={outT} dur={dur}
            onDur={handleDur} onTrim={handleTrim}
          />
          <div className="trim-actions">
            <button
              className="t-mini"
              onClick={() => { setInT(0); setOutT(dur); }}
              disabled={jobActive || dur <= 0}
            >
              <svg viewBox="0 0 24 24"><path d="M3 12a9 9 0 1 0 3-6.7L3 8" /><path d="M3 3v5h5" /></svg>
              Reset trim
            </button>
            <span className="spacer" />
            <button
              className="t-cta"
              onClick={handleProcess}
              disabled={jobActive || dur <= 0}
              data-testid="rv-process-btn"
            >
              <svg viewBox="0 0 24 24"><path d="M5 3l14 9-14 9z" /></svg>
              Send to processing · {fmtDur(keptDur) || '—'}
            </button>
          </div>
        </>
      )}

      {submitError && <div className="vf-status vf-status-error" data-testid="rv-submit-error">Error: {submitError}</div>}

      {/* Job progress */}
      {job && source && (
        <JobCard
          job={job}
          title={`Ride video · ${assetLabel(source)}`}
          etaTotalS={etaTotalS}
          onViewResult={fetchRideVideos}
          onRetry={handleProcess}
        />
      )}

      {/* Results: existing ride-videos */}
      <div className="rv-results" data-testid="rv-results">
        <div className="rv-results-head">
          Ride videos <span className="rv-count">{rideVideos.length}</span>
        </div>
        {rideVideos.length === 0 && <div className="rv-results-empty">No ride videos yet.</div>}
        {rideVideos.map(a => (
          <RideVideoRow
            key={a.id}
            asset={a}
            deleting={deletingId === a.id}
            onDelete={() => handleDelete(a)}
            onView={() => window.open(`/asset-management/?assetid=${a.id}&view=preview`, '_self')}
          />
        ))}
      </div>
    </div>
  );
}
