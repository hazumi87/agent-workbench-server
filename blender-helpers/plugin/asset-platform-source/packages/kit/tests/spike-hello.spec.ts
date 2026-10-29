// lineage: asset-platform/@asset/kit — created by domain-development (agent-user) — vk task 1a
//
// GATE SPIKE 2: assert React renders into the custom element's LIGHT DOM, that a
// CustomEvent crosses the boundary, and that the CSS design tokens are applied.
// If React had mounted into a shadow root, the light-DOM locator would be empty
// and host.shadowRoot would be non-null.
import { test, expect } from '@playwright/test';

test('asset-hello renders React into LIGHT DOM, themed, with events', async ({ page }) => {
  // Register the CustomEvent listener BEFORE the page loads its scripts, via an
  // init script that stores the fired flag on window — robust against the
  // navigation teardown that kills a floating page.evaluate promise.
  await page.addInitScript(() => {
    (window as unknown as { __ready: boolean }).__ready = false;
    document.addEventListener(
      'asset-hello:ready',
      () => {
        (window as unknown as { __ready: boolean }).__ready = true;
      },
      { once: true },
    );
  });

  await page.goto('/tests/fixture-spike-hello.html');

  // React rendered into LIGHT DOM (locator finds it without piercing shadow).
  const el = page.locator('asset-hello .asset-hello');
  await expect(el).toHaveText('Hello, world!');

  const probe = await page.evaluate(() => {
    const host = document.querySelector('asset-hello')!;
    const span = host.querySelector('.asset-hello') as HTMLElement | null;
    // The token CSS is injected by the bundle; confirm the design token
    // resolves to its parity value on :root.
    const accent = getComputedStyle(document.documentElement)
      .getPropertyValue('--ap-accent')
      .trim();
    return {
      hasShadowRoot: host.shadowRoot !== null,
      lightText: span?.textContent ?? null,
      accentToken: accent,
    };
  });

  expect(probe.hasShadowRoot).toBe(false); // genuine light DOM
  expect(probe.lightText).toBe('Hello, world!');
  expect(probe.accentToken).toBe('#a78bfa'); // token applied at parity value

  // CustomEvent crossed the WC boundary (set by the init-script listener).
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __ready: boolean }).__ready), {
      timeout: 5000,
    })
    .toBe(true);
});
