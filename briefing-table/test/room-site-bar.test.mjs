/* The Preview / Public bar's model and switch command [basic]. node test/room-site-bar.test.mjs */
import { barModel, switchCommand, stampMs } from '../web/room-site-bar.mjs';

let pass = 0; let fail = 0;
const ok = (c, m) => { if (c) { pass += 1; console.log(`  + ${m}`); } else { fail += 1; console.log(`  X ${m}`); } };
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), `${m}${JSON.stringify(a) === JSON.stringify(b) ? '' : `  got ${JSON.stringify(a)}`}`);

ok(barModel(null) === null && barModel({}) === null && barModel({ slug: null, previewUrl: null }) === null, 'not a site room (every field null) or no answer: no bar');
const m = barModel({ slug: 'my-site', id: 'abc', name: 'My Site', previewUrl: 'https://p.example/x', publicUrl: 'https://my-site.example', published: true, lastPublishedAt: 1791000000000, changedSinceSave: true });
eq([m.name, m.previewUrl, m.published, m.publicUrl, m.changed, m.canPublishNow], ['My Site', 'https://p.example/x', true, 'https://my-site.example', true, true], 'a published site with unsaved changes: public link shown, Publish now offered');
const priv = barModel({ slug: 's', previewUrl: 'https://p.example/x', publicUrl: 'https://s.example', published: false, changedSinceSave: false });
ok(priv.published === false && priv.publicUrl === null && !priv.canPublishNow && priv.name === 's', 'private: no public link (even if the engine knows one), nothing to publish now, the slug names it');
ok(barModel({ slug: 's', published: true, changedSinceSave: true }).canPublishNow && !barModel({ slug: 's', published: false, changedSinceSave: true }).canPublishNow, 'Publish now only when the site is public AND behind your save (a private site is published by the switch)');
ok(barModel({ slug: 's', previewUrl: 'javascript:alert(1)', publicUrl: 'ftp://x', published: true }).previewUrl === null && barModel({ slug: 's', publicUrl: 'ftp://x', published: true }).publicUrl === null, 'only http(s) links reach an href');
ok(stampMs('2026-10-07T23:13:00Z') === Date.parse('2026-10-07T23:13:00Z') && stampMs(1791000000000) === 1791000000000 && stampMs(1791000000) === 1791000000000 && stampMs('soon') === null && stampMs(null) === null && barModel({ slug: 's', published: true, lastPublishedAt: '2026-10-07T23:13:00Z' }).lastPublishedAt === Date.parse('2026-10-07T23:13:00Z'), 'the published time is read from the engine\'s ISO string (or ms / seconds); junk is none');
ok(barModel({ slug: 's', published: 'yes' }).published === false, 'published is true only when it is true (a string is not a yes)');
ok(barModel({ slug: 's', error: 'boom' }).error === 'boom' && barModel({ slug: 's' }).error === null, 'an error rides along; none is null');
eq([switchCommand(true), switchCommand(false)], ['/publish', '/unpublish'], 'the switch sends /publish to go public and /unpublish to go private');
/* source slices: the Basic design pass [basic] */
import { readFileSync } from 'node:fs';
const rd = (f) => readFileSync(new URL(`../web/${f}`, import.meta.url), 'utf8');
ok(rd('room-seat-menu.mjs').includes("o.noWorkgroups?.() ? [] : [{ a: 'move'") && rd('room.js').includes('noWorkgroups: () => isBasic()'), "Basic's seat menu has no 'Move to workgroup…' at all (not a greyed one)");
ok(/isBasic\(\) \? \(n \? `\$\{n\} new` : ''\) : roomChatMeta/.test(rd('room.js')), "Basic's Room chat row says the unread count or nothing, never 'main room'");
ok(/sub \|\| isBasic\(\) \? room\.name : 'Main room'/.test(rd('room.js')) && /isBasic\(\) \? ` · \$\{seats\.length\} agent/.test(rd('room.js')), "Basic's room bar is the site's name then '· N agent(s)'");
ok(/\.rd-wake \{[^}]*var\(--room-accent/.test(rd('room.css')) && !/\.rd-wake \{[^}]*var\(--coral\)/.test(rd('room.css')), "Wake and deliver is the room's accent button, not coral");
console.log(`PASS ${pass} FAIL ${fail}`);
process.exit(fail ? 1 : 0);
