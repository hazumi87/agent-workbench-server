/** T1/R1: observe actual broker input bytes on BOTH pre-doorbell and W1 engines. */
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { proof } from './_hosting-proof.mjs';
import { isProofRing } from './fixtures/proof-room-ring.mjs';
import { startTraceFixture, until, sleep } from './_w1-trace-fixture.mjs';

const RING = { test: isProofRing };

await proof('W1-TERMINAL-TRACE', async check => {
  const fixture = await startTraceFixture();
  try {
    const { request, brokerInputs } = fixture;
    const agents = [];
    for (const label of ['a', 'b']) {
      const created = await request('/api/recipes', { method: 'POST', value: {
        name: 'T1 inert ' + label, target: 'local', vendor: 'claude-code', runClaude: 1,
        projectDir: join(fixture.dir, 'project-' + label), agent: null, autoApprove: 'off',
      } });
      if (created.status !== 200 || !created.body?.recipe?.id) throw Error('Real owned recipe creation required: ' + created.status);
      agents.push(await fixture.attach(created.body.recipe));
    }
    check(agents.length === 2 && agents.every(a => a.identity.vendorBinary === fixture.binary), 'two actual inert CLI processes live on the owned broker');
    check(agents.every(a => typeof a.brokerSid === 'string') && new Set(agents.map(a => a.brokerSid)).size === 2, 'both actual broker session identities are known and distinct');
    const created = await request('/api/rooms', { method: 'POST', value: { name: 'Owned W1 terminal proof' } });
    const roomId = created.body?.id;
    if (created.status !== 200 || !roomId) throw Error('Owned room creation required');
    const seats = [];
    for (let i = 0; i < agents.length; i++) {
      const agent = agents[i];
      const recipeId = agent.paneid.slice('recipe:'.length).split('#')[0];
      const seated = await request('/api/rooms/' + roomId + '/seats', { method: 'POST', value: { recipe_id: recipeId, occupant: agent.paneid, handle: 'proof-' + (i ? 'b' : 'a') } });
      if (seated.status !== 200 || !seated.body?.seat?.handle) throw Error('Real live seat binding required: ' + seated.status);
      seats.push(seated.body.seat);
      await fixture.ready(agent);
    }
    check(seats.every((seat, i) => seat.handle === 'proof-' + (i ? 'b' : 'a')), 'both named seats are bound to live inert panes');
    const api = await request('/account/token', { method: 'POST', value: { label: 'owned T1 agent sender' } });
    if (api.status !== 200 || typeof api.body?.token !== 'string') throw Error('Owned non-person API credential required');
    const agentHeaders = { authorization: 'Bearer ' + api.body.token };
    check((await request('/api/rooms', { signedIn: false, headers: agentHeaders })).status === 200, 'agent credential authenticates for an allowed read');
    if (fixture.hasOriginTrace) {
      check((await request('/api/diag/pty-writes', { signedIn: false })).status === 401, 'unsigned caller cannot read origin trace');
      check((await request('/api/diag/pty-writes', { signedIn: false, headers: agentHeaders })).status === 403, 'authenticated non-person cannot read origin trace');
    } else {
      // Pre-W1 has no origin endpoint. Core R1 assertions STILL run over
      // actual broker frames; no assertion is skipped or passed for missing bytes.
      console.log('CAPABILITY pre-W1: origin labels unavailable; broker input capture remains authoritative');
    }

    const target = agents[1];
    const beforeKeysTrace = (await fixture.writes())?.length ?? 0;
    const keys = 'PERSON-KEYS-92c6' + String.fromCharCode(27) + '[D' + String.fromCharCode(127) + '\r';
    fixture.send({ type: 'input', paneid: target.paneid, data: keys });
    await until(() => brokerInputs.some(r => r.sid === target.brokerSid && r.data === keys), 'exact own keystrokes reach actual broker input frame');
    check(brokerInputs.filter(r => r.sid === target.brokerSid && r.data === keys).length === 1, 'actual broker receives the test keystrokes exactly once and unchanged');
    if (fixture.hasOriginTrace) {
      const personWrites = (await fixture.writes()).slice(beforeKeysTrace).filter(r => r.origin === 'person');
      check(personWrites.length === 1 && personWrites[0].paneid === target.paneid && personWrites[0].text === keys, 'person-origin record exactly equals the actual keystroke frame');
    }
    await fixture.ready(target);
    const start = brokerInputs.length;
    const traceStart = (await fixture.writes())?.length ?? 0;
    const personBody = '@proof-b PERSON-LINE-MARKER-e9c1 body-only-person';
    const peerBody = '@proof-b PEER-MARKER-7f3a body-only-peer $(id) ' + String.fromCharCode(96) + 'id' + String.fromCharCode(96) + ' ; &&';
    const postLine = (text, options = {}) => request('/api/rooms/' + roomId + '/line', { method: 'POST', value: { text, ...options.from }, ...options.auth });
    const chat = response => response.body?.entries?.find(e => e.kind === 'chat');
    async function waitForLine(id, after) {
      if (!Number.isSafeInteger(id)) throw Error('Exact persisted chat line id is required');
      return until(() => brokerInputs.slice(after).find(r => r.sid === target.brokerSid &&
        (r.data.includes('#' + id + ']') || r.data.includes('#' + id + ' '))), 'actual broker delivery correlated to chat #' + id);
    }
    const person = await postLine(personBody);
    const personLine = chat(person);
    check(person.status === 200 && personLine?.author === 'user' && personLine.body === personBody &&
      (personLine.author_kind === undefined || personLine.author_kind === 'person'), 'person room body persists exactly under the person author');
    if (person.status !== 200 || !personLine) throw Error('Person room post must be admitted');
    await waitForLine(personLine.id, start);
    check(true, 'person delivery is correlated to its exact chat line id at the broker');
    await sleep(100);
    await fixture.ready(target);
    const afterPerson = brokerInputs.length;
    const peer = await postLine(peerBody, { from: { from: { paneid: agents[0].paneid } }, auth: { signedIn: false, headers: agentHeaders } });
    const peerLine = chat(peer);
    check(peer.status === 200 && peerLine?.author_seat === seats[0].id && peerLine.body === peerBody &&
      (peerLine.author_kind === undefined || peerLine.author_kind === 'agent'), 'agent A room body persists exactly under its live seat author');
    if (peer.status !== 200 || !peerLine) throw Error('Agent A room post must be admitted: ' + peer.status);
    await waitForLine(peerLine.id, afterPerson);
    check(true, 'agent A delivery to B is correlated to its exact chat line id at the broker');
    await sleep(100);

    const observed = brokerInputs.slice(start);
    const sidToPane = new Map(agents.map(a => [a.brokerSid, a.paneid]));
    check(observed.length > 0 && observed.every(r => sidToPane.has(r.sid) && r.bytes === Buffer.byteLength(r.data) &&
      r.sha256 === createHash('sha256').update(r.data).digest('hex')), 'every observed real broker input has known ownership and exact byte metadata');
    const bySid = new Map();
    for (const r of observed) bySid.set(r.sid, (bySid.get(r.sid) ?? '') + r.data);
    const fragments = ['PERSON-LINE-MARKER-e9c1', 'PEER-MARKER-7f3a', 'body-only-person', 'body-only-peer', '$(id)', String.fromCharCode(96) + 'id' + String.fromCharCode(96), '; &&'];
    const leaked = fragments.filter(fragment => [...bySid.values()].some(text => text.includes(fragment)));
    check(leaked.length === 0, 'R1: no person/peer room-body fragment reaches ANY actual broker input');
    if (leaked.length) console.log('R1 EVIDENCE forbidden-fragments=' + JSON.stringify(leaked));
    check(observed.every(r => r.data === '\r' || RING.test(r.data)), 'R1: every non-person broker input is the agreed fixed ring or Enter');
    if (fixture.hasOriginTrace) {
      const trace = (await fixture.writes()).slice(traceStart);
      check(trace.every(r => r.origin === 'room-typer'), 'room delivery creates no person/launch/dialog/voice-origin typing');
      check(trace.every(r => r.text === '\r' || RING.test(r.text)), 'origin trace independently admits only fixed doorbells and Enter');
      check(agents.every(agent => trace.filter(r => r.paneid === agent.paneid).map(r => r.text).join('') ===
        observed.filter(r => r.sid === agent.brokerSid).map(r => r.data).join('')), 'actual broker bytes match origin trace per pane, so bypass writes cannot hide');
    }
    console.log('BROKER TRACE SUMMARY input-frames=' + observed.length + ' person-line=' + personLine.id + ' peer-line=' + peerLine.id +
      ' origin-trace=' + fixture.hasOriginTrace + ' ring-contract=fixed-json-doorbell');
  } finally { await fixture.close(); }
});
