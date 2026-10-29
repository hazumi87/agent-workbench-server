import type { ToolDeclaration, AssetCategory, RailTab } from './types';

// Default rail tabs per category
export const CATEGORY_DEFAULT_TABS: Record<AssetCategory, RailTab[]> = {
  audio: [{ id: 'library', label: 'Library' }, { id: 'audio-compare', label: 'Audio Compare' }],
  video: [{ id: 'library', label: 'Library' }],
  mesh: [{ id: 'library', label: 'Library' }],
  image: [{ id: 'library', label: 'Library' }],
  voice: [{ id: 'library', label: 'Library' }],
};

// Voice Filter — Phase 2.1: class=transform, onOutput=switchToCompare (same-length derivative)
export const VOICE_FILTER_TOOL: ToolDeclaration = {
  id: 'voice-filter',
  label: 'Voice Filter',
  category: 'audio',
  class: 'transform',
  slots: { count: 1, multiSelect: false, layout: 'rows' },
  onOutput: 'switchToCompare',
};

// Demucs — Phase 2.2: class=transform, onOutput=stayOnLibrary (multiple stems, not same-length)
export const DEMUCS_TOOL: ToolDeclaration = {
  id: 'demucs',
  label: 'Vocal Separation (demucs)',
  category: 'audio',
  class: 'transform',
  slots: { count: 1, multiSelect: false, layout: 'rows' },
  onOutput: 'stayOnLibrary',
};

// Audio Normalize — Phase 2.3: class=transform, onOutput=switchToCompare (single same-length output)
export const AUDIO_NORMALIZE_TOOL: ToolDeclaration = {
  id: 'audio-normalize',
  label: 'Audio Normalize',
  category: 'audio',
  class: 'transform',
  slots: { count: 1, multiSelect: false, layout: 'rows' },
  onOutput: 'switchToCompare',
};

// YT-Audio sourcing — Phase 2.4: class=sourcing (modal-hosted producer → Clipboard)
// Registered as sourcing so the shell knows to open a modal, not a workspace.
export const YT_AUDIO_SOURCING: ToolDeclaration = {
  id: 'yt-audio',
  label: 'Audio Ripper',
  category: 'audio',
  class: 'sourcing',
  slots: { count: 0, multiSelect: false, layout: 'rows' },
  onOutput: 'stayOnLibrary',
};

// Stub passthrough — Phase 1 demo (no-op transform)
export const STUB_PASSTHROUGH: ToolDeclaration = {
  id: 'passthrough',
  label: 'Passthrough (Demo)',
  category: 'audio',
  class: 'transform',
  slots: { count: 4, multiSelect: true, layout: 'rows' },
  onOutput: 'stayOnLibrary',
};

// Voice Register — piece ③: category=voice, class=transform
export const VOICE_REGISTER_TOOL: ToolDeclaration = {
  id: 'voice-register',
  label: 'Register Voice',
  category: 'voice',
  class: 'transform',
  slots: { count: 1, multiSelect: false, layout: 'rows' },
  onOutput: 'stayOnLibrary',
};

// Ride Video — task: video clip → derived ride video (normalize + motion profile).
// class=transform, onOutput=stayOnLibrary (derived outputs land in the results list).
export const RIDE_VIDEO_TOOL: ToolDeclaration = {
  id: 'ride-video',
  label: 'Ride Video',
  category: 'video',
  class: 'transform',
  slots: { count: 1, multiSelect: false, layout: 'rows' },
  onOutput: 'stayOnLibrary',
};

// Image Generation — task: Krea 2 via the GPU host engine. Text-to-image for now, so no slots:
// the library stays in browse mode. Edit models (up to 2 reference images, first = main
// subject) will raise this to 2.
export const IMAGE_GEN_TOOL: ToolDeclaration = {
  id: 'image-gen',
  label: 'Image Generation',
  category: 'image',
  class: 'transform',
  slots: { count: 0, multiSelect: false, layout: 'grid' },
  onOutput: 'stayOnLibrary',
};

export const TOOL_REGISTRY: ToolDeclaration[] = [
  IMAGE_GEN_TOOL,
  RIDE_VIDEO_TOOL,
  VOICE_FILTER_TOOL,
  VOICE_REGISTER_TOOL,
  DEMUCS_TOOL,
  AUDIO_NORMALIZE_TOOL,
  YT_AUDIO_SOURCING,
  STUB_PASSTHROUGH,
];

export function getToolsForCategory(category: AssetCategory): ToolDeclaration[] {
  return TOOL_REGISTRY.filter(t => t.category === category && t.class === 'transform');
}

export function getTabsForTool(tool: ToolDeclaration | null, category: AssetCategory | null): RailTab[] {
  const base = category ? CATEGORY_DEFAULT_TABS[category] : [{ id: 'library', label: 'Library' }];
  if (!tool?.railTabs) return base;
  const merged = [...tool.railTabs];
  if (!merged.find(t => t.id === 'library')) merged.unshift({ id: 'library', label: 'Library' });
  return merged;
}
