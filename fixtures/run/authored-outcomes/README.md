# Invented historical outcome oracle

This portable fixture extends the fixed merchant-reference worked history. It
contains no generation code or configuration. Settlement totals on February 1–5
are 80, 90, 100, 110 and 120 minor units. February 6 totals 160. At the February 7
authorization the fixed 10000 threshold does not fire; the relative threshold
is 100 + 3 * 10 / 0.6745, about 144.48, so the relative rule fires.

The independently authored `jump` case covers the scored February 7 window,
has a fraud outcome available February 8, and is assessed as of February 9.
The outcome does not define the preceding amounts or reference. Suite detection
is exactly `[jump]`; fixed misses exactly `[jump]`; relative detects exactly
`[jump]`. There are no legitimate merchants in this small fixture. These literal
sets are in `expected.json` and were written before the implementation.

The thirteen `expected/` tables extend the accepted merchant-reference oracle:
its event amounts, reference calculation and verdicts stay fixed. All input
event labels here are unknown, so the five reference days are unknown in the
diagnostic table; mature case truth resides separately in the authored contract.
The header/source identities were calculated independently with Python SHA-256
from the documented sorted portable-input listing and canonical manifest recipe,
without importing or running the evaluator. The new outcome/metric rows are
literal worked sets and counts. No expected table was copied from this run's
output. The ordinary run verification compares every table and row order.

Run `node scripts/run.ts fixtures/run/authored-outcomes <empty-output>`.
This demonstrates scenario performance, not corporate effectiveness.
