/**
 * Seeder for test/rooms-routes.test.mjs [ticket] — NOT a suite (the runner
 * globs *.test.*, so this file is never run on its own).
 *
 * Writes through the STORE (Seam C2) into the temp db named by
 * HARBOR_WB_TABLE, which the caller sets before spawning this. A session row
 * cannot be created over HTTP (only a spawn writes one), and the suite has no
 * broker and no pty, so rows are seeded here: DEHYDRATED / killed ones before
 * the engine boots (boot reconcile sweeps only `live`), LIVE ones after it is
 * up (the engine reads the table on every request; nothing caches it).
 *
 * argv[2] is a JSON plan:
 *   {recipes?:[Recipe-ish], sessions?:[{paneid, recipe_id, vendor, agent,
 *    session_id?, state, fabric_slug?, fabric_instance?}], rooms?:[{name,
 *    seats:[{handle, recipe_id?, project?, occupant?, policy?, thenEmpty?}]}],
 *    read?:[paneid]}   (read = print {rows:[row|null]} instead, after writing)
 * stdout is one JSON line: {rooms:[{id, name, seats:{<handle>: seatId}}]}.
 */
const plan = JSON.parse(process.argv[2] ?? '{}');
if (!process.env.HARBOR_WB_TABLE) {
  throw new Error('HARBOR_WB_TABLE must name the temp db');
}
const { table } = await import('../src/table/endpoint.ts');

for (const r of plan.recipes ?? []) {
  table.upsertRecipe({
    target: 'local',
    projectDir: null,
    agent: null,
    model: null,
    resume: 0,
    resumeName: null,
    initCmd: null,
    closeOnCleanExit: 0,
    statusPath: null,
    color: null,
    fg: null,
    bg: null,
    watermark: null,
    fontSize: null,
    logo: null,
    ...r,
  });
}
for (const s of plan.sessions ?? []) {
  table.upsert({
    paneid: s.paneid,
    recipe_id: s.recipe_id ?? null,
    server: 'local',
    vendor: s.vendor ?? 'cli-manager',
    agent: s.agent ?? null,
    session_id: s.session_id ?? null,
    state: 'live',
  });
  if (s.state && s.state !== 'live') {
    table.setState(s.paneid, s.state);
  }
  if (s.profile) {
    table.setProfile(s.paneid, s.profile); // an agent's stored {model, effort}
  }
  if (s.fabric_slug || s.fabric_instance) {
    // A previous engine's check-in hint (fabric-checkin.test.mjs: the restart case).
    table.setFabricIdentity(s.paneid, s.fabric_slug ?? null, s.fabric_instance ?? null);
  }
}
for (const [k, v] of Object.entries(plan.settings ?? {})) {
  table.setEngineSetting(k, v); // engine_settings rows (e.g. seatDisconnect.byUser: {<paneid>: ts})
}
if (plan.read) {
  // Read-back for a test: the named rows as stored, one JSON line (no rooms).
  console.log(JSON.stringify({ rows: plan.read.map((p: string) => table.get(p) ?? null) }));
  process.exit(0);
}
const out: { rooms: Array<{ id: string; name: string; seats: Record<string, string> }> } = { rooms: [] };
for (const r of plan.rooms ?? []) {
  const room = table.createRoom({ name: r.name }, { actor: 'user' }).result;
  const seats: Record<string, string> = {};
  for (const s of r.seats ?? []) {
    const seat = table.addSeat(
      room.id,
      { handle: s.handle, recipe_id: s.recipe_id ?? null, project: s.project ?? null, policy: s.policy ?? null, occupant: s.occupant ?? null },
      { actor: 'user' },
    ).result;
    if (s.thenEmpty) {
      table.setOccupant(room.id, seat.id, null, { actor: 'user', reason: 'ended' });
    }
    seats[seat.handle] = seat.id;
  }
  out.rooms.push({ id: room.id, name: room.name, seats });
}
console.log(JSON.stringify(out));
