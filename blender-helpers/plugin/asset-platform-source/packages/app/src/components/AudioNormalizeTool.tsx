// Audio Normalize tool workspace — Phase 2.3
// class=transform, category=audio, onOutput=switchToCompare (single same-length output)
// Calls /asset-management/tools/audio-normalize/api/process, then uploads output to asset-library clipboard.
import { useCallback, useState } from 'react';
import type { Asset } from '../types';

const AN_BASE = '/asset-management/tools/audio-normalize';
const LIB_BASE = '/asset-management/library';

type NormMode = 'peak' | 'loudnorm' | 'dynamic';

interface PeakSettings { targetPeak: number; frameLength: number; gaussSize: number; highpass: boolean; highpassFreq: number; }
interface LufsSettings { lufsI: number; lufsTP: number; lufsLRA: number; highpass: boolean; highpassFreq: number; }
interface DynSettings { targetPeak: number; frameLength: number; gaussSize: number; highpass: boolean; highpassFreq: number; }

interface Props {
  selectedAssets: Asset[];
  onDeselectSlot: (index: number) => void;
  onProcessDone: (source: Asset, output: Asset) => void;
}

function assetLabel(a: Asset) { return a.label || a.filename || 'asset ' + a.id.slice(0, 8); }
function fmtDur(s: number | null | undefined) {
  if (s == null || isNaN(s)) return '';
  return Math.floor(s / 60) + ':' + String(Math.floor(s % 60)).padStart(2, '0');
}

export function AudioNormalizeTool({ selectedAssets, onDeselectSlot, onProcessDone }: Props) {
  const [mode, setMode] = useState<NormMode>('peak');
  const [peakSettings, setPeak] = useState<PeakSettings>({ targetPeak: -0.1, frameLength: 500, gaussSize: 31, highpass: false, highpassFreq: 300 });
  const [lufsSettings, setLufs] = useState<LufsSettings>({ lufsI: -16, lufsTP: -1.5, lufsLRA: 11, highpass: false, highpassFreq: 300 });
  const [dynSettings, setDyn] = useState<DynSettings>({ targetPeak: -0.1, frameLength: 500, gaussSize: 31, highpass: false, highpassFreq: 300 });
  const [processing, setProcessing] = useState(false);
  const [statusMsg, setStatusMsg] = useState('');
  const [statusType, setStatusType] = useState<'idle' | 'processing' | 'done' | 'error'>('idle');

  const source = selectedAssets[0] ?? null;

  const getSettings = () => {
    if (mode === 'peak') return peakSettings;
    if (mode === 'loudnorm') return lufsSettings;
    return dynSettings;
  };

  const handleProcess = useCallback(async () => {
    if (!source) return;
    setProcessing(true);
    setStatusMsg('Fetching source clip…');
    setStatusType('processing');

    try {
      // 1. Fetch source blob
      const srcResp = await fetch(`${LIB_BASE}/api/clip/${source.id}`);
      if (!srcResp.ok) throw new Error(`fetch source: ${srcResp.status}`);
      const srcBlob = await srcResp.blob();
      const srcFilename = source.filename || `clip-${source.id}.wav`;

      // 2. POST to audio-normalize /api/process
      // audio-normalize backend requires .mp3 filename (originalname check). FFmpeg
      // decodes by content, not extension — WAV content under an .mp3 name is fine.
      setStatusMsg('Normalizing…');
      const normFilename = srcFilename.replace(/\.[^.]+$/, '') + '.mp3';
      const fd = new FormData();
      fd.append('file', new File([srcBlob], normFilename, { type: 'audio/mpeg' }));
      fd.append('mode', mode);
      fd.append('settings', JSON.stringify(getSettings()));

      const processResp = await fetch(`${AN_BASE}/api/process`, { method: 'POST', body: fd });
      if (!processResp.ok) {
        const err = await processResp.json().catch(() => ({}));
        throw new Error(err.error || `process: ${processResp.status}`);
      }
      const { outputId } = await processResp.json();

      // 3. Fetch processed output
      const outBaseName = srcFilename.replace(/\.[^.]+$/, '') + '-normalized.mp3';
      const outResp = await fetch(`${AN_BASE}/api/download/${outputId}/${encodeURIComponent(outBaseName)}`);
      if (!outResp.ok) throw new Error(`fetch output: ${outResp.status}`);
      const outBlob = await outResp.blob();

      // 4. Upload to asset-library clipboard (transient) with lineage
      setStatusMsg('Saving to Clipboard…');
      const uploadFd = new FormData();
      uploadFd.append('file', new File([outBlob], outBaseName, { type: 'audio/mpeg' }));
      const uploadResp = await fetch(`${LIB_BASE}/api/upload`, { method: 'POST', body: uploadFd });
      if (!uploadResp.ok) throw new Error(`upload: ${uploadResp.status}`);
      const { clip: rawClip } = await uploadResp.json();

      // 5. Patch lineage
      if (rawClip?.id) {
        await fetch(`${LIB_BASE}/api/clip/${rawClip.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            parent_id: source.id,
            root_id: source.root_id || source.id,
            derived_op: JSON.stringify({ tool: 'audio-normalize', mode, settings: getSettings() }),
          }),
        }).catch(() => {});
      }

      const outputAsset: Asset = rawClip || { id: outputId, category: 'audio', label: outBaseName, filename: outBaseName, transient: true };
      setStatusMsg(`Done — saved "${outBaseName}" to Clipboard`);
      setStatusType('done');
      // onOutput=switchToCompare: normalize is same-length, compare fits
      onProcessDone(source, outputAsset);

    } catch (e) {
      setStatusMsg(`Error: ${(e as Error).message}`);
      setStatusType('error');
    } finally {
      setProcessing(false);
    }
  }, [source, mode, peakSettings, lufsSettings, dynSettings, onProcessDone]);

  return (
    <div className="vf-workspace" data-testid="an-workspace">
      <div className="workspace-slots">
        {!source ? (
          <div className="slots-empty">Select 1 audio clip from the Library rail →</div>
        ) : (
          <div className="slot-row" data-testid="an-slot">
            <div className="slot-info">
              <span className="slot-label">{assetLabel(source)}</span>
              {source.duration_s != null && <span className="slot-dur">{fmtDur(source.duration_s)}</span>}
            </div>
            <button className="slot-remove" onClick={() => onDeselectSlot(0)} title="Remove" data-testid="an-slot-remove">×</button>
          </div>
        )}
      </div>

      <div className="vf-params" data-testid="an-params">
        {/* Mode */}
        <div className="vf-param-row">
          <label>Mode</label>
          <select value={mode} onChange={e => setMode(e.target.value as NormMode)} data-testid="an-mode">
            <option value="peak">Peak (flat gain)</option>
            <option value="loudnorm">Loudness (LUFS)</option>
            <option value="dynamic">Dynamic (dynaudnorm)</option>
          </select>
        </div>

        {(mode === 'peak' || mode === 'dynamic') && (<>
          <div className="vf-param-row">
            <label>Target peak (dBFS)</label>
            <input type="number" min={-20} max={0} step={0.1} value={mode === 'peak' ? peakSettings.targetPeak : dynSettings.targetPeak}
              onChange={e => mode === 'peak' ? setPeak(s => ({ ...s, targetPeak: +e.target.value })) : setDyn(s => ({ ...s, targetPeak: +e.target.value }))} />
          </div>
          {mode === 'dynamic' && <>
            <div className="vf-param-row">
              <label>Frame length (ms)</label>
              <input type="number" min={100} max={8000} step={100} value={dynSettings.frameLength}
                onChange={e => setDyn(s => ({ ...s, frameLength: +e.target.value }))} />
            </div>
            <div className="vf-param-row">
              <label>Gauss size (frames)</label>
              <input type="number" min={3} max={301} step={2} value={dynSettings.gaussSize}
                onChange={e => setDyn(s => ({ ...s, gaussSize: +e.target.value }))} />
            </div>
          </>}
          <div className="vf-param-row">
            <label>
              <input type="checkbox" checked={mode === 'peak' ? peakSettings.highpass : dynSettings.highpass}
                onChange={e => mode === 'peak' ? setPeak(s => ({ ...s, highpass: e.target.checked })) : setDyn(s => ({ ...s, highpass: e.target.checked }))} />
              {' '}High-pass filter
            </label>
          </div>
        </>)}

        {mode === 'loudnorm' && (<>
          <div className="vf-param-row">
            <label>Target (LUFS I)</label>
            <input type="number" min={-40} max={-5} step={0.5} value={lufsSettings.lufsI}
              onChange={e => setLufs(s => ({ ...s, lufsI: +e.target.value }))} />
          </div>
          <div className="vf-param-row">
            <label>True peak (dBTP)</label>
            <input type="number" min={-9} max={0} step={0.5} value={lufsSettings.lufsTP}
              onChange={e => setLufs(s => ({ ...s, lufsTP: +e.target.value }))} />
          </div>
          <div className="vf-param-row">
            <label>Range (LRA)</label>
            <input type="number" min={1} max={20} step={0.5} value={lufsSettings.lufsLRA}
              onChange={e => setLufs(s => ({ ...s, lufsLRA: +e.target.value }))} />
          </div>
          <div className="vf-param-row">
            <label>
              <input type="checkbox" checked={lufsSettings.highpass}
                onChange={e => setLufs(s => ({ ...s, highpass: e.target.checked }))} />
              {' '}High-pass filter
            </label>
          </div>
        </>)}
      </div>

      {statusMsg && (
        <div className={`vf-status vf-status-${statusType}`} data-testid="an-status">
          {statusMsg}
        </div>
      )}

      <button
        className="submit-btn"
        onClick={handleProcess}
        disabled={!source || processing}
        data-testid="an-process-btn"
      >
        {processing ? 'Normalizing…' : 'Normalize'}
      </button>
    </div>
  );
}
