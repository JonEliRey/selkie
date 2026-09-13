# Literal derivation for the readable-rule experiment

All materialized history is invented. This adapts the accepted paired-history
worked example to the unchanged saved readable rule: tenant `paper-kite`,
risk `lantern-watch`, USD settlements, previous completed-day total >1250 cents.
The original source, assistance and independent expectations are reused, not
re-authored by this builder. This builder independently derives the following
history results from that readable condition and its clock/reference formula.

Evaluation is February 7. The measured day is February 6. A three-day reference
uses February 3–5 only, excluding the measured day. Small merchant prior totals
90,100,110 have median 100 and MAD 10: at sensitivity 3 the upper bound is
100 + 3*10/0.6745 = 144.47739065974796. The large merchant's 9000,10000,11000
history gives median 10000 and MAD 1000, hence 14447.739065974797.

| Merchant suffix | Feb 6 cents | Incumbent >1250 | Relative | Mature outcome |
| --- | ---: | --- | --- | --- |
| protected | 12000 | alert | alert | fraud `protected` |
| new | 150 | no alert | alert | fraud `new-jump` |
| high | 12000 | alert | no alert | legitimate |
| low | 100 | no alert | no alert | legitimate |
| unknown | 16000 | alert | alert | unknown `unresolved` |
| immature | 16000 | alert | alert | immature fraud `pending` |

Two zero-value settlements per merchant on February 7 read the same snapshot;
they do not double-count cases or flagged merchants. Earlier settlement events
have no case identity and occur outside the measured outcome window. The fraud
denominator is 2, the legitimate merchant denominator is 2. Search has retained
cases `[protected]`, lost `[]`, new `[new-jump]`, incumbent legitimate flags
`[m-high]`, candidate flags `[]`. Reserved has distinct `r-m-*` merchants and
observations, the same trusted case identities, retained `[protected]`, lost
`[]`, new `[new-jump]`, flags `[r-m-high]` to `[]`. Unknown `[unresolved]` and
immature `[pending]` remain separately reported; no money fact is assessed.

The no-improvement command authors its withheld variation before starting the
experiment: reserved `r-m-new` has February 6 total 100, below both 1250 and
144.47739065974796. Search still wins but reserved adds no case. Although it
reduces legitimate flags, that unchosen outcome cannot satisfy `fraud_cases`.
Expected acceptance is zero and the incumbent and corpus stay at version zero.

The operator extension leaves the source threshold locked and all original
conditions intact. Reference parameters and conversion permission are declared
in `authority.json` before search; the improver cannot edit them. Additional
reference inputs in admission tests equal 1250, so the existing literal boundary,
scope, units and window expectations remain valid after conversion. No new
model-generated oracle, scenario generator or no-history suite is substituted.
