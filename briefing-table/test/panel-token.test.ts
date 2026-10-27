/**
 * Room panel FRAME TOKENS (src/server/panel-proxy.ts) [ticket]: minted per
 * projection, one panel, 6-12 h, HMAC'd with a per-process key. The engine
 * suite (room-panels.test.mjs) proves the HTTP side; this proves the rule —
 * in particular EXPIRY, which an engine test cannot reach without waiting
 * hours. Run with tsx.
 */
import { mintFrameToken, checkFrameToken, parseFramePath, frameUrlFor } from '../src/server/panel-proxy.ts';

let passed = 0;
let failed = 0;
function eq(actual: unknown, expected: unknown, msg: string): void {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a === b) {
    passed += 1;
    console.log(`  ✓ ${msg}`);
  } else {
    failed += 1;
    console.log(`  ✗ ${msg} — expected ${b}, got ${a}`);
  }
}

const H = 60 * 60 * 1000;
const now = Date.now();
const tok = mintFrameToken('room-1', 'panel-1', now);

console.log('\n[check]');
eq(checkFrameToken(tok, 'room-1', 'panel-1', now), 'ok', 'a fresh token checks ok');
eq(checkFrameToken(tok, 'room-1', 'panel-1', now + 5.9 * H), 'ok', 'still ok 5.9 h later (valid 6-12 h)');
eq(checkFrameToken(tok, 'room-1', 'panel-1', now + 12.1 * H), 'expired', 'expired past 12 h');
eq(checkFrameToken(mintFrameToken('room-1', 'panel-1', now - 13 * H), 'room-1', 'panel-1', now), 'expired', 'one minted 13 h ago is expired');
eq(checkFrameToken(tok, 'room-1', 'panel-2', now), 'bad', 'another panel: bad');
eq(checkFrameToken(tok, 'room-2', 'panel-1', now), 'bad', 'another room: bad');
const [exp, sig] = tok.split('.');
const later = (parseInt(exp, 36) + 24 * H).toString(36);
eq(checkFrameToken(`${later}.${sig}`, 'room-1', 'panel-1', now), 'bad', 'a moved expiry breaks the signature: bad');
eq(checkFrameToken(`${exp}.${sig.slice(0, -1)}${sig.endsWith('A') ? 'B' : 'A'}`, 'room-1', 'panel-1', now), 'bad', 'a flipped signature: bad');
eq(checkFrameToken('', 'room-1', 'panel-1', now), 'bad', 'empty: bad');
eq(checkFrameToken('garbage', 'room-1', 'panel-1', now), 'bad', 'garbage: bad');

console.log('\n[quantised: one bucket, one token]');
const bucketStart = Math.floor(now / (6 * H)) * 6 * H;
eq(mintFrameToken('r', 'p', bucketStart + 1000) === mintFrameToken('r', 'p', bucketStart + 6 * H - 1000), true, 'two mints in one 6 h bucket are identical (no iframe reload per push)');
eq(mintFrameToken('r', 'p', bucketStart + 1000) === mintFrameToken('r', 'p', bucketStart + 6 * H + 1000), false, 'the next bucket mints a new one');

console.log('\n[paths]');
eq(parseFramePath('/api/rooms/r/panels/p/frame'), { roomId: 'r', panelId: 'p', token: null, prefix: '/api/rooms/r/panels/p/frame/', tail: '' }, 'bare /frame');
eq(parseFramePath(`/api/rooms/r/panels/p/frame/t/${tok}/a/b.js`)?.tail, 'a/b.js', 'the token segment is stripped before the tail');
eq(parseFramePath(`/api/rooms/r/panels/p/frame/t/${tok}/a/b.js`)?.token, tok, 'and read as the token');
eq(parseFramePath('/api/rooms/r/panels/p'), null, 'the panel route is not a frame path');
eq(parseFramePath('/api/rooms/r/panels/p/framex'), null, 'nor is /framex');
eq(parseFramePath(`/api/rooms/r/line/t/${tok}/`), null, 'nor a token on another route');
const url = frameUrlFor('room 1', 'p/1');
eq(url.startsWith('/api/rooms/room%201/panels/p%2F1/frame/t/') && url.endsWith('/'), true, 'frameUrl: encoded ids, t/<token>/, trailing slash');
const fp = parseFramePath(url.slice(0, -1));
eq([fp?.roomId, fp?.panelId, fp && checkFrameToken(fp.token!, fp.roomId, fp.panelId)], ['room 1', 'p/1', 'ok'], 'a minted frameUrl parses back and checks ok');

console.log(`\n${'='.repeat(40)}`);
console.log(`PASS ${passed}  FAIL ${failed}`);
console.log(failed ? 'FAILURES' : 'all green');
process.exit(failed ? 1 : 0);
