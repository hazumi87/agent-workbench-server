/**
 * What counts as an acceptable password, and how a temporary one is minted.
 *
 * LIFTED from kiosk (`src/web/password-policy.ts`) rather than reinvented —
 * contract §0 names kiosk's model as the one being adopted, and a second,
 * subtly-different policy on the same installation is how two services end up
 * disagreeing about whether `P@ssw0rd!` is allowed. Trimmed to what this engine
 * needs; the household blocklist is re-pointed at THIS service's nouns.
 *
 * THE LEET NORMALISER IS THE WHOLE TRICK. `P@ssw0rd!` satisfies every
 * composition rule and is one of the most-guessed strings in existence, so the
 * candidate is FOLDED — substitutions mapped back to the letters they stand in
 * for, trailing decoration stripped, repeats collapsed — and the folded form is
 * what gets looked up.
 */
import { randomInt } from 'node:crypto';

/** Owner's policy (contract §0). Changing these is a policy decision. */
export const MIN_LENGTH = 8;
/** Upper bound: argon2id hashes whatever it is given, and a megabyte of input
 *  is a cheap way to make the server do expensive work on every attempt. */
export const MAX_LENGTH = 256;

const HAS_LETTER = /\p{L}/u;
const HAS_DIGIT = /\p{Nd}/u;
/** Anything that is not a letter, a digit or whitespace. Unicode-aware. */
const HAS_SYMBOL = /[^\p{L}\p{Nd}\s]/u;

export type PasswordVerdict = { ok: true } | { ok: false; reason: string };

/** Substitutions people use to satisfy a composition rule. One-way and lossy:
 *  this is not decoding, it is collapsing a family of disguises onto the word
 *  underneath so the word can be recognised. */
const LEET: Readonly<Record<string, string>> = {
  '0': 'o', '1': 'i', '2': 'z', '3': 'e', '4': 'a', '5': 's',
  '6': 'g', '7': 't', '8': 'b', '9': 'g',
  '@': 'a', $: 's', '!': 'i', '|': 'l', '+': 't', '(': 'c', '<': 'c',
};

/**
 * Fold a candidate to the word it is wearing a costume of.
 *
 * TRAILING decoration is stripped BEFORE substitution, and only trailing: a `!`
 * or a `1` on the end is padding bolted on to satisfy the rule, and reading it
 * as a substituted letter turns `Password1!` into `paswordi`, which then misses
 * the word it plainly is. Leading characters are left alone because there the
 * substitution is real — `@dmin` IS `admin`.
 */
export function foldToWord(candidate: string): string {
  const trimmed = candidate.toLowerCase().replace(/[^a-z]+$/, '');
  const substituted = [...trimmed]
    .map((ch) => LEET[ch] ?? ch)
    .join('')
    .replace(/[^a-z]/g, '');
  return substituted.replace(/(.)\1{1,}/g, '$1');
}

/**
 * Passwords and bases that must never be accepted. Stored FOLDED, so
 * `password` here also rejects `P@ssw0rd!` and `passsword123`.
 *
 * The last group is household-specific and is the part that matters most: a
 * homelab password is far likelier to be the name of the thing it protects than
 * a generic common password, and no public list contains `homeserver`.
 */
const WEAK_BASES: readonly string[] = [
  'password', 'passwd', 'pass', 'letmein', 'welcome', 'admin', 'administrator',
  'login', 'secret', 'changeme', 'default', 'guest', 'root', 'toor', 'user',
  // qwerty/asdf families are deliberately ABSENT — hasKeyboardRun owns them, and
  // listing them here too would explain a keyboard run as "a common word": a
  // correct refusal with a misleading reason, which makes people retry the idea.
  'qazwsx', 'qweasd',
  'test', 'testing', 'temp', 'demo',
  'iloveyou', 'monkey', 'dragon', 'master', 'shadow', 'football', 'starwars',
  'trustno', 'whatever', 'freedom', 'hello', 'summer', 'winter', 'money',
  'computer', 'internet', 'server', 'network', 'system', 'backup',
  'google', 'facebook', 'amazon', 'microsoft', 'apple',
  // This installation's nouns — the first thing anyone who knows Owner would try.
  'harbor', 'briefing', 'briefingtable', 'homeserver', 'tailscale', 'claude',
  'kiosk', 'owner', 'example', 'homelab', 'homebase', 'vrpc', 'homehub',
];

const WEAK_SET: ReadonlySet<string> = new Set(WEAK_BASES.map(foldToWord));

const KEYBOARD_ROWS = ['qwertyuiop', 'asdfghjkl', 'zxcvbnm', '1234567890'] as const;

/** A run of >= 4 adjacent keys, forwards or backwards. */
function hasKeyboardRun(folded: string, raw: string): boolean {
  const hay = `${folded} ${raw.toLowerCase()}`;
  for (const row of KEYBOARD_ROWS) {
    const back = [...row].reverse().join('');
    for (let i = 0; i + 4 <= row.length; i += 1) {
      if (hay.includes(row.slice(i, i + 4))) {
        return true;
      }
      if (hay.includes(back.slice(i, i + 4))) {
        return true;
      }
    }
  }
  return false;
}

/** `abcd`, `2345`, `wxyz` — sequential runs of >= 4. */
function hasSequentialRun(value: string): boolean {
  const s = value.toLowerCase();
  let ascending = 1;
  let descending = 1;
  for (let i = 1; i < s.length; i += 1) {
    const delta = s.charCodeAt(i) - s.charCodeAt(i - 1);
    ascending = delta === 1 ? ascending + 1 : 1;
    descending = delta === -1 ? descending + 1 : 1;
    if (ascending >= 4 || descending >= 4) {
      return true;
    }
  }
  return false;
}

export interface PolicyContext {
  /** The single likeliest choice for the person who owns the account. */
  readonly username?: string;
}

/**
 * Judge a candidate password. The reason is deliberately actionable: the policy
 * is printed on the form, so it is not a secret, and a vague "invalid password"
 * leaves the owner guessing at a rule they must satisfy to proceed.
 */
export function validatePassword(candidate: string, context: PolicyContext = {}): PasswordVerdict {
  if (typeof candidate !== 'string' || candidate === '') {
    return { ok: false, reason: 'Enter a new password.' };
  }
  const length = [...candidate].length; // code points, so an emoji counts as one
  if (length < MIN_LENGTH) {
    return { ok: false, reason: `Use at least ${MIN_LENGTH} characters.` };
  }
  if (length > MAX_LENGTH) {
    return { ok: false, reason: `Use at most ${MAX_LENGTH} characters.` };
  }
  if (candidate.trim() !== candidate) {
    // Leading/trailing space survives a paste and then fails to survive retyping.
    return { ok: false, reason: 'Remove the space at the start or end.' };
  }
  if (!HAS_LETTER.test(candidate)) {
    return { ok: false, reason: 'Include at least one letter.' };
  }
  if (!HAS_DIGIT.test(candidate)) {
    return { ok: false, reason: 'Include at least one number.' };
  }
  if (!HAS_SYMBOL.test(candidate)) {
    return { ok: false, reason: 'Include at least one symbol, such as ! ? # or -' };
  }

  const folded = foldToWord(candidate);
  if (folded.length > 0 && WEAK_SET.has(folded)) {
    return { ok: false, reason: 'That is one of the most-guessed passwords. Pick another.' };
  }
  // A weak base with decoration bolted on is the same password.
  for (const weak of WEAK_SET) {
    if (weak.length >= 4 && folded.includes(weak)) {
      return { ok: false, reason: 'That is a common word with characters added. Pick another.' };
    }
  }
  const username = context.username?.trim().toLowerCase();
  if (username && username.length >= 3 && folded.includes(foldToWord(username))) {
    return { ok: false, reason: 'Do not use your username in your password.' };
  }
  if (hasKeyboardRun(folded, candidate)) {
    return { ok: false, reason: 'Avoid runs of adjacent keys like qwerty or 1234.' };
  }
  if (hasSequentialRun(candidate)) {
    return { ok: false, reason: 'Avoid sequences like abcd or 2345.' };
  }
  if (new Set([...candidate.toLowerCase()]).size < 4) {
    return { ok: false, reason: 'Use a few more different characters.' };
  }
  return { ok: true };
}

/** The rule text shown on the form. Kept beside the rules so they cannot drift. */
export const POLICY_SUMMARY =
  `At least ${MIN_LENGTH} characters, with a letter, a number and a symbol. ` +
  'Common passwords and keyboard runs are refused.';

/* --- temporary credentials ------------------------------------------------ */

/**
 * The alphabet a temporary password is drawn from: lowercase only, missing
 * `i l o 0 1` — the glyphs people mis-read off a screen and mis-type into a
 * phone. A temp password exists to be transcribed by hand exactly once, so
 * every ambiguous character in the alphabet is a failed login that looks like a
 * wrong password.
 */
export const TEMP_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
const TEMP_GROUPS = 2;
const TEMP_GROUP_SIZE = 4;

/**
 * Mint a temporary password: `bkrt-9fqm`.
 *
 * ~39 bits, far below what a permanent password should carry, and that is the
 * point — Owner's rule, recorded in kiosk: "short is only safe because it
 * cannot be lived with". Safety comes from the EXPIRY and the forced change,
 * not from entropy. `randomInt` rather than `% alphabet.length` on a random
 * byte: 256 is not a multiple of 31, so the modulo would make the first five
 * letters measurably likelier than the rest.
 */
export function generateTempPassword(): string {
  const groups: string[] = [];
  for (let g = 0; g < TEMP_GROUPS; g += 1) {
    let group = '';
    for (let i = 0; i < TEMP_GROUP_SIZE; i += 1) {
      group += TEMP_ALPHABET[randomInt(TEMP_ALPHABET.length)];
    }
    groups.push(group);
  }
  return groups.join('-');
}

/** Default life of a temp code. Long enough to hand over in chat and type in;
 *  short enough that a forgotten one is not a standing credential. */
export const DEFAULT_TEMP_TTL_HOURS = 24;
