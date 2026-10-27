/* THE CLI-PROMPT MATCHER (the design notes). PURE: rendered viewport rows in, a prompt name or null out. No I/O, no clock.
 * It names the six first-run prompts Claude Code shows from a clean state (platform's evidence, coordination [ref], 2.1.310). Three outcomes live
 * one level up (vscreen.ts, which knows the screen's sync state and how long startup has run); this function only answers "which known
 * prompt is drawn here", and null means "none of them", never "the REPL" and never "cannot tell".
 *
 * A fragment is a stable phrase of the prompt's own text, case-sensitive. A wording change makes the match fail, which is the SAFE direction
 * (the screen then reads as an unmatched dialog, reported as unknown), never a false name. A conversation that merely QUOTES a prompt (an agent
 * explaining the first-run flow) is not a prompt: when the REPL's footer is on screen nothing matches. */

export const CLI_PROMPT_NAMES = ['theme', 'login', 'apiKey', 'security', 'trust', 'mcp'] as const;
export type CliPromptName = (typeof CLI_PROMPT_NAMES)[number];

/* ORDER MATTERS only where fragments could co-occur on one screen; the first listed wins. Each entry needs ALL its fragments. */
const TABLE: { name: CliPromptName; all: string[] }[] = [
  { name: 'apiKey', all: ['Detected a custom API key in your environment'] },
  { name: 'trust', all: ['Quick safety check', 'trust'] },
  { name: 'mcp', all: ['New MCP server found in this project'] },
  { name: 'security', all: ['Security notes', 'Press Enter to continue'] },
  { name: 'login', all: ['Select login method'] },
  { name: 'login', all: ['Paste code here if prompted'] },
  { name: 'theme', all: ['Choose the text style that looks best with your terminal'] },
];

/** The REPL's footer: the mode row (⏵⏵ ...) or the "? for shortcuts" hint. Same signal bg-detect.ts uses. */
const REPL_FOOTER = /^\s*(?:⏵|⏸|\? for shortcuts)/;

export function matchCliPrompt(rows: readonly string[]): CliPromptName | null {
  if (rows.some((r) => REPL_FOOTER.test(r))) {
    return null;
  }
  /* join so a phrase the terminal wrapped across two rows still matches */
  const text = rows.map((r) => r.trim()).join(' ').replace(/\s+/g, ' ');
  for (const e of TABLE) {
    if (e.all.every((f) => text.includes(f))) {
      return e.name;
    }
  }
  return null;
}

const WORDS: Record<CliPromptName, string> = {
  theme: 'theme choice',
  login: 'sign-in',
  apiKey: 'API key approval',
  security: 'security notes',
  trust: 'folder trust',
  mcp: 'MCP server approval',
};

/** What a person reads after "waiting at a CLI prompt:". A name has plain words; 'unmatched' is "an unknown CLI prompt". Every other case
 *  (cleared, or cannot tell yet) is null: no claim is made, so nothing is announced and no roster line is shown. */
export function cliPromptWords(prompt: CliPromptName | 'unknown' | 'shell' | null, reason: string | null): string | null {
  if (prompt === null || prompt === 'shell') {
    return null;
  }
  if (prompt === 'unknown') {
    return reason === 'unmatched' ? 'an unknown CLI prompt' : null;
  }
  return WORDS[prompt] ?? null;
}

/** Says each prompt ONCE per entry: returns the words the first time a pane shows them (and again after it cleared in between), null while
 *  it is still showing the same thing. The caller writes one room fact per non-null answer. */
export class PromptAnnouncer {
  private last = new Map<string, string>();
  update(paneid: string, words: string | null): string | null {
    if (words === null) {
      this.last.delete(paneid);
      return null;
    }
    if (this.last.get(paneid) === words) {
      return null;
    }
    this.last.set(paneid, words);
    return words;
  }
  forget(paneid: string): void {
    this.last.delete(paneid);
  }
}

/* THE SIGN-IN LINK. The login prompt prints a one-time browser sign-in URL; the OOBE wizard offers "Copy" and "Open". It is lifted from the
 * drawn screen, so it is validated before anyone is handed it: https only, and a host that is Anthropic's (the screen is just text a program
 * drew, and must not be able to name where the person is sent). It may wrap across rows: a row filled to the terminal's width continues on
 * the next one. The result is a credential-adjacent value: callers keep it in memory, return it only over an authenticated route, and never
 * put it in a room line, a log or a table row. */
const LINK_HOSTS = ['claude.ai', 'claude.com', 'anthropic.com'];
const hostAllowed = (host: string): boolean => LINK_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));

export function extractSignInLink(rows: readonly string[], cols: number): string | null {
  for (let i = 0; i < rows.length; i++) {
    const at = rows[i].indexOf('https://');
    if (at < 0) {
      continue;
    }
    let link = rows[i].slice(at).split(/\s/)[0];
    /* it continues on the next row only when it ran to the LAST column of a full row: no space after it, and the row fills the terminal */
    let j = i;
    let toEdge = link.length === rows[i].slice(at).trimEnd().length && rows[i].trimEnd().length >= cols;
    while (toEdge && j + 1 < rows.length) {
      const rest = rows[j + 1].trimEnd();
      const next = rest.split(/\s/)[0];
      if (!next) {
        break;
      }
      link += next;
      j++;
      toEdge = next.length === rest.length && rows[j].trimEnd().length >= cols;
    }
    try {
      const u = new URL(link);
      if (u.protocol === 'https:' && hostAllowed(u.hostname.toLowerCase())) {
        return link;
      }
    } catch {
      /* not a URL */
    }
  }
  return null;
}

/* A BARE SHELL PROMPT (fb30s, the design system [ref]). A local seat is a plain shell with the vendor line TYPED into it, so when that line did not run (the program is not installed,
 * or it exited) the pane sits at the shell's own prompt. That is not "an unknown CLI prompt" and not an agent waiting for an answer: it is "no agent is running in this
 * terminal". Recognised from the last non-blank row only: PowerShell (`PS C:\x> `), cmd (`C:\x>`), bash/zsh (`user@host:path$ `, `# `, `%`). A line that merely ENDS in
 * a symbol after other text is not a prompt. Never true on a screen that shows the Claude REPL footer. */
const SHELL_PROMPTS: RegExp[] = [
  /^PS [A-Za-z]:[\\/][^>]*> ?$/,
  /^PS> ?$/,
  /^(?:bash|sh|zsh|dash)-?[\d.]*[$#%] ?$/,
  /^[A-Za-z]:[\\/][^>]*> ?$/,
  /^[\w.-]+@[\w.-]+[: ][^\s]*\s*[$#%] ?$/,
  /^[\w.-]+@[\w.-]+:.*[$#] ?$/,
];
export function looksLikeShellPrompt(rows: readonly string[]): boolean {
  if (rows.some((r) => REPL_FOOTER.test(r))) {
    return false;
  }
  for (let i = rows.length - 1; i >= 0; i--) {
    const t = rows[i].trimEnd();
    if (!t.trim()) {
      continue;
    }
    return SHELL_PROMPTS.some((re) => re.test(t.trimStart()));
  }
  return false;
}

/** The room fact for a lead whose terminal is a bare shell. Plain words; not the "waiting at a CLI prompt" sentence, which is for an agent that IS waiting. */
export function shellFactText(handle: string): string {
  return `@${handle}: no agent is running in its terminal`;
}
