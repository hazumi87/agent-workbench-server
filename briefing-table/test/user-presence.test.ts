/* USER DEVICE PRESENCE logic [room [ref]]: descriptor validation, active/recent/primary/summary, rate limit. Run with tsx. */
const up = await import('../src/engine/user-presence.ts');
let passed = 0;
let failed = 0;
function eq(actual: unknown, expected: unknown, msg: string): void {
  if (JSON.stringify(actual) === JSON.stringify(expected)) { passed += 1; console.log(`  ok  ${msg}`); }
  else { failed += 1; console.log(`  FAIL ${msg} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`); }
}
const base = {
  device: 'dev-phone-0001', instance: 'inst-0001-aaaa', class: 'phone', surface: 'browser', page: 'room', browser: 'Safari', os: 'iOS',
  viewport: { w: 390, h: 844 }, standalone: false, visible: true, label: 'iPhone browser',
};
const T0 = 1_800_000_000_000;
const MIN = 60_000;
const ok = (o: unknown) => { const v = up.validateDescriptor(o); return v.ok ? v.value : null; };

console.log('\n[validation]');
eq(ok(base)?.class, 'phone', 'a good descriptor passes');
eq(up.validateDescriptor({ ...base, class: 'laptop' }).ok, false, "'laptop' is not a class (cannot be told from a page)");
eq(up.validateDescriptor({ ...base, surface: 'tv' }).ok, false, 'unknown surface refused');
eq(up.validateDescriptor({ ...base, device: 'x' }).ok, false, 'short device id refused');
eq(up.validateDescriptor({ ...base, device: 'a b c d e f g h' }).ok, false, 'device id alphabet enforced');
eq(up.validateDescriptor({ ...base, viewport: { w: -1, h: 5 } }).ok, false, 'negative viewport refused');
eq(up.validateDescriptor({ ...base, visible: 'yes' }).ok, false, 'visible must be a boolean');
eq(up.validateDescriptor(null).ok, false, 'null body refused');
eq(up.validateDescriptor([]).ok, false, 'array body refused');
const extra = ok({ ...base, userAgent: 'Mozilla/5.0 secret', ip: '1.2.3.4', cookie: 'x' }) as unknown as Record<string, unknown>;
eq(['userAgent', 'ip', 'cookie'].some((k) => k in extra), false, 'unknown keys (UA, ip) are dropped');
eq(ok({ ...base, label: 'x'.repeat(500) })?.label.length, 60, 'label capped at 60');
eq(ok({ ...base, label: 'a\nb\u0007c' })?.label, 'abc', 'control characters stripped from the label');

console.log('\n[active / recent / primary / summary]');
up.reset();
const phone = ok(base)!;
const laptop = ok({ ...base, device: 'dev-desk-00002', instance: 'inst-0002-bbbb', class: 'desktop', browser: 'Chrome', os: 'Windows', label: 'Windows browser', viewport: { w: 1280, h: 800 } })!;
up.record('p1', laptop, T0);
up.record('p1', phone, T0 + 10 * MIN);
let q = up.query('p1', 'Owner', T0 + 11 * MIN);
eq(q.active.map((d) => d.device), ['dev-phone-0001'], 'phone is active (fresh + visible)');
eq(q.recent.map((d) => d.device), ['dev-desk-00002'], 'desktop reported 11 min ago is recent, not active');
eq(q.primary?.device, 'dev-phone-0001', 'primary = the active visible device');
eq(q.summary, 'Owner is on a phone (iPhone, Safari) in a room, active now; also a desktop (Windows, Chrome) idle 11 min', 'summary line');
q = up.query('p1', 'Owner', T0 + 14 * MIN);
eq(q.active.length, 0, 'phone report 4 min old is no longer active');
eq(q.primary, null, 'no primary when nothing is active');
eq(q.recent.length, 2, 'both are recent');
eq(q.summary.startsWith('Owner has no visible page; last seen on a phone'), true, 'summary with nothing active');
q = up.query('p1', 'Owner', T0 + 45 * MIN);
eq(q.recent.length, 0, 'past 30 min: off the live list');
eq(up.history('p1', T0 + 45 * MIN).length, 2, '...but kept in history for 24 h');
eq(up.history('p1', T0 + 25 * 3_600_000).length, 0, '...and not past 24 h');
eq(up.query('nobody', null, T0).summary, 'The user has no device reporting.', 'unknown person');

console.log('\n[a hidden page is not active; a hidden tab does not cancel the visible one]');
up.reset();
up.record('p', phone, T0);
up.record('p', { ...phone, visible: false }, T0 + MIN);
eq(up.query('p', 'E', T0 + 2 * MIN).active.length, 0, 'same instance reports hidden: not active');
up.record('p', { ...phone, instance: 'inst-tab-two-cc', visible: true, surface: 'shell-tab', page: 'solo' }, T0 + 2 * MIN);
up.record('p', { ...phone, visible: false }, T0 + 3 * MIN); // the first tab hides again, later
q = up.query('p', 'E', T0 + 3 * MIN + 1000);
eq(q.active.length, 1, 'one device, still active through its visible tab');
eq(q.primary?.page, 'solo', 'the visible tab speaks for the device');
eq(q.primary?.surface, 'shell-tab', 'surface is that tab\'s');

console.log('\n[primary is the most recently active visible device]');
up.reset();
up.record('p', phone, T0);
up.record('p', laptop, T0 + MIN);
eq(up.query('p', 'E', T0 + 2 * MIN).primary?.device, 'dev-desk-00002', 'the fresher visible device wins');
up.record('p', phone, T0 + 90_000);
eq(up.query('p', 'E', T0 + 2 * MIN).primary?.device, 'dev-phone-0001', 'and it flips when the other reports later');

console.log('\n[rate limit]');
up.reset();
let allowed = 0;
for (let i = 0; i < 30; i++) if (up.takeReport('dev-rate-00001', T0 + i * 100)) allowed++;
eq(allowed, up.RATE_PER_MIN, `${up.RATE_PER_MIN} per minute per device`);
eq(up.takeReport('dev-rate-00001', T0 + 61_000), true, 'a minute later it clears');
eq(up.takeReport('dev-other-0001', T0 + 200), true, 'another device is unaffected');

console.log(`\nPASS ${passed}  FAIL ${failed}`);
process.exit(failed ? 1 : 0);
