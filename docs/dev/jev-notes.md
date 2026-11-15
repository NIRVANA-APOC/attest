# Jev audit subsystem: design notes

This document is the engineering record for `src/jev/**`: what the subsystem
is, how it decides, how the ledger attests, what it deliberately does not do,
and where the risks remain. Product vocabulary is Attest, case, role, gate,
stage, audit. The interface contract is `docs/dev/contracts.md` §6-7; this file
explains the implementation behind it.

## 1. What it is

Attest asks a small, typed decision model narrow questions at orchestration key
points (plan, dispatch, result, merge, teardown), records every answer in a
hash-chained append-only ledger, and lets a deterministic policy — never the
model — turn an answer into `allow` / `ask` / `block` (or `shadow`).

The subsystem is inspired by the published Jev decision-model interface: a
`Noul` (boolean), a `Choice` (named options) or a `Score` (0..N levels), cheap
and fast compared with a full agent turn, used for triage at harness decision
points. The background sources named in the task brief are:

- <https://jev-agent.com/jev-harness>
- <https://blog.ai.gov.sg/decision-models-for-guardrails-exploring-jev-and-kev-for-moderation/>
- <https://export.arxiv.org/pdf/2610.04985>
- <https://www.langchain.com/blog/building-a-harness-with-jev>

Key findings the implementation honors (taken from the brief, not re-derived
here):

1. Ask narrow, typed questions over untrusted harness state.
2. Instructions live in the question, never in the state.
3. Cap the state (32,000 characters) and say when it was truncated.
4. Calibrated probabilities must be validated per deployment, not assumed.
5. Insecure or uncertain results must fail safe.
6. A decision model is a signal, never an authorization.
7. The value is low latency / cheap triage where a full agent turn is too
   expensive.

**The heuristic provider is not the real TypeSafe model.** It is an offline,
deterministic approximation with a published weighting table, and the outcome
always says `provider: "heuristic"` with a bounded confidence. The optional
HTTP provider speaks to a Jev-compatible endpoint; it is not a claim of
compatibility beyond the protocol documented below.

## 2. Files

| File | Responsibility |
| --- | --- |
| `types.ts` | Typed decision protocol, outcome/ledger/view/outcome-record types, `JEV_DECISION_IDS`. |
| `notes.ts` | Stable reason-code table (`REASONS`, `reasonFor`, `reasonCodeOf`). |
| `probability.ts` | Thresholds, band mapping, risk-probability extraction. |
| `ledger.ts` | Canonical JSON, `sha256` chain, read/verify, append functions, outcome records, truncation handling. |
| `heuristic.ts` | Deterministic feature extraction, weighting table, offline provider. |
| `typesafe.ts` | Optional HTTP provider: zod validation, 32k cap, p-retry, key safety. |
| `policy.ts` | Pre-checks, threshold → action mapping, modes, fail-safe, provider fallback, `loadAuditConfig`. |
| `decisions.ts` | Decision catalogue, question templates, instruction-stripped state builders, high-level audit helpers. |
| `calibration.ts` | Brier score, reliability bins, holdout-validated recalibration, advisory thresholds. |
| `report.ts` | One-case report (text/markdown/json) shared by the command and the panel view. |
| `view.ts` | `auditViewOf(commonDir, caseName)` for the panel; never throws. |
| `commands.ts` | `runAudit` for `verify|report|show|outcome|calibrate`. |
| `hooks.ts` | Orchestration facade the lead wires: `record*`, `loadAuditConfig`, `auditLine`, gate predicates. |

## 3. Decision protocol and catalogue

One call carries one `state` and one or more typed questions in the shape from
contracts §6.1. Each catalogue entry asks exactly one question (`risk`), so the
policy has one probability to read; the question kind varies:

| Id | Question kind | When | State highlights |
| --- | --- | --- | --- |
| `plan.risk` | noul | plan stage / approve | plan text, goal, why, roles, touches, done-when |
| `plan.clarity` | score (5) | plan stage / approve | same state |
| `role.boundary` | noul | dispatch | brief, goal, touches, dependencies, plan goal |
| `result.fidelity` | noul | role result | result body/front matter, done-when, changed/outside, commits, files, reviews |
| `drift.step` | noul | orchestration step (helper, not auto-wired) | step, goal, lexical overlap |
| `merge.risk` | noul | before `mr-ok` | role results, reviews, diff size, files, commits, changed/touches |
| `teardown.safety` | noul | teardown | dirty/untracked paths, unmerged commits, unpushed flag, commands |
| `review.triage` | noul | review helper (not auto-wired) | summary, diff size, files, reviews, changed/touches |

State builders:

- strip instruction-like lines (`ignore previous instructions`, `system:`,
  `<system>`, `you are`, `jailbreak`) and record how many were removed;
- bound free text (12,000 characters) and lists, so a huge state cannot flood
  the provider;
- hash the canonical JSON into `stateDigest` (sha256), which the ledger record,
  the panel row and `audit show` display;
- keep the same facts hashing identically: no timestamps or ordering noise in
  the state.

## 4. Safety framing (normative)

- **State is untrusted data.** The heuristic only scans it; the HTTP provider
  sends it inside `<attest-state untrusted="true">…</attest-state>` and the
  question carries the instructions.
- **Instructions only in questions.** `JevQuestion.instructions` is the only
  instruction channel; state builders remove instruction-like lines.
- **Answers are signals, not authorization.** `policy.ts` is the only place an
  answer becomes an action, and `blocksInEnforce` is true only for
  `mode: enforce` + `action: block`. Gates still ask the person.
- **Fail closed on uncertainty.** Malformed, missing, non-finite or out-of-range
  answers give `band: high`, `action: ask` in enforce mode and `shadow` in shadow
  mode — never `allow`. A provider that throws also fails safe after the
  fallback attempt.
- **Deterministic rules win.** `precheckOf` re-scans the state itself (a state
  claiming `hazards: []` cannot hide a force push) and decides force pushes,
  destructive commands, check bypasses, secret paths, writes outside touches,
  unmerged/pushed work and dirty worktrees without consulting a model.
- **Calibration is validated, not assumed.** A recalibration map is applied
  only when a chronological holdout split shows it improves the Brier score by
  at least 0.01, with at least 12 samples. Otherwise raw probabilities are kept.
- **Reports read the ledger, not just the config.** A ledger can mix modes (an
  experiment in shadow, then an enforced block). The report's mode, counts and
  verdict come from recorded actions; a config hint only labels an empty
  ledger, and a broken chain blocks `report --write`.
- **The heuristic is not the real model.** Output, reports and docs say so; the
  provider id and model version are recorded.

## 5. Providers

### 5.1 heuristic (default)

Deterministic given the state and the recorded samples. Features are normalised
0..1; unknown features are 0 and lower confidence; a state with no structural
key and no lexical evidence at all answers 0.5 with confidence 0.05 (the policy
then asks). Probability is `base + Σ weight × feature`, clamped 0.01..0.99;
confidence is `0.15 + 0.7 × known-weight coverage`, bounded 0.05..0.90.

Weight table (`src/jev/heuristic.ts#WEIGHTS`, base omitted):

| Decision | hazard | ambiguity | scope | outside | touchesUncovered | doneWhenGap | evidenceGap | diffSize | reviewGap | statusRisk | drift | dirty |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| plan.risk | .45 | .15 | .10 | .15 | | | | | | | | |
| plan.clarity | .10 | .75 | .10 | | | | | | | | | |
| role.boundary | .50 | .05 | | .35 | | | | | | | | |
| result.fidelity | | | | .10 | .15 | .30 | .25 | | | .20 | | |
| drift.step | .05 | .10 | | | | | | | | | .60 | |
| merge.risk | .30 | | | .20 | | .10 | | .10 | .20 | .10 | | |
| teardown.safety | .25 | | .05 | | | | | | .10 | | | .40 |
| review.triage | .25 | .05 | .15 | | | | | .30 | .10 | | | |

Feature definitions (all bounded, all from state):

- `hazard`: force push, destructive command, secret path, check bypass hits / 2.
- `secretPath`: any secret-path hit (binary).
- `outsideTouches`: named changed files not covered by a declared touch / 3.
- `touchesUncovered`: declared touches with no matching change / declared count.
- `doneWhenGap`: 1 − met/total done-when criteria (empty list = 1).
- `evidenceGap`: 1 − (commits, checks, summary length, test/verify words).
- `diffSize`: diff lines / 1500.
- `reviewGap`: 0 with passing reviews; failed/total otherwise; 0.75 with none.
- `ambiguity`: (vague-word hits + `?` count) / 4.
- `scope`: (roles − 1) / 6.
- `statusRisk`: blocked/failed = 1, unknown status = 0.5, done = 0; role-result vector ratio.
- `drift`: 1 − lexical overlap of step and goal.
- `dirty`: unmerged > unpushed > dirty > untracked, 0 when none.

### 5.2 typesafe (optional)

POST `<baseUrl>/v1/decisions` with:

```json
{ "model": "jev-latest", "state": "<attest-state untrusted=\"true\">…</attest-state>",
  "stateChars": 1234, "stateOriginalChars": 1234, "truncated": false,
  "questions": { "risk": { "kind": "noul", "question": "…", "instructions": "…" } } }
```

- Env: `ATTEST_JEV_API_KEY` (required), `ATTEST_JEV_BASE_URL` (default
  `https://api.typesafe.ai`), `ATTEST_JEV_MODEL` (default `jev-latest`),
  `ATTEST_JEV_TIMEOUT_MS` (default 8000).
- Auth header `authorization: Bearer <key>`; errors never include the key or
  headers (`sanitize` replaces key and `Bearer …` with `[redacted]`).
- State field is capped at exactly 32,000 characters including the delimiter
  and an explicit truncation marker.
- Response is zod-validated and checked against the questions (every key
  answered, right kind, choice in options, probability 0..1). Malformed answers
  are a typed `malformed` error.
- `p-retry`: two retries with exponential backoff for network, timeout, 408,
  429 and 5xx; no retry for 4xx or malformed responses.
- Any failure throws `TypeSafeError`; `policy.decide` falls back to the
  heuristic and records the error in `JevOutcome.error`.

### 5.3 off

No calls and no audit rows. The facade returns a disabled outcome with
`provider: "off"` so orchestration can keep going and the audit stage can report
disabled. `attest audit report` derives its mode/provider from recorded actions
when no config is given.

## 6. Policy

Thresholds: low `< 0.25`, medium `0.25..0.75`, high `> 0.75`. Enforce maps low →
allow, medium → ask, high → block; unknown asks. Shadow records every outcome
and sets `action: "shadow"`, and the reason says what enforce would have done.

Order of resolution:

1. `provider: off` → no call, no record.
2. Deterministic pre-check → decide without a model; `provider: "precheck"`,
   `answers: {}`, `precheck: { code, detail, action }`. Pre-check applicability
   is per decision: force push/destructive/check-bypass apply to every decision
   except `plan.clarity`; secret paths exclude `plan.clarity`; writes outside
   touches apply to role/result/merge; unmerged/dirty work applies to teardown.
3. Provider call (typesafe → heuristic fallback with the error recorded).
4. Validate answers; malformed → fail-safe.
5. Missing risk probability → fail-safe.
6. Band → enforce action, then wrapped by shadow.

`loadAuditConfig(planAudit, env)` reads the plan's optional `audit:` block and
the env overrides; invalid values fall back to `shadow`/`heuristic` and append a
problem string rather than throwing. Note: `src/plan.ts` (core-owned) must
accept the `audit` key before the block can arrive from a plan file.

## 7. Ledger

Path: `<git-common-dir>/attest/<case>/audit.jsonl`. Records:

```json
{"seq":0,"at":"…","type":"audit-decision","prev":"","hash":"sha256:…","payload":{…JevOutcome…}}
{"seq":1,"at":"…","type":"audit-outcome","prev":"sha256:…","hash":"sha256:…","payload":{"id":"plan.risk","target":0,"expected":"allow","observed":"pass","source":"human"}}
{"seq":2,"at":"…","type":"audit-verify","prev":"sha256:…","hash":"sha256:…","payload":{"ok":true,"length":2,"by":"cli"}}
```

- Hash: `sha256:` over canonical JSON (object keys sorted recursively) of
  `{seq, at, type, prev, payload}`. The record's own `hash` is excluded.
- Append is one `appendFileSync` per line; nothing rewrites records.
- `readLedger` checks JSON, shape, contiguous `seq`, `prev` link and hash, and
  returns the valid prefix plus `brokenAt`/`reason`.
- A final line without a trailing newline is an interrupted write: the read
  reports `incomplete: true` with the valid prefix; `verifyLedger` reports
  `ok: true, length: n, incomplete: true`. An append then refuses (throws
  `LedgerError`) rather than link past an unverifiable fragment, so integrity is
  never silently repaired. A person can remove the torn line deliberately.
- `attest audit verify` appends an `audit-verify` record only when the chain is
  OK, non-empty and not torn, so a CI check leaves its own attestation.
- `decisionTarget` resolves `show`/`outcome` arguments as a ledger seq or the
  latest decision with that id.
- Outcome records judge a decision (`target` seq, `expected` = recorded action,
  `observed` verdict); calibration joins them to the decision's risk probability.

Concurrency limitation: two processes computing `seq` from the same read can
race. The CLI and orchestrator append whole lines, which keeps the file
parseable, but the chain check would then report a break at the duplicate seq.
The orchestration hooks run in one orchestrator, so this is accepted for 0.1.

## 8. Calibration

- `observedOf`: `pass`/`allow` → 0 (risk did not materialise);
  `defect`/`ask`/`block` → 1.
- Brier score: mean `(p − o)²`; 0 perfect, 0.25 = always 0.5.
- Reliability bins: 5 equal bins, count and mean observed per bin.
- `fitCalibration`: needs ≥12 samples; fits a shrunk reliability map on the
  first half (chronological); applies it only if the later-half Brier improves
  by ≥0.01. The map is `(observed×n + p×2)/(n+2)` per bin with n≥3.
- `attest audit calibrate` needs ≥5 outcomes, otherwise says
  `insufficient outcomes` and exits 0.
- Advisory threshold suggestions are printed but never applied automatically;
  the text repeats that the heuristic is not the real TypeSafe model.

## 9. Command surface

`runAudit(runtime, caseObj, options | argv)`:

- `verify [--json]` → chain status; appends `audit-verify` on success.
- `report [--json] [--write]` → markdown report; `--write` writes
  `<case worktree>/docs/cases/<case>/audit.md` and `--json` then includes
  `written`. A broken chain exits 1 and **refuses to write**: `--json` carries
  `writeRefused` instead of `written`, so an unverifiable ledger never produces
  a published audit report. The report's `mode` is derived from the recorded
  actions (all `shadow` → shadow, otherwise enforce); the plan/env config only
  decides the mode before the ledger has records. The verdict is derived from
  the action counts too, so a mixed ledger (shadow experiment + one enforced
  block) says "N decisions: 1 enforced (… block) and M shadow; K need a
  person", never "nothing was refused".
- `show <seq|id> [--json]` → one outcome, its state digest and reason.
- `outcome <seq|id> <allow|ask|block|defect|pass> [--note text]` → records a
  human verdict for calibration.
- `calibrate [--json]` → Brier, bins, validated-recalibration status, advisory.

Exit codes follow contracts §7 (0 success, 1 refused/broken chain, 2 usage).
`report` and `verify` print the chain first so a person sees the integrity
status before any numbers.

## 10. Wiring exports (lead-owned files unchanged)

From `src/jev/hooks.ts`:

```ts
loadAuditConfig(planAudit: unknown, env?: NodeJS.ProcessEnv): LoadedJevConfig
recordPlanAudit(commonDir, caseName, planText, plan: unknown, config?): Promise<JevOutcome>
recordRoleAudit(commonDir, caseName, role, config?): Promise<JevOutcome>
recordResultAudit(commonDir, caseName, roleName, result, diffSummary, config?): Promise<JevOutcome>
recordMergeAudit(commonDir, caseName, state, config?): Promise<JevOutcome>
recordTeardownAudit(commonDir, caseName, state, config?): Promise<JevOutcome>
auditLine(outcome): string
blocksInEnforce(outcome, mode): boolean
needsPersonInEnforce(outcome, mode): boolean
runAudit(runtime, caseObj, options): Promise<Reply>
```

`record*` never throw; a provider failure, a broken ledger or `provider: off`
all return an outcome. `blocksInEnforce` is true only for enforce + block;
`needsPersonInEnforce` is the "ask" case (including every fail-safe).

CLI sketch (lead's file):

```ts
if (command === 'audit') return await runAudit(r, m, { action: pos[0] ?? '', args: pos.slice(1), json: !!values.json, write: !!values.write, note: values.note })
```

## 11. Reason codes

Stable codes (`src/jev/notes.ts`): `policy.allow.low`, `policy.ask.medium`,
`policy.block.high`, `policy.shadow`, `policy.fail-safe`,
`policy.missing-probability`, `policy.no-question`, `provider.disabled`,
`provider.error`, `provider.fallback`, `answer.malformed`, and
`precheck.force-push`, `precheck.destructive-command`, `precheck.secret-path`,
`precheck.outside-touches`, `precheck.hook-bypass`, `precheck.unmerged-work`,
`precheck.dirty-work`.

`JevOutcome.reason` is `<code>: <human sentence>`; `reasonCode` is the code
alone, for the panel and machine reports.

## 12. Testing

`tests/jev.node.mjs` (built `dist/jev/*.js`) covers: chain append/verify/tamper,
torn-tail handling and append refusal; deterministic heuristic and calibration;
policy thresholds, shadow/enforce, fail-safe, pre-check precedence and provider
fallback; the HTTP provider against a local `node:http` mock (success, malformed,
retry, non-retryable status, truncation, missing key) — no real network; the
catalogue, instruction stripping and state digests; `verify/report/show/outcome/
calibrate`; the view on normal, absent and corrupt ledgers; the hooks facade.

## 13. Limitations and remaining risks

- The heuristic's weights are intuition, not fitted parameters; only recorded
  outcomes can validate them, and per-deployment calibration needs real data.
  Do not read its probabilities as TypeSafe model output.
- The HTTP protocol is our documented seam, not a verified vendor API. It has
  only been exercised against a local mock; a real endpoint may differ.
- Append concurrency is not locked; the orchestrator is expected to be the one
  writer. A crashed write leaves a torn tail that must be removed by hand
  before further appends (by design, rather than silently rewriting).
- The heuristic reads lexical instruction patterns; stripping is best-effort
  and injection in state remains a risk for the model path. The deterministic
  pre-checks and policy are the actual guardrails.
- `result.fidelity` from the hook receives a diff summary (commits/files/outside)
  rather than the full diff, so its evidence features are coarse.
- `precheck` outcomes have no probability, so they do not enter calibration;
  that is deliberate (a rule is not a prediction) and documented in reports.
- `plan.clarity` and `review.triage`/`drift.step` are available but not all are
  auto-wired; wiring is the lead's orchestration decision.
