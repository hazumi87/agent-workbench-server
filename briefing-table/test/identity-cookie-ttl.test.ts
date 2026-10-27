/**
 * THE SIGN-IN COOKIES SURVIVE A RESTART OF THE WINDOW HOST: a session cookie without Expires/Max-Age is dropped when a WebView2 profile closes, so both identity cookies
 * carry Max-Age (session 30 days, remembered device 180 days). Pure: no engine, no port.
 */
process.env.HARBOR_WB_IDENTITY = 'both';
const auth = await import('../src/identity/auth.ts');
const store = await import('../src/identity/store.ts');

let passed = 0;
let failed = 0;
const ok = (c: unknown, m: string): void => { if (c) { passed++; console.log(`  ok ${m}`); } else { failed++; console.log(`  X  ${m}`); } };

const s = auth.sessionCookie('tok', true);
const d = auth.deviceCookie('tok', true);
ok(s.includes(`Max-Age=${store.SESSION_TTL_MS / 1000}`) && store.SESSION_TTL_MS === 30 * 86400000, `session cookie: Max-Age 30 days (${s.replace(/tok/, '…')})`);
ok(d.includes(`Max-Age=${store.DEVICE_TTL_MS / 1000}`) && store.DEVICE_TTL_MS === 180 * 86400000, `device cookie: Max-Age 180 days (${d.replace(/tok/, '…')})`);
ok(/HttpOnly/.test(s) && /HttpOnly/.test(d) && /Secure/.test(s) && /Secure/.test(d), 'both stay HttpOnly and Secure behind https');
console.log(`\nPASS ${passed} FAIL ${failed}`);
process.exit(failed ? 1 : 0);
