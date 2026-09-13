# Merchant references through replay

Merchant references extend the selected-suite daily replay. On Node 24:

```text
node scripts/run.ts fixtures/run/merchant-reference <empty-output-directory>
```

The fixture uses only invented identifiers, rules, amounts and labels. Replay requires no generator, model call or runtime package. Existing daily-only, selected-suite and legacy runs keep their table sets.

## Configuration and clock

The optional `daily_totals.reference` object pins `feature`, `estimator: trailing_median_mad`, `sensitivity_parameter`, `window_parameter`, `minimum_history_parameter`, `fallback: peer_segment_median`, and `zero_or_missing_peer: unavailable`. Unknown keys or policies reject. Each parameter names a threshold in the admitted DSL suite. Bounds and steps are validated by the existing rule reader, with supported sensitivity bounds 0.1..20 and integer window/minimum-history bounds 1..366 days. The selected minimum cannot exceed the selected window. The fixture uses k=3, W=5, minimum=4; there are no implicit defaults.

The catalog baseline entry has matching `unit: minor_currency_units`, estimator, parameter bindings and fallback policy. Its name is distinct from the daily-total feature and reserved event/outcome fields. Input events cannot supply either computed feature. The rule uses the unchanged `field_factor` grammar, comparing daily total with the assembled baseline times a fixed unit factor. There are no executable expressions or relationship features.

At boundary B, the measured day D is B minus one UTC day. D's total and its reference become available together at B; the reference uses only complete merchant-day totals in `[D-W, D)`. Covered empty days count as zero, whereas unavailable or partial days do not count toward history. The grid has W+1 warmup days plus evaluation days and is bounded by `workload.max_events`, as are the raw history rows; the existing event/rule bound also applies. A changed W rebuilds the grid and reference, not just metadata.

For adequate nonflat history, the threshold is `median + k * MAD / 0.6745`, evaluated without integer rounding. Even-sized medians average the central pair. For sparse or flat history, the threshold is k times the median of eligible other merchants' medians in the same declared segment and prior window. Peers need the same minimum history; each gets equal weight. A zero or absent peer median yields unavailable, never zero as a fabricated threshold. An applicable rule reading a missing total/reference is unavailable; unrelated rules still evaluate. The ordinary alert/suppress policy remains unchanged.

## Ledger evidence

The daily ledger adds `reference` evidence to each feature snapshot: measured day, exact prior window, available-day count, median, MAD, threshold, status, fallback reason, peer count and peer median. The combined feature definition pins resolved settings and estimator/fallback semantics; its identity changes with those settings. Run and suite provenance retain the admitted DSL parameters and bounds through existing identities.

Only reference-enabled runs add `reference-assessments.jsonl`. This post-replay table counts authored fraud, legit and unknown days in the complete reference window. A day with any fraud-labelled settlement is fraud; a day with only legit-labelled settlements is legit; absent, unknown or mixed legit/unknown truth is unknown. Empty covered days have unknown outcome truth. The fraud fraction uses all complete reference days, with unknown days reported explicitly. More than half authored fraud records `majority_authored_fraud`; it does not sanitize the reference or infer fraud from an alert. These are synthetic authored diagnostics, not mature corporate outcome assessments.

## Independently worked examples

| Example | Prior history or trajectory | Expected behavior |
| --- | --- | --- |
| Small jump | 80,90,100,110,120 then 160 | Median100, MAD10, threshold144.47739065974796; relative alerts at next boundary, fixed10000 does not |
| Window/sensitivity | 10,20,90,100,110 then 140 | W5/k3 threshold178.95478131949592; W3/k3 threshold144.47739065974796; W3/k2 threshold129.6515937731653 and alerts |
| Sparse/flat | Three-day merchant; five flat days at10; eligible peer medians50,70 | Sparse uses segment median50 including the flat peer; flat uses median60 excluding itself; thresholds150 and180 |
| Legit growth | 9000 to10800 over30 days (+20%), then10860 | No relative alerts in24 scored days;14 fixed-floor alerts |
| Weekly seasonality | Repeated80,90,100,110,120,200,210 | Median110, MAD20; six legitimate peak alerts in24 scored days remain visible |
| Fraud escalation | Explicit increasing attack after a small merchant history | All24 scored days alert with W7; no claim against arbitrary adaptive attacks |
| 60% contamination | 10,20,900,1000,1100 then1200; last three prior days authored fraud | Median900, MAD200, threshold1789.5478131949592 hides1200; diagnostics report3/5 fraud days |

The initial fixture's eleven expected tables were assembled independently with Python/PyYAML and SHA-256 from the documented ledger contract and literal calculations, without importing or running the implementation to obtain expected values. The other materialized histories are explicit arrays serialized as settlement events by the tests. They are worked examples, not population generation. Relabeling all outcomes changes diagnostics and input/run provenance but leaves feature values and verdicts unchanged; changing future activity likewise leaves past results intact.

## Delivery boundary

Runtime changes: `src/daily-totals.ts`, `src/merchant-reference.ts`, `src/reference-assessments.ts`, `src/seams/run.ts`, and `src/ledger.ts`. The new modules use only the existing `yaml`, `rules`, `ledger` and daily-replay types plus standard JavaScript. The public CLI remains `scripts/run.ts`; its transitive runtime closure is `src/seams/run.ts`, `src/daily-totals.ts`, `src/merchant-reference.ts`, `src/reference-assessments.ts`, `src/ledger.ts`, `src/rules.ts`, `src/yaml.ts`, `src/alert-rows.ts`, plus Node built-ins. No new runtime dependency was added.

The bundled fixed fixture includes eleven expected tables for comparison with a fresh local run. This establishes an invented history example only; independent review, human acceptance and any corporate qualification remain separate.
