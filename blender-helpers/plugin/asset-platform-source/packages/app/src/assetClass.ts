// Asset class / sub-class display + accent mapping.
//
// The library's two-tier taxonomy: `category` (audio|video|mesh|image|voice) is
// the CLASS; `subtype` (clip|voice|stem|sample|voice-ref) is the SUB-CLASS. The
// viewer surfaces both, and echoes an accent keyed to the asset's FUNCTIONAL role
// — voice ≠ raw clip is a real function distinction, not bare file-type (settled
// principle, the design notes). Accents pull from the Aurora palette via the
// --ap-role-* tokens declared in @asset/kit tokens.css.

import type { Asset } from './types';

const CLASS_LABELS: Record<string, string> = {
  audio: 'Audio',
  video: 'Video',
  mesh: 'Mesh',
  image: 'Image',
  voice: 'Voice',
};

const SUBTYPE_LABELS: Record<string, string> = {
  clip: 'Clip',
  voice: 'Voice',
  'voice-ref': 'Voice Ref',
  stem: 'Stem',
  sample: 'Sample',
  avatar: 'Avatar',
  general: 'General',
};

// role → Aurora accent token (values live in @asset/kit tokens.css as --ap-role-*).
// A voice is functionally distinct from a raw clip, so it carries its own accent
// regardless of whether it lands as category=voice or category=audio/subtype=voice.
const ROLE_VAR: Record<string, string> = {
  voice: 'var(--ap-role-voice)',   // magenta
  clip: 'var(--ap-role-clip)',     // coral
  audio: 'var(--ap-role-audio)',   // indigo
  video: 'var(--ap-role-video)',   // sky
  mesh: 'var(--ap-role-mesh)',     // lime
  image: 'var(--ap-role-image)',   // amber
};

function humanize(s: string): string {
  return s.replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

export interface AssetClassInfo {
  /** Top-tier class label, e.g. "Audio". */
  className: string;
  /** Sub-class label, e.g. "Voice" / "Clip" — null when the asset has no subtype. */
  subName: string | null;
  /** CSS color expression (an Aurora --ap-role-* var) for the asset's functional role. */
  accent: string;
}

/**
 * Resolve an asset's class / sub-class labels and its functional accent.
 * Class comes from `category`; sub-class from `subtype`. A voice — whether
 * modeled as category=voice or category=audio/subtype=voice — reads as a voice
 * and takes the voice accent.
 */
export function assetClassInfo(asset: Asset): AssetClassInfo {
  const category = (asset.category || '').toLowerCase();
  const subtype = (asset.subtype || '').toLowerCase();

  const className = CLASS_LABELS[category] || (category ? humanize(category) : 'Asset');
  const subName = subtype ? (SUBTYPE_LABELS[subtype] || humanize(subtype)) : null;

  // Role for the accent: voice trumps category; otherwise the subtype's own role,
  // else the class itself.
  const role =
    category === 'voice' || subtype === 'voice' || subtype === 'voice-ref' ? 'voice'
    : ROLE_VAR[subtype] ? subtype
    : ROLE_VAR[category] ? category
    : 'audio';

  return { className, subName, accent: ROLE_VAR[role] || 'var(--ap-role-audio)' };
}
