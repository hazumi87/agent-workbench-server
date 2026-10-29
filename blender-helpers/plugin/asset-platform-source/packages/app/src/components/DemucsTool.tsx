// Demucs tool workspace — Phase 2.2
// class=transform, category=audio, onOutput=stayOnLibrary (multiple stems, not same-length single)
// Submits multipart to /asset-management/tools/demucs/api/separate, polls /api/job/:id,
// stems land in asset-library clipboard with parent_id lineage (demucs backend handles it).
import { useCallback, useState } from 'react';
import type { Asset } from '../types';

const DEMUCS_BASE = '/asset-management/tools/demucs';
const LIB_BASE = '/asset-management/library';
const POLL_MS = 1500;

interface Stem { name: string; clipId: string | null; url: string | null; }

interface Props {
  selectedAssets: Asset[];
  onDeselectSlot: (index: number) => void;
  onProcessDone: (source: Asset, output: Asset | null) => void;
}

function assetLabel(a: Asset) { return a.label || a.filename || 'asset ' + a.id.slice(0, 8); }
function fmtDur(s: number | null | undefined) {
  if (s == null || isNaN(s)) return '';
  return Math.floor(s / 60) + ':' + String(Math.floor(s % 60)).padStart(2, '0');
}

export function DemucsTool({ selectedAssets, onDeselectSlot, onProcessDone }: Props) {
  const [processing, setProcessing] = useState(false);
  const [progress, setProgress] = useState(0);
  const [stage, setStage] = useState('');
  const [stems, setStems] = useState<Stem[]>([]);
  const [statusMsg, setStatusMsg] = useState('');
  const [statusType, setStatusType] = useState<'idle' | 'processing' | 'done' | 'error'>('idle');

  const source = selectedAssets[0] ?? null;

  const handleProcess = useCallback(async () => {
    if (!source) return;
    setProcessing(true);
    setStems([]);
    setProgress(0);
    setStage('');
    setStatusMsg('Fetching source clip…');
    setStatusType('processing');

    try {
      // 1. Fetch source blob
      const srcResp = await fetch(`${LIB_BASE}/api/clip/${source.id}`);
      if (!srcResp.ok) throw new Error(`fetch source: ${srcResp.status}`);
      const srcBlob = await srcResp.blob();
      const srcFilename = source.filename || `clip-${source.id}.wav`;

      // 2. Submit separation job
      setStatusMsg('Submitting separation job…');
      const fd = new FormData();
      fd.append('file', new File([srcBlob], srcFilename, { type: srcBlob.type || 'audio/wav' }));
      fd.append('sourceName', source.label || source.filename || source.id);
      fd.append('parentId', source.id);

      const submitResp = await fetch(`${DEMUCS_BASE}/api/separate`, { method: 'POST', body: fd });
      if (!submitResp.ok) {
        const err = await submitResp.json().catch(() => ({}));
        throw new Error(err.error || `submit: ${submitResp.status}`);
      }
      const { jobId } = await submitResp.json();

      // 3. Poll until done
      setStatusMsg('Separating stems…');
      setStage('separating');
      let done = false;
      while (!done) {
        await new Promise(r => setTimeout(r, POLL_MS));
        const pollResp = await fetch(`${DEMUCS_BASE}/api/job/${jobId}`);
        if (!pollResp.ok) throw new Error(`poll: ${pollResp.status}`);
        const job = await pollResp.json();
        setProgress(job.pct ?? 0);
        setStage(job.stage ?? '');
        if (job.status === 'done') {
          done = true;
          setStems(job.stems ?? []);
          const stemNames = (job.stems ?? []).map((s: Stem) => s.name).join(' + ');
          setStatusMsg(`Done — stems: ${stemNames}`);
          setStatusType('done');
          // onOutput=stayOnLibrary: multiple stems, not a single same-length derivative
          onProcessDone(source, null);
        } else if (job.status === 'error') {
          throw new Error(job.error || 'Separation failed');
        } else {
          setStatusMsg(`${job.stage ?? 'Processing'}… ${job.pct ?? 0}%`);
        }
      }
    } catch (e) {
      setStatusMsg(`Error: ${(e as Error).message}`);
      setStatusType('error');
    } finally {
      setProcessing(false);
    }
  }, [source, onProcessDone]);

  return (
    <div className="vf-workspace" data-testid="demucs-workspace">
      <div className="workspace-slots">
        {!source ? (
          <div className="slots-empty">Select 1 audio clip from the Library rail →</div>
        ) : (
          <div className="slot-row" data-testid="demucs-slot">
            <div className="slot-info">
              <span className="slot-label">{assetLabel(source)}</span>
              {source.duration_s != null && <span className="slot-dur">{fmtDur(source.duration_s)}</span>}
            </div>
            <button className="slot-remove" onClick={() => onDeselectSlot(0)} title="Remove" data-testid="demucs-slot-remove">×</button>
          </div>
        )}
      </div>

      <div className="vf-params" style={{ minHeight: 0 }}>
        <div style={{ fontSize: '11px', color: 'var(--text-dim)', padding: '4px 0' }}>
          Produces: vocals + accompaniment stems (24 kHz mono WAV)
        </div>
        <div style={{ fontSize: '11px', color: 'var(--text-dim)' }}>
          Model: htdemucs (default)
        </div>
      </div>

      {/* Progress bar */}
      {processing && (
        <div className="demucs-progress" data-testid="demucs-progress">
          <div className="demucs-progress-bar" style={{ width: `${progress}%` }} />
          <div className="demucs-progress-label">{stage} {progress > 0 ? `${progress}%` : ''}</div>
        </div>
      )}

      {statusMsg && (
        <div className={`vf-status vf-status-${statusType}`} data-testid="demucs-status">
          {statusMsg}
        </div>
      )}

      {/* Stem results */}
      {stems.length > 0 && (
        <div className="demucs-stems" data-testid="demucs-stems">
          {stems.map(stem => (
            <div key={stem.name} className="demucs-stem-row" data-testid={`demucs-stem-${stem.name}`}>
              <span className="demucs-stem-name">{stem.name}</span>
              {stem.url && (
                <audio controls src={stem.url} style={{ flex: 1, height: 28 }} />
              )}
            </div>
          ))}
        </div>
      )}

      <button
        className="submit-btn"
        onClick={handleProcess}
        disabled={!source || processing}
        data-testid="demucs-process-btn"
      >
        {processing ? `Separating… ${progress}%` : 'Separate Stems'}
      </button>
    </div>
  );
}
