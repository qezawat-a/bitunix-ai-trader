/**
 * Agent context policy: autonomous and signal-judgement turns must not be
 * able to rewrite risk settings or bypass the scanner with a new entry.
 */
import { runTool, toolSchemas } from '../src/ai/tools.js';

let passed = 0, failed = 0;
const assert = (condition, message) => {
  condition ? (passed++, console.log(`  ok  ${message}`)) : (failed++, console.log(`  FAIL ${message}`));
};

const names = (options) => new Set(toolSchemas(options).map((x) => x.name));

console.log('=== agent tool context policy ===\n');

const full = names();
assert(full.has('update_settings'), 'user turns expose update_settings');
assert(full.has('set_leverage'), 'user turns expose set_leverage');
assert(full.has('open_position'), 'user turns expose open_position');

const autonomous = names({ allowRiskChanges: false, allowEntries: false });
assert(!autonomous.has('update_settings'), 'autonomous turns hide update_settings');
assert(!autonomous.has('set_leverage'), 'autonomous turns hide set_leverage');
assert(!autonomous.has('set_margin_mode'), 'autonomous turns hide set_margin_mode');
assert(!autonomous.has('open_position'), 'autonomous turns cannot open an unscreened entry');
assert(!autonomous.has('reverse_position'), 'autonomous turns cannot reverse into an unscreened entry');
assert(autonomous.has('get_positions'), 'autonomous turns retain read-only account tools');
assert(autonomous.has('set_position_tpsl'), 'autonomous turns retain position protection tools');

const judgement = names({ allowRiskChanges: false, allowEntries: false, readOnly: true });
assert(judgement.has('get_performance'), 'signal judgement retains performance history');
assert(!judgement.has('set_position_tpsl'), 'signal judgement cannot modify TP/SL');
assert(!judgement.has('close_all_positions'), 'signal judgement cannot close positions');

const blockedRisk = await runTool('update_settings', { changes: { leverage: 1 } }, { allowRiskChanges: false });
assert(String(blockedRisk.error).includes('disabled'), 'runtime guard blocks a hidden risk tool');
const blockedEntry = await runTool('reverse_position', { positionId: 'x' }, { allowEntries: false });
assert(String(blockedEntry.error).includes('disabled'), 'runtime guard blocks a hidden entry tool');
const blockedMutation = await runTool('close_all_positions', {}, { readOnly: true });
assert(String(blockedMutation.error).includes('read-only'), 'runtime guard blocks mutation during judgement');

console.log(`\npassed ${passed}, failed ${failed}`);
process.exit(failed ? 1 : 0);
