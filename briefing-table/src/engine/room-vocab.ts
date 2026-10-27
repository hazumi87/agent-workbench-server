/**
 * ROOM VOCABULARY — the two word lists the store AND the command parser both
 * need (the design notes §1.2, §3) [ticket].
 *
 * A module with NO imports, so the parser (src/server/room-commands.ts) stays
 * pure in the strong sense: loading it pulls in no db, no driver and no server
 * code. The store imports these and re-exports them (the endpoint re-exports
 * them from there), and the store's handle validator (`normalizeHandle`) is
 * what enforces RESERVED_HANDLES on a write — this file only declares them.
 * One list each; nobody keeps a second copy.
 */

export type SeatPolicy = 'persistent' | 'fresh' | 'dispatched' | 'pool';

/** The fill policies (wr §2.7). The store's CHECK constraint is built from it. */
export const SEAT_POLICIES: readonly SeatPolicy[] = ['persistent', 'fresh', 'dispatched', 'pool'];

/** Handles a human may not TYPE, because each is already an address with a
 *  meaning of its own (`@room` = everyone here, `@lead`, `@all` = the installation,
 *  `@user`, and `voice` = the voice agent's author name, room-voice §6.1, and
 *  `concierge` = the Concierge's proxy author, concierge.md P2). A
 *  DERIVED default that lands on one takes the placeholder suffix path instead
 *  (`room2`, handle_named=0). Enforced by the store's
 *  `normalizeHandle` / `freeHandle`, and by the parser before a write. */
export const RESERVED_HANDLES: readonly string[] = ['room', 'lead', 'all', 'user', 'voice', 'concierge'];
