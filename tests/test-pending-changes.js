/**
 * Risk / signal-gate settings can only be proposed by the AI; they apply on the user's /confirmset.
 */
import { needsConfirmation, queueChange, takePending, listPending } from '../src/ai/pending-changes.js';
import { runTool, applyConfirmed } from '../src/ai/tools.js';
import { settings } from '../src/db/index.js';

let passed = 0, failed = 0;
const ok = (c, m) => { c ? (passed++, console.log(`  ok  ${m}`)) : (failed++, console.log(`  FAIL ${m}`)); };

ok(needsConfirmation('min_confidence', 50) === true, 'min_confidence is protected');
ok(needsConfirmation('min_agreement', 1) === true, 'min_agreement is protected');
ok(needsConfirmation('margin_pct', 100) === true, 'margin_pct is protected');
ok(needsConfirmation('auto_trade', false) === false && needsConfirmation('auto_trade', 'off') === false, 'turning auto_trade OFF needs no confirmation');
ok(needsConfirmation('auto_trade', true) === true, 'turning auto_trade ON does');
ok(needsConfirmation('thinking_level', 'high') === false, 'a non-risk setting is not protected');

const before = settings().min_confidence;
const r = await runTool('update_settings', { changes: { min_confidence: 50 } });
ok(Array.isArray(r.pending) && r.pending.length === 1 && r.pending[0].key === 'min_confidence', 'AI change to min_confidence is queued, not applied');
ok(settings().min_confidence === before, 'the live setting did not change');
ok(/NOT applied/.test(String(r.note)), 'the model is told it was not applied');
ok(listPending().some((p) => p.id === r.pending[0].id), 'the proposal is listed for the user');

const taken = takePending(r.pending[0].id);
ok(!!taken && takePending(r.pending[0].id) === null, 'a pending change can be taken once only');

const lev = await runTool('set_leverage', { leverage: 5 });
ok(lev.pending?.length === 1 && settings().leverage !== 5, 'AI leverage change is queued, not applied');

// the user's /confirmset path applies it
const id = queueChange({ tool: 'update_settings', args: { changes: { min_agreement: 3 } }, summary: 'test' });
const t = takePending(id);
const done = await applyConfirmed(t.tool, t.args);
ok(done.applied?.min_agreement === 3 && settings().min_agreement === 3, 'a confirmed change is applied');

console.log(`\n${passed} passed, ${failed} failed`); process.exit(failed ? 1 : 0);
