// Tool-declaration contract — the interface a tool registers with the shell.
// Phase 1.3 canonical definition.

export type AssetCategory = 'audio' | 'video' | 'mesh' | 'image' | 'voice';
export type ToolClass = 'transform' | 'selection-aid' | 'sourcing';
export type OnOutputBehavior = 'switchToCompare' | 'stayOnLibrary';

export interface SlotConfig {
  count: number;
  multiSelect: boolean;
  layout: 'grid' | 'rows';
}

export interface RailTab {
  id: string;
  label: string;
}

export interface ToolDeclaration {
  id: string;
  label: string;
  category: AssetCategory;
  class: ToolClass;
  slots: SlotConfig;
  railTabs?: RailTab[];  // overrides category default; Library always present
  onOutput: OnOutputBehavior;
}

export interface Asset {
  id: string;
  category: string;
  subtype?: string | null;
  label?: string | null;
  filename?: string | null;
  duration_s?: number | null;
  sample_rate?: number | null;
  format?: string | null;
  bytes?: number | null;
  transient?: boolean | number;
  trashed_at?: string | null;
  created_at?: string | null;
  origin_created_at?: string | null;
  collection?: string | null;
  external_id?: string | null;
  is_favorite?: boolean;   // task
  rating?: number;         // my vote: -1 | 0 | 1
  score?: number;          // sum of votes
  source?: string | null;
  rel_path?: string | null;
  parent_id?: string | null;
  root_id?: string | null;
  derived_op?: { tool?: string; params?: Record<string, unknown> } | string | null;
  meta?: Record<string, unknown> | string | null;
}
