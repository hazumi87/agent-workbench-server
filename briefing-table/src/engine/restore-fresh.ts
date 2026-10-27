/**
 * A RESTORE WHOSE CONVERSATION WAS NEVER WRITTEN (Owner 2026-10-13, Kiosk).
 *
 * The engine banks a session id when it LAUNCHES a claude pane, before claude has written a line. A launch that ends at
 * the folder-trust prompt (the person answered "No, exit") therefore leaves a banked id with NO transcript, and every
 * Restore after it ran `claude --resume <id>` against nothing: "No session found", straight back to the shell, however
 * many times it was tried. The restore path had chosen that on purpose ("let the resume fail visibly rather than silently
 * launching fresh") for a transcript that was LOST; it was never meant for one that never existed.
 *
 * THREE OUTCOMES, NEVER TWO: this answers true ONLY when this engine's own disk can say the transcript is absent (the
 * access is `local`, so the read is definite, and the exact file the vendor would resume is not there). An ssh or agent
 * read that came back empty may just be unreachable, so it stays "resume the banked id" and fails visibly as before.
 */
export function neverWritten(opts: {
  /** remoteFsAccess(target).mode */
  access: string;
  /** the vendor's local transcript path, when it has one */
  transcriptPath?: (cwd: string, sessionId: string) => string;
  cwd: string | null | undefined;
  sessionId: string;
  exists: (path: string) => boolean;
}): boolean {
  if (opts.access !== 'local' || !opts.transcriptPath || !opts.cwd) {
    return false;
  }
  try {
    return !opts.exists(opts.transcriptPath(opts.cwd, opts.sessionId));
  } catch {
    return false; // could not tell: keep the banked id
  }
}
