/**
 * Build the ENGINE half of the desktop app's package (lead order 15616 item 3; compile script).
 *
 *   node scripts/build-engine-package.mjs --out <dir>
 *
 * Produces <dir>/ with dist/ (the engine as plain JavaScript), web/ (beside dist/: the engine finds its repo root as dist's parent),
 * src/components/ (the manifests the engine scans), package.json, and BUILD-MANIFEST.json (what was built, from what, with SHA-256s).
 * It does NOT touch node_modules or the native modules: that step (fetch or build for Node 22.23.1 win32-x64, provenance, the
 * Visual C++ import check) is builder-one's, and it runs on this output.
 *
 * Two things it does that tsc alone does not:
 *   1. compiles with rewriteRelativeImportExtensions, so `./x.ts` imports become `./x.js` for plain Node;
 *   2. VENDORS the one file the engine imports from a dependency's TypeScript source, pty-broker/src/protocol.ts (two constants,
 *      BROKER_DEFAULT_PORT and PROTOCOL_VERSION): Node refuses to load .ts under node_modules. It is compiled to
 *      dist/vendor/pty-broker-protocol.js and the import is repointed; the source and output hashes go in the manifest. If the
 *      engine ever imports another .ts from node_modules, this script FAILS rather than ship something that cannot start.
 * Fails the build when any compiled file still imports a .ts file.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const NODE_TARGET = '22.23.1'; // the version the suite and the server engine run on; the app bundles exactly this
const PROTOCOL_SRC = 'node_modules/pty-broker/src/protocol.ts';
const PROTOCOL_SPEC = 'pty-broker/src/protocol.ts';
const PROTOCOL_OUT = 'dist/vendor/pty-broker-protocol.js';

function fail(msg) {
  console.error(`build-engine-package: ${msg}`);
  process.exit(1);
}
const sha = (buf) => createHash('sha256').update(buf).digest('hex');

function walk(dir, out = []) {
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      walk(p, out);
    } else {
      out.push(p);
    }
  }
  return out;
}

const argv = process.argv.slice(2);
const outIx = argv.indexOf('--out');
if (outIx < 0 || !argv[outIx + 1]) {
  fail('usage: node scripts/build-engine-package.mjs --out <dir>');
}
const OUT = resolve(argv[outIx + 1]);
if (OUT === ROOT || OUT.startsWith(`${ROOT}/src`) || OUT.startsWith(`${ROOT}/web`) || OUT.startsWith(`${ROOT}/test`)) {
  fail(`refusing to build into ${OUT} (inside the source tree)`);
}
if (!existsSync(join(ROOT, PROTOCOL_SRC))) {
  fail(`${PROTOCOL_SRC} is missing: run npm install first`);
}
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

/* 1. compile */
const tsc = spawnSync(process.execPath, [join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', 'tsconfig.json', '--noEmit', 'false', '--outDir', join(OUT, 'dist'), '--rewriteRelativeImportExtensions', '--allowImportingTsExtensions', 'false'], { cwd: ROOT, encoding: 'utf8' });
if (tsc.status !== 0) {
  fail(`tsc failed:\n${tsc.stdout}${tsc.stderr}`);
}

/* 2. vendor the protocol constants, repoint the one import */
const protocolJs = ts.transpileModule(readFileSync(join(ROOT, PROTOCOL_SRC), 'utf8'), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 }, fileName: 'protocol.ts', reportDiagnostics: true });
if ((protocolJs.diagnostics ?? []).length > 0) {
  fail(`could not compile ${PROTOCOL_SRC}: ${protocolJs.diagnostics.map((d) => ts.flattenDiagnosticMessageText(d.messageText, ' ')).join('; ')}`);
}
mkdirSync(dirname(join(OUT, PROTOCOL_OUT)), { recursive: true });
writeFileSync(join(OUT, PROTOCOL_OUT), protocolJs.outputText);
const brokerClient = join(OUT, 'dist', 'engine', 'broker-client.js');
const before = readFileSync(brokerClient, 'utf8');
const repointed = before.split(`'${PROTOCOL_SPEC}'`).join("'../vendor/pty-broker-protocol.js'");
if (repointed === before) {
  fail(`dist/engine/broker-client.js does not import '${PROTOCOL_SPEC}' any more: update this script`);
}
writeFileSync(brokerClient, repointed);

/* 2b. the PTY BROKER, compiled the same way, so the app can run it as its own supervised process: `node broker/main.js` with
   PTY_BROKER_PORT (a real port: 0 is not supported by the broker) and PTY_BROKER_TOKEN in the environment. It imports ws and node-pty from
   the package's node_modules. Its readiness is GET /health on its port (open, tokenless); it also logs "pty-broker up on ..." to stdout. */
const BROKER_SRC = ['main.ts', 'protocol.ts', 'auth.ts'];
const brokerOut = {};
for (const f of BROKER_SRC) {
  const srcPath = join(ROOT, 'node_modules', 'pty-broker', 'src', f);
  if (!existsSync(srcPath)) {
    fail(`${srcPath} is missing: run npm install first`);
  }
  const text = readFileSync(srcPath, 'utf8');
  const r = ts.transpileModule(text, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 }, fileName: f, reportDiagnostics: true });
  if ((r.diagnostics ?? []).length > 0) {
    fail(`could not compile pty-broker/src/${f}: ${r.diagnostics.map((d) => ts.flattenDiagnosticMessageText(d.messageText, ' ')).join('; ')}`);
  }
  const js = r.outputText.split("'./protocol.ts'").join("'./protocol.js'").split("'./auth.ts'").join("'./auth.js'");
  const outPath = join(OUT, 'broker', f.replace(/\.ts$/, '.js'));
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, js);
  brokerOut[`broker/${f.replace(/\.ts$/, '.js')}`] = { source: `node_modules/pty-broker/src/${f}`, sourceSha256: sha(readFileSync(srcPath)), outputSha256: sha(Buffer.from(js)) };
}

/* 3. nothing may still import TypeScript (a package specifier ending .ts, or a relative one) */
const stray = [];
for (const f of [...walk(join(OUT, 'dist')), ...walk(join(OUT, 'broker'))].filter((p) => p.endsWith('.js'))) {
  const text = readFileSync(f, 'utf8');
  for (const m of text.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+\.ts)['"]/g)) {
    stray.push(`${relative(OUT, f)} imports ${m[1]}`);
  }
}
if (stray.length > 0) {
  fail(`compiled files still import TypeScript:\n  ${stray.join('\n  ')}`);
}

/* 4. what sits beside dist */
cpSync(join(ROOT, 'web'), join(OUT, 'web'), { recursive: true });
if (existsSync(join(ROOT, 'src', 'components'))) {
  cpSync(join(ROOT, 'src', 'components'), join(OUT, 'src', 'components'), { recursive: true });
}
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
writeFileSync(join(OUT, 'package.json'), `${JSON.stringify({ name: pkg.name, version: pkg.version, private: true, type: 'module', engines: { node: NODE_TARGET }, dependencies: pkg.dependencies }, null, 2)}\n`);

/* 5. the manifest */
const git = (args) => spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' }).stdout.trim();
const lock = JSON.parse(readFileSync(join(ROOT, 'package-lock.json'), 'utf8'));
const files = {};
for (const f of walk(join(OUT, 'dist'))) {
  files[relative(OUT, f)] = sha(readFileSync(f));
}
for (const f of walk(join(OUT, 'broker'))) {
  files[relative(OUT, f)] = sha(readFileSync(f));
}
const manifest = {
  builtFrom: { commit: git(['rev-parse', 'HEAD']), dirty: git(['status', '--porcelain']) !== '' },
  nodeTarget: NODE_TARGET,
  builtWithNode: process.version,
  entry: 'dist/server/index.js',
  vendored: [{ spec: PROTOCOL_SPEC, source: PROTOCOL_SRC, sourceSha256: sha(readFileSync(join(ROOT, PROTOCOL_SRC))), output: PROTOCOL_OUT, outputSha256: files[PROTOCOL_OUT], ptyBrokerResolved: lock.packages?.['node_modules/pty-broker']?.resolved ?? null }],
  broker: { entry: 'broker/main.js', env: ['PTY_BROKER_PORT', 'PTY_BROKER_TOKEN'], readiness: 'GET /health', files: brokerOut },
  nativeModulesNeeded: ['better-sqlite3', 'node-pty'],
  nativeModulesNotNeeded: { argon2: 'accounts only, loaded on demand', '@resvg/resvg-js': 'icon lab only', sharp: 'thumbnails only; a request answers 415 without it' },
  files,
};
writeFileSync(join(OUT, 'BUILD-MANIFEST.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`built ${Object.keys(files).length} files into ${OUT} (entry ${manifest.entry}, commit ${manifest.builtFrom.commit.slice(0, 7)}${manifest.builtFrom.dirty ? ' + uncommitted changes' : ''})`);
