'use strict';
// The ONE map from what the engine answers to the sentence the person reads. Source of every sentence: the design's
// "When the server says no" (the design, section 5): one plain sentence each, no codes, no ids, no HTTP status.
// Pure, no I/O. Rule: engine text NEVER reaches the page; an answer with no row says CATCH_ALL and is counted, and a
// UI test that calls assertNoUnmapped() fails if any answer got that far. A new engine answer needs its row first.
//
// To add a row (each owner, in their own commit): push one object onto ROWS below, in your section:
//   { id, call, match(answer) -> boolean, say(answer) -> string, samples: [answer, ...] }
// `call` is one of CALLS (the place in the page that asked); `answer` is {status, reason?, field?, ...} as the page's
// engine client returns it, plus any values the sentence needs ({name}, {size}, {limit}, {file}, {program}); `samples`
// are real answers the row must claim (the test feeds each one through and checks the sentence).

const CATCH_ALL = "The server couldn't do that. Try again.";

// where in the page the question was asked; rows are looked up by call, so the same status can mean different things
const CALLS = [
  'setup.folder',     // first-login default folder refused (not a full path / not on this server / outside the allowed places)
  'trust.folder',     // trust a folder
  'person-only',      // a person-only route that did not see the person signed in (403)
  'auto-approve',     // turning auto-approve On without the notice having been read (400)
  'signin.start',     // opening a program's sign-in terminal
  'agent.status',     // installed / sign-in status of a program (null is a status, not an error)
  'note.save',        // a room note saved against a changed or deleted note (412)
  'upload',           // a file too large (413)
  'plugin.upload',    // a plugin zip too large (413)
  'module.budget',    // a plugin made too many requests (429)
  'send.file',        // sending a message with a picture or file (the room file store is not set up on this server: 503)
  'generic',          // anything else that has no place of its own yet
];

/** Fill {name}-style placeholders from `values`; a placeholder with no value is a bug, never printed. */
function fill(template, values) {
  return String(template).replace(/\{(\w+)\}/g, (_, key) => {
    if (!values || values[key] === undefined || values[key] === null || values[key] === '') throw new Error('server-answers: missing ' + key);
    return String(values[key]);
  });
}

// ---- rows, by owner ----------------------------------------------------------------------------------------------
const ROWS = [
  // a builder: the catch-all lives in CATCH_ALL (no row; reaching it is a defect in a test)
  // a builder: setup folder x3, folder-trust 400, person-only 403, auto-approve-without-notice 400, sign-in could-not-start, agent status null
  { id: 'setup.absolute', call: 'setup.folder',
    match: a => a.status === 400 && a.field === 'defaultFolder' && a.reason === 'an absolute folder',
    say: () => "That isn't a full folder path. Choose a folder from the list.",
    samples: [{ status: 400, field: 'defaultFolder', reason: 'an absolute folder' }] },
  { id: 'setup.missing', call: 'setup.folder',
    match: a => a.status === 400 && a.field === 'defaultFolder' && a.reason === 'that folder does not exist',
    say: () => "That folder doesn't exist on this server. Choose another.",
    samples: [{ status: 400, field: 'defaultFolder', reason: 'that folder does not exist' }] },
  { id: 'setup.outside', call: 'setup.folder',
    match: a => a.status === 403 && a.field === 'defaultFolder' && a.reason === 'outside-root',
    say: () => "That folder is outside the places this server lets you use. Choose another.",
    samples: [{ status: 403, field: 'defaultFolder', reason: 'outside-root' }] },
  { id: 'trust.missing', call: 'trust.folder',
    match: a => a.status === 400 && a.field === 'path' && a.reason === 'that folder does not exist',
    say: () => "That folder can't be trusted: it doesn't exist on this server. Choose it from the list.",
    samples: [{ status: 400, field: 'path', reason: 'that folder does not exist' }] },
  { id: 'person.required', call: 'person-only',
    match: a => a.status === 403 && a.reason === 'person_only',
    say: () => "Only you can do this, and the server didn't see you signed in. Sign in again, then try again.",
    samples: [{ status: 403, reason: 'person_only' }] },
  { id: 'approval.disclosure', call: 'auto-approve', action: 'show-disclosure',
    match: a => a.status === 400 && ['disclosed', 'autoApprove'].includes(a.field) && a.reason === 'disclosure-required',
    say: () => 'Read the notice before you turn this on.',
    samples: ['disclosed', 'autoApprove'].map(field => ({ status: 400, field, reason: 'disclosure-required' })) },
  { id: 'signin.prepare', call: 'signin.start',
    match: a => a.status === 502 && a.reason === 'could not prepare the sign-in terminal' && ['Claude Code', 'Codex', 'Gemini CLI'].includes(a.program),
    say: a => fill("Couldn't open sign-in for {program}. Try again.", a),
    samples: ['Claude Code', 'Codex', 'Gemini CLI'].map(program => ({ status: 502, reason: 'could not prepare the sign-in terminal', program })) },
  { id: 'agent.unknown', call: 'agent.status',
    match: a => a.status === 200 && a.installed === null,
    say: () => "Can't check. Open a sign-in terminal to see.",
    samples: [{ status: 200, installed: null }] },
  // a builder: note 412 changed, note 412 deleted, upload 413 ({name} is {size}. The limit is {limit}.)
  {
    id: 'note.save.changed', call: 'note.save',
    match: (a) => a.status === 412 && a.reason === 'changed',
    say: () => 'This note changed on the server. Your draft is still here. Reload the saved note to replace your draft.',
    samples: [{ status: 412, reason: 'changed' }],
  },
  {
    id: 'note.save.deleted', call: 'note.save',
    match: (a) => a.status === 412 && (a.reason === 'deleted' || a.reason === 'gone'),
    say: () => 'This note was deleted on the server. Your draft is still here. Save it as a new note, or close it.',
    samples: [{ status: 412, reason: 'deleted' }, { status: 412, reason: 'gone' }],
  },
  {
    id: 'note.new.name-exists', call: 'note.save',
    match: (a) => a.status === 200 && a.reason === 'new-name-exists',
    say: () => 'A note with that name already exists. Choose a different name.',
    samples: [{ status: 200, reason: 'new-name-exists' }],
  },
  {
    id: 'note.new.changed', call: 'note.save',
    match: (a) => a.status === 200 && a.reason === 'new-changed',
    say: () => 'The new note was changed on the server while it was being saved. Your draft is still here. Check the list before you try again.',
    samples: [{ status: 200, reason: 'new-changed' }],
  },
  {
    id: 'upload.too-large', call: 'upload',
    match: (a) => a.status === 413,
    say: (a) => fill('{name} is {size}. The limit is {limit}.', a),
    samples: [{ status: 413, name: 'report.pdf', size: '63 MB', limit: '50 MB' }],
  },
  // a builder: plugin upload 413, module budget 429 (the design, web screens section 5)
  {
    id: 'plugin.too-big', call: 'plugin.upload',
    match: (a) => a.status === 413,
    say: (a) => fill("Can't install {file}. The limit is 20 MB zipped and 50 MB unpacked.", a),
    samples: [{ status: 413, file: 'notes-plus.zip' }],
  },
  {
    id: 'module.too-many-requests', call: 'module.budget',
    match: (a) => a.status === 429,
    say: () => 'This tool has made too many requests. Wait a moment, then try again.',
    samples: [{ status: 429 }, { status: 429, kind: 'slow' }],
  },
  // a builder: a picture cannot be sent because the server has no room file store (the design walk; the engine's text is for the operator)
  {
    id: 'send.store-missing', call: 'send.file',
    match: (a) => a.status === 503, // the fixed code file-store-missing, or the old operator text from a non-hosted engine: any 503 on a file send
    say: () => "Pictures can't be sent on this server yet. Whoever runs it needs to set up the file store.",
    samples: [{ status: 503, reason: 'file-store-missing', field: 'file-store' }, { status: 503, reason: 'the room file store is not set up' }, { status: 503 }],
  },
];

let unmapped = 0;
function resetUnmapped() { unmapped = 0; }
function unmappedCount() { return unmapped; }
function assertNoUnmapped() {
  if (unmapped > 0) throw new Error('server-answers: ' + unmapped + ' engine answer(s) reached the catch-all; add a row for each');
}

/**
 * The sentence for an engine answer asked from `call`. Never returns the engine's own text. No matching row: the
 * catch-all, counted, and recorded for the page's defect list (call and status only, never the engine's words).
 */
function sayServerAnswer(call, answer) {
  if (!CALLS.includes(call)) throw new Error('server-answers: unknown call ' + String(call));
  const a = answer || {};
  const row = ROWS.find((r) => r.call === call && r.match(a));
  if (row) return row.say(a);
  unmapped += 1;
  const defects = globalThis.__wbWebDefects;
  if (Array.isArray(defects)) defects.push({ kind: 'unmapped-server-answer', channel: call, count: 1, status: Number(a.status) || 0 });
  return CATCH_ALL;
}

module.exports = { CATCH_ALL, CALLS, ROWS, fill, sayServerAnswer, unmappedCount, resetUnmapped, assertNoUnmapped };
