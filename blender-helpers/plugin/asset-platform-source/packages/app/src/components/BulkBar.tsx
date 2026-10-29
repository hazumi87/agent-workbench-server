// ── Multi-select + bulk actions (Aurora spec,) ──
// NOT the tool slot picker (useToolSelection / toolActive): that fills a tool's inputs. This one
// picks many tiles in ONE rail section and acts on them together.
import type { Asset } from '../types';
import { IconCheck, IconClose, IconReload, IconStar, IconStarFilled, IconTrash } from '../icons';

export type BulkSection = 'favorites' | 'clipboard' | 'recycle' | 'library';
// base = the selection when the anchor was set: a shift-range is recomputed from it, so shift-click /
// Shift+arrow can shrink the range again instead of only ever growing it.
export interface BulkSel { section: BulkSection; ids: string[]; anchor: string | null; base: string[] }
export type BulkKind = 'fav' | 'unfav' | 'save' | 'trash' | 'revive';
export const SECTION_NAME: Record<BulkSection, string> = { favorites: 'Favorites', clipboard: 'Clipboard', recycle: 'Recycle', library: 'Library' };

// Save promotes scratch → curated; the destination is only defined for images and audio
// (images/uploads · audio/samples). Video/mesh have no curated home yet, so they're skipped.
export const canSave = (a: Asset) => !!a.transient && (a.category === 'image' || a.category === 'audio');

// No bulk endpoint: a few requests at a time. Resolves to the items that succeeded.
export async function runPool<T>(items: T[], fn: (t: T) => Promise<boolean>, n = 4): Promise<T[]> {
  const ok: T[] = [];
  let i = 0;
  const worker = async () => { while (i < items.length) { const t = items[i++]; if (await fn(t).catch(() => false)) ok.push(t); } };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  return ok;
}

// icons.tsx is Aurora-owned; these two follow its contract (24px box, currentColor stroke, 1.8).
const glyph = (body: React.ReactNode) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" className="icon" aria-hidden focusable="false">{body}</svg>
);
export const IconCheckSquare = () => glyph(<><rect x="4" y="4" width="16" height="16" rx="3" /><path d="M8.5 12.2l2.5 2.5 4.8-5.2" /></>);
export const IconMore = () => glyph(<><circle cx="6" cy="12" r="1.2" fill="currentColor" /><circle cx="12" cy="12" r="1.2" fill="currentColor" /><circle cx="18" cy="12" r="1.2" fill="currentColor" /></>);

interface ActionsProps { assets: Asset[]; section: BulkSection; favoriteIds?: Set<string>; onAct: (k: BulkKind) => void; phone?: boolean }

// ★ · Save (teal: the go action) · Recycle (ghost — recoverable, so not coral); Revive alone in Recycle.
export function BulkActions({ assets, section, favoriteIds, onAct, phone = false }: ActionsProps) {
  const n = assets.length;
  if (section === 'recycle') {
    return <button className="bulk-btn teal" disabled={!n} onClick={() => onAct('revive')} data-testid="bulk-revive"><IconReload /><span>Revive</span></button>;
  }
  const allFav = n > 0 && assets.every(a => favoriteIds?.has(a.id));
  const saveN = assets.filter(canSave).length;
  return (<>
    <button className="bulk-btn ghost" disabled={!n} onClick={() => onAct(allFav ? 'unfav' : 'fav')} data-testid="bulk-fav">
      {allFav ? <IconStarFilled className="bulk-star" /> : <IconStar className="bulk-star" />}<span>{allFav ? 'Unfavorite' : 'Favorite'}</span>
    </button>
    <button className="bulk-btn teal" disabled={!saveN} onClick={() => onAct('save')} data-testid="bulk-save"
      title={saveN ? `Save ${saveN} unsaved item${saveN === 1 ? '' : 's'} to the Library` : 'Nothing unsaved in the selection'}>
      <IconCheck /><span>{phone ? 'Save' : 'Save to Library'}{saveN && saveN < n ? ` (${saveN})` : ''}</span>
    </button>
    <button className="bulk-btn ghost" disabled={!n} onClick={() => onAct('trash')} data-testid="bulk-trash">
      <IconTrash /><span>{phone ? 'Recycle' : 'Move to Recycle'}</span>
    </button>
  </>);
}

interface BarProps extends ActionsProps { height?: number; onClear: () => void; onSelectAll: () => void }

// Desktop: takes the header control row's place at its exact height, so the grid never jumps.
export function BulkBar({ height, onClear, onSelectAll, ...act }: BarProps) {
  return (
    <div className="rail-allassets-header bulk-bar" style={height ? { height } : undefined} role="toolbar" aria-label="Selection" data-testid="bulk-bar">
      <button className="ctrl-btn bulk-x" onClick={onClear} aria-label="Clear selection" title="Clear selection (Esc)" data-testid="bulk-clear"><IconClose /></button>
      <span className="bulk-count" data-testid="bulk-count">{act.assets.length} selected</span>
      <button className="bulk-link" onClick={onSelectAll} data-testid="bulk-select-all">Select all in {SECTION_NAME[act.section]}</button>
      <span className="bulk-sp" />
      <BulkActions {...act} />
      <button className="bulk-btn ghost" onClick={onClear} data-testid="select-btn"><IconCheckSquare /><span>Done</span></button>
    </div>
  );
}
