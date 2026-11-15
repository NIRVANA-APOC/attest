# Attest engineering contracts

This file is the coordination contract for the team building Attest 0.1.0. It
describes the product vocabulary, module ownership, data formats and the
interfaces between the backend, the panel and the Jev audit subsystem. Keep it
current: every contract change lands here first, with the code that implements
it.

## 1. Identity

- Project: **Attest**, package `attest`, version `0.1.0`, executable `attest`.
- Tagline: one command calls up an attested agent team: each role in its own
  tmux window and git worktree, with Jev-gated decisions and a tamper-evident
  audit ledger.
- The product must never contain the old project name, its misspellings, its
  package names, its directory names, its environment variables or its people.
  `scripts/check-names.mjs` enforces this in `npm run check`.

| Concept | Attest word | Where |
| --- | --- | --- |
| one orchestrated unit of work | **case** | `attest case new <name>`, `-m/--case` |
| the agent session that plans and merges | **orchestrator** | panel, notices |
| one worker in its own window/worktree | **role** | plan roles, dispatch |
| person-facing approval point | **gate** | plan, mr-ok, merged |
| workflow progress marker | **stage** | stages.yaml |
| Jev decision evidence | **audit ledger** | `.attest` ledger, `attest audit` |
| Jev decision engine | **decision model** | `src/jev` |

## 2. Repository layout

```
Attest/
  src/                 TypeScript sources, one module per concern
  src/jev/             Jev decision engine, policy, ledger, commands
  tests/               node:test suites; fixtures and goldens
  skills/attest-case/  the workflow skill installed for agents
  docs/                user guide (en/zh), Jev audit guide (en/zh)
  docs/media/          real runtime screenshots (committed)
  assets/              logo and README banner
  scripts/             checks and tooling
  tools/               screenshot harness
```

Paths inside a target repository:

| What | Where | In git |
| --- | --- | --- |
| case worktree | `.attest/cases/<case>` on branch `case/<case>` | no |
| plan | `docs/cases/<case>/plan.md` in the case worktree | yes |
| run log | `<git-common-dir>/attest/<case>/log.jsonl` | no |
| audit ledger | `<git-common-dir>/attest/<case>/audit.jsonl` | no |
| audit report | `<case worktree>/docs/cases/<case>/audit.md` | yes, when the audit stage runs |
| role worktrees | `.attest/worktrees/<case>/<role>` | no |
| role brief | `<worktree>/.attest/brief.md` | no |
| role result | `<worktree>/.attest/result.md` | no |
| role activity | `<worktree>/.attest/activity.json` | no |
| context window | `<worktree>/.attest/context.json` | no |
| reviews | `<worktree>/.attest/reviews/<role>.md` | no |
| agent adapters | `~/.config/attest/agents/*.yaml`, `<repo>/.attest/agents/*.yaml` | repo ones yes |
| panel language | `~/.config/attest/settings.json` | no |

tmux marks: `@attest-case`, `@attest-case-repo`, `@attest-panel`,
`@attest-panel-orchestrator`, `@attest-orchestrator-token`, `@attest-planning`.
Environment: `ATTEST_TMUX_SOCKET`, `ATTEST_PANEL_GRADIENT`.

## 3. Plan format

Markdown around one fenced yaml block; each role's instructions are in its
`## Role: <name>` section.

```yaml
attest: 1
goal: "Refresh tokens rotate on every use, and a reused one is refused"
why: "Stolen refresh tokens stay valid for 30 days today (issue #212)"
workflow: attest-case
base: case/auth-refresh
profiles:
  claude-build:
    agent: claude
    model: opus
    effort: high
    flags: [--permission-mode, acceptEdits]
    text: workflow:builder
roles:
  api:
    agent: codex
    model: gpt-6.1-sol
    effort: high
    flags: [-a, on-request, -s, workspace-write]
    goal: "Rotate the token on refresh; refuse a reused one"
    touches: [src/api/refresh.ts, src/api/errors.ts]
  review:
    use: claude-build
    goal: "Review each branch as it lands"
    touches: []
    reviews: [api]
    text: workflow:reviewer
audit:                        # optional; defaults below
  mode: shadow                # shadow | enforce
  provider: heuristic         # heuristic | typesafe | off
  questions: [plan.risk, plan.clarity, review.fidelity, merge.risk, teardown.safety]
```

Rules: a role needs `agent`, permission-pinning `flags`, `touches`, and a text
section; dependencies must not cycle; overlapping `touches` require an explicit
`depends_on`. The version key is `attest: 1`.

## 4. Backend module ownership

| Area | Modules | Owner |
| --- | --- | --- |
| CLI surface and command dispatch | `src/cli.ts`, `src/commands.ts`, `src/panel-open.ts`, `src/command-context.ts` | lead |
| planning and validation | `src/plan.ts`, `src/check.ts`, `src/touches.ts`, `src/yaml.ts` | core |
| case lifecycle, panes, roles | `src/cases.ts`, `src/panes.ts`, `src/role-commands.ts`, `src/orchestrator.ts`, `src/notices.ts`, `src/activity.ts`, `src/setup.ts` | core |
| live reads, log, usage, diff | `src/state.ts`, `src/log.ts`, `src/usage.ts`, `src/diff.ts`, `src/screen.ts`, `src/statusline.ts`, `src/agents.ts`, `src/run.ts` | core |
| panel rendering and input | `src/draw.ts`, `src/canvas.ts`, `src/motion.ts`, `src/panel.ts`, `src/panel-input.ts`, `src/panel-model.ts`, `src/panel-actions.ts`, `src/model.ts`, `src/i18n.ts` | tui |
| Jev engine, policy, ledger, commands | `src/jev/**` | jev |
| skill and workflow | `skills/attest-case/**` | workflow |
| README, guides, assets, screenshots | `README*.md`, `docs/**`, `assets/**`, `tools/**` | docs |
| test suites and verification | `tests/**`, `scripts/check-names.mjs` | qa |

Nobody edits another owner's files without asking the lead. Shared files
(`package.json`, `check.sh`, `tsconfig*.json`) are lead-owned.

## 5. Library policy

Use a mature library for commodity work: YAML parsing (`yaml`), schema
validation (`zod`), process execution (`execa`), terminal color (`picocolors`),
display width (`string-width`), retries (`p-retry`). Keep bespoke modules only
where the domain needs exact control or no mature library fits:

- diff metadata comes from `git diff --numstat -z --no-renames` plumbing plus
  `git ls-files -z` for untracked files, because the FileDiff shape (paths,
  added/deleted counts, binary and new-file flags, hunks shown by the panel) is
  a UI contract that generic patch parsers do not preserve without an adapter;
  the hunk text parser stays in `src/diff.ts` for that reason;

- the cell canvas, motion and panel renderer (deterministic cell-level output
  and golden files are the product's UI contract);
- the event log fold and live state reads (format is part of the workflow
  contract and is shared with the panel);
- the hash-chained audit ledger (the chain format is the attestation);
- the typed Jev decision protocol itself (it is the novel subsystem).

Every new dependency needs a one-line justification in `docs/dev/contracts.md`
and the third-party NOTICE.

## 6. Jev audit subsystem contract

### 6.1 Decision protocol

A decision call is one `state` plus one or more typed questions. The protocol
follows the published Jev decision-model interface: a `Noul` (boolean), a
`Choice` (one of named options) or a `Score` (0..N levels). The code, not the
model, decides what happens with an answer.

```ts
export type JevQuestion =
  | { kind: 'noul'; question: string; instructions?: string }
  | { kind: 'choice'; question: string; options: string[]; instructions?: string }
  | { kind: 'score'; question: string; levels: number; instructions?: string }

export type JevDecisionId =
  | 'plan.risk' | 'plan.clarity' | 'role.boundary' | 'result.fidelity'
  | 'drift.step' | 'merge.risk' | 'teardown.safety' | 'review.triage'

export type JevBand = 'low' | 'medium' | 'high' | 'unknown'
export type JevAction = 'allow' | 'ask' | 'block' | 'shadow'

export type JevAnswer = {
  kind: 'noul' | 'choice' | 'score'
  probability?: number          // noul / score, calibrated 0..1
  choice?: string               // choice
  confidence?: number
}

export type JevOutcome = {
  id: JevDecisionId
  at: string
  provider: string              // heuristic | typesafe | off
  model?: string
  stateDigest: string           // sha256 of the canonical state payload
  answers: Record<string, JevAnswer>
  band: JevBand
  action: JevAction             // what the policy decides
  reason: string
  latencyMs: number
  usage?: { inputTokens?: number; outputTokens?: number } // hosted provider only
  error?: string
}
```

### 6.2 Providers

- `heuristic` (default): deterministic, offline, no network. Scores come from
  documented lexical/structural features of the state (destructive commands,
  touched paths, missing done-when evidence, diff size, reviews) and are
  calibrated by the ledger's recorded outcomes. It must be honest about being a
  heuristic: `provider` says so, `confidence` is bounded.
- `typesafe`: the hosted System One client. It posts `{state, model, questions}`
  to `POST {base}/v1/systemone` (base default `https://api.typesafe.ai`), with
  questions mapped to the published wire shape (`type`, `instructions`,
  `criteria`), and reads the published `answers` envelope (`noul`, `score` +
  `legend`, `choice` + `probabilities`) plus `model` and `usage`.
  Configuration: `ATTEST_JEV_API_KEY`, `ATTEST_JEV_BASE_URL`,
  `ATTEST_JEV_MODEL` (default `jev-latest`), `ATTEST_JEV_TIMEOUT_MS` (default
  8000). Validate responses with zod, cap state at 32,000 characters, retry
  idempotent calls twice with `p-retry`, never log the key. Score answers are
  normalized by their criteria/legend into the 0..1 risk band. On error fall
  back to `heuristic` and record the error in the outcome. Live-verified against
  `api.typesafe.ai` on 2026-11-15 (`jev-1.14.0`); see
  `docs/dev/jev-live-verification.md`.
- `off`: no calls, no audit rows; the audit stage reports disabled.

**Security rules.** State is untrusted data. Instructions live only in the
question, never in the state. A regex or a deterministic rule wins whenever it
can decide (`git push --force`, `rm -rf`, writes outside `touches`, secrets).
Jev answers are signals, never authorization: the policy engine and the
existing deterministic checks make the call. Jev must never cause an action
that the mode (`shadow`/`enforce`) does not permit. Prompt injection in role
text/result state is truncated and explicitly delimited in the request.

### 6.3 Policy

Thresholds default to low `< 0.25`, medium `0.25..0.75`, high `> 0.75`.
`shadow` records every outcome and never refuses. `enforce` maps high risk to
`block`, medium to `ask`, low to `allow`; the caller decides how a gate handles
that (`gate` refuses to open a blocked gate; `dispatch` refuses a blocked
role; `merge.risk` requires an answered human gate). Configuration in the plan
`audit:` block; environment `ATTEST_JEV_MODE`, `ATTEST_JEV_PROVIDER` override
for experiments.

### 6.4 Ledger

`<git-common-dir>/attest/<case>/audit.jsonl`, one JSON object per line:

```json
{"seq":0,"at":"2026-11-15T12:00:00.000Z","type":"audit-decision","prev":"","hash":"sha256:…","payload":{…JevOutcome…}}
{"seq":1,"at":"…","type":"audit-outcome","prev":"sha256:…","hash":"sha256:…","payload":{"id":"…","expected":"allow","observed":"…","source":"gate|review|human"}}
```

Every record hash is `sha256:` over the canonical JSON of `{seq, at, type,
prev, payload}` (sorted keys). `verifyLedger` walks the file, checks sequence
and chain, and reports the first broken record. The ledger is append-only; no
code rewrites it. A `audit-verify` record is appended when a person or CI
verifies it.

### 6.5 Panel and command surface

- `attest audit verify` — verify the chain, print `OK <n> records` or the break.
- `attest audit report [--json]` — summarize decisions, bands, calibration and
  outcomes; writes `docs/cases/<case>/audit.md` in the case worktree when
  `--write` is passed.
- `attest audit show <n>` — one decision with its state digest and reason.
- `attest audit outcome <id> <allow|ask|block|defect|pass> [--note]` — record a
  verdict for calibration.
- `attest audit calibrate [--json]` — Brier score, reliability bins and
  suggested threshold adjustments.
- `attest stage audit` runs the workflow audit stage: verify + decisions for
  every result + report, then the orchestrator opens `mr-ok`.

`PanelModel` gains an optional `audit?: AuditView` produced by
`src/jev/view.ts#auditViewOf(commonDir, caseName)`:

```ts
export type AuditView = {
  enabled: boolean
  mode: 'shadow' | 'enforce' | 'off'
  provider: string
  chain: { ok: boolean; length: number; brokenAt?: number }
  counts: { allow: number; ask: number; block: number; shadow: number }
  risk: 'low' | 'medium' | 'high' | 'unknown'
  verdict: string
  lastAt?: string
  decisions: {
    seq: number; id: string; at: string; band: string; action: string;
    probability?: number; provider: string; reason: string
  }[]
  calibration?: { n: number; brier: number; bins: { lo: number; hi: number; n: number; observed: number }[] }
}
```

The TUI adds tab 6 `AUDIT` (Chinese: 审计), keys `1-6`, help entries and the
audit page: chain status, mode/provider, band counts, the risk verdict, a
compact decision table and calibration bars. `j/k` moves the selection, `Enter`
shows the reason and digest in the detail column. The page must render with the
same width rules as the other tabs and respect the minimum 40x10 terminal.

## 7. Commands (stable surface)

```
attest setup [--remove]
attest case new <name> [--base <ref>]
attest open [--planning] [-m case]
attest up -m <case> [--orch claude|codex]
attest check [case|folder|plan] [-m case]
attest approve [-m case]
attest gate <id> ["question"] [--no-wait]
attest stage <id>
attest dispatch <role>
attest status [--json] [--watch]
attest send <role> <text…>
attest wait (--role <r> [--ready] | --gate <id>) [--timeout s]
attest close <role> | --all
attest teardown [--force]
attest panel [--once] [--plain] [--no-anim] [--width N --height N]
attest audit verify|report|show|outcome|calibrate
attest activity <name>
```

Exit codes: 0 success, 1 refused with reasons, 2 usage.

## 8. Verification

`npm run check` must: type-check, build, run every test, scan for forbidden
names, and leave the panel goldens unchanged unless deliberately regenerated.
Panel goldens: `UPDATE_GOLDENS=1 node --test tests/draw.node.mjs`; read the
diff before committing. Screenshots are captured from the real panel in tmux
and rendered to PNG under `docs/media/`.
