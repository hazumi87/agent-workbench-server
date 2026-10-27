// Screen-state vocabulary for the Workrooms wizard. No mount, process launch or
// detector here; callers consume the frozen bridge, never terminal text.
const names = {'claude-code':'Claude Code','codex-cli':'Codex','gemini-cli':'Gemini'};
export function agentWords(row) {
  let chip, detail;
  if (row.installed === 'checking') {chip = 'Checking…'; detail = 'Checking this computer…';}
  else if (row.installed === 'installing') {chip = 'Installing'; detail = 'Follow the instructions in the terminal.';}
  else if (row.installed === 'failed') {chip = 'Install failed'; detail = (names[row.id] || 'The agent') + " didn't install. Check the terminal for the reason, then try again.";}
  else if (row.installed === 'missing') {chip = 'Not installed'; detail = 'Choose Install to set up this agent.';}
  else if (row.installed !== 'installed') {chip = "Couldn't check"; detail = "The version check did not finish. Choose Check again.";}
  else if (row.presenceOnly === true) {chip = 'Installed'; detail = 'Installed. Sign in when it asks.';}
  else if (row.id === 'gemini-cli') {chip = 'Installed'; detail = 'Installed. Sign in in the terminal.';}
  else if (row.auth === 'signed-in') {chip = 'Signed in'; detail = 'Signed in. First-start setup may still be needed.';}
  else if (row.auth === 'needs-sign-in') {chip = 'Needs sign-in'; detail = 'Sign in in the terminal.';}
  else {chip = 'Installed'; detail = 'Installed. Sign in in the terminal.';}
  return {chip, detail, accessibleName:(names[row.id] || 'Agent') + ', ' + chip};
}
export function promptWords(row) {
  const words = {theme:'Choose a theme in the terminal.', login:'Sign in using the terminal instructions.',
    apiKey:'Review the API key question in the terminal.', security:'Read the security notes, then press Enter in the terminal.',
    trust:'Review the folder trust question in the terminal.', mcp:'Review the MCP server question in the terminal.'};
  if (row?.cliPromptReason) return 'Waiting for the terminal state. You can continue through the instructions.';
  if (row && Object.hasOwn(row, 'cliPrompt') && row.cliPrompt === null) return 'The terminal is ready.';
  return Object.hasOwn(words, row?.cliPrompt) ? words[row.cliPrompt] : 'Follow the terminal instructions. You can continue to the next help step.';
}

// Independently mountable states for review; the Workrooms wizard deliberately
// does not import/mount them until its engine contract is admitted.
export function createAgentRows({host, api, onSkip = () => {}}) {
  let alive = true, epoch = 0, busy = false, snapshot = {rows:[]};
  const doc = host.ownerDocument;
  const el = (tag, cls, text) => {const node = doc.createElement(tag); node.className = cls; if (text) node.textContent = text; return node;};
  const status = el('p', 'lf-operation'); status.setAttribute('role', 'status');
  const list = el('div', '');
  function button(text, fn) {
    const b = el('button', 'lf-button tonal', text); b.type = 'button'; b.disabled = busy;
    b.addEventListener('click', fn); return b;
  }
  function paint() {
    if (!alive) return;
    list.replaceChildren();
    for (const row of snapshot.rows || []) {
      if (!Object.hasOwn(names, row.id)) continue;
      const words = agentWords(row), card = el('section', 'lf-card');
      card.setAttribute('aria-label', words.accessibleName);
      card.append(el('h2', '', names[row.id]), el('span', 'lf-location', words.chip), el('p', 'lf-secondary', words.detail));
      const actions = el('div', 'lf-actions');
      if (['missing','failed'].includes(row.installed)) actions.append(button('Install ' + names[row.id], () => void act('install', row.id)));
      if (row.installed === 'installed') actions.append(button('Open terminal for ' + names[row.id], () => void act('openTerminal', row.id)));
      card.append(actions); list.append(card);
    }
    const controls = el('div', 'lf-actions');
    controls.append(button('Check again', () => void act('check')));
    const skip = button('Skip for now', () => {epoch++; busy = false; onSkip();}); skip.disabled = false;
    controls.append(skip); list.append(controls);
  }
  async function act(method, id) {
    if (!alive || busy) return;
    const stamp = ++epoch; busy = true; status.textContent = 'Working…'; paint();
    try {
      const result = await api[method](id);
      if (!alive || stamp !== epoch) return;
      if (result?.ok === false) throw Error();
      const next = await api.getState();
      if (!alive || stamp !== epoch) return;
      snapshot = next; status.textContent = '';
    } catch {if (alive && stamp === epoch) status.textContent = 'Could not finish that action. Try again.';}
    finally {if (alive && stamp === epoch) {busy = false; paint();}}
  }
  host.classList.add('lf-host'); host.replaceChildren(list, status);
  return Object.freeze({
    show(state) {epoch++; busy = false; snapshot = state; status.textContent = ''; paint();},
    destroy() {alive = false; epoch++; host.replaceChildren();}
  });
}
