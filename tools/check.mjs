#!/usr/bin/env node
/**
 * One-shot local check: everything CI would do, with no network and no install.
 *
 * Use this when you do not want to wait for GitHub Actions (or when the
 * workflow file could not be pushed because the token lacked the `workflow`
 * scope). Wrapped by ./check.sh for convenience.
 *
 * Exits non-zero on the first failing section.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;

const run = (label, cmd, args, opts = {}) => {
  process.stdout.write(`\n=== ${label}\n`);
  const r = spawnSync(cmd, args, { cwd: ROOT, stdio: 'inherit', shell: false, ...opts });
  if (r.status !== 0) {
    failures++;
    process.stdout.write(`--- FAILED: ${label} (exit ${r.status})\n`);
  }
  return r.status === 0;
};

// 1. syntax
const files = [];
for (const dir of ['lib', 'test', 'tools']) {
  for (const f of readdirSync(join(ROOT, dir))) {
    if (f.endsWith('.js') || f.endsWith('.mjs')) files.push(join(dir, f));
  }
}
let syntaxOk = true;
for (const f of files) {
  const r = spawnSync(process.execPath, ['--check', f], { cwd: ROOT, stdio: 'pipe' });
  if (r.status !== 0) {
    syntaxOk = false;
    failures++;
    console.log(`syntax FAIL ${f}\n${r.stderr}`);
  }
}
console.log(`=== syntax: ${syntaxOk ? `all ${files.length} modules parse` : 'FAILED'}`);

// 2. tests
run('tests (detector + plugin)', process.execPath, [
  '--test',
  'test/detector.test.mjs',
  'test/plugin.test.mjs',
]);

// 3. host contract regression
run('host contract', process.execPath, ['tools/verify-cordis-contract.mjs']);

// 4. calibration must still separate loops from clean corpora
run('calibration', process.execPath, ['tools/calibrate.mjs']);

// 5. release must stay dependency-free
console.log('\n=== dependency-free release');
if (existsSync(join(ROOT, 'node_modules'))) {
  console.log('node_modules present -- the plugin must run without an install');
  failures++;
} else {
  console.log('no node_modules, as expected');
}

console.log(
  failures === 0
    ? '\nALL CHECKS PASSED'
    : `\n${failures} CHECK(S) FAILED`,
);
process.exit(failures === 0 ? 0 : 1);
