// lineage: asset-platform/@asset/kit — created by domain-development (agent-user) — task (Track A A3)
//
// Shared audio player — the first "build once, mount everywhere" kit component
// (the design notes Track A step 3). Ported at PARITY from the vanilla
// picker.js inline player (lines 184–193): a native <audio controls preload=none>
// with crossorigin for Web-Audio-safe cross-origin reads. Native element = the
// browser drives play/pause/seek; we only manage the src + cleanup.
//
// Exposed as the light-DOM WC <asset-audio-player src="…">. Attributes:
//   src         (required) audio URL
//   preload     default "none" (parity)
//   crossorigin default "anonymous" (parity — needed if a tool later feeds the
//               same URL into Web Audio decodeAudioData; harmless otherwise)
// Re-rendering / removal cleans up the element (pause + detach) so re-mounts
// don't leak playing audio — mirrors picker.js clearAudio (lines 141–147).
import { useEffect, useRef } from 'react';

export interface AudioPlayerProps {
  src: string;
  preload?: string;
  crossOrigin?: '' | 'anonymous' | 'use-credentials';
}

export function AudioPlayer({ src, preload = 'none', crossOrigin = 'anonymous' }: AudioPlayerProps) {
  const ref = useRef<HTMLAudioElement>(null);

  // On unmount (or src change), stop + detach so no ghost playback survives a
  // re-render — parity with the vanilla clearAudio cleanup.
  useEffect(() => {
    const el = ref.current;
    return () => {
      if (!el) return;
      try {
        el.pause();
        el.removeAttribute('src');
        el.load();
      } catch {
        /* element already gone */
      }
    };
  }, [src]);

  return (
    <audio
      ref={ref}
      className="ap-audio"
      controls
      preload={preload}
      crossOrigin={crossOrigin === '' ? undefined : crossOrigin}
      src={src}
      // clicks on the player must not bubble to a row's select handler (parity)
      onClick={(e) => e.stopPropagation()}
    />
  );
}
