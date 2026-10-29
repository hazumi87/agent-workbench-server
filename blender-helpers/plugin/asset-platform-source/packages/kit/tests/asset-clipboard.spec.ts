// lineage: asset-platform/@asset/kit — created by domain-development (agent-user) — task
//
// 1b ACCEPTANCE — <asset-clipboard> at vanilla parity. Exercises the full behavior
// contract against a faithful in-memory MOCK of the asset-clipboard backend
// (tests/mock-clipboard-server.ts), which ALSO serves the fixture + bundle so the
// page and the API share ONE origin — same as production behind the gateway, so
// NO CORS is involved and the component uses a relative `base`. The mock binds an
// OS-assigned ephemeral port (no registry-managed service port is squatted).
// Deterministic + zero live-backend pollution. All assertions are in LIGHT DOM.
import { test, expect } from '@playwright/test';
import { startMock, type MockHandle } from './mock-clipboard-server';

let mock: MockHandle;
test.beforeAll(async () => {
  mock = await startMock();
});
test.afterAll(async () => {
  await new Promise<void>((r) => mock.server.close(() => r()));
});

test('asset-clipboard: light-DOM render + Add/Save/Trash/Recycle/Revive parity', async ({ page }) => {
  await page.goto(`${mock.origin}/fixture.html`);

  // (a) light DOM (no shadow), empty state for a fresh mock.
  const host = page.locator('asset-clipboard');
  await expect(host).toBeVisible();
  expect(await page.evaluate(() => document.querySelector('asset-clipboard')!.shadowRoot === null)).toBe(true);
  await expect(page.locator('asset-clipboard .ap-empty')).toContainText('Clipboard is empty');

  // (b) Add menu: exactly 5 items; URL disabled.
  await page.locator('asset-clipboard .ap-cb-add-btn').click();
  await expect(page.locator('asset-clipboard .ap-menu-item')).toHaveCount(5);
  const disabled = page.locator('asset-clipboard .ap-menu-item-disabled');
  await expect(disabled).toHaveCount(1);
  await expect(disabled).toContainText('URL');
  // outside-click closes the Add menu (vanilla-faithful behavior)
  await page.locator('body').click({ position: { x: 2, y: 2 } });
  await expect(page.locator('asset-clipboard .ap-menu-item')).toHaveCount(0);

  // (c) upload two clips through the component's OWN hard-drive flow (set files
  // on its hidden <input>), which triggers the component's post-upload reload —
  // true parity behavior, no test-only refresh hack.
  const fileInput = page.locator('asset-clipboard input[type="file"]');
  await fileInput.setInputFiles([
    { name: 'f0.wav', mimeType: 'audio/wav', buffer: Buffer.from([1, 2, 3]) },
    { name: 'f1.wav', mimeType: 'audio/wav', buffer: Buffer.from([4, 5, 6]) },
  ]);
  const rows = page.locator('asset-clipboard .ap-cb-row');
  await expect(rows).toHaveCount(2);

  // list count matches the backend
  const apiCount = await page.evaluate(
    async () => (await (await fetch('/asset-management/library/api/list')).json()).clips.length,
  );
  expect(apiCount).toBe(2);

  // (d) Save the first row → in-place flip to saved (Save disabled+greyed, action → ✕).
  const firstRow = rows.first();
  await firstRow.locator('.ap-cb-save').click();
  await expect(firstRow.locator('.ap-cb-save')).toBeDisabled();
  await expect(firstRow.locator('.ap-cb-save')).toHaveClass(/ap-cb-saved/);
  await expect(firstRow.locator('.ap-cb-x')).toBeVisible();
  // promoted clip stays in the list — parity
  await expect(rows).toHaveCount(2);
  const curated = await page.evaluate(
    async () => (await (await fetch('/asset-management/library/api/assets?transient=0')).json()).assets.length,
  );
  expect(curated).toBe(1);

  // (e) Trash a still-transient row → leaves the list, into recycle.
  const transientRow = rows.filter({ has: page.locator('.ap-cb-trash') }).first();
  await transientRow.locator('.ap-cb-trash').click();
  await expect(rows).toHaveCount(1);

  await page.locator('asset-clipboard .ap-cb-add-btn').click();
  await page.locator('asset-clipboard .ap-menu-item', { hasText: 'Recycle bin' }).click();
  const recycleRows = page.locator('asset-clipboard .ap-recycle-row');
  await expect(recycleRows).toHaveCount(1);

  // (f) Revive → returns to the list (back to 2).
  await recycleRows.first().locator('.ap-recycle-revive').click();
  await expect(rows).toHaveCount(2);
});
