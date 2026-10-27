/** M5: an uploaded file is served as itself only on a short allowlist; script/html/svg/unknown types go out as octet-stream attachments. */
const { safeServeType, dispositionFor } = await import('../src/server/safe-serve.ts');
let passed = 0;
let failed = 0;
const ok = (c: unknown, m: string): void => { if (c) { passed++; console.log(`  ok ${m}`); } else { failed++; console.log(`  X  ${m}`); } };
for (const t of ['image/png', 'image/jpeg', 'application/pdf', 'text/plain; charset=utf-8', 'text/markdown', 'application/json']) ok(!safeServeType(t).attachment && safeServeType(t).type === t, `served as itself: ${t}`);
for (const t of ['text/javascript', 'application/javascript', 'text/html', 'image/svg+xml', 'application/xml', 'text/xml', 'application/x-sh', 'application/wasm', '', null, undefined]) {
  const r = safeServeType(t as never);
  ok(r.attachment && r.type === 'application/octet-stream', `octet-stream attachment: ${String(t)}`);
}
for (const t of ['text/html', 'image/svg+xml']) ok(dispositionFor(safeServeType(t), 'inline; filename=x') === 'attachment' && dispositionFor(safeServeType(t), undefined) === 'attachment', `a forced attachment stays one when the share says inline or nothing: ${t}`);
ok(dispositionFor(safeServeType('image/png'), 'inline') === 'inline' && dispositionFor(safeServeType('image/png'), undefined) === 'inline', 'a safe type stays inline');
ok(dispositionFor(safeServeType('image/png'), 'attachment; filename=x') === 'attachment', 'the share can still make a safe type an attachment');
console.log(`\nPASS ${passed} FAIL ${failed}`);
process.exit(failed ? 1 : 0);
