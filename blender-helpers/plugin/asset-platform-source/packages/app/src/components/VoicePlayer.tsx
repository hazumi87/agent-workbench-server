import { useCallback, useEffect, useRef, useState } from 'react';

const LIB_BASE = '/asset-management/library';
// Optional voice service: set VITE_VOICE_URL at build time (e.g. a local text-to-speech service). Unset = the test voice is disabled.
const VOICE_BASE: string = ((import.meta as any).env?.VITE_VOICE_URL as string | undefined) ?? '';
const GPUHOST_SYNTH = VOICE_BASE ? `${VOICE_BASE}/synthesize_ref` : '';
const DEFAULT_AUDITION = 'The quick brown fox jumps over the lazy dog.';

interface Props {
  audioRef: string;
  refText?: string;
}

export function VoicePlayer({ audioRef, refText }: Props) {
  const [testLine, setTestLine] = useState('');
  const [synthesizing, setSynthesizing] = useState(false);
  const [synthStatus, setSynthStatus] = useState('');
  const [synthAudioUrl, setSynthAudioUrl] = useState<string | null>(null);
  const synthAudioRef = useRef<HTMLAudioElement>(null);

  const handleSynthesize = useCallback(async () => {
    const line = testLine.trim() || DEFAULT_AUDITION;
    setSynthesizing(true);
    setSynthStatus('Fetching ref clip…');
    setSynthAudioUrl(null);
    try {
      const fileResp = await fetch(`${LIB_BASE}/api/assets/${audioRef}/file`);
      if (!fileResp.ok) throw new Error(`fetch ref wav: ${fileResp.status}`);
      const wavBlob = await fileResp.blob();
      const fd = new FormData();
      fd.append('wav', new File([wavBlob], 'ref.wav', { type: 'audio/wav' }));
      fd.set('text', line);
      if (refText) fd.set('ref_text', refText);
      setSynthStatus('Synthesizing (~1.5s)…');
      if (!GPUHOST_SYNTH) throw new Error('voice service not configured (set VITE_VOICE_URL when building the app)');
      const r = await fetch(GPUHOST_SYNTH, { method: 'POST', body: fd });
      if (!r.ok) {
        const err = await r.json().catch(() => ({ error: `HTTP ${r.status}` }));
        throw new Error(err.detail || err.error || `synth ${r.status}`);
      }
      const audioBlob = await r.blob();
      const url = URL.createObjectURL(audioBlob);
      setSynthAudioUrl(url);
      setSynthStatus('');
    } catch (e) {
      const m = (e as Error).message;
      setSynthStatus(/fetch|network|load failed/i.test(m) ? 'The test voice service is not answering. Start it, then try again.' : `Synth error: ${m}`);
    } finally {
      setSynthesizing(false);
    }
  }, [audioRef, refText, testLine]);

  useEffect(() => {
    if (!synthAudioUrl || !synthAudioRef.current) return;
    const el = synthAudioRef.current;
    const tryPlay = () => {
      el.play().catch((err: Error) => {
        if (err.name !== 'AbortError') {
          setSynthStatus('Tap ▶ to play');
        }
      });
    };
    if (el.readyState >= 3) {
      tryPlay();
    } else {
      el.addEventListener('canplay', tryPlay, { once: true });
    }
    return () => el.removeEventListener('canplay', tryPlay);
  }, [synthAudioUrl]);

  return (
    <div data-testid="voice-player">
      <div style={{ marginBottom: 8, fontSize: '0.85em' }}>
        <span style={{ opacity: 0.7 }}>Ref clip:</span>
        {' '}
        <audio
          controls
          src={`${LIB_BASE}/api/assets/${audioRef}/file`}
          style={{ verticalAlign: 'middle', height: 28 }}
          data-testid="vp-ref-audio"
        />
      </div>

      <div className="vf-param-row" style={{ flexDirection: 'column', alignItems: 'flex-start', gap: 4 }}>
        <label style={{ fontWeight: 600, fontSize: '0.85em' }}>Speak a test line</label>
        <div style={{ display: 'flex', gap: 6, width: '100%' }}>
          <input
            type="text"
            value={testLine}
            onChange={e => setTestLine(e.target.value)}
            placeholder={DEFAULT_AUDITION}
            style={{ flex: 1 }}
            data-testid="vp-testline"
          />
          <button
            className="submit-btn"
            style={{ flex: 'none', padding: '4px 10px', fontSize: '0.85em' }}
            onClick={handleSynthesize}
            disabled={synthesizing}
            data-testid="vp-speak-btn"
          >
            {synthesizing ? '…' : 'Speak'}
          </button>
        </div>
        {synthStatus && (
          <div style={{ fontSize: '0.8em', opacity: 0.8, marginTop: 2 }} data-testid="vp-synth-status">
            {synthStatus}
          </div>
        )}
        {synthAudioUrl && (
          <audio
            ref={synthAudioRef}
            controls
            src={synthAudioUrl}
            style={{ marginTop: 4, height: 28, width: '100%' }}
            data-testid="vp-synth-audio"
          />
        )}
      </div>
    </div>
  );
}
