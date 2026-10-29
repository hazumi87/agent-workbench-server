// The Clip Editor as a full-page app (task; Aurora fullpage-apps-v1.2 §3): a fixed overlay over the
// still-mounted library. Empty (?app=clip-editor) → "Choose a clip…" + up to 3 recent chips (the
// picker is offered, never auto-opened). Loaded (&edit=<id>) → the shipped P1 editor in the frame.
// Changing the clip REPLACES the history entry; ← leaves through leaveApp() (one popstate path).
import { useEffect, useRef } from 'react';
import type { Asset } from '../types';
import { ClipEditor } from './ClipEditor';
import { pickAsset } from '../picker/AssetPicker';
import { leaveApp, noteDraftSaved, pushRecent, readRecents, replaceApp, type AppRoute } from '../shell/appRoute';
import { IconBack, IconScissors, IconSearch } from '../icons';
import './clip-editor.css';

const ACCEPT = ['audio'];   // P1; P2 adds 'video' (then the picker shows its category chips)

export function ClipEditorApp({ route, onOpenAsset }: { route: AppRoute; onOpenAsset: (id: string) => void }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const choose = (opener?: HTMLElement) => pickAsset({ accept: ACCEPT, title: 'Choose a clip…', opener }).then(a => { if (a) replaceApp(a.id); });

  // Focus on enter: ← when loaded, "Choose a clip…" when empty. The title names the clip.
  useEffect(() => {
    const prev = document.title;
    document.title = 'Clip Editor — Asset Library';
    return () => { document.title = prev; };
  }, []);
  useEffect(() => {
    rootRef.current?.querySelector<HTMLElement>(route.edit ? '[data-testid="ce-back"]' : '[data-testid="ce-choose"]')?.focus();
  }, [route.edit]);

  const onLoaded = (a: Asset) => {
    pushRecent(a);
    document.title = `Clip Editor · ${a.label || a.filename || a.id.slice(0, 8)} — Asset Library`;
  };
  const recents = readRecents().filter(r => ACCEPT.includes(r.category)).slice(0, 3);

  return (
    <div className="fp-app" ref={rootRef} data-testid="fp-app">
      {route.edit ? (
        <ClipEditor key={`${route.edit}|${route.from ?? ''}`} assetId={route.edit} fromId={route.from}
          nav={{ onBack: leaveApp, onChangeClip: choose, onEditAgain: child => replaceApp(route.edit, child), onOpenAsset, onLoaded, onSaved: noteDraftSaved }} />
      ) : (
        <div className="ce-root">
          <header className="ce-head">
            <button className="ce-back" onClick={leaveApp} data-testid="ce-back" aria-label="Back to the Library"><IconBack /><span className="ce-back-lbl">Library</span></button>
            <span className="ce-name">Clip Editor</span>
          </header>
          <div className="fp-empty">
            <div className="fp-empty-box">
              <IconScissors style={{ fontSize: 30 }} />
              <h4>Choose a clip to edit</h4>
              <p>Audio today; video uses the same editor later. Edits autosave as one draft per source.</p>
              <button className="fp-btn teal" onClick={e => choose(e.currentTarget)} data-testid="ce-choose"><IconSearch style={{ fontSize: 15 }} />Choose a clip…</button>
              {recents.length > 0 && (
                <div className="fp-recents">
                  {recents.map(r => (
                    <button key={r.id} className="fp-chip" onClick={() => replaceApp(r.id)} data-testid="ce-recent">{r.label || r.filename || r.id.slice(0, 8)}</button>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
