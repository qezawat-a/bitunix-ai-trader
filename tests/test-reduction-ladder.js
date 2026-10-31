/**
 * The tiered risk-limit cascade from the Bitunix help-centre article
 * "Bitunix Futures Liquidation Mechanism and Tiered Risk Limit".
 *
 * A position above tier 1 is not liquidated outright: the exchange cancels
 * open orders, then PARTIALLY closes the position (FOK) to drop it into the
 * tier below, repeating until it is back inside its margin requirement or
 * reaches tier 1. Only tier 1 gets the outright liquidation.
 *
 * The article's worked example, used verbatim as the anchor here:
 *   5,000,000 USDT position at tier 4
 *   Reduced Value = Position Value - Limit Amount of the Original Level
 *                = 5,000,000 - 2,500,000 = 2,500,000
 *   -> back to tier 3
 *
 * risk.js models this with reductionLadder() / inReductionZone().
 */
import { reductionLadder, inReductionZone } from '../src/trading/risk.js';

let passed = 0, failed = 0;
const assert = (c, m) => { c ? (passed++, console.log(`  ok  ${m}`)) : (failed++, console.log(`  FAIL ${m}`)); };

// Tier bands chosen so tier 4's floor is 2,500,000 — the number the article
// subtracts in its example. Levels ascend with size; MMR rises with size.
const TIERS = [
  { level: 1, startValue: 0, endValue: 100_000, leverage: 200, mmr: 0.003 },
  { level: 2, startValue: 100_000, endValue: 1_000_000, leverage: 150, mmr: 0.005 },
  { level: 3, startValue: 1_000_000, endValue: 2_500_000, leverage: 100, mmr: 0.0065 },
  { level: 4, startValue: 2_500_000, endValue: 5_000_000, leverage: 75, mmr: 0.01 },
  { level: 5, startValue: 5_000_000, endValue: 10_000_000, leverage: 50, mmr: 0.0125 },
];

console.log("\nthe article's worked example: 5,000,000 at tier 4");
{
  const ladder = reductionLadder(TIERS, 5_000_000);
  assert(ladder.length > 0, 'a tier-4 position is exposed to a forced reduction');
  const first = ladder[0];
  assert(first.fromLevel === 4, `first step starts at tier 4 (got ${first.fromLevel})`);
  assert(first.toNotional === 2_500_000,
    `reduced to 2,500,000 exactly as the article states (got ${first.toNotional})`);
  assert(first.toLevel === 3, `and lands back in tier 3 (got ${first.toLevel})`);
  assert(first.closesNotional === 2_500_000,
    `closes 2,500,000 of notional (got ${first.closesNotional})`);
  assert(first.orderType === 'FOK', 'the reduction leg is FOK');
  assert(first.toMmr === 0.0065,
    `the reduced leg re-prices at tier 3 MMR (got ${first.toMmr})`);
}

console.log('\nthe cascade steps down one tier at a time');
{
  const ladder = reductionLadder(TIERS, 9_000_000);
  const levels = ladder.map((s) => `${s.fromLevel}->${s.toLevel}`).join(' ');
  assert(levels === '5->4 4->3 3->2 2->1', `walks 5->4->3->2->1 (got ${levels})`);
  const last = ladder[ladder.length - 1];
  assert(last.toNotional === 100_000,
    `finishes at tier 1's ceiling, 100,000 (got ${last.toNotional})`);
}

console.log('\ntier 1 is NOT in a reduction zone — it liquidates outright');
{
  assert(reductionLadder(TIERS, 50_000).length === 0, 'no ladder below tier 1');
  assert(inReductionZone(TIERS, 50_000) === false, 'tier-1 position reports no reduction zone');
  assert(inReductionZone(TIERS, 100_000) === false, 'exactly at the tier 1/2 boundary is still tier 1');
  assert(inReductionZone(TIERS, 100_001) === true, 'one USDT into tier 2 is exposed');
}

console.log('\nthe ladder terminates — it can never spin');
{
  const ladder = reductionLadder(TIERS, 50_000_000);
  assert(ladder.length <= TIERS.length, `at most one step per tier (got ${ladder.length})`);
  const last = ladder[ladder.length - 1];
  assert(last && last.toLevel === 1, 'always bottoms out at tier 1');
  const mono = ladder.every((s) => s.toNotional < s.fromNotional);
  assert(mono, 'every step strictly shrinks the position');
}

console.log('\na position past the top tier is the MOST exposed, not the least');
{
  // 50,000,000 is above every band (the highest ends at 10,000,000). It must
  // still resolve to the top tier and walk all the way down — reading it as
  // "no tier" would report the single most exposed position as safe.
  const ladder = reductionLadder(TIERS, 50_000_000);
  assert(ladder.length === 4, `above the top tier still walks the full cascade (got ${ladder.length})`);
  assert(ladder[0].fromLevel === 5, `starts from the top tier (got ${ladder[0].fromLevel})`);
  assert(ladder[0].toNotional === 5_000_000,
    `first step lands on the top tier's floor (got ${ladder[0].toNotional})`);
  assert(inReductionZone(TIERS, 50_000_000) === true, 'above the top tier is in a reduction zone');
}

console.log('\ndegenerate input is safe');
{
  assert(reductionLadder([], 5_000_000).length === 0, 'no tiers -> no ladder');
  assert(reductionLadder(null, 5_000_000).length === 0, 'null tiers -> no ladder');
  assert(reductionLadder(TIERS, 0).length === 0, 'zero notional -> no ladder');
  assert(reductionLadder(TIERS, -5).length === 0, 'negative notional -> no ladder');
  const flat = [{ level: 1, startValue: 0, endValue: 100, leverage: 1, mmr: 0.01 }];
  assert(reductionLadder(flat, 999_999).length === 0, 'a lone tier 1 never reduces');
}

console.log(`\npassed ${passed}, failed ${failed}`);
process.exit(failed ? 1 : 0);