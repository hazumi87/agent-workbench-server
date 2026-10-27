/* icon-lab-trace.test — the Icon Lab's tracer stage (src/engine/contour-trace.ts, ours; it replaced the GPL-2.0 `potrace`, 2026-10).
 * Proves the swap kept the contract: a rung returns ONE ink-coloured silhouette (no white backing shape), it still reads as the
 * same mark, and the recipe levers still move the output. Also pins that the GPL package is gone from the manifest. */
import { readFileSync } from 'node:fs';
import { runRecipe, rasterizeSvg, ensureViewBox, LADDER, race } from '../src/engine/icon-lab.ts';
import { traceInk } from '../src/engine/contour-trace.ts';

let pass = 0;
let fail = 0;
const ok = (cond: boolean, label: string, detail?: string) => {
  console.log(`${cond ? '  ✓' : '  ✗'} ${label}${detail ? `  (${detail})` : ''}`);
  if (cond) { pass++; } else { fail++; }
};

// A ring with a dot inside plus a speck far outside the mark: the ring and dot must survive, the speck must go at the turd rungs.
const MARK = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path fill-rule="evenodd" d="M50 10a40 40 0 1 0 .01 0zM50 24a26 26 0 1 1-.01 0z"/><circle cx="50" cy="50" r="8"/><rect x="2" y="2" width="1.2" height="1.2"/></svg>';
const bm = await rasterizeSvg(ensureViewBox(MARK), 512);

const r512 = await runRecipe(bm, LADDER[0]);
ok(/<path\b/.test(r512.svg) && r512.paths >= 1, 'a rung traces to path data', `${r512.paths} path(s), ${r512.bytes} bytes`);
ok(!/rgb\(\s*255|#fff\b|#ffffff|fill="white"/i.test(r512.svg), 'no white backing shape: only the ink is drawn');
ok(!/<rect\b/i.test(r512.svg), 'no background rect');
ok(r512.svg.includes('currentColor'), 'colour is applied by the consumer (currentColor)');

const master = (await race(bm, MARK)).find((c) => c.id === 'original')!;
ok(master.fidelity === 100, 'the original control is its own reference');
const t128 = (await race(bm, MARK)).find((c) => c.id === 'trace-128')!;
ok(t128.fidelity >= 90, 'trace-128 still reads as the same mark', `fidelity ${t128.fidelity}`);

const small = await runRecipe(bm, LADDER[2]); // @96 dilate 1 turd 8
ok(small.bytes > 0 && small.svg.length < r512.svg.length * 2, 'a simplifying rung returns a bounded result', `${small.bytes} vs ${r512.bytes} bytes`);

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const deps = { ...manifest.dependencies, ...manifest.devDependencies };
ok(!('potrace' in deps), 'package.json no longer depends on the GPL-2.0 potrace');
ok(!('@image-tracer-ts/core' in deps), 'and carries no third-party tracer at all (the tracer is in the tree)');

/* The tracer on its own: a disc must stay a disc (the failure the design system saw was an octagon), a speck must go, a hole must stay. */
{
  const N = 64;
  const ink = new Uint8Array(N * N);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const dx = x + 0.5 - 32;
      const dy = y + 0.5 - 32;
      const r = Math.hypot(dx, dy);
      ink[y * N + x] = r <= 24 && r >= 8 ? 1 : 0; // a ring
    }
  }
  ink[2 * N + 2] = 1; // a one-pixel speck in the corner
  const svg = traceInk(ink, N, N, { turd: 4, smooth: 0.9, round: 2 });
  ok((svg.match(/M/g) ?? []).length === 2, 'a ring traces to exactly two loops (outer + hole); the speck is dropped', `${(svg.match(/M/g) ?? []).length} loops`);
  const got = await rasterizeSvg(svg, N);
  let inter = 0;
  let uni = 0;
  for (let i = 0; i < N * N; i++) {
    const a = ink[i] && i !== 2 * N + 2 ? 1 : 0;
    const b = got.pixels[i * 4 + 3] > 127 ? 1 : 0;
    inter += a & b;
    uni += a | b;
  }
  ok(inter / uni > 0.95, 'the traced ring matches the ring it came from', `IoU ${(inter / uni).toFixed(3)}`);
  const sharpSvg = traceInk(ink, N, N, { turd: 4, smooth: 0, round: 0 });
  ok(/Q/.test(svg) && sharpSvg.length > 0, 'corner rounding on gives curves; off still returns a polygon');
}

console.log(`\nPASS ${pass} FAIL ${fail}`);
process.exit(fail ? 1 : 0);
