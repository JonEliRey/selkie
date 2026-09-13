# Invented merchant reference

The seven explicit events measure five prior days (80,90,100,110,120), an abnormal sixth day (160), and an authorization at the seventh day's midnight. Median100 and MAD10 give a k=3 threshold of144.47739065974796. The fixed10000 rule does not fire; the relative rule fires only when the sixth day is complete.

The expected ledger is independently assembled from these literal values and the documented provenance/hash contract. No runtime feature calculation supplied the expected threshold or verdicts. Additional authored growth, seasonality, escalation, sparse/flat, zero/missing-peer and contaminated examples are described in `docs/merchant-reference.md`.
