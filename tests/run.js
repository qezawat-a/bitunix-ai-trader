#!/usr/bin/env node
/**
 * Runs every test in tests/ and reports one summary.
 *
 *   node tests/run.js            all suites
 *   node tests/run.js roi        only suites whose name contains "roi"
 */

import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const filter = process.argv[2];

const suites = readdirSync(here)
  .filter((f) => f.startsWith('test-') && f.endsWith('.js'))
  .filter((f) => !filter || f.includes(filter))
  .sort();

if (!suites.length) {
  console.error(filter ? `no test matches "${filter}"` : 'no tests found');
  process.exit(1);
}

let failed = 0;
for (const suite of suites) {
  console.log(`\n${'='.repeat(60)}\n${suite}\n${'='.repeat(60)}`);
  const r = spawnSync(process.execPath, [join(here, suite)], { stdio: 'inherit' });
  if (r.status !== 0) failed++;
}

console.log(`\n${'='.repeat(60)}`);
console.log(failed ? `${failed} of ${suites.length} suites FAILED` : `all ${suites.length} suites passed`);
process.exit(failed ? 1 : 0);