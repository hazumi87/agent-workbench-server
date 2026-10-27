/** The CLI-prompt matcher (src/engine/cli-prompt.ts), against the fixtures in test/fixtures/cli-prompts/ (the texts platform captured, [ref]). */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { matchCliPrompt, CLI_PROMPT_NAMES, cliPromptWords, PromptAnnouncer, extractSignInLink, looksLikeShellPrompt, shellFactText } from '../src/engine/cli-prompt.ts';

let passed = 0;
let failed = 0;
function ok(cond: unknown, msg: string): void {
  if (cond) { passed++; console.log(`  ok ${msg}`); } else { failed++; console.log(`  FAIL ${msg}`); }
}
const dir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'cli-prompts');
const rowsOf = (f: string): string[] => readFileSync(join(dir, `${f}.txt`), 'utf8').split('\n');

const want: [string, string | null][] = [
  ['theme', 'theme'], ['login', 'login'], ['login-code', 'login'], ['api-key', 'apiKey'],
  ['security', 'security'], ['trust', 'trust'], ['mcp', 'mcp'],
  ['repl', null], ['repl-mentions-trust', null], ['unmatched-dialog', null],
];
for (const [f, name] of want) {
  ok(matchCliPrompt(rowsOf(f)) === name, `${f}: ${name ?? 'no known prompt'}`);
}
ok(CLI_PROMPT_NAMES.length === 6, 'six names, the ones platform measured');

console.log('\n[wrapping and stray rows]');
const trust = rowsOf('trust').join(' ');
const wrapped = ['Quick safety ', 'check: Is this a project you created or one you ', 'trust?'];
ok(matchCliPrompt(wrapped) === 'trust', 'a phrase the terminal wrapped across rows still matches');
ok(matchCliPrompt(['Quick safety check but nothing else']) === null, 'a fragment alone is not enough when the entry needs two');
ok(matchCliPrompt([]) === null && matchCliPrompt(['']) === null, 'an empty screen names nothing');
ok(matchCliPrompt([...rowsOf('theme'), '  ? for shortcuts']) === null, 'the REPL footer on screen: nothing matches, even with a prompt phrase above it');
ok(trust.length > 0, 'fixtures are non-empty');
console.log('\n[the words a person reads]');
ok(cliPromptWords('trust', null) === 'folder trust' && cliPromptWords('login', null) === 'sign-in' && cliPromptWords('theme', null) === 'theme choice', 'a name has plain words');
ok(CLI_PROMPT_NAMES.every((n) => !!cliPromptWords(n, null)), 'every name has words');
ok(cliPromptWords('unknown', 'unmatched') === 'an unknown CLI prompt', "'unmatched' reads as \"an unknown CLI prompt\"");
ok(cliPromptWords('unknown', 'starting') === null && cliPromptWords('unknown', 'no-screen') === null && cliPromptWords('unknown', 'not-synced') === null, 'cannot-tell-yet is NOT a claim: no words');
ok(cliPromptWords(null, null) === null, 'startup cleared: no words');

console.log('\n[the room fact is said once per entry, not per repaint]');
const an = new PromptAnnouncer();
ok(an.update('p1', 'folder trust') === 'folder trust', 'a new prompt is announced');
ok(an.update('p1', 'folder trust') === null, 'the same prompt on the next sweep is not');
ok(an.update('p1', null) === null && an.update('p1', 'folder trust') === 'folder trust', 'after it cleared, the same prompt coming back (a resume) is announced again');
ok(an.update('p1', 'sign-in') === 'sign-in', 'a different prompt is announced');
ok(an.update('p2', 'folder trust') === 'folder trust', 'another pane is tracked separately');
an.forget('p2');
ok(an.update('p2', 'folder trust') === 'folder trust', 'a forgotten pane starts over');

console.log('\n[the sign-in link: only a real https link on an allowed host, joined across wrapped rows, nothing else]');
const url = 'https://claude.ai/oauth/authorize?code=true&client_id=abc-123&response_type=code&redirect_uri=https%3A%2F%2Fconsole.anthropic.com%2Foauth%2Fcode%2Fcallback&state=ZZZ';
const wrap = (u: string, cols: number): string[] => u.match(new RegExp(`.{1,${cols}}`, 'g')) ?? [];
ok(extractSignInLink(['Browser didn\'t open? Use the url below to sign in', '', url, '', 'Paste code here if prompted >'], 400) === url, 'a link on one row');
const w60 = wrap(url, 60);
ok(extractSignInLink(['Use the url below', '', ...w60, '', 'Paste code here if prompted >'], 60) === url, 'a link the terminal wrapped across several rows is joined back whole');
ok(extractSignInLink(['See https://claude.ai/oauth/authorize?code=true and then', 'Paste code here if prompted >'], 400) === 'https://claude.ai/oauth/authorize?code=true', 'a link inside a sentence stops at the space');
ok(extractSignInLink(['https://evil.example.com/oauth/authorize?code=true', 'Paste code here if prompted >'], 400) === null, 'a host that is not Anthropic\'s is refused (the screen is not trusted to name a link)');
ok(extractSignInLink(['https://claude.ai.evil.example.com/x'], 400) === null && extractSignInLink(['https://evilclaude.ai/x'], 400) === null, 'look-alike hosts are refused');
ok(extractSignInLink(['http://claude.ai/oauth/authorize'], 400) === null, 'plain http is refused');
ok(extractSignInLink(['no link here'], 400) === null && extractSignInLink([], 400) === null, 'no link: null');
ok(extractSignInLink(['https://console.anthropic.com/oauth/authorize?x=1'], 400) === 'https://console.anthropic.com/oauth/authorize?x=1', 'console.anthropic.com is allowed');

console.log('\n[a bare shell prompt is its own state, not "an unknown CLI prompt" (fb30s, auriga [ref])]');
const ps = ['Windows PowerShell', 'Copyright (C) Microsoft Corporation. All rights reserved.', '', 'PS C:\\Users\\Owner\\workbench\\agents\\lead> '];
ok(looksLikeShellPrompt(ps), 'a PowerShell prompt');
ok(looksLikeShellPrompt(['PS C:\\Users\\Owner> ', '', '']), 'trailing blank rows do not matter');
ok(looksLikeShellPrompt(['Microsoft Windows [Version 10.0.22631]', 'C:\\Users\\Owner>']), 'a cmd prompt');
ok(looksLikeShellPrompt(['Last login: Sat Oct 25', 'owner@pc:~/code/my-project$ ']), 'a bash prompt');
ok(looksLikeShellPrompt(['bash-5.2$ ']) && looksLikeShellPrompt(['sh-4.4# ']), 'a bare `bash-5.2$` prompt (no user@host)');
ok(looksLikeShellPrompt(['root@host:/srv# ']) && looksLikeShellPrompt(['user@host ~ % ']), 'root and zsh prompts');
ok(!looksLikeShellPrompt([]) && !looksLikeShellPrompt(['']), 'an empty screen is not a shell');
ok(looksLikeShellPrompt(['claude : The term \'claude\' is not recognized as the name of a cmdlet', '', 'PS C:\\x> ']), 'after the "not recognized" error the prompt is back: a shell (the state the fb30s card sees)');
ok(!looksLikeShellPrompt(['Choose the text style that looks best with your terminal', ' ❯ 1. Auto']), 'a Claude first-run dialog is not a shell');
ok(!looksLikeShellPrompt(['Quick safety check: Is this a project you trust?', ' ❯ 1. Yes, I trust this folder', '   2. No, exit']), 'neither is the trust dialog');
ok(!looksLikeShellPrompt(['output line', 'cost: 5$']) , 'a line that merely ends in $ after text is not a prompt');
ok(!looksLikeShellPrompt([...rowsOf('repl')]), 'the REPL is not a shell');
ok(matchCliPrompt(ps) === null, 'and the first-run matcher still names nothing for it (the shell is a separate question)');
ok(shellFactText('steward') === "@steward: no agent is running in its terminal", 'the room fact for a shell lead says so in plain words, not "waiting at a CLI prompt"');
ok(cliPromptWords('shell', null) === null, 'and a shell is not a "waiting at" prompt: no words for that sentence');

console.log(`\nPASS ${passed} FAIL ${failed}`);
process.exit(failed ? 1 : 0);
