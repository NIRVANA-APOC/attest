# Roadmap

Attest 0.1.0 is the first release. This file says what it is, what the next
work is, and where the line between code and workflow runs. It is a direction,
not a promise: items move as evidence arrives.

## What Attest is

One person plus a change becomes a **case**: a plan they approve, roles that
build in their own tmux windows and git worktrees, a reviewer per branch, an
audit of the decisions recorded along the way, and MR/cleanup gates that only a
person passes. The orchestrator and the roles are real Claude Code or Codex
sessions. The product is the CLI, the panel, the case lifecycle and the audit
subsystem.

**The rule that draws the line.** Code enforces only what keeps the work
correct; the method lives in the workflow skill, as text, and can be swapped.
Enforced in code:

- no role opens before the plan as it is now is approved (plan bytes plus every
  referenced role text, hashed; approval recorded in the run log);
- one role, one worktree, one branch, one pane; overlapping `touches` require
  an explicit `depends_on`;
- each role's `flags` pin its agent's permission; it is never inherited;
- nothing is typed into a window that is not ready, and only into panes Attest
  opened;
- the persistent panel, the run log and the audit ledger.

When a rule can be decided deterministically (a force push, a secret path, a
write outside `touches`, unmerged work), the code decides it. A model's answer
is a signal for policy, never an authorization.

## Now: 0.1.0

Shipped: cases and the CLI surface; roles, worktrees, panes and gates; the six
page panel in English and Chinese; adapters and permission pinning; the Jev
audit subsystem with the offline heuristic, the optional HTTP provider, the
hash-chained ledger, reports, outcomes and calibration; the `attest-case` skill
and a real screenshot pipeline.

## Next: trust and evidence (safety)

**Real Jev API calibration.** The default provider is a deterministic offline
heuristic, and the optional provider speaks a Jev-compatible API. The next step
is not a new promise but better evidence: run the remote provider on real cases,
record outcomes, and validate calibration *per task and repository* instead of
assuming it. The GovTech Singapore evaluation found calibration varies across
tasks and datasets even for a model trained for it, so Attest should publish the
numbers it measures, per release, and refuse to call enforce mode "validated"
without them.

**Policy learning with a holdout.** The ledger already fits a recalibration map
only when a chronological holdout improves the Brier score. Extend that from
probability mapping to the policy itself — thresholds, per-decision weights for
the heuristic — with the same discipline: train on early outcomes, evaluate on
later ones, apply only on a measured improvement, and keep every suggestion
advisory in the report. No online self-modification of a gate.

**Automated outcome capture.** Today a person records outcomes with
`attest audit outcome`. A review's PASS/FAIL, a `mr-ok` answer and a reverted
merge are already evidence; capture them as outcomes automatically, with the
same `source` labels the ledger API already accepts (`gate`, `review`, `human`),
and keep the person's verdict authoritative where they conflict.

**Adversarial testing of the audit path.** The arXiv study of Jev reports
prompt-injection, adversarial-suffix, supply-chain and privacy attacks against
decision layers. Attest's mitigations (instructions only in questions, bounded
and stripped state, deterministic pre-checks, fail-safe policy) are design
choices, not yet a measured claim. Add an adversarial suite that plants
injections in plan text, briefs, results, diffs and commit messages, and
reports how often the recorded decision changes. Publish the result.

**Ledger integrity beyond one file.** The ledger is tamper-evident, not
tamper-proof. Later: an optional signed checkpoint (a detached signature over
the head hash), a CI verifier that records `audit verify` in the pipeline, and
a documented concurrency story for two processes appending at once (today the
hooks run in one orchestrator and the chain reports a duplicate-seq break).

**Portable boundaries.** tmux and git worktrees are the boundary, not a
sandbox. Investigate running roles under an opt-in OS sandbox (macOS seatbelt,
Linux namespaces) while keeping a role's agent flags exactly the ones the plan
declares, and document the residual sharing of the case's refs and objects.

## Next: the human workload (efficiency)

The point of typed decisions is that a cheap, narrow call (or a free offline
heuristic) replaces a full model call at each judgement point. Attest records
`latencyMs`, provider and state digest on every outcome, but it has not measured
its own end-to-end effect.

- **Measure net human workload, not just tokens or wall-clock.** The NeurIPS 2026
  position paper "AI Agents Are Making Knowledge Workers Busier, Not Freer"
  argues agents increase the number of work items and push the overflow into
  review and coordination (a Jevons-paradox effect). Track review time and
  gate interventions per case alongside agent time, and treat a drop in one but
  a rise in the other as a failure.
- **Cut the review queue where the evidence allows.** Use recorded outcomes to
  identify decisions a reviewer consistently confirms without looking (for
  example low-risk `result.fidelity` on small diffs), and make the panel
  prioritise the ones that actually needed a person. Suggestions stay advisory.
- **Record real audit cost.** Aggregate latency and provider token use from the
  ledger into `audit report`, so a team can see what audit costs without trusting
  a vendor claim.
- **Benchmark the offline default honestly.** The heuristic is free and offline;
  measure how often its band agrees with a person's verdict, and publish the
  confusion matrix rather than a single accuracy number.

## Next: everyday use

- More first-class adapters beyond Claude Code and Codex, with the same
  permission-pinning and real-screen fixtures (see CONTRIBUTING).
- Windows-native support (today: macOS, Linux, WSL2) and a tmux-version floor
  in `attest setup`.
- Several repositories per case (cross-repository roles) behind an explicit
  plan field, instead of one repository per case.
- `attest audit report --json` in CI as a required check, with a documented exit
  contract and an example workflow file.
- Review artefacts: keep `<worktree>/.attest/reviews/<role>.md` in the case
  worktree (or link it from the MR) so review evidence survives teardown.

## Non-goals

- **Not a hosted service.** Attest orchestrates local terminals; there is no
  server component and no account.
- **Not a sandbox, and not a merge bot.** The CLI does not push or merge for
  you, and it does not replace OS-level isolation.
- **Not a replacement for the agent.** Attest does not write the code; roles do.
- **Not a new workflow language.** The method lives in the `attest-case` skill,
  where a team can change it without changing the code.
