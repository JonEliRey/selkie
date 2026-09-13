# Independently worked paired history

All names, labels and values are invented. These are fixed materialized historical
inputs, not a population generator or scenario-authoring configuration.

The incumbent flags yesterday's completed settlement total above 10,000 minor
USD units. The permitted conversion uses the merchant reference, with sensitivity
3 and a three-day window. Evaluation is February 7; the measured day is February
6. The reference excludes February 6 and uses February 3–5 only.

| Merchant | Prior completed totals | February 6 | Fixed alert | Relative alert | Mature truth |
| --- | --- | --- | --- | --- | --- |
| m-protected | 90, 100, 110 | 12,000 | yes | yes | fraud case protected |
| m-new | 90, 100, 110 | 150 | no | yes | fraud case new-jump |
| m-high | 9,000, 10,000, 11,000 | 12,000 | yes | no | legitimate |
| m-low | 90, 100, 110 | 100 | no | no | legitimate |
| m-unknown | 90, 100, 110 | 16,000 | yes | yes | unresolved case |
| m-immature | 90, 100, 110 | 16,000 | yes | yes | fraud outcome available March 1 |

For the small histories, median=100 and MAD=10; the robust reference is
100 + 3 × 1.4825796886582654 × 10 = 144.47739065974796. For m-high it is
14,447.739065974797. Each merchant has two scored authorization events on
February 7, so twelve event/rule results still represent two mature fraud cases
and two legitimate merchants. Settlement lifecycle identifiers are distinct.

At the February 9 outcome cutoff, `pending` is immature and `unresolved` is
unknown. Neither becomes mature fraud or a legitimate merchant. The independently
specified expected comparison fields are in `expected.json`.

The public tests derive these additional worked examples by changing only the
materialized source history and replaying both suites:

- Fraud-only gain: m-high's measured total is 10,000. Both suites flag zero
  legitimate merchants; only the candidate adds new-jump.
- Legitimate-only gain: m-new's measured total is 100. Both retain protected;
  only the candidate removes m-high's flag.
- Substitution regression: protected's prior totals become 9,000/10,000/11,000.
  The incumbent catches protected, the candidate catches new-jump, and each
  catches one case. Losing protected rejects despite fewer legitimate flags.
- Increased legitimate flags: m-high's total is 10,000 and m-low's is 150.
  The candidate adds new-jump but also flags m-low, so it rejects.
- Tie: m-high's total is 10,000 and m-new's is 100. Neither count improves.

These examples establish observed count behavior only. Reserved validation,
protected-corpus enforcement and experimental acceptance are separate work.
