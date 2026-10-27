export interface ToMeFlags {
  kind: string;
  author: string;
  authorSeat: string;
  target: string;
  targetSeat: string;
  toUser: boolean;
  tool: string;
  for: string;
}
export function toMeFlags(e: { kind: string; author?: string | null; author_seat?: string | null; target?: string | null; target_seat?: string | null; meta?: unknown }): ToMeFlags;
export function isToMe(f: ToMeFlags, namesPerson?: boolean): boolean;
export function isHiddenFact(e: { kind: string; meta?: unknown }): boolean;
