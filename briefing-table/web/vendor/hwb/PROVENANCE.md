# hwb bridge (vendored, pinned)

`hwb-bridge v1.0`, copied from the window-host library at its
2026-08-18 release. `hwb-host.css` carries no version of its own and pins with
the same release.

Why it is vendored: the shell page is served from this engine's own origin, and
ES module imports are blocked cross-origin, so the bridge is copied here rather
than imported from the window host.

## Rules

- No behaviour edits. The only differences from the upstream copy are comment
  text normalized for this release. Verify the files
  with the hashes in the table below.
- The absolute import is a contract. `hwb-host.js` imports
  `/assets/aurora/window-chrome/hwb-chrome.js` by absolute path (search for
  `hwb-chrome`). The window-chrome bundle is therefore served at exactly that
  path: `web/assets/aurora/window-chrome/`. Move that folder and the bridge
  breaks.
- To update, replace both files together from the upstream release and update
  the table.

| File | SHA-256 |
|---|---|
| hwb-host.js | 2ed5239e52dd0c80b5381616346db698d00e2f902e14a63ec1a0aa275705bc59 |
| hwb-host.css | 0268ae7b9ffbf3767d5b3a4c44c241600f77fb4a0e89a2372eae95616fdf6730 |
