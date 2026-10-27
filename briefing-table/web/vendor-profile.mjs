/* ONE PLACE for "which models and efforts does this vendor offer" (Owner
 * 2026-10-03, Codex vendor). The CLI Manager form + launch-new select
 * (manager.js), the room's add sheet (room-add-sheet.mjs) and the agent
 * profile card (agent-profile-card.mjs) each carried their own copy of the
 * CLAUDE aliases; a second brand made that three places to forget.
 *
 * The EFFORT lists mirror src/engine/effort.ts (EFFORTS_BY_VENDOR), which is
 * what the engine validates against; test/vendor-profile.test.mjs fails if the
 * two ever disagree. MODEL lists are what the UIs OFFER — a stored model outside
 * a list is still kept as its own option by each caller, and the engine accepts
 * any well-formed model name.
 *
 * Claude's lists are byte-for-byte what each surface had (`cardModels` keeps
 * the profile card's own order). A vendor with no entry has no list: the
 * callers show no model/effort select for it rather than another brand's. */
export const VENDOR_PROFILE = Object.freeze({
  'claude-code': {
    models: ['sonnet', 'opus', 'fable'],
    cardModels: ['opus', 'sonnet', 'fable'],
    efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultracode'],
  },
  /* codex-cli 0.160.0 `codex debug models` (KB design-notes-id). Effort rides
     `-c model_reasoning_effort=`; the model decides which levels it supports. */
  'codex-cli': {
    /* `codex debug models` as chat-ops, 2026-10-05: the listed (not hidden) models */
    models: ['gpt-6-astra', 'gpt-6.1-sol', 'gpt-6-sol', 'gpt-6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5'],
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
  },
  /* gemini-cli: `-m/--model` takes these aliases (verified flag, 0.62.0); it
     has no effort setting. */
  'gemini-cli': {
    models: ['pro', 'flash', 'flash-lite'],
    efforts: [],
  },
});

const none = Object.freeze({ models: [], cardModels: [], efforts: [] });
const entry = (vendor) => VENDOR_PROFILE[vendor || 'claude-code'] ?? none;

export const modelsFor = (vendor) => [...entry(vendor).models];
export const cardModelsFor = (vendor) => [...(entry(vendor).cardModels ?? entry(vendor).models)];
export const effortsFor = (vendor) => [...entry(vendor).efforts];
