// Voice Register tool — piece ③ of the Voice Library build.
// category=voice, class=transform. Flow:
//   pick audio asset → auto-transcribe → edit transcript → optional label → Register
// On success the new voice record appears in GET /api/assets?subtype=voice.
// Audition player (PART C) is inline below: plays ref clip + synthesizes a test line
// via the optional voice service (build-time VITE_VOICE_URL).
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Asset } from '../types';
import { VoicePlayer } from './VoicePlayer';
import { pickAsset } from '../picker/AssetPicker';

const LIB_BASE = '/asset-management/library';

interface Props {
  selectedAssets: Asset[];
  onDeselectSlot: (index: number) => void;
  onProcessDone: (source: Asset, output: Asset | null) => void;
  onShowAsset?: (a: Asset) => void;
}

function assetLabel(a: Asset) {
  return a.label || a.filename || 'asset ' + a.id.slice(0, 8);
}

export function VoiceRegisterTool({ selectedAssets, onDeselectSlot, onProcessDone, onShowAsset }: Props) {
  const [transcript, setTranscript] = useState('');
  const [label, setLabel] = useState('');
  const [labelWarn, setLabelWarn] = useState(false);
  const [status, setStatus] = useState<{ msg: string; type: 'idle' | 'busy' | 'done' | 'error' }>({ msg: '', type: 'idle' });
  const [transcribing, setTranscribing] = useState(false);
  const [registering, setRegistering] = useState(false);
  const [registeredVoice, setRegisteredVoice] = useState<Asset | null>(null);
  // voice-to-voice keeps its own list; the Library registers each voice there (meta.v2v)
  const [v2v, setV2v] = useState<{ status: string; error?: string } | null>(null);
  const [syncing, setSyncing] = useState(false);


  // A clip comes from the mini picker (the old slot flow meant hunting the whole
  // library) or, as before, from a ticked tile in the Library rail.
  const [picked, setPicked] = useState<Asset | null>(null);
  const source = picked ?? selectedAssets[0] ?? null;
  // Voice records and their converted refs are outputs of this tool, not sources — keep them out of the list.
  const choose = (opener: HTMLElement) => pickAsset({ accept: ['audio'], title: 'Choose a voice clip…', opener, excludeSubtypes: ['voice', 'voice-ref'] }).then(a => { if (a) setPicked(a); });
  // The chosen clip also shows in the Preview ().
  useEffect(() => { if (source) onShowAsset?.(source); }, [source?.id]);   // eslint-disable-line react-hooks/exhaustive-deps
  // Follow along: scrub + slow down a fast talker.
  const [rate, setRate] = useState(1);
  const playerRef = useRef<HTMLAudioElement>(null);
  useEffect(() => { if (playerRef.current) playerRef.current.playbackRate = rate; }, [rate, source?.id]);
  const clear = () => { if (picked) setPicked(null); else onDeselectSlot(0); };

  // Which services this tool leans on, so a failure names the one to restart.
  const [voiceUp, setVoiceUp] = useState<boolean | null>(null);
  useEffect(() => {
    let live = true;
    const base = ((import.meta as any).env?.VITE_VOICE_URL as string | undefined) ?? '';
    if (!base) { setVoiceUp(false); return () => { live = false; }; }
    fetch(`${base}/health`, { signal: AbortSignal.timeout(4000) })
      .then(r => live && setVoiceUp(r.ok)).catch(() => live && setVoiceUp(false));
    return () => { live = false; };
  }, [source?.id]);

  const handlePickChange = useCallback(async (asset: Asset | null) => {
    setTranscript('');
    setStatus({ msg: '', type: 'idle' });
    setRegisteredVoice(null);
    if (!asset) return;
    setTranscribing(true);
    setStatus({ msg: 'Transcribing…', type: 'busy' });
    try {
      const fileResp = await fetch(`${LIB_BASE}/api/assets/${asset.id}/file`);
      if (!fileResp.ok) throw new Error(`fetch file: ${fileResp.status}`);
      const blob = await fileResp.blob();
      const fd = new FormData();
      fd.append('audio', new File([blob], asset.filename || 'audio.wav', { type: blob.type || 'audio/wav' }));
      const r = await fetch(`${LIB_BASE}/api/transcribe`, { method: 'POST', body: fd });
      const data = await r.json();
      if (!data.ok) throw new Error(data.error || 'transcribe failed');
      setTranscript(data.text || '');
      setStatus({ msg: 'Transcript ready — edit if needed', type: 'idle' });
    } catch (e) {
      const m = (e as Error).message;
      setStatus({
        msg: /sidecar|502|fetch failed/i.test(m)
          ? 'Transcription is unavailable (the optional transcription service is not running or not configured). You can still type the transcript yourself and register.'
          : `Transcribe error: ${m}`,
        type: 'error',
      });
    } finally {
      setTranscribing(false);
    }
  }, []);

  // Trigger transcription when the selected asset changes
  useEffect(() => {
    if (source) {
      void handlePickChange(source);
    } else {
      setTranscript('');
      setStatus({ msg: '', type: 'idle' });
      setRegisteredVoice(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source?.id]);

  const handleLabelChange = (v: string) => {
    setLabel(v);
    setLabelWarn(v.length > 0 && v.length < 2);
  };

  const handleRegister = useCallback(async () => {
    if (!source) return;
    setRegistering(true);
    setStatus({ msg: 'Registering voice…', type: 'busy' });
    try {
      const r = await fetch(`${LIB_BASE}/api/voices/create`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ audio_asset_id: source.id, label: label || undefined, ref_text: transcript }),
      });
      const data = await r.json();
      if (!data.ok) throw new Error(data.error || 'register failed');
      setRegisteredVoice(data.voice);
      setV2v(data.v2v ?? null);
      setStatus({ msg: `Voice registered — id ${data.voice.id.slice(0, 8)}…`, type: 'done' });
      onProcessDone(source, data.voice);
    } catch (e) {
      setStatus({ msg: `Error: ${(e as Error).message}`, type: 'error' });
    } finally {
      setRegistering(false);
    }
  }, [source, label, transcript, onProcessDone]);


  return (
    <div className="vf-workspace vr-workspace" data-testid="vr-workspace">
      {/* Slot: pick one audio asset */}
      <div className="workspace-slots">
        {!source ? (
          <div className="slots-empty">
            <button className="submit-btn" onClick={e => choose(e.currentTarget)} data-testid="vr-choose">Choose a voice clip…</button>
            <div style={{ marginTop: 6, opacity: 0.7, fontSize: '0.8em' }}>or tick one in the Library</div>
          </div>
        ) : (
          <div className="slot-row" data-testid="vr-slot">
            <div className="slot-info">
              <span className="slot-label">{assetLabel(source)}</span>
              {source.duration_s != null && (
                <span className="slot-dur">
                  {Math.floor(source.duration_s / 60)}:{String(Math.floor(source.duration_s % 60)).padStart(2, '0')}
                </span>
              )}
            </div>
            <button className="slot-remove" onClick={e => choose(e.currentTarget)} title="Choose another clip" data-testid="vr-change">Change…</button>
            <button className="slot-remove" onClick={clear} title="Remove">×</button>
          </div>
        )}
      </div>

      {/* Player: scrub the clip and slow it down to check the transcript */}
      {source && (
        <div className="vr-player" data-testid="vr-player">
          <audio ref={playerRef} controls preload="metadata" src={`${LIB_BASE}/api/assets/${source.id}/file`}
            onLoadedMetadata={e => { e.currentTarget.playbackRate = rate; }} />
          <div className="vr-speeds" role="group" aria-label="Playback speed">
            {[0.5, 0.75, 1, 1.25].map(r => (
              <button key={r} className={`vr-speed${rate === r ? ' on' : ''}`} onClick={() => setRate(r)} aria-pressed={rate === r}>{r}×</button>
            ))}
          </div>
        </div>
      )}

      {/* Transcript */}
      {source && (
        <div className="vf-params">
          <div className="vf-param-row" style={{ flexDirection: 'column', alignItems: 'flex-start', gap: 4 }}>
            <label style={{ fontWeight: 600 }}>Transcript {transcribing && <span style={{ fontWeight: 400, opacity: 0.7 }}>(transcribing…)</span>}</label>
            <textarea
              value={transcript}
              onChange={e => setTranscript(e.target.value)}
              disabled={transcribing}
              rows={6}
              style={{ width: '100%', fontFamily: 'inherit', fontSize: '1rem', lineHeight: 1.5, resize: 'vertical' }}
              placeholder="Transcript will appear here…"
              data-testid="vr-transcript"
            />
          </div>
          <div className="vf-param-row">
            <label>Label (optional)</label>
            <div style={{ flex: 1 }}>
              <input
                type="text"
                value={label}
                onChange={e => handleLabelChange(e.target.value)}
                placeholder="e.g. Billy Bob"
                style={{ width: '100%' }}
                data-testid="vr-label"
              />
              {labelWarn && (
                <div style={{ fontSize: '0.75em', color: '#e8a000', marginTop: 2 }}>
                  Give it ≥2 chars so it's findable
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* The services behind this tool — the one that's down is the one to restart */}
      <div className="vr-services" data-testid="vr-services" style={{ fontSize: '0.75em', opacity: 0.8, margin: '6px 0' }}>
        Test voice: voice-to-voice (GPU host, harbor) — {voiceUp == null ? 'checking…' : voiceUp ? 'up' : 'DOWN, start it in Harbor'}
      </div>

      {/* Status */}
      {status.msg && (
        <div className={`vf-status vf-status-${status.type}`} data-testid="vr-status">
          {status.msg}
        </div>
      )}

      {/* Register button */}
      {source && (
        <button
          className="submit-btn"
          onClick={handleRegister}
          disabled={transcribing || registering || !transcript}
          data-testid="vr-register-btn"
        >
          {registering ? 'Registering…' : 'Register Voice'}
        </button>
      )}

      {/* In voice-to-voice? (registered there automatically; Retry when it was busy or down) */}
      {registeredVoice && v2v && (
        <div className={`vf-status vf-status-${v2v.status === 'registered' ? 'done' : 'error'}`} data-testid="vr-v2v">
          {v2v.status === 'registered'
            ? 'Also in voice-to-voice — it shows in their voice list and sampler now.'
            : <>Not in voice-to-voice yet: {v2v.error}{' '}
              <button className="vr-speed" disabled={syncing} onClick={async () => {
                setSyncing(true);
                const r = await fetch(`${LIB_BASE}/api/voices/${registeredVoice.id}/sync`, { method: 'POST' }).then(x => x.json()).catch(e => ({ ok: false, error: String(e) }));
                setV2v(r.v2v ?? { status: 'failed', error: r.error });
                setSyncing(false);
              }}>{syncing ? 'Retrying…' : 'Retry'}</button></>}
        </div>
      )}

      {/* Audition player — shown after successful register */}
      {registeredVoice && (
        <div style={{ marginTop: 16, borderTop: '1px solid #333', paddingTop: 12 }} data-testid="vr-audition">
          <div style={{ fontWeight: 600, marginBottom: 8, fontSize: '0.9em' }}>Audition</div>
          <VoicePlayer
            audioRef={(registeredVoice.meta as { audio_ref?: string } | null)?.audio_ref ?? source?.id ?? ''}
            refText={(registeredVoice.meta as { ref_text?: string } | null)?.ref_text}
          />
        </div>
      )}
    </div>
  );
}
