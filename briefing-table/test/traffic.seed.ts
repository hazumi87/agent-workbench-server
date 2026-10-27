/**
 * Seeder for test/traffic.probe.mjs [perf/poll-traffic] — NOT a suite (the
 * runner globs *.test.*, so this file is never run on its own).
 *
 * Builds a table shaped like Owner's on 2026-09-29 (the traffic report): a logo
 * library of 17 sets at ~18 KB each, ~20 recipes wearing them, and 144 session
 * rows (117 killed, 6 dehydrated, 21 live) whose logo pref carries the FULL
 * {key, svg, scale, mono, opacity} object, plus 3 rooms with art and seats.
 * Calibrated to the report's sizes: about a quarter of the rows (and 7 of the
 * recipes) carry a logo, so /api/table is ~0.7 MB and /api/recipes ~0.13 MB.
 *
 * argv[2] is 'pre' (logos, recipes, killed + dehydrated rows: before boot,
 * which reconciles only `live`), 'post' (live rows + rooms, after boot) or
 * 'bump' (one more killed row: the table changed).
 * stdout is one JSON line: {rooms:[{id, name}]}.
 */
const phase = process.argv[2];
if (!process.env.HARBOR_WB_TABLE) {
  throw new Error('HARBOR_WB_TABLE must name the temp db');
}
const { table } = await import('../src/table/endpoint.ts');

const LOGOS = 17;
const RECIPES = 20;

/** A valid SVG of about `size` bytes: many small path segments, distinct per
 *  set. The three room arts are ~5.4 KB (the report's art_render), the rest
 *  ~18 KB. */
function bigSvg(n: number, size = n < 3 ? 5_400 : 18_000): string {
  const parts: string[] = [];
  let seed = n * 7919 + 13;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return (seed % 10000) / 10;
  };
  while (parts.join('').length < size) {
    parts.push(`M${rnd().toFixed(1)} ${rnd().toFixed(1)}L${rnd().toFixed(1)} ${rnd().toFixed(1)}L${rnd().toFixed(1)} ${rnd().toFixed(1)}Z`);
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 1000"><path fill="#000" d="${parts.join('')}"/></svg>`;
}

const logoPref = (key: string, svg: string) => JSON.stringify({ key, svg, scale: 60, mono: 'white', opacity: 12 });

if (phase === 'pre') {
  const lib = [];
  for (let i = 0; i < LOGOS; i++) {
    lib.push(table.createLogo(`Set ${i}`, bigSvg(i)));
  }
  for (let i = 0; i < RECIPES; i++) {
    const art = lib[i % LOGOS];
    table.upsertRecipe({
      id: `rec-${i}`,
      name: `Project ${i}`,
      target: 'local',
      projectDir: `/srv/x/p${i}`,
      vendor: 'claude-code',
      agent: `p${i}`,
      model: null,
      resume: 0,
      resumeName: null,
      initCmd: null,
      closeOnCleanExit: 0,
      statusPath: null,
      color: '#3b82f6',
      fg: null,
      bg: null,
      watermark: null,
      fontSize: null,
      logo: i < 7 ? logoPref(`lib:${art.id}`, art.svg) : null,
    } as any);
  }
  const rows = (state: string, count: number, start: number) => {
    for (let i = 0; i < count; i++) {
      const n = start + i;
      const rec = n % RECIPES;
      const art = lib[rec % LOGOS];
      const paneid = `pane-${state}-${n}`;
      table.upsert({ paneid, recipe_id: `rec-${rec}`, server: 'local', vendor: 'claude-code', agent: `p${rec}`, session_id: null, state: 'live' } as any);
      table.setState(paneid, state as any);
      if (n % 4 === 0) {
        table.setPrefs(paneid, { logo: logoPref(`lib:${art.id}`, art.svg) });
      }
    }
  };
  rows('killed', 117, 0);
  rows('dehydrated', 6, 200);
  console.log(JSON.stringify({ rooms: [] }));
} else if (phase === 'post') {
  const lib = table.listLogos().sort((a, b) => a.id - b.id); // creation order, as in 'pre'
  for (let i = 0; i < 21; i++) {
    const rec = i % RECIPES;
    const paneid = `pane-live-${i}`;
    table.upsert({ paneid, recipe_id: `rec-${rec}`, server: 'local', vendor: 'claude-code', agent: `p${rec}`, session_id: null, state: 'live' } as any);
    if (i % 3 === 0) {
      table.setPrefs(paneid, { logo: logoPref(`lib:${lib[rec % LOGOS].id}`, lib[rec % LOGOS].svg) });
    }
  }
  const out: { rooms: Array<{ id: string; name: string }> } = { rooms: [] };
  for (let r = 0; r < 3; r++) {
    const room = table.createRoom({ name: `Traffic Room ${r}` }, { actor: 'user' }).result;
    table.setRoomSettings(room.id, { art: `lib:${lib[r].id}` });
    for (let s = 0; s < 4; s++) {
      const i = r * 4 + s;
      table.addSeat(room.id, { handle: `p${i}`, recipe_id: `rec-${i % RECIPES}`, project: null, policy: null, occupant: `pane-live-${i}` }, { actor: 'user' });
    }
    out.rooms.push({ id: room.id, name: room.name });
  }
  console.log(JSON.stringify(out));
} else if (phase === 'bump') {
  /* one more killed row: /api/table changes (poll-traffic.test's ETag case) */
  table.upsert({ paneid: 'pane-bump', recipe_id: 'rec-0', server: 'local', vendor: 'claude-code', agent: 'p0', session_id: null, state: 'live' } as any);
  table.setState('pane-bump', 'killed' as any);
  console.log(JSON.stringify({ rooms: [] }));
} else {
  throw new Error(`phase must be pre|post|bump (got ${phase})`);
}
