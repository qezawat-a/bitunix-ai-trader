/**
 * Per-position record of what the position guard decided on its LAST pass, stage
 * by stage. Without it "why didn't trailing trigger" can only be guessed at;
 * with it the answer is a fact (ROI below threshold, no ATR, stop not an
 * improvement, exchange refused the write...). Last value per stage, in memory.
 */
const traces = new Map();   // positionId -> { symbol, side, passes, lastPassAt, stages: {name: {...}} }

export function recordGuard(positionId, symbol, side, stage, data = {}) {
  const id = String(positionId);
  let t = traces.get(id);
  if (!t) { t = { symbol, side, passes: 0, lastPassAt: 0, stages: {} }; traces.set(id, t); }
  if (stage === 'gate') { t.passes += 1; t.lastPassAt = Date.now(); }
  t.stages[stage] = { at: Date.now(), ...data };
}

export function forgetGuard(positionId) { traces.delete(String(positionId)); }

export function getGuardTrace({ positionId = null, symbol = null } = {}) {
  const out = [];
  for (const [id, t] of traces) {
    if (positionId && String(positionId) !== id) continue;
    if (symbol && t.symbol !== symbol) continue;
    out.push({ positionId: id, ...t });
  }
  return out;
}
