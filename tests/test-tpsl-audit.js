import { auditTpSl } from '../src/ai/tpsl-audit.js';
let passed = 0, failed = 0;
const ok = (c, m) => { c ? (passed++, console.log(`  ok  ${m}`)) : (failed++, console.log(`  FAIL ${m}`)); };
const round5 = (p) => Number(Number(p).toFixed(5));
const steps = [{ share: 25, r: 1 }, { share: 25, r: 1.4 }, { share: 25, r: 1.6 }, { share: 25, r: 3 }];

// low-priced coin: stop distance is only ~2 ticks, so nearby R levels round to one price
const a = auditTpSl({ side: 'LONG', qty: 824, entry: 0.00328, slDist: 0.000016, steps,
  rows: [{ tpPrice: 0.00331, tpQty: 206 }, { tpPrice: 0.00334, tpQty: 412 }, { slPrice: 0.00326, slQty: 412 }], round: round5 });
ok(a.flags.some((f) => /collide after rounding/.test(f)), 'rungs that round to the same price are flagged');
ok(a.flags.some((f) => /No TP row on the exchange for/.test(f)), 'a ladder price with no exchange row is flagged');
ok(a.flags.some((f) => /covers 412 of 824/.test(f)), 'a stop row that covers only part of the position is flagged');

const dup = auditTpSl({ side: 'LONG', qty: 800, entry: 100, slDist: 1, steps: [{ share: 50, r: 1 }, { share: 50, r: 2 }],
  rows: [{ tpPrice: 101, tpQty: 400 }, { tpPrice: 101, tpQty: 400 }, { slPrice: 99 }], round: (p) => p });
ok(dup.flags.some((f) => /more than one TP row at the same price/.test(f)), 'duplicate TP rows on the exchange are flagged');
ok(!dup.flags.some((f) => /covers/.test(f)), 'a whole-position stop row (no qty) is accepted');

const clean = auditTpSl({ side: 'SHORT', qty: 100, entry: 100, slDist: 1, steps: [{ share: 40, r: 1 }, { share: 60, r: 2 }],
  rows: [{ tpPrice: 99, tpQty: 40 }, { tpPrice: 98, tpQty: 60 }, { slPrice: 101 }], round: (p) => p });
ok(clean.flags.length === 0, 'a correct SHORT ladder produces no findings');
console.log(`\n${passed} passed, ${failed} failed`); process.exit(failed ? 1 : 0);
