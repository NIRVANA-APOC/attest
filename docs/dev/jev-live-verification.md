# Live Jev provider verification

This is the evidence record for the optional hosted provider
(`provider: typesafe`). The default Attest configuration and the committed
screenshots use the offline `heuristic`; this page records a separate live smoke
run so the HTTP adapter is not only mock-tested.

- **Date:** 2026-11-15 (Asia/Shanghai)
- **Endpoint:** `POST https://api.typesafe.ai/v1/systemone`
- **Model returned:** `jev-1.14.0`
- **Credential:** supplied by the operator at runtime as
  `ATTEST_JEV_API_KEY`; it is not stored in this repository, printed here, or
  written to any file. The adapter redacts it from errors.
- **Code path:** `src/jev/typesafe.ts` → `src/jev/policy.ts` →
  `src/jev/hooks.ts` → `attest gate plan` → hash-chained ledger.

## What was run

A scratch copy of the demo plan (`examples/demo`) was changed to
`provider: typesafe`, `mode: shadow`. The plan passed `attest check`; then:

```sh
ATTEST_JEV_API_KEY=… attest gate plan "Live Jev check" --no-wait -m storefront-search
attest audit verify -m storefront-search
attest audit report --json -m storefront-search
```

## Result (sanitized)

```
plan.risk     provider typesafe  model jev-1.14.0  latencyMs 639  usage input=2726 output=20  band low     probability 0.12
plan.clarity  provider typesafe  model jev-1.14.0  latencyMs 250  usage input=2762 output=17  band medium  probability 0.2775 (confidence 0.62)
audit verify: OK 2 records; Verify record 2 appended.
chain: ok, length 3; mode shadow; provider typesafe; risk medium.
```

`plan.clarity` was returned by the API as a score (0..4 with a five-label
legend); the adapter normalized it to 0.2775 on the 0..1 risk scale.
`attest audit show 0` now prints `latency 639 ms · tokens 2726 in / 20 out`. The ledger
stores the versioned model, latency and token usage with each decision, so the
cost of a decision can be audited later.

## Panel capture

The same live ledger was captured from the real panel on tab `6 AUDIT` and
rendered to `docs/media/panel-audit-live-en.png`: it shows
`provider typesafe`, `policy.ask.medium` with `typesafe/jev-1.14.0` in the
reason, and the state digest. The key was supplied at runtime; it is not in the
image or the repository.

## What this proves

- The hosted request shape (`state`, `model`, `questions` with
  `type`/`instructions`/`criteria`) is accepted by the live endpoint.
- The `noul` / `score` / `choice` response variants are parsed and validated.
- A real decision flows through the policy, the hash chain and the report with
  `provider: typesafe` and a versioned model id.

## What this does not prove

- It is **one** smoke run, not a calibration study. The probabilities are not
  validated per deployment until enough `attest audit outcome` verdicts exist.
- The attacker-controlled state was a benign demo plan. The published
  adversarial and calibration caveats still apply; see `docs/jev-audit.md`.
- No vendor availability, latency SLO or price commitment is implied.

## Reproduce

```sh
npm run build
ATTEST_JEV_API_KEY=… node tools/jev-live-check.mjs
```

The helper prints the safe envelope only. To run a full case, set the plan's
`audit.provider: typesafe` and env as above, then use `attest gate plan` and
`attest audit report`.
