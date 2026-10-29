// lineage: asset-platform/@asset/kit — created by domain-development (agent-user) — task (Track A A2)
//
// A2 ACCEPTANCE: a second token set re-skins <asset-clipboard> WITHOUT touching
// component code. We render the same component under the default theme and under
// `data-ap-theme="light"` and assert the computed colors change. The component
// source (AssetClipboard.tsx) is unchanged from 1b — only a token override on an
// ancestor differs, proving the documented theme-override surface (THEMING.md).
import { test, expect } from '@playwright/test';
import { startMock, type MockHandle } from './mock-clipboard-server';

let mock: MockHandle;
test.beforeAll(async () => {
  mock = await startMock();
});
test.afterAll(async () => {
  await new Promise<void>((r) => mock.server.close(() => r()));
});

// normalize an rgb(...) string for comparison (runs in the test/Node context).
const norm = (s: string) => s.replace(/\s+/g, '');
// read a computed style property off the first match of a selector, in-page.
const computed = (page: import('@playwright/test').Page, sel: string, prop: string) =>
  page.locator(sel).first().evaluate(
    (el, p) => getComputedStyle(el).getPropertyValue(p),
    prop,
  );

test('theme override re-skins <asset-clipboard> via tokens, no component change', async ({ page }) => {
  await page.goto(`${mock.origin}/fixture.html`);

  // sanity: it rendered in light DOM
  await expect(page.locator('asset-clipboard .ap-empty')).toContainText('Clipboard is empty');

  // Read accent-driven + text colors under the DEFAULT theme.
  const addSel = 'asset-clipboard .ap-cb-add-btn';
  const emptySel = 'asset-clipboard .ap-empty';
  const defaultBg = norm(await computed(page, addSel, 'background-color'));
  const defaultText = norm(await computed(page, emptySel, 'color'));

  // Apply the "light" theme by setting data-ap-theme on an ANCESTOR (body) —
  // pure token override, the component is never touched.
  await page.evaluate(() => document.body.setAttribute('data-ap-theme', 'light'));

  // computed styles must change (the token cascade re-skinned the live element)
  await expect
    .poll(async () => norm(await computed(page, addSel, 'background-color')))
    .not.toBe(defaultBg);

  const themedBg = norm(await computed(page, addSel, 'background-color'));
  const themedText = norm(await computed(page, emptySel, 'color'));

  expect(themedBg).not.toBe(defaultBg);
  expect(themedText).not.toBe(defaultText);

  // Specific expected values confirm it's the token set doing the work:
  // default audio accent #a78bfa → light accent #6d4ad8.
  expect(defaultBg).toBe(norm('rgb(167, 139, 250)')); // #a78bfa
  expect(themedBg).toBe(norm('rgb(109, 74, 216)')); // #6d4ad8

  // Removing the theme reverts to parity default (no sticky state).
  await page.evaluate(() => document.body.removeAttribute('data-ap-theme'));
  await expect
    .poll(async () => norm(await computed(page, addSel, 'background-color')))
    .toBe(defaultBg);
});
