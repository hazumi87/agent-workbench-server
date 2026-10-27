/**
 * Seeder for test/scratch-real.probe.mjs, NOT a suite. Writes notes AS ANOTHER PERSON straight through the store into the temp db
 * HARBOR_WB_TABLE (a note needs a person; the scratch engine has one window person, so "someone else" is a row with another created_by).
 * argv[2]: JSON {room, by, notes:[text]}.  stdout: {ids:[...]}.
 */
const plan = JSON.parse(process.argv[2] ?? '{}');
if (!process.env.HARBOR_WB_TABLE) {
  throw new Error('HARBOR_WB_TABLE must name the temp db');
}
const { table } = await import('../src/table/endpoint.ts');
if (plan.handle) {
  table.setUserHandle(plan.by, plan.handle); // the other person's @name, as the room line names people
}
const ids: string[] = [];
for (const text of plan.notes ?? []) {
  ids.push(table.createRoomNote(plan.room, plan.by, text).id);
}
console.log(JSON.stringify({ ids }));
