// P05 (the design s12, the Handbook's ask-for-approval): an agent that needs the person's go posts a line that starts "APPROVAL:" (after an
// optional leading @name). Under that line the person gets a plate: "@{seat} needs your approval." with Approve and "Reply…". Approve posts
// exactly "Approved." as the person, as a reply to the line (the Handbook teaches agents to look for that); "Reply…" posts nothing and
// opens the person's reply box on the line, where their own typed words are the answer (the design: a "Cancel" that cancels nothing would
// lie). Nothing is stored: the plate shows while the line has no reply from the person, and once it has one the plate becomes a quiet
// line. The buttons are the page's own; nothing is ever sent without a tap, and an agent cannot press them.
// m3-chrome.js's icon(), inline: that module touches window when it loads, and this one is unit-tested in node
const icon = (name) => '<span class="ms" aria-hidden="true">' + name + '</span>';

export const APPROVAL_WORDS = Object.freeze({
  needs: (handle) => '@' + handle + ' needs your approval.',
  approve: 'Approve',
  reply: 'Reply…',
  replyName: 'Reply to the approval',
  replyHint: 'Say what you want instead',
  sending: 'Sending…',
  approved: (time) => 'You approved this at ' + time + '.',
  answered: (time) => 'You answered this at ' + time + '.',
  already: 'This approval was already answered.',
});
/** The reply the Approve button posts (the Handbook's exact words). */
export const APPROVED = 'Approved.';

const ASK = /^\s*(?:@[A-Za-z0-9-]+[,:]?\s+)?approval\s*:\s*(\S[\s\S]*)$/i;
const metaOf = (e) => (e && e.meta && typeof e.meta === 'object' ? e.meta : null);
const fromPerson = (x) => x.author === 'user' && (x.author_kind === undefined || x.author_kind === 'person');

/**
 * The asking seat's handle when `e` is an approval ask, else null. Only a chat line AUTHORED by a seat of this room whose handle is the
 * line's author counts: never the person's own line, the engine's, another room's seat (a cross-post), a fact, or text that merely contains
 * "approval:" (a quote, a code block, an attachment's name). seatOf(seatId) -> {id, handle} | null, the room's seats.
 */
export function approvalAsk(e, seatOf) {
  if (!e || e.kind !== 'chat' || !e.author_seat || e.author === 'user' || e.author === 'room') return null;
  if (e.author_kind !== undefined && e.author_kind !== 'agent') return null;
  const m = metaOf(e);
  if (m && m.hidden === true) return null;
  const seat = typeof seatOf === 'function' ? seatOf(e.author_seat) : null;
  if (!seat || seat.id !== e.author_seat || !seat.handle || seat.handle !== e.author) return null;
  return ASK.test(String(e.body ?? '')) ? seat.handle : null;
}

/** The person's answer to line `id` among `entries` ({entry, approved}), or null. Any line of the person's that replies to it counts. */
export function approvalAnswer(entries, id) {
  for (const x of entries || []) {
    const r = metaOf(x) && metaOf(x).reply;
    if (r && r.id === id && fromPerson(x)) return { entry: x, approved: String(x.body || '').trim() === APPROVED };
  }
  return null;
}

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

/** The quiet line that replaces the plate once the line is answered. */
export function approvalDone(text) {
  const n = el('div', 'wr-approval done');
  n.setAttribute('role', 'status');
  n.innerHTML = icon('check');
  n.appendChild(el('span', 'wr-approvaltx', text));
  return n;
}

/**
 * The plate under an approval ask. onApprove() -> Promise<true | 'answered' | false> (posted / someone answered first / not sent: the
 * plate stays and the page's snackbar says why); onReply() opens the reply box.
 */
export function approvalPlate(handle, { onApprove, onReply }) {
  const n = el('div', 'wr-approval');
  n.setAttribute('role', 'group');
  n.setAttribute('aria-label', APPROVAL_WORDS.needs(handle));
  const head = el('div', 'wr-approvalhead');
  head.innerHTML = icon('shield');
  head.appendChild(el('span', 'wr-approvaltx', APPROVAL_WORDS.needs(handle)));
  const acts = el('div', 'wr-approvalacts');
  const yes = el('button', 'wr-approvalbtn yes', APPROVAL_WORDS.approve);
  const no = el('button', 'wr-approvalbtn no', APPROVAL_WORDS.reply);
  yes.type = no.type = 'button';
  no.setAttribute('aria-label', APPROVAL_WORDS.replyName);
  yes.addEventListener('click', async () => {
    if (yes.disabled) return;
    yes.disabled = no.disabled = true;
    yes.textContent = APPROVAL_WORDS.sending;
    let r = false;
    try { r = await onApprove(); } catch (e) { r = false; }
    if (r === 'answered') { n.replaceWith(approvalDone(APPROVAL_WORDS.already)); return; }
    if (r !== true) { yes.disabled = no.disabled = false; yes.textContent = APPROVAL_WORDS.approve; }
  });
  no.addEventListener('click', () => onReply());
  acts.append(yes, no);
  n.append(head, acts);
  return n;
}
