/**
 * Seeder for test/concierge-routes.test.mjs: NOT a suite. Writes pane tokens
 * (and session state changes) through the store into the temp db named by
 * HARBOR_WB_TABLE. A token is only ever minted by a spawn, and the suite has
 * no broker and no pty, so it is seeded here, hashed exactly as
 * engine/pane-tokens.ts hashes it (sha256 hex).
 *
 * argv[2] is a JSON plan: {tokens?:[{paneid, token, generation?}], states?:[{paneid, state}], engineSettings?:[{key, value}]}
 */
import { createHash } from 'node:crypto';

const plan = JSON.parse(process.argv[2] ?? '{}');
if (!process.env.HARBOR_WB_TABLE) {
  throw new Error('HARBOR_WB_TABLE must name the temp db');
}
const { table } = await import('../src/table/endpoint.ts');
for (const t of plan.tokens ?? []) {
  table.insertPaneToken({ hash: createHash('sha256').update(t.token).digest('hex'), paneid: t.paneid, generation: t.generation ?? 0, origin: 'local' });
}
for (const e of plan.engineSettings ?? []) {
  table.setEngineSetting(e.key, e.value);
}
for (const s of plan.states ?? []) {
  table.setState(s.paneid, s.state);
}
console.log(JSON.stringify({ ok: true }));
