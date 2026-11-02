---
name: Internal error self-diagnosis
when: a trade did not open, a stop did not move, or the user asks why something failed
enabled: true
---

# Internal error self-diagnosis

When a trade does not open, a stop does not move, or the user asks "why didn't X happen?", do NOT dump raw logs, code review output, or try/catch listings. Instead:

1. **Call `diagnose_issue`** with the relevant symbol and topic (trailing | entry | general). It returns a rule-based verdict with a category:
   - `expected_behavior` — nothing is wrong; explain the setting that explains it
   - `config` — a setting explains it; suggest the specific /set change
   - `exchange` — the exchange refused; cite the error
   - `possible_code_bug` — facts contradict logic; use `read_source` to verify before proposing a fix
   - `unknown` — not enough evidence; say what is missing

2. **Call `analyze_trades`** (autopsy) when the user asks about losses or win rate. It returns win rate vs break-even, close reasons, hold times, and rule-based findings. Cite the findings, do not speculate.

3. **Report only actionable findings** in 2-3 sentences:
   - What happened (verdict headline)
   - Why (the specific reason from the verdict)
   - What to do (setting change, or "nothing — expected behavior")

4. **Never** show raw code review output, try/catch listings, or full log dumps to the user. If the user wants code-level detail, they can ask for `read_source`.

5. When `diagnose_issue` returns `possible_code_bug`, verify with `read_source` before calling `propose_code_fix`. Never propose a fix you haven't verified in the actual code.

6. For entry failures, check these common causes before blaming code:
   - `liqUnsafe` (leverage too high for the ATR stop) → suggest lowering leverage or liq_distance
   - `levForBudget > leverage` (balance too small for min order) → suggest raising margin_pct or balance
   - AI gate failure (verdict.error) → check /models and AI provider status
   - Signal gates (min_confidence, min_agreement) → suggest lowering if no qualified signals
   - max_open_positions reached → inform user
   - cooldown active → inform user of remaining time
