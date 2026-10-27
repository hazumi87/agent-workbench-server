/** L4: redirects cannot escape the signed-in engine's origin. */
import { proof } from './_hosting-proof.mjs';
import { tsImport } from 'tsx/esm/api';
const { safeNext } = await tsImport('../src/server/auth.ts', import.meta.url);
await proof('L4', async check => {
  for (const value of ['/\\evil.example', '/\\\\evil.example', '//evil.example', 'https://evil.example', '\\evil.example', '/a\\b']) {
    const result = safeNext(value);
    check(result === '/', `reject unsafe next ${JSON.stringify(value)}`);
    check(new URL(result, 'https://engine.example').origin === 'https://engine.example', 'result remains on engine origin');
  }
  for (const value of ['/rooms', '/manager.html?x=1#anchor']) check(safeNext(value) === value, `preserve safe path ${value}`);
  check(safeNext(null) === '/', 'missing next goes home');
});
