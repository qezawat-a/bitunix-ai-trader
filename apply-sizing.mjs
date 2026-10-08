#!/usr/bin/env node
// apply-sizing.mjs — implements stopAtrFor() (the TODO(human) stub in src/trading/risk.js).
//   node apply-sizing.mjs [path/to/bitunix-ai-trader]
// Stop/target distance is sized off the first structure timeframe after the execution one
// (e.g. 3m for TIMEFRAMES=1m,3m,5m,15m) instead of the noise-level 1m ATR.
// It touches ONLY stopAtrFor in src/trading/risk.js: no leverage, margin, cross/isolated code.
// Idempotent; writes risk.js.bak; changes nothing unless every step matches.
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(process.argv[2] || '.');
const PAYLOAD = {"ops": [{"file": "src/trading/risk.js", "old": " * The pick below is the human's design task (see the TODO marker in the body).\n */\nexport function stopAtrFor(signal, s) {\n  // TODO(human): pick the sizing ATR here.\n  //   signal.timeframes \u2014 per-TF analysis; a TF whose candles failed is absent\n  //   s.timeframes      \u2014 \"1m,3m,5m,15m\" (first entry = the execution TF)\n  //   return { atr, tf } \u2014 tf names the timeframe actually used\n  const tf = String(s?.timeframes || '1m').split(',')[0].trim();\n  return { atr: Number(signal.atr) || 0, tf };\n}\n\nexport function computeDynamicTpSl(signal) {", "new": " * The pick below is the human's design task (see the TODO marker in the body).\n */\nexport function stopAtrFor(signal, s) {\n  // Size off the first STRUCTURE timeframe: the first configured TF AFTER the\n  // execution one (the first entry) that produced a valid ATR. A TF whose\n  // candles failed is absent from signal.timeframes and is skipped. With none\n  // valid, fall back to the execution ATR.\n  const tfs = String(s?.timeframes || '1m').split(',').map((x) => x.trim()).filter(Boolean);\n  const exec = tfs[0] || '1m';\n  for (const tf of tfs.slice(1)) {\n    const a = Number(signal.timeframes?.[tf]?.atr);\n    if (Number.isFinite(a) && a > 0) return { atr: a, tf };\n  }\n  return { atr: Number(signal.atr) || 0, tf: exec };\n}\n\nexport function computeDynamicTpSl(signal) {"}]};

const count = (hay, needle) => hay.split(needle).length - 1;
let failed = false;
for (const file of [...new Set(PAYLOAD.ops.map((o) => o.file))]) {
  const full = path.join(root, file);
  if (!fs.existsSync(full)) { console.log(`FAIL  ${file}: not found under ${root}`); failed = true; continue; }
  let text = fs.readFileSync(full, 'utf8');
  let changed = 0, already = 0; const bad = [];
  for (const [i, op] of PAYLOAD.ops.filter((o) => o.file === file).entries()) {
    if (count(text, op.old) === 1) { text = text.replace(op.old, () => op.new); changed++; }
    else if (count(text, op.new) === 1) already++;
    else bad.push(i + 1);
  }
  if (bad.length) { console.log(`FAIL  ${file}: step(s) ${bad.join(', ')} do not match (stopAtrFor was edited?). Nothing written.`); failed = true; }
  else if (changed) { fs.copyFileSync(full, full + '.bak'); fs.writeFileSync(full, text); console.log(`OK    ${file}: stopAtrFor implemented`); }
  else console.log(`SKIP  ${file}: already applied`);
}
if (failed) { console.log('\nSend me the FAIL line.'); process.exit(1); }
console.log('\nCheck:  node tests/test-tpsl-sizing.js   (expect: passed 4, failed 0)');
