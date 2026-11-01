/**
 * Guard rails of the self-repair path and the deterministic trailing verdict.
 * Pure: reads real repo files, never writes any.
 */
import { safePath, simulate, readSource } from '../src/ai/repair.js';
import { explainTrailing } from '../src/ai/diagnose.js';

let passed = 0, failed = 0;
const assert = (c, m) => { c ? (passed++, console.log(`  ok  ${m}`)) : (failed++, console.log(`  FAIL ${m}`)); };
const throws = (fn) => { try { fn(); return false; } catch { return true; } };

// ---- path safety
assert(throws(() => safePath('../etc/passwd')), 'path escaping the repo is refused');
assert(throws(() => safePath('/etc/passwd')), 'absolute path is refused');
assert(throws(() => safePath('.env')), '.env is protected');
assert(throws(() => safePath('.env.local')), '.env.* is protected');
assert(throws(() => safePath('node_modules/pg/index.js')), 'node_modules is protected');
assert(throws(() => safePath('.git/config')), '.git is protected');
assert(throws(() => safePath('src/ai/repair.js')), 'the repair machinery cannot edit itself');
assert(throws(() => safePath('scripts/run-guarded.js')), 'the supervisor cannot be edited by the agent');
assert(!throws(() => safePath('src/trading/manager.js')), 'normal source files are allowed');
assert(throws(() => readSource('.env')), 'read_source cannot read .env');

// ---- edit validation against a real file (in memory only)
const anchor = "export function recordGuard(";
assert(simulate([{ path: 'src/trading/trace.js', old_str: anchor, new_str: anchor }]).length === 1, 'unique old_str is accepted');
assert(throws(() => simulate([{ path: 'src/trading/trace.js', old_str: 'const ', new_str: 'let ' }])), 'ambiguous old_str (matches many times) is refused');
assert(throws(() => simulate([{ path: 'src/trading/trace.js', old_str: 'THIS_DOES_NOT_EXIST_ANYWHERE', new_str: 'x' }])), 'old_str that is absent is refused');
assert(throws(() => simulate([{ path: 'src/nope-missing.js', old_str: 'a', new_str: 'b' }])), 'editing a non-existent file is refused');
assert(throws(() => simulate([])), 'empty edit list is refused');
const sim = simulate([{ path: 'src/trading/trace.js', old_str: anchor, new_str: 'export function renamed(' }]);
assert(sim[0].after.includes('export function renamed(') && sim[0].before.includes(anchor), 'simulate returns before/after without touching disk');

// ---- deterministic trailing verdicts
const now = 1_000_000;
const S = { manage_interval_sec: 15, breakeven_threshold: 20, trailing_trigger_roi_pct: 25 };
const mk = (stages, ago = 3) => ({ symbol: 'X', side: 'LONG', passes: 5, lastPassAt: now - ago * 1000, stages });

let v = explainTrailing(null, S, now);
assert(v.category === 'unknown', 'no trace -> unknown');

v = explainTrailing(mk({ gate: { inProfit: true, roi: 5, leverage: 40, atrSource: 'execution-tf' } }, 300), S, now);
assert(v.category === 'possible_code_bug' && /stalled/.test(v.headline), 'stale guard pass -> loop stalled');

v = explainTrailing(mk({ gate: { inProfit: false, roi: -3, leverage: 40 } }), S, now);
assert(v.category === 'expected_behavior' && /not in profit/.test(v.headline), 'negative ROI -> not armed, expected');

v = explainTrailing(mk({ gate: { inProfit: true, roi: 12, leverage: 40 }, trail_eval: { method: 'ATR', roi: 12, breakevenThreshold: 20, trailingTriggerRoi: 25, atr: 1, trailStop: null } }), S, now);
assert(v.category === 'expected_behavior' && /below breakeven_threshold/.test(v.headline), 'ROI below breakeven threshold is named with the numbers');

v = explainTrailing(mk({ gate: { inProfit: true, roi: 30, leverage: 40, atrSource: 'none' }, trail_eval: { method: 'ATR', roi: 30, breakevenThreshold: 20, trailingTriggerRoi: 25, atr: null, trailStop: 100, trailReason: 'breakeven' } }), S, now);
assert(v.category === 'possible_code_bug' && /no ATR/.test(v.headline), 'past trigger with no ATR -> flagged');

v = explainTrailing(mk({
  gate: { inProfit: true, roi: 30, leverage: 40 },
  trail_eval: { method: 'ATR', roi: 30, breakevenThreshold: 20, trailingTriggerRoi: 25, atr: 1, trailStop: 101, trailReason: 'trailing 0.5 ATR' },
  ratchet: { wanted: 101, exchangeStop: 102, baseline: 102, improved: false },
}), S, now);
assert(v.category === 'expected_behavior' && v.reasons.some((r) => /not an improvement/.test(r)), 'stop not better than the exchange stop -> explained');

v = explainTrailing(mk({
  gate: { inProfit: true, roi: 30, leverage: 40 },
  trail_eval: { method: 'ATR', roi: 30, breakevenThreshold: 20, trailingTriggerRoi: 25, atr: 1, trailStop: 101, trailReason: 'trailing 0.5 ATR' },
  ratchet: { wanted: 101, exchangeStop: 95, baseline: 95, improved: true },
  write: { ok: false, reason: 'exchange did not apply', exchangeSl: 95, wanted: 101 },
}), S, now);
assert(v.category === 'exchange' && /write failed/.test(v.headline), 'failed exchange write -> exchange category');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
