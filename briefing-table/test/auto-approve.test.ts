/**
 * AUTO-APPROVE resolution and its launch effect (security review H1): follow|on|off, the first-run default (off), and what the vendor command line carries. Pure: no engine, no port.
 */
process.env.HARBOR_WB_TOKEN = 'test-token-do-not-ship';
const aa = await import('../src/engine/auto-approve.ts');
const gemini = await import('../src/engine/vendors/gemini-cli.ts');
const { buildLaunch } = await import('../src/engine/launch.ts');

let passed = 0;
let failed = 0;
const ok = (c: unknown, m: string): void => { if (c) { passed++; console.log(`  ok ${m}`); } else { failed++; console.log(`  X  ${m}`); } };

console.log('[the resolver]');
ok(aa.effectiveAutoApprove('follow', 'off') === 'off' && aa.effectiveAutoApprove('follow', 'on') === 'on', 'follow takes the default');
ok(aa.effectiveAutoApprove('on', 'off') === 'on' && aa.effectiveAutoApprove('off', 'on') === 'off', 'on/off on the recipe win over the default');
ok(aa.effectiveAutoApprove(undefined, 'on') === 'on' && aa.effectiveAutoApprove(null, 'off') === 'off' && aa.effectiveAutoApprove('', 'off') === 'off', 'a missing value reads as follow');
ok(aa.effectiveAutoApprove('always', 'on') === 'off' && aa.effectiveAutoApprove(5, 'on') === 'off', 'an unknown value is treated as off, never a silent on');
ok(aa.readSetting('nope') === 'follow' && aa.readSetting('on') === 'on', 'an unreadable stored value reads as follow');
ok(aa.readState(null).default === 'off' && aa.readState({ default: 'yes' }).default === 'off' && aa.readState({ default: 'on', disclosedAt: 5 }).disclosedAt === 5, 'the default is off unless exactly "on"');
ok(aa.autoApproveSource('on') === 'recipe' && aa.autoApproveSource('follow') === 'default', 'the source says why');

console.log('\n[the hook: off until wired, a throwing reader is off]');
ok(aa.autoApproveDefault() === 'off', 'nothing wired: off');
aa.setDefaultReader(() => 'on');
ok(aa.autoApproveDefault() === 'on' && aa.effectiveFor({ autoApprove: 'follow' }) === 'on' && aa.effectiveFor({ autoApprove: 'off' }) === 'off', 'wired: follow reads the default');
aa.setDefaultReader(() => { throw new Error('db gone'); });
ok(aa.autoApproveDefault() === 'off', 'a throwing reader is off');

console.log('\n[Gemini: the approval mode only when the EFFECTIVE value is on]');
const recipe = { id: 'r', name: 'g', target: 'local', projectDir: null, vendor: 'gemini-cli', agent: 'g', runClaude: 0, model: null, resume: 0, resumeName: null, initCmd: null } as never;
const cmdOf = (autoApprove?: 'on' | 'off') => gemini.buildInvocation(recipe, { remote: false, autoApprove })?.cmd ?? '';
ok(!/yolo/.test(cmdOf()) && !/yolo/.test(cmdOf('off')), 'no auto-approve flag by default or when off');
ok(/--approval-mode yolo/.test(cmdOf('on')), 'on: --approval-mode yolo');

console.log('\n[the launch path reads the recipe + default]');
aa.setDefaultReader(() => 'off');
const t = { id: 'local', label: 'Local', kind: 'local', shell: '/bin/bash' } as never;
const launch = (setting: string) => JSON.stringify(buildLaunch({ ...(recipe as object), autoApprove: setting } as never, t, null, null, { paneid: 'recipe:x#1' }));
ok(!/yolo/.test(launch('follow')), 'default off + recipe follow: no yolo on the real launch line');
ok(/yolo/.test(launch('on')), 'recipe on: yolo on the real launch line');
aa.setDefaultReader(() => 'on');
ok(/yolo/.test(launch('follow')) && !/yolo/.test(launch('off')), 'default on: follow gets it, a recipe off does not');

console.log(`\nPASS ${passed} FAIL ${failed}`);
process.exit(failed ? 1 : 0);
