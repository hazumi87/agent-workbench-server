import { createComposer, canCompose, heldMessage } from './model.mjs';

// Structured App Server output only. This page never sees PTY data, account
// credentials, an RPC method, an executable or a transport address.
export function createCodexPage({ host, api, onAvailability = () => {} }) {
  const el = (tag, cls, text) => {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const button = (text, action) => {
    const node = el('button', 'cx-button', text);
    node.type = 'button'; node.addEventListener('click', action); return node;
  };
  const root = el('div', 'cx-page');
  const title = el('h2', '', 'Codex');
  const subtitle = el('p', 'cx-muted', 'Choose a conversation on this computer.');
  const notice = el('p', 'cx-notice'); notice.setAttribute('role', 'status');
  const choices = el('div', 'cx-choices');
  const conversation = el('section', 'cx-conversation'); conversation.hidden = true;
  const header = el('div', 'cx-header');
  const heading = el('h3');
  const status = el('span', 'cx-muted'); status.setAttribute('role', 'status');
  const close = button('Disconnect', () => void disconnect());
  header.append(heading, status, close);
  const output = el('div', 'cx-output'); output.setAttribute('aria-label', 'Codex conversation');
  const requests = el('div', 'cx-requests');
  const form = el('form', 'cx-composer');
  const label = el('label', '', 'Message');
  const input = el('textarea'); input.rows = 3; input.maxLength = 65536; label.append(input);
  const send = el('button', 'cx-button', 'Send'); send.type = 'submit';
  const sendQueued = button('Send queued message', () => void deliver('sendPending'));
  sendQueued.hidden = true;
  const feedback = el('p', 'cx-muted'); feedback.setAttribute('role', 'status');
  form.append(label, send, sendQueued, feedback);
  conversation.append(header, output, requests, form);
  root.append(title, subtitle, notice, choices, conversation); host.append(root);

  let client = api.bind(), selected = null, state = null, shown = false, busy = false, sending = false, answering = false;
  let epoch = 0, timer = null, painting = '', sent = [];
  let receiptState = null;
  const composer = createComposer();
  const current = token => epoch === token && client.current();
  function stopTimer() { clearTimeout(timer); timer = null; }
  function controls() {
    const pending = composer.pending();
    input.readOnly = !!pending;
    input.disabled = busy || sending || !canCompose(state);
    send.textContent = pending ? 'Check same message' : 'Send';
    send.disabled = busy || sending || answering || (!pending && !canCompose(state));
    sendQueued.hidden = !pending || !['held', 'queued-next'].includes(receiptState);
    sendQueued.disabled = busy || sending || answering || !canCompose(state);
    close.disabled = busy;
    for (const node of choices.querySelectorAll('button')) node.disabled = busy || !!selected;
    for (const node of requests.querySelectorAll('button')) node.disabled = busy || answering;
  }
  function reset() {
    epoch++; stopTimer(); client = api.bind(); selected = null; state = null;
    busy = false; sending = false; answering = false; painting = ''; sent = []; receiptState = null; composer.clear(); input.value = '';
    output.replaceChildren(); requests.replaceChildren(); conversation.hidden = true;
    notice.textContent = ''; feedback.textContent = ''; controls();
  }
  function textBlock(parent, text, cls = '') {
    if (typeof text === 'string' && text) parent.append(el('pre', cls, text));
  }
  function files(parent, values) {
    for (const file of values || []) {
      const details = el('details'); details.append(el('summary', '', `${file.kind || 'Change'} · ${file.path}${file.movePath ? ' → ' + file.movePath : ''}`));
      textBlock(details, file.diff); parent.append(details);
    }
  }
  function paint(next) {
    state = next;
    if (!next?.ok) { notice.textContent = heldMessage(next?.reason); controls(); return; }
    const view = next.view;
    status.textContent = view?.state === 'waiting' ? 'Needs your answer' : view?.state === 'active' ? 'Working' : view?.state === 'idle' ? 'Ready' : 'Paused';
    notice.textContent = next.snapshot?.reason ? heldMessage(next.snapshot.reason) : view?.reason ? heldMessage(view.reason) : '';
    const fingerprint = JSON.stringify([view, sent]);
    if (fingerprint !== painting) {
      painting = fingerprint;
      const nearBottom = output.scrollHeight - output.scrollTop - output.clientHeight < 80;
      output.replaceChildren(); requests.replaceChildren();
      for (const message of sent) {
        const row = el('article', 'cx-message cx-human'); row.append(el('b', '', 'You'));
        textBlock(row, message.text); output.append(row);
      }
      for (const item of view?.items || []) {
        const row = el('article', 'cx-message');
        const names = { agentMessage: 'Codex', plan: 'Plan', commandExecution: 'Command', fileChange: 'File changes', mcpToolCall: 'Tool' };
        row.append(el('b', '', names[item.kind] || 'Codex'));
        if (item.kind !== 'agentMessage') row.append(el('small', 'cx-muted', item.status));
        textBlock(row, item.text); textBlock(row, item.command);
        if (item.cwd) row.append(el('p', 'cx-muted', item.cwd));
        if (item.tool) row.append(el('p', '', [item.server, item.tool].filter(Boolean).join(' · ')));
        files(row, item.files);
        if (item.truncated) row.append(el('p', 'cx-muted', 'Only part of this item is shown.'));
        output.append(row);
      }
      if (view?.truncated || view?.outputStatus === 'truncated') output.append(el('p', 'cx-muted', 'Only part of the conversation is shown.'));
      if (view?.outputStatus === 'unavailable') output.append(el('p', 'cx-muted', 'Earlier output is unavailable.'));
      for (const request of view?.requests || []) {
        const card = el('section', 'cx-request');
        card.append(el('h4', '', request.kind === 'command' ? 'Allow this command?' : 'Allow these file changes?'));
        textBlock(card, request.command); textBlock(card, request.reason);
        if (request.cwd) card.append(el('p', 'cx-muted', request.cwd));
        files(card, request.files);
        const actions = el('div', 'cx-actions');
        for (const [decision, word] of [['accept', 'Allow once'], ['decline', 'Decline'], ['cancel', 'Cancel turn']]) {
          if (request.allowedDecisions.includes(decision)) actions.append(button(word, () => void answer(request.requestId, decision)));
        }
        card.append(actions); requests.append(card);
      }
      if (nearBottom) output.scrollTop = output.scrollHeight;
    }
    controls();
  }
  function schedule() {
    stopTimer();
    if (shown && selected && client.current()) timer = setTimeout(() => void readState(), 650);
  }
  async function readState() {
    const token = epoch, id = selected?.id;
    if (!id || !client.current()) return;
    if (busy) { schedule(); return; }
    try { const value = await client.state(id); if (current(token) && selected?.id === id) paint(value); }
    catch { if (current(token)) notice.textContent = 'Could not refresh this conversation.'; }
    if (current(token)) schedule();
  }
  async function catalog() {
    const token = epoch;
    try {
      const value = await client.list();
      if (!current(token)) return;
      onAvailability(value?.enabled === true); choices.replaceChildren();
      // the status line speaks only while the Codex tab is shown: a hidden tab never announces a failure (a server with no Codex asked on every load); showing the tab asks again
      if (!value?.ok) { notice.textContent = shown ? heldMessage(value?.reason) : ''; return; }
      notice.textContent = shown && !value.entries.length ? 'No Codex conversations are set up for this account.' : '';
      for (const entry of value.entries) {
        const row = el('div', 'cx-choice'); row.append(el('b', '', entry.label));
        const actions = el('div', 'cx-actions');
        actions.append(button('Create conversation', () => void open(entry, 'create')), button('Resume', () => void open(entry, 'recover')));
        row.append(actions); choices.append(row);
      }
      controls();
    } catch { if (current(token)) notice.textContent = shown ? 'Could not load Codex conversations.' : ''; }
  }
  async function open(entry, mode) {
    if (busy || selected || !client.current()) return;
    const token = epoch; busy = true; controls(); notice.textContent = mode === 'create' ? 'Creating conversation…' : 'Resuming conversation…';
    try {
      const value = await client.open(entry.id, mode);
      if (!current(token)) return;
      if (!value?.ok) { notice.textContent = heldMessage(value?.reason); return; }
      selected = entry; conversation.hidden = false; heading.textContent = entry.label; paint(value); input.focus();
      const pending = await client.pending(entry.id);
      if (!current(token)) return;
      if (pending?.ok && pending.entries.length) {
        const first = pending.entries[0];
        if (composer.restore(first)) {
          input.value = first.text; receiptState = first.receipt.state;
          feedback.textContent = 'A saved message is waiting. Check its delivery before sending another.';
        }
      } else if (!pending?.ok) {
        notice.textContent = heldMessage(pending?.reason);
      }
    } catch { if (current(token)) notice.textContent = 'Could not open Codex. Check the saved conversation before trying again.'; }
    finally { if (current(token)) { busy = false; controls(); schedule(); } }
  }
  async function disconnect() {
    if (busy || !selected) return;
    const token = epoch; busy = true; controls(); stopTimer();
    try {
      const value = await client.close(selected.id);
      if (!current(token)) return;
      if (!value?.ok) { notice.textContent = heldMessage(value?.reason); return; }
      reset(); await catalog();
    } catch { if (current(token)) notice.textContent = 'Could not confirm that Codex disconnected.'; }
    finally { if (current(token)) { busy = false; controls(); schedule(); } }
  }
  async function answer(requestId, decision) {
    if (busy || answering || !selected || !client.current()) return;
    const token = epoch; answering = true; controls();
    try { const value = await client.respond(selected.id, requestId, decision); if (current(token) && !value?.ok) notice.textContent = heldMessage(value?.reason); }
    catch { if (current(token)) notice.textContent = 'The answer was not confirmed. Refresh before answering again.'; }
    finally { if (current(token)) { answering = false; controls(); await readState(); } }
  }
  async function deliver(verb) {
    if (busy || sending || answering || !selected || !client.current() || (!composer.pending() && !canCompose(state))) return;
    const message = composer.begin(input.value);
    if (!message) { feedback.textContent = 'Enter a message of up to 64 KB.'; return; }
    const token = epoch; sending = true; controls(); feedback.textContent = verb === 'check' ? 'Checking delivery…' : 'Sending…';
    try {
      const result = verb === 'submit' ? await client.submit(selected.id, message.submissionId, message.text)
        : await client[verb](selected.id, message.submissionId, message.recovered === true);
      if (!current(token)) return;
      receiptState = result?.ok ? result.receipt?.state : receiptState;
      const outcome = composer.settle(result);
      if (outcome) {
        if (['accepted', 'steering-accepted'].includes(outcome.state)) sent.push(message);
        sent = sent.slice(-50); input.value = outcome.draft;
        feedback.textContent = outcome.draft ? 'Message was not sent. Your draft is kept.' : 'Sent';
      } else feedback.textContent = ['held', 'queued-next'].includes(receiptState)
        ? 'Message is waiting. Use Send queued message when the conversation is ready.'
        : 'Delivery is not confirmed. Check the same message before sending another.';
    } catch { if (current(token)) feedback.textContent = 'Delivery is not confirmed. Check the same message before sending another.'; }
    finally { if (current(token)) { sending = false; controls(); await readState(); } }
  }
  form.addEventListener('submit', event => {
    event.preventDefault(); void deliver(composer.pending() ? 'check' : 'submit');
  });
  input.addEventListener('keydown', event => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); form.requestSubmit(); }
  });
  controls();
  return {
    refresh: catalog,
    accountChanged() { if (!client.current()) { reset(); void catalog(); } },
    setShown(value) { shown = !!value; if (shown) { void (selected ? readState() : catalog()); } else stopTimer(); },
    dispose() { reset(); root.remove(); },
  };
}
