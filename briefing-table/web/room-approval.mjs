/* APPROVAL ASK (Owner 2026-10-12, room lines [ref] / [ref]). An agent that needs the person's
 * sign-off posts a line that starts `APPROVAL:` and says what it wants to do. Under that line the
 * person gets two buttons: Approve (posts "Approved." as a reply to the line, so the asking seat is
 * answered and woken the usual way) and Cancel (opens the composer already replying to the line,
 * for what they need to say instead). Nothing is stored for it: the plate shows while the line
 * has no reply from the person, so it survives a reload and goes the moment either answer is sent.
 * The agent cannot press it: the buttons are the page's, and the answer is posted as the person. */
import { replyOfEntry } from '/room-reply.mjs';

/** `APPROVAL: …` (optionally after a leading @address), from a seat, in a chat line. */
const ASK = /^\s*(?:@[A-Za-z0-9-]+[,:]?\s+)?approval\s*:\s*(\S[\s\S]*)$/i;

/** The thing asked for, or null when this line is not an approval ask. Only a seat's line counts. */
export function approvalAsk(e) {
  if (!e || e.kind !== 'chat' || !e.author_seat || e.author === 'user') {
    return null;
  }
  const m = ASK.exec(String(e.body ?? ''));
  return m ? m[1].trim() : null;
}

/** Has the person answered this line (any line of theirs that replies to it)? */
export function approvalAnswered(entries, id) {
  for (const x of entries) {
    if (x.author === 'user' && replyOfEntry(x)?.id === id) {
      return true;
    }
  }
  return false;
}

/** The plate: `rm-notice` (the design system plate) with two buttons. `onApprove()` and `onCancel()` are the page's. */
export function approvalPlate(handle, onApprove, onCancel) {
  const n = document.createElement('div');
  n.className = 'rm-notice rm-approval';
  n.setAttribute('role', 'status');
  const t = document.createElement('span');
  t.className = 'rm-notice-text';
  const who = document.createElement('b');
  who.textContent = `@${handle} needs your approval.`;
  t.append(who);
  const yes = document.createElement('button');
  yes.type = 'button';
  yes.className = 'rm-notice-act';
  yes.textContent = 'Approve';
  const no = document.createElement('button');
  no.type = 'button';
  no.className = 'rm-notice-act rm-notice-alt';
  no.textContent = 'Cancel';
  yes.addEventListener('click', async () => {
    yes.disabled = true;
    no.disabled = true;
    yes.textContent = 'Sending…';
    if ((await onApprove()) !== true) {
      yes.disabled = false; // not sent: the plate stays, the toast says why
      no.disabled = false;
      yes.textContent = 'Approve';
    }
  });
  no.addEventListener('click', () => onCancel());
  n.append(t, yes, no);
  return n;
}
