/* THE COMPACT REF GRAMMAR (design review [ref]): `asset_<12 hex>`, `note_<12 hex>`, `line_<digits>`. Pure, no imports, so a test or the app's regex can be compared to it.
 * A ref that does not match is just text; whether a ref that DOES match points at something is refs.ts's refState. */
export type RefKind = 'asset' | 'note' | 'line';
export interface ParsedRef {
  kind: RefKind;
  id: string;
}

const RE = /^(?:(asset|note)_([0-9a-f]{12})|line_([0-9]{1,12}))$/;

export function parseRef(s: unknown): ParsedRef | null {
  if (typeof s !== 'string') {
    return null;
  }
  const m = RE.exec(s);
  if (!m) {
    return null;
  }
  return m[1] ? { kind: m[1] as RefKind, id: m[2] } : { kind: 'line', id: m[3] };
}

export const refOf = (kind: RefKind, id: string): string => `${kind}_${id}`;
