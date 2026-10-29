<!-- lineage: asset-platform/@asset/kit — created by domain-development (agent-user) — task (Track A A2) -->
# Theming the Asset Platform kit

A **theme is a set of CSS custom-property values**. Kit components never hardcode
colors, spacing, or type — they read `var(--ap-*)` tokens. To re-skin the kit you
override those tokens; **you never touch component code.** This works because the
kit mounts in **light DOM** (not shadow DOM), so tokens defined anywhere above a
kit element cascade into it (the design notes).

## The token schema (the override contract)

| Group | Tokens |
|---|---|
| Surfaces | `--ap-bg` `--ap-bg-card` `--ap-bg-hover` `--ap-border` |
| Text | `--ap-text-primary` `--ap-text-secondary` `--ap-text-muted` |
| Accents | `--ap-accent` (+ semantic `--ap-accent-audio` `--ap-accent-voice` `--ap-accent-rip` `--ap-accent-clip`) `--ap-danger` `--ap-success` |
| Typography | `--ap-font-sans` `--ap-font-mono` `--ap-fs-xs` `--ap-fs-sm` `--ap-fs-base` `--ap-fs-lg` |
| Spacing | `--ap-space-1` … `--ap-space-5` (4px base) |
| Radius | `--ap-radius` `--ap-radius-sm` |

Component CSS also reads short aliases (`--accent`, `--surface`, `--border`,
`--text`, `--text-muted`, `--bg-hover`) ported from the vanilla `picker.css`.
These **derive from the `--ap-*` set**, so overriding `--ap-*` updates them too —
you only ever set `--ap-*` values in a theme.

## Applying a theme

Two equivalent ways — neither edits any component:

**1. `data-ap-theme` attribute** (built-in themes). Set it on any ancestor of a
kit element, or on the element itself:

```html
<div data-ap-theme="light">
  <asset-clipboard base="/asset-tools/asset-clipboard"></asset-clipboard>
</div>
```

`tokens.css` ships the default (`:root`, parity with the asset-tools/landing
look) and an example `light` theme. Add a per-game theme by adding another block:

```css
[data-ap-theme='mygame'] {
  --ap-bg: #0a0e14;
  --ap-accent: #ff7a1a;
  /* …override only what differs from default… */
}
```

**2. Override the tokens directly** under any scope you control (your own
stylesheet). A `[data-ap-theme]` block is just that, pre-packaged:

```css
.my-embed-context {
  --ap-accent: #00bcd4;
  --ap-bg-card: #102027;
}
```

## Notes

- A theme only needs to set tokens that differ from the default; unset tokens
  inherit the `:root` parity values.
- Themes compose with the cascade: an inner `data-ap-theme` overrides an outer
  one for the subtree it scopes.
- Per-game theming is the intended use (the kit embeds in different game-dev
  contexts); the mechanism is identical for any host.
- Verified by `tests/theme-override.spec.ts`: switching `data-ap-theme` re-skins
  `<asset-clipboard>` (computed colors change) with zero component changes.
