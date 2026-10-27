/**
 * PANE TOKENS, S1 (the design notes §3, §4.1, §4.3, §7 unit list):
 *   - the resolver's refusal codes, generation mismatch, origin mismatch;
 *   - mint / supersede / revoke / boot reconcile, and the token FILE;
 *   - generation: adoption does not bump it, a spawn or restore does;
 *   - delivery: the ssh command line, every typed prelude and every argv never
 *     carry the token; only the broker env (remote) or a file path (local);
 *   - the per-pane room_post rate;
 *   - the pane-token fabric send: `from` forced, `ref room:*` and room
 *     threads refused;
 *   - the rooms door: a byte-identical `not_seated`, GET /api/rooms filtered,
 *     `from_mismatch`, posting as its seat;
 *   - seat binding is `human_only` for a seat actor on the pane token, on
 *     bearer + `from` and on the typed line (HARBOR_WB_SEAT_BIND=human), and
 *     unchanged with that flag off.
 *   - security review fixes: introspect skips the origin check (P1-B); a
 *     non-string thread is refused (P2-1); a failed spawn revokes only its
 *     own token (P2-2); a throw on the pane-token path is a bare 500 (P2-3);
 *     the agent room view mints no frame token (P2-4); asset uploads are
 *     rate-limited (P2-5); the spawn env never inherits a pane token (P2-6).
 *
 * SAFETY: a temp table and a temp token dir, set BEFORE any import; fabric
 * off. Nothing listens, nothing spawns. Run with tsx.
 */
import { mkdtempSync, rmSync, readFileSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

const dir = mkdtempSync(join(tmpdir(), 'wb-pane-tokens-'));
process.env.HARBOR_WB_TABLE = join(dir, 'mapping.db');
process.env.HARBOR_WB_CHANNELS_DIR = join(dir, 'mcp');
process.env.HARBOR_WB_FABRIC_URL = '';
process.env.HARBOR_WB_NATS_URL = '';
process.env.HARBOR_WB_ROOM_FABRIC = '0';
process.env.HARBOR_WB_NODE = 'homebase';
delete process.env.HARBOR_WB_SEAT_BIND;
delete process.env.HARBOR_WB_PANE_TOKENS;

const { table } = await import('../src/table/endpoint.ts');
const pt = await import('../src/engine/pane-tokens.ts');
const { buildLaunch, sessionEnv } = await import('../src/engine/launch.ts');
const channels = await import('../src/engine/channels.ts');
const rooms = await import('../src/server/rooms.ts');
const { spawnEnv } = await import('../src/engine/cli-host.ts');
type Target = import('../src/engine/launch.ts').Target;
type Recipe = import('../src/table/store.ts').Recipe;

let passed = 0;
let failed = 0;
function ok(cond: unknown, msg: string): void {
  if (cond) {
    passed++;
    console.log(`  ✓ ${msg}`);
  } else {
    failed++;
    console.log(`  ✗ ${msg}`);
  }
}
function eq(actual: unknown, expected: unknown, msg: string): void {
  ok(Object.is(actual, expected), `${msg} (got ${JSON.stringify(actual)})`);
}

/* A request as the resolver and the route handlers read it. */
function req(method: string, url: string, body?: unknown, headers: Record<string, string> = {}): any {
  const r = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]) as any;
  r.method = method;
  r.url = url;
  r.headers = headers;
  return r;
}
function res(): { out: { status: number; raw: string; body: any }; r: any } {
  const out = { status: 0, raw: '', body: null as any };
  return {
    out,
    r: {
      writeHead(s: number) {
        out.status = s;
      },
      end(x?: unknown) {
        out.raw = String(x ?? '');
        try {
          out.body = JSON.parse(out.raw);
        } catch {
          out.body = null;
        }
      },
    },
  };
}
const bearer = (t: string) => ({ authorization: `Bearer ${t}` });

function live(paneid: string, recipeId: string | null, agent: string | null, generation: number): void {
  table.upsert({ paneid, recipe_id: recipeId, server: 'local', vendor: 'claude-code', agent, session_id: null, state: 'live', generation });
}

try {
  /* ------------------------------------------------------------------ */
  console.log('\n[mint (local): a 0600 file, only its PATH in the env]');
  live('recipe:a', 'rec-a', 'alpha', 1);
  const mA = pt.mint('recipe:a', 1, 'file');
  const fileA = pt.tokenFileFor('recipe:a');
  eq(mA?.env[pt.TOKEN_FILE_ENV], fileA, 'the env names the file');
  eq(mA?.env[pt.TOKEN_ENV], undefined, 'and never the token itself');
  ok(existsSync(fileA), 'the file exists');
  if (process.platform !== 'win32') {
    eq(statSync(fileA).mode & 0o777, 0o600, 'mode 0600');
  }
  const tokA = readFileSync(fileA, 'utf8');
  eq(tokA.length, 43, '32 random bytes, base64url');
  const hashA = table.currentPaneToken('recipe:a')?.hash;
  ok(!!hashA && hashA !== tokA && !hashA.includes(tokA), 'only the hash is stored');

  console.log('\n[resolve: the refusal codes]');
  eq(pt.resolve(req('GET', '/')), null, 'no bearer: not a pane-token request at all');
  const good = pt.resolve(req('GET', '/', undefined, bearer(tokA)));
  ok(good?.ok === true, 'the token resolves');
  if (good?.ok) {
    eq(good.principal.kind, 'pane', 'kind pane');
    eq(good.principal.paneid, 'recipe:a', 'its pane');
    eq(good.principal.generation, 1, 'its generation');
    eq(good.principal.origin, 'local', 'origin local');
  }
  const code = (headers: Record<string, string>) => {
    const r = pt.resolve(req('GET', '/', undefined, headers));
    return r && !r.ok ? r.code : r ? 'ok' : null;
  };
  eq(code(bearer('not-a-token')), 'token_invalid', 'unknown token → token_invalid (the server lets it meet the normal gate)');
  eq(code({ ...bearer(tokA), 'x-forwarded-for': '100.1.2.3' }), 'origin_mismatch', 'a LOCAL token arriving through Serve (x-forwarded-for) → origin_mismatch');
  table.upsert({ paneid: 'recipe:a', server: 'local', vendor: 'claude-code', agent: 'alpha', session_id: null, state: 'live', generation: 2 });
  eq(code(bearer(tokA)), 'generation_mismatch', 'the row moved to generation 2 → generation_mismatch');
  table.upsert({ paneid: 'recipe:a', server: 'local', vendor: 'claude-code', agent: 'alpha', session_id: null, state: 'live', generation: 1 });
  eq(code(bearer(tokA)), 'ok', 'back on generation 1 → ok');
  table.setState('recipe:a', 'dehydrated');
  eq(code(bearer(tokA)), 'pane_not_live', 'the pane is not live → pane_not_live');
  table.setState('recipe:a', 'live');

  console.log('\n[mint (remote): the broker env only; origin remote needs x-forwarded-for]');
  live('recipe:v', 'rec-v', 'vee', 1);
  const mV = pt.mint('recipe:v', 1, 'env');
  const tokV = mV?.env[pt.TOKEN_ENV] ?? '';
  eq(tokV.length, 43, 'the token rides the env');
  eq(mV?.env[pt.TOKEN_FILE_ENV], undefined, 'no file for a remote pane');
  ok(!existsSync(pt.tokenFileFor('recipe:v')), 'and none written');
  eq(code(bearer(tokV)), 'origin_mismatch', 'a REMOTE token with no x-forwarded-for → origin_mismatch');
  eq(code({ ...bearer(tokV), 'x-forwarded-for': '100.1.2.3' }), 'ok', 'through Serve → ok');
  {
    /* ACCOUNT SPLIT (HARBOR_WB_PANE_TOKEN_DELIVERY=env): the pty is on THIS host (another OS account), so the token rides the broker env but its caller is local: no x-forwarded-for, and it must work over loopback */
    process.env.HARBOR_WB_PANE_TOKEN_DELIVERY = 'env';
    live('recipe:split', 'rec-split', 'split', 1);
    const mS = pt.mint('recipe:split', 1, 'env');
    const tokS = mS?.env[pt.TOKEN_ENV] ?? '';
    eq(tokS.length, 43, 'split: the token rides the env');
    ok(!existsSync(pt.tokenFileFor('recipe:split')), 'split: no token file');
    eq(code(bearer(tokS)), 'ok', 'split: the env token over loopback (no x-forwarded-for) is accepted');
    eq(code({ ...bearer(tokS), 'x-forwarded-for': '100.1.2.3' }), 'origin_mismatch', 'split: arriving through a proxy is not the agent on the box');
    eq(code(bearer(tokS.slice(0, -1) + (tokS.endsWith('A') ? 'B' : 'A'))), 'token_invalid', 'split: a wrong token is invalid');
    delete process.env.HARBOR_WB_PANE_TOKEN_DELIVERY;
  }
  eq(pt.mint('recipe:ssh', 1, 'none'), null, 'ssh: nothing minted');

  console.log('\n[supersede, revoke, reconcile]');
  const mA2 = pt.mint('recipe:a', 2, 'file');
  table.upsert({ paneid: 'recipe:a', server: 'local', vendor: 'claude-code', agent: 'alpha', session_id: null, state: 'live', generation: 2 });
  const tokA2 = readFileSync(fileA, 'utf8');
  ok(!!mA2 && tokA2 !== tokA, 'a new mint writes a new token to the same file');
  eq(code(bearer(tokA)), 'token_revoked', 'the earlier token → token_revoked (superseded in the same transaction)');
  eq(code(bearer(tokA2)), 'ok', 'the new one works');
  pt.revoke('recipe:a', 'ended');
  eq(code(bearer(tokA2)), 'token_revoked', 'revoked when the pane ends');
  ok(!existsSync(fileA), 'and its file is deleted');
  live('recipe:k', 'rec-k', 'kay', 1);
  const tokK = pt.mint('recipe:k', 1, 'file') ? readFileSync(pt.tokenFileFor('recipe:k'), 'utf8') : '';
  table.setState('recipe:k', 'killed');
  const keptBefore = code({ ...bearer(tokV), 'x-forwarded-for': '1.1.1.1' });
  eq(pt.reconcile(), 1, 'boot reconcile revokes the one token whose pane is gone');
  eq(code(bearer(tokK)), 'token_revoked', '...that token');
  ok(!existsSync(pt.tokenFileFor('recipe:k')), '...and deletes its file');
  eq(code({ ...bearer(tokV), 'x-forwarded-for': '1.1.1.1' }), keptBefore, 'a live pane on its own generation keeps its token (an adopted pane)');

  /* ------------------------------------------------------------------ */
  console.log('\n[generation: a spawn or restore bumps it, adoption and bookkeeping do not]');
  table.upsert({ paneid: 'recipe:g', recipe_id: 'rec-g', server: 'local', vendor: 'claude-code', agent: 'gee', session_id: 's1', state: 'dehydrated' });
  eq(table.get('recipe:g')?.generation, 0, 'a row that never spawned: generation 0');
  live('recipe:g', 'rec-g', 'gee', (table.get('recipe:g')?.generation ?? 0) + 1);
  eq(table.get('recipe:g')?.generation, 1, 'the spawn writes 1');
  table.setState('recipe:g', 'dehydrated');
  eq(table.get('recipe:g')?.generation, 1, 'dehydrating keeps it');
  table.upsert({ paneid: 'recipe:g', server: 'local', vendor: 'claude-code', agent: 'gee', session_id: 's1', state: 'dehydrated' });
  eq(table.get('recipe:g')?.generation, 1, 'a bookkeeping upsert with no generation (the picker path) keeps it');
  table.setState('recipe:g', 'live');
  table.reconcileStaleLive(['recipe:g']);
  eq(table.get('recipe:g')?.generation, 1, 'boot reconcile + adoption of a broker-held pane: unchanged');
  live('recipe:g', 'rec-g', 'gee', (table.get('recipe:g')?.generation ?? 0) + 1);
  eq(table.get('recipe:g')?.generation, 2, 'a restore (the next spawn) → 2');

  /* ------------------------------------------------------------------ */
  console.log('\n[delivery: never on argv, never typed, never in sessionEnv]');
  const TOKEN = 'TESTTOKEN_abcdefghijklmnopqrstuvwxyz0123456789';
  const recipe = (over: Partial<Recipe>): Recipe =>
    ({
      id: 'r1', name: 'T', target: 'x', projectDir: '/srv/code/thing', vendor: 'claude-code', agent: 'thing', runClaude: 1,
      model: null, resume: 0, resumeName: null, initCmd: null, closeOnCleanExit: 0, statusPath: null, color: null, fg: null,
      bg: null, watermark: null, fontSize: null, logo: null, created_at: 0, updated_at: 0, last_launched_at: null, ...over,
    }) as Recipe;
  const targets: Array<[Target, pt.Delivery]> = [
    [{ id: 'local', label: 'L', kind: 'local', broker: 'local' }, 'file'],
    [{ id: 'homebase-resident', label: 'NR', kind: 'ssh', sshAlias: 'homeserver-svc-ops', broker: 'homebase' }, 'file'],
    [{ id: 'vrpc', label: 'V', kind: 'local', broker: 'vrpc', shell: 'powershell.exe' }, 'env'],
    [{ id: 'ssh', label: 'S', kind: 'ssh', sshAlias: 'host-user', broker: 'local' }, 'none'],
    [{ id: 'ssh-client', label: 'SC', kind: 'ssh', sshAlias: 'host-user', broker: 'vrpc', sshClient: true }, 'none'],
  ];
  {
    /* engine and broker on DIFFERENT OS accounts (hosted + R7): the token rides the broker env, no file; a target with no pty (ssh) still gets none */
    process.env.HARBOR_WB_PANE_TOKEN_DELIVERY = 'env';
    eq(pt.deliveryFor(targets[0][0]), 'env', 'account split: a local-broker pane gets env delivery, never a file');
    eq(pt.deliveryFor(targets[3][0]), 'none', 'account split: an ssh target still has no delivery');
    delete process.env.HARBOR_WB_PANE_TOKEN_DELIVERY;
  }
  for (const [t, want] of targets) {
    eq(pt.deliveryFor(t), want, `${t.id}: delivery ${want}`);
    const vrpc = channels.isVrpcRelayTarget(t);
    const plan = vrpc
      ? channels.planVrpcLaunch({ enabled: true, vendor: 'claude-code', shell: t.shell, paneid: 'recipe:r1', slug: 'thing', v: channels.vrpcDefaults() })
      : null;
    const channelConfig = plan?.on ? { configRef: plan.configRef, prelude: plan.prelude } : '/tmp/x.json';
    const spec = buildLaunch(recipe({ target: t.id }), t, null, null, { paneid: 'recipe:r1', channelConfig });
    const env = want === 'env' ? { [pt.TOKEN_ENV]: TOKEN } : want === 'file' ? { [pt.TOKEN_FILE_ENV]: '/tmp/p.token' } : null;
    const desc = env ? pt.withToken(spec.descriptor, env) : spec.descriptor;
    const visible = JSON.stringify([desc.binary, desc.args ?? [], desc.cwd ?? null, spec.inject ?? null]);
    ok(!visible.includes(TOKEN), `${t.id}: the token is on no argv and in no typed line (ssh command line, prelude, claude line)`);
    ok(!JSON.stringify(spec.descriptor.env ?? {}).includes(TOKEN), `${t.id}: buildLaunch's own env (sessionEnv, the ssh export prefix) never holds it`);
    if (plan?.on) {
      ok(!plan.prelude.includes(TOKEN) && !JSON.stringify(plan.config).includes(TOKEN), `${t.id}: the VRPC prelude and its MCP config carry no token`);
    }
    eq((desc.env ?? {})[pt.TOKEN_ENV] ?? null, want === 'env' ? TOKEN : null, `${t.id}: HARBOR_WB_PANE_TOKEN only on a remote broker spawn`);
  }
  ok(!JSON.stringify(sessionEnv({ paneid: 'p', slug: 's', vendor: 'v' })).includes('PANE_TOKEN'), 'sessionEnv has no token variable at all');
  eq(pt.isSeatable('rec', 'cli-manager', null), false, 'a plain shell (no slug) is not seatable: no token');
  eq(pt.isSeatable(null, 'claude-code', 'x'), false, 'a pane with no recipe is not seatable');
  eq(pt.isSeatable('rec', 'gemini-cli', 'x'), true, 'any seatable vendor gets one, not only claude');

  /* ------------------------------------------------------------------ */
  console.log('\n[room_post rate: 20 a rolling minute per pane]');
  pt.resetRates();
  let allowed = 0;
  for (let i = 0; i < 20; i++) {
    allowed += pt.takeRoomPost('p', 1000).ok ? 1 : 0;
  }
  eq(allowed, 20, '20 in a minute pass');
  const r21 = pt.takeRoomPost('p', 1500);
  ok(!r21.ok && r21.retryAfter === 60, `the 21st is refused with retry_after (got ${JSON.stringify(r21)})`);
  ok(pt.takeRoomPost('q', 1500).ok, 'another pane is not affected');
  ok(pt.takeRoomPost('p', 61_001).ok, 'a minute later it passes again');

  /* ------------------------------------------------------------------ */
  console.log('\n[fabric send on a pane token: from forced, room refs refused]');
  const own = (f: unknown) => pt.isOwnPane(f, 'recipe:a');
  const threads = (th: string) => th === 'room-thread-1';
  eq(pt.fabricSendRefusal({ to: 'x', body: 'hi' }, own, threads), null, 'no from: allowed (the engine stamps the pane)');
  eq(pt.fabricSendRefusal({ from: { paneid: 'recipe:a' } }, own, threads), null, 'from naming its own pane: allowed');
  eq(pt.fabricSendRefusal({ from: { paneid: 'recipe:v' } }, own, threads)?.error, 'from_mismatch', 'from naming another pane → from_mismatch');
  eq(pt.fabricSendRefusal({ from: 'user' }, own, threads)?.error, 'from_mismatch', 'from "user" → from_mismatch');
  eq(pt.fabricSendRefusal({ ref: 'room:abc/line:4' }, own, threads)?.error, 'room_ref_refused', 'ref room:* → room_ref_refused');
  eq(pt.fabricSendRefusal({ ref: '  ROOM:abc' }, own, threads)?.error, 'room_ref_refused', '...case and leading space do not get past it');
  eq(pt.fabricSendRefusal({ ref: 'ticket' }, own, threads), null, 'another ref: allowed');
  eq(pt.fabricSendRefusal({ thread: 'room-thread-1' }, own, threads)?.error, 'room_thread_refused', "a room's pinned thread → room_thread_refused");
  eq(pt.fabricSendRefusal({ thread: '  room-thread-1 ' }, own, threads)?.error, 'room_thread_refused', 'P2-1: ...padded with spaces, still refused');
  const numThread = pt.fabricSendRefusal({ thread: 1 }, own, (th) => th === '1');
  eq(numThread?.error, 'thread_invalid', 'P2-1: a NUMERIC thread → thread_invalid (it used to pass the room-thread check)');
  eq(numThread?.status, 400, '...400');
  eq(pt.fabricSendRefusal({ thread: ['room-thread-1'] }, own, threads)?.error, 'thread_invalid', 'P2-1: an array thread → thread_invalid');
  eq(pt.fabricSendRefusal({ thread: null }, own, threads), null, 'a null thread is absent: allowed');
  eq(pt.fabricSendRefusal({ thread: 'ticket' }, own, threads), null, 'another string thread: allowed');

  /* ------------------------------------------------------------------ */
  console.log('\n[rooms door on a pane token]');
  for (const [id, agent] of [['rec-a', 'alpha'], ['rec-b', 'beta'], ['rec-c', 'gamma']]) {
    table.upsertRecipe({
      id, name: agent, target: 'local', projectDir: `/x/${agent}`, vendor: 'claude-code', agent, model: null, resume: 0, resumeName: null,
      initCmd: null, closeOnCleanExit: 0, statusPath: null, color: null, fg: null, bg: null, watermark: null, fontSize: null, logo: null,
    } as never);
  }
  live('recipe:rec-a', 'rec-a', 'alpha', 1);
  live('recipe:rec-b', 'rec-b', 'beta', 1);
  live('recipe:rec-c', 'rec-c', 'gamma', 1);
  const R1 = table.createRoom({ name: 'Alpha room' }, { actor: 'user' }).result;
  const seatA = table.addSeat(R1.id, { recipe_id: 'rec-a', occupant: 'recipe:rec-a' }, { actor: 'user' }).result;
  table.addSeat(R1.id, { project: 'spare', handle: 'spare' }, { actor: 'user' });
  const R2 = table.createRoom({ name: 'Beta room' }, { actor: 'user' }).result;
  table.addSeat(R2.id, { recipe_id: 'rec-b', occupant: 'recipe:rec-b' }, { actor: 'user' });
  const R3 = table.createRoom({ name: 'Gamma room' }, { actor: 'user' }).result;
  const seatC = table.addSeat(R3.id, { recipe_id: 'rec-c', occupant: 'recipe:rec-c' }, { actor: 'user' }).result;
  eq(table.getRoom(R1.id)?.lead_seat, seatA.id, 'pane A leads room 1');
  eq(table.getRoom(R3.id)?.lead_seat, seatC.id, 'pane C leads room 3');
  const deps = { projector: async () => (r: any) => r, log: () => {} };
  const agent = async (method: string, url: string, body?: unknown) => {
    const { out, r } = res();
    const handled = await rooms.handleAgent(req(method, url, body), r, url.split('?')[0], 'recipe:rec-a', deps);
    return { handled, ...out };
  };

  const list = await agent('GET', '/api/rooms');
  eq(list.status, 200, 'GET /api/rooms answers');
  eq(JSON.stringify((list.body ?? []).map((r: any) => r.room?.id)), JSON.stringify([R1.id]), '...filtered to the one room pane A sits in');
  const nsB = await agent('GET', `/api/rooms/${R2.id}`);
  const nsX = await agent('GET', '/api/rooms/no-such-room');
  eq(nsB.status, 403, 'another room: 403');
  eq(nsB.body?.error, 'not_seated', '...not_seated');
  eq(nsX.status, nsB.status, 'a room that does not exist: the same status');
  eq(nsX.raw, nsB.raw, '...and byte-identical bytes');
  eq(JSON.stringify(nsB.body?.rooms), JSON.stringify([{ id: R1.id, name: 'Alpha room' }]), 'the answer lists only the caller\'s own rooms');
  eq((await agent('GET', `/api/rooms/${R2.id}/line`)).raw, nsB.raw, 'reading room 2\'s line: the same not_seated');
  eq((await agent('POST', `/api/rooms/${R2.id}/line`, { text: 'hi' })).raw, nsB.raw, 'posting to room 2: the same not_seated');
  eq((await agent('GET', `/api/rooms/${R1.id}`)).status, 200, 'its own room: 200 (roster)');
  eq((await agent('GET', `/api/rooms/${R1.id}/line`)).status, 200, 'its own line: 200');
  for (const [m, u] of [['GET', '/api/diag/rooms'], ['POST', '/api/rooms'], ['PATCH', `/api/rooms/${R1.id}`], ['POST', `/api/rooms/${R1.id}/archive`], ['POST', `/api/rooms/${R1.id}/seats`], ['POST', '/api/rooms/assemble'], ['GET', `/api/rooms/${R1.id}/panels`], ['POST', `/api/rooms/${R1.id}/disconnect`]]) {
    eq((await agent(m, u)).handled, false, `${m} ${u}: not on the allow-list (index answers not_for_pane_token)`);
  }
  pt.resetRates();
  const post = await agent('POST', `/api/rooms/${R1.id}/line`, { text: 'hello from A' });
  eq(post.status, 200, 'a chat post: 200');
  eq(post.body?.entries?.[0]?.author_seat, seatA.id, '...written as its seat');
  const same = await agent('POST', `/api/rooms/${R1.id}/line`, { text: 'again', from: { paneid: 'recipe:rec-a' } });
  eq(same.status, 200, 'a body from naming its own pane: allowed');
  const mism = await agent('POST', `/api/rooms/${R1.id}/line`, { text: 'as B', from: { paneid: 'recipe:rec-b' } });
  eq(mism.status, 403, 'a body from naming another pane: 403');
  eq(mism.body?.error, 'from_mismatch', '...from_mismatch');
  const add = await agent('POST', `/api/rooms/${R1.id}/line`, { text: '/add beta' });
  eq(add.body?.status, 'refused', 'pane token (the LEAD): /add is refused');
  ok(String(add.body?.refused?.error).startsWith('human_only'), `...human_only (got ${add.body?.refused?.error})`);
  const repl = await agent('POST', `/api/rooms/${R1.id}/line`, { text: '/replace @spare with recipe:rec-c' });
  ok(String(repl.body?.refused?.error).startsWith('human_only'), '...and /replace binding a pane is human_only');
  eq(table.roomsForPane('recipe:rec-b').length, 1, 'nothing was bound');
  pt.resetRates();
  let codes: number[] = [];
  for (let i = 0; i < 21; i++) {
    codes.push((await agent('POST', `/api/rooms/${R1.id}/line`, { text: `n${i}` })).status);
  }
  eq(codes.filter((c) => c === 200).length, 20, 'rate: 20 posts pass');
  const last = await agent('POST', `/api/rooms/${R1.id}/line`, { text: 'one too many' });
  eq(last.status, 429, '...the next is 429');
  eq(last.body?.error, 'rate_limited', '...rate_limited');
  ok(typeof last.body?.retry_after === 'number' && last.body.retry_after > 0, '...with retry_after');

  /* ------------------------------------------------------------------ */
  console.log('\n[seat binding on the bearer + from door and the typed line]');
  const bearerDoor = async (method: string, url: string, body?: unknown, human = false) => {
    const { out, r } = res();
    await rooms.handle(req(method, url, body), r, url, null, { ...deps, human });
    return out;
  };
  delete process.env.HARBOR_WB_SEAT_BIND;
  const off = await bearerDoor('POST', `/api/rooms/${R3.id}/seats`, { recipe_id: 'rec-a', handle: 'extra', from: { paneid: 'recipe:rec-c' } });
  eq(off.status, 200, 'flag OFF: the lead may still add a seat with a recipe (unchanged)');
  process.env.HARBOR_WB_SEAT_BIND = 'human';
  const on = await bearerDoor('POST', `/api/rooms/${R3.id}/seats`, { recipe_id: 'rec-b', handle: 'extra2', from: { paneid: 'recipe:rec-c' } });
  eq(on.status, 403, 'flag ON: bearer + from, POST seats with a recipe_id → 403');
  ok(String(on.body?.error).startsWith('human_only'), '...human_only');
  const onOcc = await bearerDoor('POST', `/api/rooms/${R3.id}/seats`, { project: 'bee', handle: 'bee', occupant: 'recipe:rec-b', from: { paneid: 'recipe:rec-c' } });
  ok(onOcc.status === 403 && String(onOcc.body?.error).startsWith('human_only'), '...POST seats with an occupant → human_only');
  const empty = await bearerDoor('POST', `/api/rooms/${R3.id}/seats`, { project: 'later', handle: 'later', from: { paneid: 'recipe:rec-c' } });
  eq(empty.status, 200, '...an EMPTY seat (no recipe, no occupant) is still the lead\'s');
  const extraSeat = table.listSeats(R3.id).find((s) => s.handle === 'extra')!;
  const patch = await bearerDoor('PATCH', `/api/rooms/${R3.id}/seats/${extraSeat.id}`, { occupant: 'recipe:rec-b', from: { paneid: 'recipe:rec-c' } });
  ok(patch.status === 403 && String(patch.body?.error).startsWith('human_only'), '...an occupant PATCH that binds → human_only');
  const start = await bearerDoor('POST', `/api/rooms/${R3.id}/seats/${extraSeat.id}/start`, { from: { paneid: 'recipe:rec-c' } });
  ok(start.status === 403 && String(start.body?.error).startsWith('human_only'), '...seats/:id/start → human_only');
  const typedAdd = await bearerDoor('POST', `/api/rooms/${R3.id}/line`, { text: '/add beta', from: { paneid: 'recipe:rec-c' } });
  ok(typedAdd.body?.status === 'refused' && String(typedAdd.body?.refused?.error).startsWith('human_only'), 'the typed line: /add from the lead → human_only');
  const typedRepl = await bearerDoor('POST', `/api/rooms/${R3.id}/line`, { text: '/replace @extra with recipe:rec-b', from: { paneid: 'recipe:rec-c' } });
  ok(typedRepl.body?.status === 'refused' && String(typedRepl.body?.refused?.error).startsWith('human_only'), 'the typed line: /replace naming a pane → human_only');
  const asm = await bearerDoor('POST', '/api/rooms/assemble', { room: { id: R3.id }, seats: [{ occupant: 'recipe:rec-b' }], key: 'k1', from: { paneid: 'recipe:rec-c' } });
  ok(asm.status === 403 && String(asm.body?.error).startsWith('human_only'), `assemble from the lead → human_only (got ${asm.status} ${asm.body?.error})`);
  const lead = await bearerDoor('POST', `/api/rooms/${R3.id}/line`, { text: '/set lead @extra', from: { paneid: 'recipe:rec-c' } });
  eq(lead.body?.status, 'applied', '/set lead is unchanged');
  const user = await bearerDoor('POST', `/api/rooms/${R3.id}/seats`, { recipe_id: 'rec-b', handle: 'byuser' }, true);
  eq(user.status, 200, 'the USER (a human credential, no from) still binds');
  eq(table.roomsForPane('recipe:rec-b').length, 1, 'no seat actor bound pane B anywhere');
  delete process.env.HARBOR_WB_SEAT_BIND;

  /* ------------------------------------------------------------------ */
  console.log('\n[P1-B: introspect skips the origin check, nothing else]');
  live('recipe:ib', 'rec-ib', 'ib', 1);
  const tokIB = pt.mint('recipe:ib', 1, 'env')?.env[pt.TOKEN_ENV] ?? '';
  const noOrigin = (headers: Record<string, string>) => {
    const r = pt.resolve(req('GET', '/identity/introspect', undefined, headers), { checkOrigin: false });
    return r && !r.ok ? r.code : r ? 'ok' : null;
  };
  eq(code(bearer(tokIB)), 'origin_mismatch', 'a REMOTE token from loopback (the fabric) with the check on → origin_mismatch');
  eq(noOrigin(bearer(tokIB)), 'ok', '...with checkOrigin:false (introspect) → ok');
  const tokIL = pt.mint('recipe:ib', 1, 'file') ? readFileSync(pt.tokenFileFor('recipe:ib'), 'utf8') : '';
  eq(noOrigin({ ...bearer(tokIL), 'x-forwarded-for': '100.1.2.3' }), 'ok', 'a LOCAL token with x-forwarded-for, check off → ok');
  eq(noOrigin(bearer(tokIB)), 'token_revoked', 'revocation still applies (superseded)');
  table.upsert({ paneid: 'recipe:ib', server: 'local', vendor: 'claude-code', agent: 'ib', session_id: null, state: 'live', generation: 2 });
  eq(noOrigin(bearer(tokIL)), 'generation_mismatch', 'generation still applies');
  table.upsert({ paneid: 'recipe:ib', server: 'local', vendor: 'claude-code', agent: 'ib', session_id: null, state: 'live', generation: 1 });
  table.setState('recipe:ib', 'dehydrated');
  eq(noOrigin(bearer(tokIL)), 'pane_not_live', 'liveness still applies');
  pt.revoke('recipe:ib', 'ended');

  /* ------------------------------------------------------------------ */
  console.log('\n[P2-2: a failed spawn revokes only the token it minted]');
  live('recipe:race', 'rec-race', 'race', 1);
  const fileR = pt.tokenFileFor('recipe:race');
  const loser = pt.mint('recipe:race', 1, 'file');
  const winner = pt.mint('recipe:race', 1, 'file');
  const tokWin = readFileSync(fileR, 'utf8');
  ok(!!loser && !!winner && loser.hash !== winner.hash, 'two concurrent spawns mint two tokens (the second supersedes the first)');
  pt.revokeMinted('recipe:race', loser!.hash, 'spawn-failed');
  eq(code(bearer(tokWin)), 'ok', "the LOSER's spawn failed: the winner's token still resolves");
  ok(existsSync(fileR) && readFileSync(fileR, 'utf8') === tokWin, "...and the winner's file is untouched");
  eq(table.paneTokenByHash(loser!.hash)?.revoked_at !== null, true, "the loser's own row is revoked");
  pt.revokeMinted('recipe:race', winner!.hash, 'spawn-failed');
  eq(code(bearer(tokWin)), 'token_revoked', "revoking the winner's own hash revokes it");
  ok(!existsSync(fileR), '...and deletes the file that holds it');

  /* ------------------------------------------------------------------ */
  console.log('\n[P2-3: a throw on the pane-token path is a bare 500]');
  {
    const { out, r } = res();
    await pt.guarded(r, 'GET /x', async () => {
      throw new Error('SECRET /home/svc-ops/.claude/x.token');
    });
    eq(out.status, 500, 'guarded: a throwing handler answers 500');
    eq(out.body?.error, 'internal_error', '...internal_error');
    ok(!out.raw.includes('SECRET'), '...and never the raw error');
  }
  const throwingDeps = { projector: async () => { throw new Error('SECRET projector failure'); }, log: () => {} };
  for (const u of ['/api/rooms', `/api/rooms/${R1.id}`]) {
    const { out, r } = res();
    const handled = await rooms.handleAgent(req('GET', u), r, u, 'recipe:rec-a', throwingDeps as any);
    ok(handled && out.status === 500 && out.body?.error === 'internal_error' && !out.raw.includes('SECRET'), `GET ${u} with a throwing projector: 500 internal_error, no message (got ${out.status} ${out.raw})`);
  }

  /* ------------------------------------------------------------------ */
  console.log('\n[P2-4: the agent room view carries no frameUrl (no frame token minted)]');
  table.addPanel(R1.id, { title: 'Tasks', url: 'http://127.0.0.1:9999/tasks' }, { actor: 'user' });
  const aList = await agent('GET', '/api/rooms');
  const aPanels = aList.body?.[0]?.panels ?? [];
  eq(aPanels.length, 1, 'GET /api/rooms on the token lists the panel');
  eq(aPanels[0]?.frameUrl, undefined, '...with no frameUrl');
  const aOne = await agent('GET', `/api/rooms/${R1.id}`);
  eq(aOne.body?.panels?.length, 1, 'GET /api/rooms/:id on the token lists the panel');
  eq(aOne.body?.panels?.[0]?.frameUrl, undefined, '...with no frameUrl');
  ok(!aList.raw.includes('/frame/t/') && !aOne.raw.includes('/frame/t/'), '...and no frame token anywhere in either answer');
  const human = await bearerDoor('GET', `/api/rooms/${R1.id}`, undefined, true);
  ok(String(human.body?.panels?.[0]?.frameUrl ?? '').includes('/frame/t/'), 'the bearer/human door still gets its frameUrl (unchanged)');

  /* ------------------------------------------------------------------ */
  console.log('\n[P2-5: asset uploads on a pane token: 10 a rolling minute]');
  pt.resetRates();
  const upload = async () => {
    const { out, r } = res();
    const u = `/api/rooms/${R1.id}/assets`;
    await rooms.handleAgent(req('POST', u, undefined, { 'x-filename': 'a.txt' }), r, u, 'recipe:rec-a', deps);
    return out;
  };
  const upCodes: number[] = [];
  for (let i = 0; i < pt.ASSET_POST_PER_MIN; i++) {
    upCodes.push((await upload()).status);
  }
  ok(upCodes.every((c) => c === 400), `10 uploads pass the limit (and then meet the empty-body 400) (got ${JSON.stringify(upCodes)})`);
  const up11 = await upload();
  eq(up11.status, 429, 'the 11th: 429');
  eq(up11.body?.error, 'rate_limited', '...rate_limited');
  ok(typeof up11.body?.retry_after === 'number' && up11.body.retry_after > 0, '...with retry_after');
  ok(pt.takeAssetPost('other-pane').ok, 'another pane is not affected');
  ok(pt.takeRoomPost('recipe:rec-a').ok, 'room posts are a separate budget');

  /* ------------------------------------------------------------------ */
  console.log('\n[P2-6: the spawn env never inherits a pane token]');
  const base = { PATH: '/bin', HARBOR_WB_PANE_TOKEN: 'LEAKED', HARBOR_WB_PANE_TOKEN_FILE: '/tmp/leaked.token', CLAUDE_CODE_CHILD_SESSION: '1' };
  const plain = spawnEnv({ binary: 'bash' }, base);
  eq(plain.HARBOR_WB_PANE_TOKEN, undefined, "an engine run from inside a pane: a tokenless pane does not get that pane's HARBOR_WB_PANE_TOKEN");
  eq(plain.HARBOR_WB_PANE_TOKEN_FILE, undefined, '...nor its HARBOR_WB_PANE_TOKEN_FILE');
  eq(plain.CLAUDE_CODE_CHILD_SESSION, undefined, 'the child-session marker is still stripped');
  eq(plain.PATH, '/bin', 'the rest of the env is inherited');
  const own2 = spawnEnv({ binary: 'bash', env: { HARBOR_WB_PANE_TOKEN_FILE: '/tmp/own.token' } }, base);
  eq(own2.HARBOR_WB_PANE_TOKEN_FILE, '/tmp/own.token', "a pane's OWN token (desc.env) still arrives");
  eq(own2.HARBOR_WB_PANE_TOKEN, undefined, '...and the inherited one does not ride along');
} catch (e) {
  failed++;
  console.log(`  ✗ threw: ${(e as Error).stack}`);
} finally {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows: the store still holds the db (EPERM) */ }
}

/* THE DEFAULT (design review [ref]/[ref]): pane tokens are ON in local mode and OFF on the server, and the env var wins in BOTH directions. */
{
  const saved = { t: process.env.HARBOR_WB_PANE_TOKENS, m: process.env.HARBOR_WB_MODE };
  const set = (t: string | undefined, m: string | undefined): void => {
    if (t === undefined) delete process.env.HARBOR_WB_PANE_TOKENS; else process.env.HARBOR_WB_PANE_TOKENS = t;
    if (m === undefined) delete process.env.HARBOR_WB_MODE; else process.env.HARBOR_WB_MODE = m;
  };
  console.log('\n[the default: on in local mode, off on the server; the env var wins both ways]');
  set(undefined, undefined);
  ok(pt.enabled() === false, 'server engine, nothing set: OFF (the server is unchanged)');
  set(undefined, 'server');
  ok(pt.enabled() === false, 'mode=server, nothing set: off');
  set(undefined, 'local');
  ok(pt.enabled() === true, 'local engine, nothing set: ON, so no supervisor has to remember to set it');
  set(undefined, ' LOCAL ');
  ok(pt.enabled() === true, '...whatever the case or spacing of the mode');
  set('0', 'local');
  ok(pt.enabled() === false, 'local with HARBOR_WB_PANE_TOKENS=0: off (an explicit 0 wins)');
  set('1', undefined);
  ok(pt.enabled() === true, 'a server with HARBOR_WB_PANE_TOKENS=1: on (as before)');
  set('1', 'local');
  ok(pt.enabled() === true, 'local with =1: on');
  set('yes', 'local');
  ok(pt.enabled() === true, 'local with an unrecognised value: the default (on), not a silent off');
  set('yes', undefined);
  ok(pt.enabled() === false, 'a server with an unrecognised value: the default (off)');
  {
    const sh = process.env.HARBOR_WB_HOSTED;
    process.env.HARBOR_WB_HOSTED = '1';
    set(undefined, undefined);
    ok(pt.enabled() === true, 'a HOSTED engine, nothing set: ON (a hosted seat has no other way to read its room)');
    set('0', undefined);
    ok(pt.enabled() === false, '...and an explicit =0 still wins');
    const bt = await import('../src/server/bt-mcp.ts');
    set(undefined, undefined);
    const be = process.env.HARBOR_WB_BT_MCP;
    delete process.env.HARBOR_WB_BT_MCP;
    ok(bt.enabled() === true, 'hosted: the bt room tools are ON by default too');
    process.env.HARBOR_WB_BT_MCP = '0';
    ok(bt.enabled() === false, '...=0 is still off');
    if (be === undefined) delete process.env.HARBOR_WB_BT_MCP; else process.env.HARBOR_WB_BT_MCP = be;
    if (sh === undefined) delete process.env.HARBOR_WB_HOSTED; else process.env.HARBOR_WB_HOSTED = sh;
  }
  set(saved.t, saved.m);
}

{
  console.log('\n[mintHost: a token for a LOGICAL connector pane, returned (never written), local mode only (draftsman [ref], D-E1-1)]');
  const saved = process.env.HARBOR_WB_MODE;
  process.env.HARBOR_WB_MODE = 'server';
  ok(pt.mintHost('recipe:conn', 3) === null, 'on a server: refused (a token in a child env is never for a shared host)');
  process.env.HARBOR_WB_MODE = 'local';
  table.upsert({ paneid: 'recipe:conn', server: 'local', vendor: 'codex-cli', agent: 'conn', session_id: null, state: 'live', generation: 3 });
  const h = pt.mintHost('recipe:conn', 3);
  ok(!!h && h.token.length >= 43 && !!h.hash, 'in local mode: the token and its hash are returned');
  const rq = req('GET', '/api/rooms', undefined, bearer(h!.token));
  const rr = pt.resolve(rq);
  ok(rr?.ok === true && rr.principal.paneid === 'recipe:conn' && rr.principal.generation === 3, 'it resolves to the logical pane at the binding generation, through the SAME resolver');
  ok(!existsSync(pt.tokenFileFor('recipe:conn')), 'nothing was written to a token file');
  table.upsert({ paneid: 'recipe:conn', server: 'local', vendor: 'codex-cli', agent: 'conn', session_id: null, state: 'dehydrated', generation: 3 });
  const dr = pt.resolve(req('GET', '/api/rooms', undefined, bearer(h!.token)));
  ok(dr?.ok === false && dr.code === 'pane_not_live', 'host down (the row goes dehydrated): refused as pane_not_live');
  table.upsert({ paneid: 'recipe:conn', server: 'local', vendor: 'codex-cli', agent: 'conn', session_id: null, state: 'live', generation: 4 });
  const gr = pt.resolve(req('GET', '/api/rooms', undefined, bearer(h!.token)));
  ok(gr?.ok === false && gr.code === 'generation_mismatch', 'a new binding generation: the old token is refused');
  const h2 = pt.mintHost('recipe:conn', 4);
  ok(pt.resolve(req('GET', '/api/rooms', undefined, bearer(h2!.token)))?.ok === true, 'the new generation mints a new token');
  const old = pt.resolve(req('GET', '/api/rooms', undefined, bearer(h!.token)));
  ok(old?.ok === false && old.code === 'token_revoked', '...and minting it superseded the earlier one');
  pt.revoke('recipe:conn', 'ended');
  const rv = pt.resolve(req('GET', '/api/rooms', undefined, bearer(h2!.token)));
  ok(rv?.ok === false && rv.code === 'token_revoked', 'revoke(paneid) at the end of the generation kills it');
  if (saved === undefined) delete process.env.HARBOR_WB_MODE; else process.env.HARBOR_WB_MODE = saved;
}

console.log(`\nPASS ${passed} FAIL ${failed}`);
process.exit(failed ? 1 : 0);
