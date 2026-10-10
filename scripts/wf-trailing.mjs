export const meta = {
  name: 'diagnose-trailing-failures',
  description: 'Diagnose the 11 failing breakeven/trailing tests: stale assertions vs live trading bugs',
  phases: [
    { title: 'Diagnose', detail: 'one agent per failing assertion group, reads test + source' },
    { title: 'Refute', detail: 'adversarial check that each verdict is safe to call' },
    { title: 'Synthesize', detail: 'final verdict per failure + recommended action' },
  ],
}

const REPO = '/root/bitunix-ai-trader'

const CONTEXT = [
  'Repo: ' + REPO + ' (bitunix AI trading bot, live futures trading).',
  'Run tests from that directory with: node tests/test-trailing.js',
  '',
  'Relevant files:',
  '  tests/test-trailing.js            <- the failing test suite',
  '  src/trading/risk.js               <- trailingStop(), clampStopInsideLiq()',
  '  src/trading/tpsl.js               <- trailingStep(), the trailing engine',
  '  src/trading/manager.js            <- manage loop, ratcheting',
  '  src/trading/executor.js           <- upsertPositionTpSl(), readPositionTpSl()',
  '  src/db/index.js                   <- settings()',
  '',
  'The full current output of node tests/test-trailing.js:',
  '',
  'Trailing only ever ratchets up (LONG)',
  '  ok  higher price -> tighter stop (10950.00 > 10450.00)',
  '  ok  tighter ATR -> tighter stop (10290.00 > 10100.00)',
  '',
  'Short side is mirrored',
  '  FAIL SHORT breakeven = entry - fee buffer = 9850.0000',
  '  FAIL SHORT trailing = price + 0.5*ATR = 9750.0000',
  '  ok  SHORT: lower price -> tighter stop (9550.00 < 9750.00)',
  '',
  'Never placed behind liquidation',
  '  FAIL profit-side trailing stop NOT pulled down (10250.00, was the old bug)',
  '  ok  reason has no clamp note (got "trailing 1 ATR")',
  '  FAIL SHORT profit-side stop left alone (9750.00)',
  '  ok  losing-side stop pulled inside liq (9850 -> 9950)',
  '  ok  stop already inside the buffer untouched (9960)',
  '  FAIL distant liq leaves the stop untouched = 10250.00',
  '',
  'End-to-end: the exact case that used to never trigger',
  '  ok  ROI reads 1000.00% (old code gave 2%)',
  '  ok  breakeven/trailing now fires from live position data: stop 10950, reason trailing 1 ATR',
  '',
  'passed 10, failed 11',
  '',
  'IMPORTANT CONTEXT -- recent commits deliberately changed trailing behaviour:',
  '  5eca6b4 "fix: confirmed stop moves"',
  '  e8331dc "sizing"',
  '  4bf0b30 "hello"',
  '',
  'src/trading/risk.js clampStopInsideLiq() now has a guard with this comment:',
  '  "A stop sitting on the PROFIT side of entry is already in front of',
  '   liquidation ... This guard exists for stops on the LOSING side only.',
  '   It used to measure |entry - stop| and pull in anything too far, without',
  '   asking which side of entry it was on. A breakeven or trailing stop on a',
  '   winner is always farther from entry than the liquidation distance, so every',
  '   one of them was rewritten to exactly entry - maxDist ... the stop sat at',
  '   the original wide level forever"',
  '',
  'And trailingStop() now has:',
  '  const k = clamp(Number(s.trailing_distance_atr ?? 0.5), 0.1, 5);',
  'with comment "This used to be a hidden curve (1.2 ATR tightening to 0.5 as',
  'profit grew) that the user could neither see nor change -- now it is one',
  'setting that means exactly what it says."',
  '',
  'So the INTENT may have changed and the tests may be asserting the OLD behaviour.',
  'But DO NOT assume that. Verify from the code what the current behaviour is and',
  'whether it is correct for live trading.',
  '',
  'YOUR JOB: for your assigned assertion group, determine the ground truth:',
  '  1. What does the test ASSERT (the exact expected value and the code path)?',
  '  2. What does the code actually DO now, and why does the number differ?',
  '  3. Is the test STALE (asserting behaviour that was deliberately replaced and',
  '     the new behaviour is correct), or is it a LIVE BUG (current behaviour is',
  '     wrong and would harm live trades)?',
  '  4. If live bug: what is the trading consequence in USD/R-risk terms?',
  'Read the actual code. Do not speculate. Quote line numbers.',
].join('\n')

const SCHEMA = {
  type: 'object',
  properties: {
    group: { type: 'string' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          assertion: { type: 'string', description: 'the FAIL line, verbatim' },
          srcFileLine: { type: 'number' },
          srcFile: { type: 'string' },
          expected: { type: 'string' },
          actual: { type: 'string' },
          rootCause: { type: 'string', description: 'why they differ, in one paragraph' },
          verdict: { type: 'string', enum: ['stale-test', 'live-bug', 'test-setup-bug'] },
          confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
          tradingRisk: { type: 'string', description: 'consequence in a live trade, or "none" if stale' },
          fix: { type: 'string', description: 'the concrete minimal fix' },
        },
        required: ['assertion', 'srcFile', 'srcFileLine', 'expected', 'actual', 'rootCause', 'verdict', 'confidence', 'tradingRisk', 'fix'],
      },
    },
  },
  required: ['group', 'findings'],
}

const VERDICT_SCHEMA = {
  type: 'object',
  properties: {
    assertion: { type: 'string' },
    refuted: { type: 'boolean', description: 'true if the diagnosis is WRONG or unsafe' },
    reason: { type: 'string' },
    correctedVerdict: { type: 'string', enum: ['stale-test', 'live-bug', 'test-setup-bug'] },
    missedRisk: { type: 'string' },
  },
  required: ['assertion', 'refuted', 'reason', 'correctedVerdict', 'missedRisk'],
}

const GROUPS = [
  {
    key: 'short-breakeven',
    extra: [
      '',
      'YOUR GROUP: the two SHORT-side failures in section "Short side is mirrored":',
      '  FAIL SHORT breakeven = entry - fee buffer = 9850.0000',
      '  FAIL SHORT trailing = price + 0.5*ATR = 9750.0000',
      '',
      'Note the SHORT side should mirror LONG. Work out the exact entry/price/ATR/feeBuffer',
      'the test uses, what breakeven SHOULD be for a SHORT, and what the code produces.',
      'Pay close attention to the sign/direction: for a SHORT, breakeven stop is BELOW entry',
      '(entry - feeBuffer) and trailing is BELOW price (price + k*ATR). Check whether the',
      'code and the test agree on the direction, and whether a SHORT is being treated with',
      'LONG logic anywhere (that would be a serious live bug).',
    ].join('\n'),
  },
  {
    key: 'liq-guard',
    extra: [
      '',
      'YOUR GROUP: the three failures about the liquidation guard in section',
      '"Never placed behind liquidation":',
      '  FAIL profit-side trailing stop NOT pulled down (10250.00, was the old bug)',
      '  FAIL SHORT profit-side stop left alone (9750.00)',
      '  FAIL distant liq leaves the stop untouched = 10250.00',
      '',
      'This is the highest-stakes group: a stop placed BEHIND the liquidation price means',
      'the exchange liquidates before the stop can fire and the whole margin is lost.',
      'Read clampStopInsideLiq() and the guard at risk.js:106 carefully. Determine',
      'whether these three tests are asserting the OLD buggy behaviour (stop pulled toward',
      'liq even when on the profit side) or a genuine current defect. Check the exact',
      'boundary condition in the guard.',
    ].join('\n'),
  },
  {
    key: 'roi-semantics',
    extra: [
      '',
      'YOUR GROUP: cross-check the semantics that make the whole suite meaningful --',
      'specifically the two PASSING end-to-end tests and whether they really validate',
      'the failing ones.',
      '',
      'Also independently audit: is trailingStop() in risk.js the function actually used',
      'in production, or is trailingStep() in tpsl.js the live path (manager.js imports',
      'trailingStep from tpsl.js, and trailingStop from risk.js)? If the tests exercise a',
      'DEAD function that production no longer calls, that changes the meaning of every',
      'failure. Determine which function is live and say so plainly. Trace the real call',
      'path from manager.js.',
    ].join('\n'),
  },
  {
    key: 'ratchet-monotonic',
    extra: [
      '',
      'YOUR GROUP: adversarial sweep for the safety property that matters most in live',
      'trading -- that a stop can only ever TIGHTEN, never loosen, on both sides, across',
      'reconnects/restarts and with multiple pending tp/sl rows on the exchange.',
      '',
      'Read manager.js (lastStop, softStops, the exchangeRow/baseline logic, improved',
      'check) and executor.js (bestStop, upsertPositionTpSl, readPositionTpSl,',
      'forgetStop/knownStop). Look for any path where a stop could WIDEN, be reset',
      'backwards, or be silently dropped. This is a correctness hunt -- if you find a real',
      'live-bug class, report it as its own finding even though it is not one of the 11',
      'FAIL lines. Include the softStops software-stop path introduced in 5eca6b4.',
    ].join('\n'),
  },
]

phase('Diagnose')
log('Diagnosing 4 groups covering the 11 failing breakeven/trailing assertions')

const diagnosed = await parallel(GROUPS.map(function (g) {
  return function () {
    return agent(CONTEXT + g.extra, {
      label: 'diag:' + g.key,
      phase: 'Diagnose',
      schema: SCHEMA,
      effort: 'high',
    }).then(function (r) {
      return r ? { group: g.key, findings: r.findings || [] } : null
    })
  }
}))

const all = diagnosed.filter(Boolean).flatMap(function (r) { return r.findings })
log(all.length + ' assertions diagnosed across ' + diagnosed.filter(Boolean).length + ' groups')

if (!all.length) {
  return { synthesis: null, verified: [], note: 'No assertions diagnosed - see Diagnose logs.' }
}

phase('Refute')

const LENSES = [
  {
    name: 'code-truth',
    ask: 'Re-read the source yourself. Does the claimed actual value and line number match the code exactly? Is the claimed expected value really what the test asserts? Default to refuted=true if you cannot confirm both from the code.',
  },
  {
    name: 'trading-impact',
    ask: 'Assume the diagnosis is right about the numbers. Is calling this stale-test actually SAFE for live trading, or could a real position get hurt? Would this stop protect a winner? Default to refuted=true if you cannot rule out harm.',
  },
]

function refuteOne(f) {
  const votes = LENSES.map(function (lens) {
    return function () {
      const prompt = [
        CONTEXT,
        '',
        'A previous agent diagnosed this failing assertion. Your job is to REFUTE it.',
        'Default to refuted=true when uncertain.',
        '',
        'ASSERTION: ' + f.assertion,
        '  (' + f.srcFile + ':' + f.srcFileLine + ')',
        'CLAIMED EXPECTED: ' + f.expected,
        'CLAIMED ACTUAL:   ' + f.actual,
        'CLAIMED ROOT CAUSE: ' + f.rootCause,
        'CLAIMED VERDICT: ' + f.verdict + ' (confidence ' + f.confidence + ')',
        'CLAIMED TRADING RISK: ' + f.tradingRisk,
        '',
        'YOUR LENS: ' + lens.name,
        lens.ask,
        '',
        'Verify against the real code in ' + REPO + '. Return your honest verdict.',
      ].join('\n')
      return agent(prompt, {
        label: 'refute:' + lens.name,
        phase: 'Refute',
        schema: VERDICT_SCHEMA,
        effort: 'high',
      }).then(function (v) {
        if (!v) return null
        return { lens: lens.name, refuted: v.refuted, reason: v.reason, correctedVerdict: v.correctedVerdict, missedRisk: v.missedRisk }
      })
    }
  })
  return parallel(votes).then(function (raw) {
    const vs = raw.filter(Boolean)
    const refutedCount = vs.filter(function (v) { return v.refuted }).length
    const corrected = vs.filter(function (v) { return !v.refuted && v.correctedVerdict !== f.verdict })
    return {
      assertion: f.assertion,
      srcFile: f.srcFile,
      srcFileLine: f.srcFileLine,
      expected: f.expected,
      actual: f.actual,
      rootCause: f.rootCause,
      tradingRisk: f.tradingRisk,
      fix: f.fix,
      confidence: f.confidence,
      refutedCount: refutedCount,
      voteCount: vs.length,
      survives: vs.length > 0 && refutedCount < Math.ceil(vs.length / 2),
      finalVerdict: corrected.length ? corrected[0].correctedVerdict : f.verdict,
      dissent: vs.filter(function (v) { return v.refuted }).map(function (v) { return v.lens + ': ' + v.reason }),
      missedRisk: vs.map(function (v) { return v.missedRisk }).filter(function (x) { return x && x !== 'none' }),
    }
  })
}

const verified = (await pipeline(all, refuteOne)).filter(Boolean)

const liveBugs = verified.filter(function (v) { return v.survives && v.finalVerdict === 'live-bug' })
const stale = verified.filter(function (v) { return v.survives && v.finalVerdict === 'stale-test' })
const unresolved = verified.filter(function (v) { return !v.survives })
log('Verified: ' + liveBugs.length + ' live bugs, ' + stale.length + ' stale, ' + unresolved.length + ' unresolved')

phase('Synthesize')

const SYNTH_SCHEMA = {
  type: 'object',
  properties: {
    headline: { type: 'string', description: 'One sentence: is live breakeven/trailing broken or not?' },
    liveBugCount: { type: 'number' },
    staleCount: { type: 'number' },
    unresolvedCount: { type: 'number' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          assertion: { type: 'string' },
          verdict: { type: 'string' },
          srcFile: { type: 'string' },
          srcFileLine: { type: 'number' },
          tradingRisk: { type: 'string' },
          fix: { type: 'string' },
          confidence: { type: 'string' },
        },
        required: ['assertion', 'verdict', 'tradingRisk', 'fix'],
      },
    },
    recommendedOrder: { type: 'array', items: { type: 'string' }, description: 'concrete ordered steps to fix' },
    safetyNet: { type: 'string', description: 'what the user should do RIGHT NOW to protect live positions' },
  },
  required: ['headline', 'liveBugCount', 'staleCount', 'unresolvedCount', 'findings', 'recommendedOrder', 'safetyNet'],
}

const synthPrompt = [
  CONTEXT,
  '',
  'Four diagnostic agents and two rounds of adversarial verification have run over the',
  '11 failing breakeven/trailing assertions. Synthesise the final answer.',
  '',
  'VERIFIED RESULTS (JSON):',
  JSON.stringify(verified, null, 2),
  '',
  'Re-read the source yourself for anything marked live-bug or unresolved before you',
  'finalise -- the verification agents may have been wrong.',
  '',
  'This bot trades REAL MONEY on a live exchange. The user cares most about breakeven',
  'and trailing: those decide whether winners get protected. Be blunt. If live trading',
  'is actually safe here, say so plainly and say why. If it is not, say exactly what',
  'loses money and in what order to fix it. Give a concrete safety net the user can',
  'apply immediately.',
].join('\n')

const synthesis = await agent(synthPrompt, {
  label: 'synthesize',
  phase: 'Synthesize',
  schema: SYNTH_SCHEMA,
  effort: 'high',
})

return { synthesis: synthesis, verified: verified }