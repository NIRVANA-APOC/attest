# Changelog

## 0.1.0 — first release

The first Attest release. Everything here is new; there are no earlier Attest
versions to migrate from.

### Added

- **Cases.** One orchestrated unit of work: its own branch `case/<case>`, its
  own worktree, a plan in `docs/cases/<case>/plan.md`, and a hashed approval in
  the run log. Several cases can run at once.
- **The `attest` CLI.** `setup`, `case new`, `open`, `up`, `check`, `approve`,
  `gate`, `stage`, `dispatch`, `status`, `send`, `wait`, `close`, `panel`,
  `audit` (verify/report/show/outcome/calibrate) and `teardown`, with exit codes
  0 (success), 1 (refused) and 2 (usage). `-m/--case` resolves an explicit case,
  the caller pane's case, a panel's orchestrator, or the checked-out `case/`
  branch.
- **Roles as real agent sessions.** Each role runs Claude Code or Codex in its
  own tmux window, worktree and branch. Briefs, results
  (`.attest/result.md`), commits, diffs, files outside `touches`, and readiness
  are read live. `dispatch` refuses without an approved plan and refuses a role
  whose dependencies are not done; `send` refuses a role that is not ready.
- **The live panel.** Six pages: `1 CASE` (roles, stages, activity, flow and the
  selected role's live window, plus a needs-you strip), `2 ROLES`, `3 PLAN`,
  `4 LOG`, `5 DIFF`, `6 AUDIT`. English and Chinese, remembered in
  `~/.config/attest/settings.json`. Approval and change from the panel; `--once
  --plain` prints a frame for scripts. Minimum 40x10.
- **Gates and stages.** The plan gate blocks dispatch until the plan (and every
  referenced role text) is approved; the workflow's `stages.yaml` supplies the
  rest (`mr-ok`, `merged`, `audit`). `teardown` refuses dirty, unmerged or
  unpushed work without `--force`.
- **The Jev audit subsystem.** Typed decisions (`plan.risk`, `plan.clarity`,
  `role.boundary`, `result.fidelity`, `drift.step`, `merge.risk`,
  `teardown.safety`, `review.triage`) over one state, with an optional
  `audit:` plan block (`mode: shadow|enforce`, `provider:
  heuristic|typesafe|off`, `questions`). The deterministic pre-checks win where
  they can decide; malformed answers fail safe; answers never authorize.
- **A tamper-evident ledger.** Append-only, hash-chained JSONL at
  `<git-common-dir>/attest/<case>/audit.jsonl`, with `audit verify`,
  `audit report [--write]` (`docs/cases/<case>/audit.md`), `audit show`,
  `audit outcome`, and `audit calibrate` (Brier score, reliability bins,
  holdout-validated recalibration and advisory thresholds).
- **Agent adapters.** Built-in Claude Code and Codex; add or override any
  terminal agent with a YAML adapter under `~/.config/attest/agents/` or the
  repository's `.attest/agents/`. A role's `flags` must pin its permission;
  Claude Code roles get lifecycle hooks and a status line, Codex roles are read
  from their session log.
- **The `attest-case` workflow skill.** Plan template, stages and
  builder/reviewer/auditor role texts, installed by `attest setup`.
- **Bilingual docs.** English and Simplified Chinese READMEs, user guide and
  Jev audit design doc, with real panel screenshots under `docs/media/`
  produced by `tools/screenshot/` (tmux capture, Pillow render).

### Changed

- Nothing: this is the first Attest release.

### Verification

- `./check.sh`: `tsc --noEmit` clean, `scripts/check-names.mjs` clean, build,
  and the full `node:test` suite green on Node 20/22 (Linux and macOS in CI,
  including one run with all locale variables empty).
- Real-tmux integration: case creation, plan gate refusal, dispatch, wait,
  status, send, close and teardown; panel goldens for every page including
  AUDIT.
- Packaging: `npm pack` contains `dist`, `skills` and `NOTICE` only; installing
  the tarball into an isolated prefix yields a working `attest --version`,
  `attest --help` lists every command, and `attest setup` installs/removes the
  skill in an isolated HOME without touching unmarked directories.
- Audit: ledger append/verify/tamper detection, torn-tail handling, policy
  precedence, provider fallback against a local mock (no network), and
  `auditViewOf` on corrupt, empty and populated ledgers.
- Docs: the documentation-contract test checks documented commands against
  `attest --help`, image existence and bilingual screenshot parity; screenshots
  are real captures produced by `tools/screenshot/`.
