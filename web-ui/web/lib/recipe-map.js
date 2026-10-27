'use strict';
// The one mapper between the desktop's recipe record (src/recipes.js: loginId, serverId, folder, programId, options, ...)
// and the engine's recipe row (POST/GET /api/recipes: target, projectDir, vendor, model, effort, ...). Pure, no I/O.
// The web build has one node per person, so the server-and-login pair has no meaning here and is dropped on the way out
// and rebuilt as "this server" on the way in. Everything the desktop record cannot carry is taken from the engine row
// the save is replacing (`existing`), because the engine's upsert is a FULL replace. Rules in web/handlers/recipes.js.
// the design notes; the engine side: the engine web contracts notes.

const VENDORS = ['claude-code', 'cli-manager', 'gemini-cli', 'codex-cli', 'ollama'];
const PROGRAM_OF = { 'cli-manager': 'shell', 'claude-code': 'claude-code', 'codex-cli': 'codex-cli', 'gemini-cli': 'gemini-cli', ollama: 'ollama' };
const VENDOR_OF = { shell: 'cli-manager', custom: 'cli-manager', 'claude-code': 'claude-code', 'codex-cli': 'codex-cli', 'gemini-cli': 'gemini-cli', ollama: 'ollama' };
const LABEL = { 'cli-manager': 'Shell', 'claude-code': 'Claude Code', 'codex-cli': 'Codex', 'gemini-cli': 'Gemini', ollama: 'Ollama' };
const AUTO_APPROVE = ['follow', 'on', 'off'];
const HEX = /^#[0-9a-f]{6}$/i;
const NAME_MAX = 60;
const ARGS_MAX = 500;
const LOGO_MAX = 65536;
/** Engine fields no desktop record carries: kept from the row being replaced, never wiped by a save from the page. */
const ENGINE_ONLY = ['fg', 'bg', 'watermark', 'resume', 'resumeName', 'closeOnCleanExit', 'statusPath'];

const isStr = (v) => typeof v === 'string';
const refuse = (field, message) => ({ ok: false, field, message });

/** The folder the way the page says: empty and "~" mean the home folder, which the engine stores as no project dir. */
function projectDirOf(folder) {
  const f = String(folder == null ? '' : folder).trim().replace(/[\\/]+$/, '');
  return f === '' || f === '~' ? null : f.slice(0, 300);
}

/**
 * desktop record -> the engine's POST /api/recipes body.
 * opts: {targetId (the engine's own single target), imported (true: the person is importing a file), existing (the engine row being replaced)}
 * Returns {ok:true, body} or {ok:false, field, message} with the page's field name, before anything is sent.
 */
function toEngine(r, opts = {}) {
  if (!r || typeof r !== 'object') return refuse('recipe', 'There is no recipe to save.');
  const { targetId, imported = false, existing = null } = opts;
  if (!isStr(targetId) || !targetId) return refuse('target', 'This server has no place to run a program yet.');
  const name = String(r.name == null ? '' : r.name).trim().slice(0, NAME_MAX);
  if (!name) return refuse('name', 'Give the recipe a name.');
  const programId = isStr(r.programId) && r.programId ? r.programId : 'shell';
  const vendor = VENDOR_OF[programId];
  if (!vendor) return refuse('programId', 'This server cannot run ' + JSON.stringify(programId.slice(0, 40)) + '.');
  const body = { name, target: targetId, vendor, projectDir: projectDirOf(r.folder) };
  if (isStr(r.id) && r.id && !imported) body.id = r.id; // an update; an import always makes a new recipe
  if (isStr(r.agent) && r.agent.trim()) body.agent = r.agent.trim().slice(0, 80);
  const options = r.options && typeof r.options === 'object' ? r.options : {};
  if (isStr(options.model) && options.model.trim()) body.model = options.model.trim().slice(0, 80);
  if (isStr(options.effort) && options.effort.trim()) body.effort = options.effort.trim();
  if (Array.isArray(r.vendorArgs)) body.vendorArgs = r.vendorArgs.filter(isStr).slice(0, 32).map((x) => x.slice(0, ARGS_MAX));
  if (Array.isArray(r.vendorFlags)) body.vendorFlags = r.vendorFlags.filter(isStr).slice(0, 32).map((x) => x.slice(0, 80));
  if (programId === 'custom' && isStr(r.command) && r.command.trim()) body.initCmd = r.command.trim().slice(0, ARGS_MAX);
  const color = HEX.test(r.importColor || '') ? r.importColor : HEX.test(r.color || '') ? r.color : null;
  if (color) body.color = color.toLowerCase();
  if (typeof r.fontSize === 'number' && Number.isFinite(r.fontSize)) body.fontSize = r.fontSize;
  if (r.worktree === 'auto' || r.worktree === 'never') body.worktree = r.worktree;
  else if (r.importWorktree === 'auto' || r.importWorktree === 'never') body.worktree = r.importWorktree;
  if (isStr(r.logo) && r.logo.length <= LOGO_MAX) body.logo = r.logo; // the engine's JSON mark; a raster object has no place there
  // the approval: an import never carries more than "follow", never a disclosure, never a trust (slice 4's rule)
  if (imported) body.autoApprove = 'follow';
  else if (AUTO_APPROVE.includes(r.autoApprove)) {
    body.autoApprove = r.autoApprove;
    if (r.autoApprove === 'on' && r.disclosed === true) body.disclosed = true;
  }
  // a full replace must not wipe what this record cannot say: carry the replaced row's own values
  if (existing && typeof existing === 'object' && !imported) {
    for (const k of ENGINE_ONLY) if (body[k] === undefined && existing[k] !== undefined && existing[k] !== null) body[k] = existing[k];
    if (body.model === undefined && !r.options && isStr(existing.model) && existing.model) body.model = existing.model;
  }
  return { ok: true, body };
}

/** The engine's recipe row -> the desktop-shaped record the renderer's rail and forms already read. */
function fromEngine(row) {
  if (!row || typeof row !== 'object' || !isStr(row.id)) return null;
  const vendor = VENDORS.includes(row.vendor) ? row.vendor : row.runClaude === 0 ? 'cli-manager' : 'claude-code';
  const custom = vendor === 'cli-manager' && isStr(row.initCmd) && row.initCmd.trim();
  const out = {
    id: row.id,
    accountId: null,
    name: String(row.name || '').slice(0, NAME_MAX),
    loginId: 'local',
    serverId: 'local',
    folder: isStr(row.projectDir) && row.projectDir ? row.projectDir : '~',
    programId: custom ? 'custom' : PROGRAM_OF[vendor],
    runsOn: 'local',
    command: custom ? row.initCmd.trim() : '',
    where: 'This server',
    programLabel: custom ? 'Custom command' : LABEL[vendor],
    options: { ...(isStr(row.model) && row.model ? { model: row.model } : {}), ...(isStr(row.effort) && row.effort ? { effort: row.effort } : {}) },
    color: 'auto',
    importColor: HEX.test(row.color || '') ? row.color.toLowerCase() : null,
    logo: isStr(row.logo) && row.logo ? row.logo : null,
    agent: isStr(row.agent) && row.agent ? row.agent : null,
    fontSize: typeof row.fontSize === 'number' ? row.fontSize : null,
    worktree: row.worktree === 'never' ? 'never' : 'auto',
    vendorArgs: Array.isArray(row.vendorArgs) ? row.vendorArgs.filter(isStr) : null,
    vendorFlags: Array.isArray(row.vendorFlags) ? row.vendorFlags.filter(isStr) : [],
    unavailableTarget: null,
    importWorktree: 'never',
    createdAt: Number.isFinite(row.created_at) ? row.created_at : 0,
    updatedAt: Number.isFinite(row.updated_at) ? row.updated_at : 0,
    rev: Number.isFinite(row.updated_at) ? row.updated_at : 0,
  };
  // what only the engine knows, for the settings screen: the approval the recipe carries and what it resolves to
  if (AUTO_APPROVE.includes(row.autoApprove)) out.autoApprove = row.autoApprove;
  if (row.autoApproveEffective === 'on' || row.autoApproveEffective === 'off') out.autoApproveEffective = row.autoApproveEffective;
  if (row.autoApproveSource === 'recipe' || row.autoApproveSource === 'default') out.autoApproveSource = row.autoApproveSource;
  return out;
}

module.exports = { toEngine, fromEngine, projectDirOf, VENDORS, VENDOR_OF, PROGRAM_OF, ENGINE_ONLY };
