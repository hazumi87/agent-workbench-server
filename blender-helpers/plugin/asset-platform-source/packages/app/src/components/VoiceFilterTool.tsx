// Voice Filter tool workspace — Phase 2.1
// Registered in toolRegistry as class=transform, category=audio, onOutput=switchToCompare.
// Runs in the left-column workspace. Source clip from rail Library-tab selection.
// Calls /asset-management/tools/voice-filter/api/process with multipart file+settings,
// then uploads the output to asset-library clipboard (transient, lineage preserved).
import { useCallback, useState } from 'react';
import type { Asset } from '../types';

const VF_BASE = '/asset-management/tools/voice-filter';
const LIB_BASE = '/asset-management/library';

const PRESETS: Record<string, Settings> = {
  none:          { hpFreq: 20,  lpFreq: 20000, afftdnNr: 0,  afftdnNf: -25, loudnorm: false, lufsI: -16 },
  conservative:  { hpFreq: 80,  lpFreq: 8000,  afftdnNr: 12, afftdnNf: -25, loudnorm: true,  lufsI: -16 },
  balanced:      { hpFreq: 90,  lpFreq: 7000,  afftdnNr: 25, afftdnNf: -25, loudnorm: true,  lufsI: -16 },
  aggressive:    { hpFreq: 120, lpFreq: 6000,  afftdnNr: 40, afftdnNf: -30, loudnorm: true,  lufsI: -16 },
  suppress_music:{ hpFreq: 90,  lpFreq: 5000,  afftdnNr: 60, afftdnNf: -20, loudnorm: true,  lufsI: -16 },
  background:    { hpFreq: 100, lpFreq: 7500,  afftdnNr: 35, afftdnNf: -28, loudnorm: true,  lufsI: -16 },
};

interface Settings {
  hpFreq: number;
  lpFreq: number;
  afftdnNr: number;
  afftdnNf: number;
  loudnorm: boolean;
  lufsI: number;
}

interface Props {
  selectedAssets: Asset[];
  onDeselectSlot: (index: number) => void;
  onProcessDone: (source: Asset, output: Asset) => void;
}

function assetLabel(a: Asset) {
  return a.label || a.filename || 'asset ' + a.id.slice(0, 8);
}

function fmtDur(s: number | null | undefined) {
  if (s == null || isNaN(s)) return '';
  const m = Math.floor(s / 60);
  const x = Math.floor(s % 60);
  return m + ':' + String(x).padStart(2, '0');
}

export function VoiceFilterTool({ selectedAssets, onDeselectSlot, onProcessDone }: Props) {
  const [preset, setPreset] = useState('balanced');
  const [settings, setSettings] = useState<Settings>({ ...PRESETS.balanced });
  const [processing, setProcessing] = useState(false);
  const [status, setStatus] = useState<{ msg: string; type: 'idle' | 'processing' | 'done' | 'error' }>({ msg: '', type: 'idle' });

  const applyPreset = (name: string) => {
    setPreset(name);
    if (PRESETS[name]) setSettings({ ...PRESETS[name] });
  };

  const handleProcess = useCallback(async () => {
    if (selectedAssets.length === 0) return;
    const source = selectedAssets[0];
    setProcessing(true);
    setStatus({ msg: 'Fetching source clip…', type: 'processing' });

    try {
      // 1. Fetch source audio blob
      const srcResp = await fetch(`${LIB_BASE}/api/clip/${source.id}`);
      if (!srcResp.ok) throw new Error(`fetch source: ${srcResp.status}`);
      const srcBlob = await srcResp.blob();
      const srcFilename = source.filename || `clip-${source.id}.wav`;

      // 2. POST to voice-filter /api/process
      setStatus({ msg: 'Processing with voice filter…', type: 'processing' });
      const fd = new FormData();
      fd.append('file', new File([srcBlob], srcFilename, { type: srcBlob.type || 'audio/wav' }));
      fd.append('settings', JSON.stringify(settings));
      const processResp = await fetch(`${VF_BASE}/api/process`, { method: 'POST', body: fd });
      if (!processResp.ok) {
        const err = await processResp.json().catch(() => ({}));
        throw new Error(err.error || `process: ${processResp.status}`);
      }
      const { outputId } = await processResp.json();

      // 3. Fetch processed output blob
      const outBaseName = srcFilename.replace(/\.[^.]+$/, '') + '-voice-filtered.wav';
      const outResp = await fetch(`${VF_BASE}/api/download/${outputId}/${encodeURIComponent(outBaseName)}`);
      if (!outResp.ok) throw new Error(`fetch output: ${outResp.status}`);
      const outBlob = await outResp.blob();

      // 4. Upload output to asset-library clipboard (transient) with lineage
      setStatus({ msg: 'Saving to Clipboard…', type: 'processing' });
      const uploadFd = new FormData();
      uploadFd.append('file', new File([outBlob], outBaseName, { type: 'audio/wav' }));
      const uploadResp = await fetch(`${LIB_BASE}/api/upload`, { method: 'POST', body: uploadFd });
      if (!uploadResp.ok) throw new Error(`upload: ${uploadResp.status}`);
      const { clip: rawClip } = await uploadResp.json();

      // 5. Patch lineage (parent_id + derived_op) onto the new clipboard clip
      if (rawClip?.id) {
        await fetch(`${LIB_BASE}/api/clip/${rawClip.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            parent_id: source.id,
            root_id: source.root_id || source.id,
            derived_op: JSON.stringify({ tool: 'voice-filter', settings, preset }),
          }),
        }).catch(() => {}); // lineage patch is best-effort
      }

      const outputAsset: Asset = rawClip || {
        id: outputId,
        category: 'audio',
        label: outBaseName,
        filename: outBaseName,
        transient: true,
      };

      setStatus({ msg: `Done — saved "${outBaseName}" to Clipboard`, type: 'done' });
      // onOutput: switchToCompare(source, output) — parent handles rail tab switch
      onProcessDone(source, outputAsset);

    } catch (e) {
      setStatus({ msg: `Error: ${(e as Error).message}`, type: 'error' });
    } finally {
      setProcessing(false);
    }
  }, [selectedAssets, settings, preset, onProcessDone]);

  const source = selectedAssets[0] ?? null;

  return (
    <div className="vf-workspace" data-testid="vf-workspace">
      {/* Input slot */}
      <div className="workspace-slots">
        {!source ? (
          <div className="slots-empty">Select 1 audio clip from the Library rail →</div>
        ) : (
          <div className="slot-row" data-testid="vf-slot">
            <div className="slot-info">
              <span className="slot-label">{assetLabel(source)}</span>
              {source.duration_s != null && <span className="slot-dur">{fmtDur(source.duration_s)}</span>}
            </div>
            <button className="slot-remove" onClick={() => onDeselectSlot(0)} title="Remove" data-testid="vf-slot-remove">×</button>
          </div>
        )}
      </div>

      {/* Params */}
      <div className="vf-params" data-testid="vf-params">
        <div className="vf-param-row">
          <label>Preset</label>
          <select value={preset} onChange={e => applyPreset(e.target.value)} data-testid="vf-preset">
            <option value="none">None (passthrough)</option>
            <option value="conservative">Conservative</option>
            <option value="balanced">Balanced</option>
            <option value="aggressive">Aggressive</option>
            <option value="suppress_music">Suppress music</option>
            <option value="background">Background noise</option>
          </select>
        </div>
        <div className="vf-param-row">
          <label>High-pass (Hz)</label>
          <input type="number" min={20} max={500} step={10} value={settings.hpFreq}
            onChange={e => setSettings(s => ({ ...s, hpFreq: +e.target.value }))} />
        </div>
        <div className="vf-param-row">
          <label>Low-pass (Hz)</label>
          <input type="number" min={2000} max={16000} step={500} value={settings.lpFreq}
            onChange={e => setSettings(s => ({ ...s, lpFreq: +e.target.value }))} />
        </div>
        <div className="vf-param-row">
          <label>Noise reduction (dB)</label>
          <input type="number" min={0} max={97} step={1} value={settings.afftdnNr}
            onChange={e => setSettings(s => ({ ...s, afftdnNr: +e.target.value }))} />
        </div>
        <div className="vf-param-row">
          <label>Noise floor (dBFS)</label>
          <input type="number" min={-80} max={0} step={1} value={settings.afftdnNf}
            onChange={e => setSettings(s => ({ ...s, afftdnNf: +e.target.value }))} />
        </div>
        <div className="vf-param-row">
          <label>
            <input type="checkbox" checked={settings.loudnorm}
              onChange={e => setSettings(s => ({ ...s, loudnorm: e.target.checked }))} />
            {' '}Loudness norm
          </label>
        </div>
        {settings.loudnorm && (
          <div className="vf-param-row">
            <label>Target (LUFS)</label>
            <input type="number" min={-40} max={-5} step={0.5} value={settings.lufsI}
              onChange={e => setSettings(s => ({ ...s, lufsI: +e.target.value }))} />
          </div>
        )}
      </div>

      {/* Status */}
      {status.msg && (
        <div className={`vf-status vf-status-${status.type}`} data-testid="vf-status">
          {status.msg}
        </div>
      )}

      {/* Process button */}
      <button
        className="submit-btn"
        onClick={handleProcess}
        disabled={!source || processing}
        data-testid="vf-process-btn"
      >
        {processing ? 'Processing…' : 'Process'}
      </button>
    </div>
  );
}
