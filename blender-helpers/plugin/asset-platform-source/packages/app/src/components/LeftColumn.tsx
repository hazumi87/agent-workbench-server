import type { AssetCategory, Asset, ToolDeclaration } from '../types';
import { TOOL_REGISTRY } from '../toolRegistry';
import { VoiceFilterTool } from './VoiceFilterTool';
import { DemucsTool } from './DemucsTool';
import { AudioNormalizeTool } from './AudioNormalizeTool';
import { VoiceRegisterTool } from './VoiceRegisterTool';

interface Props {
  open: boolean;
  activeTool: ToolDeclaration | null;
  activeCategory: AssetCategory | null;
  selectedAssets: Asset[];
  onHamburgerToggle: () => void;
  onToolSelect: (tool: ToolDeclaration) => void;
  onDeselectSlot: (index: number) => void;
  onSubmit: () => void;
  submitting: boolean;
  onYtModalOpen: () => void;
  onProcessDone: (source: Asset, output: Asset | null) => void;
}

const CATALOG_GROUPS = [
  {
    label: 'Import',
    items: [
      { id: '_file-import', label: 'File Import', class: 'sourcing' as const },
      { id: '_youtube', label: 'Audio Ripper', class: 'sourcing' as const },
      { id: '_image-scrape', label: 'Image Scrape', class: 'sourcing' as const },
    ],
  },
  { label: 'Image Tools', items: TOOL_REGISTRY.filter(t => t.category === 'image') },
  { label: 'Mesh Tools', items: [] as { id: string; label: string }[] },
  {
    label: 'Audio Tools',
    // Include sourcing tools (yt-audio) in the catalog under Audio Tools
    items: TOOL_REGISTRY.filter(t => t.category === 'audio' && (t.class === 'transform' || t.class === 'sourcing')),
  },
  {
    label: 'Voice Tools',
    items: TOOL_REGISTRY.filter(t => t.category === 'voice'),
  },
  { label: 'Etc.', items: [] as { id: string; label: string }[] },
];

function fmtDur(s: number | null | undefined): string {
  if (s == null || isNaN(s)) return '—';
  const m = Math.floor(s / 60);
  const x = Math.floor(s % 60);
  return m + ':' + String(x).padStart(2, '0');
}

function assetLabel(a: Asset): string {
  return a.label || a.filename || 'asset ' + a.id.slice(0, 8);
}

export function LeftColumn({
  open, activeTool, activeCategory, selectedAssets,
  onHamburgerToggle, onToolSelect, onDeselectSlot, onSubmit, submitting,
  onYtModalOpen, onProcessDone,
}: Props) {
  return (
    <div className={`left-col${open ? ' open' : ''}`}>
      <button className="hamburger-btn" onClick={onHamburgerToggle} title="Tool catalog">
        ☰
      </button>

      {open && !activeTool && (
        <div className="tool-catalog">
          <div className="catalog-title">Asset Tools</div>
          {CATALOG_GROUPS.map(group => (
            <div key={group.label} className="catalog-group">
              <div className="catalog-group-label">{group.label}</div>
              {group.items.length === 0 && (
                <div className="catalog-item empty">[…{group.label.toLowerCase()}]</div>
              )}
              {group.items.map(item => (
                <button
                  key={item.id}
                  className={`catalog-item${activeCategory && 'category' in item && (item as ToolDeclaration).category !== activeCategory ? ' dimmed' : ''}`}
                  data-testid={
                    item.id === '_youtube' ? 'catalog-youtube' :
                    item.id === '_file-import' ? 'catalog-file-import' :
                    `catalog-${item.id}`
                  }
                  onClick={() => {
                    // Sourcing: _youtube (legacy import group) and yt-audio (registered sourcing tool)
                    if (item.id === '_youtube' || ('class' in item && (item as ToolDeclaration).class === 'sourcing' && (item as ToolDeclaration).id === 'yt-audio')) {
                      onYtModalOpen();
                      return;
                    }
                    if ('class' in item && (item as ToolDeclaration).class === 'transform') {
                      onToolSelect(item as ToolDeclaration);
                    }
                  }}
                >
                  {item.label}
                </button>
              ))}
            </div>
          ))}
        </div>
      )}

      {activeTool && (
        <div className="tool-workspace">
          <div className="workspace-header">
            <button className="hamburger-btn small" onClick={onHamburgerToggle} title="Back to catalog">☰</button>
            <span className="workspace-title" data-testid="workspace-title">{activeTool.label}</span>
          </div>

          {activeTool.id === 'voice-filter' ? (
            <VoiceFilterTool
              selectedAssets={selectedAssets}
              onDeselectSlot={onDeselectSlot}
              onProcessDone={(src, out) => onProcessDone(src, out)}
            />
          ) : activeTool.id === 'demucs' ? (
            <DemucsTool
              selectedAssets={selectedAssets}
              onDeselectSlot={onDeselectSlot}
              onProcessDone={onProcessDone}
            />
          ) : activeTool.id === 'audio-normalize' ? (
            <AudioNormalizeTool
              selectedAssets={selectedAssets}
              onDeselectSlot={onDeselectSlot}
              onProcessDone={(src, out) => onProcessDone(src, out)}
            />
          ) : activeTool.id === 'voice-register' ? (
            <VoiceRegisterTool
              selectedAssets={selectedAssets}
              onDeselectSlot={onDeselectSlot}
              onProcessDone={onProcessDone}
            />
          ) : (
            /* Generic stub workspace (passthrough demo) */
            <>
              <div className="workspace-slots">
                {selectedAssets.length === 0 && (
                  <div className="slots-empty">Select {activeTool.slots.count > 1 ? `up to ${activeTool.slots.count}` : '1'} asset{activeTool.slots.count > 1 ? 's' : ''} from the Library rail →</div>
                )}
                {selectedAssets.map((asset, idx) => (
                  <div key={asset.id} className="slot-row">
                    <div className="slot-info">
                      <span className="slot-label">{assetLabel(asset)}</span>
                      {asset.duration_s != null && (
                        <span className="slot-dur">{fmtDur(asset.duration_s)}</span>
                      )}
                    </div>
                    <button className="slot-remove" onClick={() => onDeselectSlot(idx)} title="Remove from selection">×</button>
                  </div>
                ))}
              </div>
              <div className="workspace-params" />
              <button
                className="submit-btn"
                onClick={onSubmit}
                disabled={selectedAssets.length === 0 || submitting}
              >
                {submitting ? 'Processing…' : 'Process (no-op)'}
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
