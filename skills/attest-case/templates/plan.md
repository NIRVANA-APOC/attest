# <case>: <title>

## Intent

<Two or three sentences: what the person wants and why; link the issue.>

## Done when

- <one line the person can check: what, not how>
- <one line the person can check>

## Out of scope

<What this case deliberately does not do.>

## Decisions for you

1. <A question the code cannot answer, with the options.> **Recommended:
   <option>**, because <reason>. Approving takes the recommendations; a
   different answer is a change.

<Leave the section out when there is none.>

## How the work is split

<Why the roles are cut where they are. Files that change together sit in one
role. A hub file (shared helpers, types, config) is touched by exactly one
role. Two roles whose `touches` overlap are ordered by `depends_on`;
everything else runs at once. The audit stage runs after review and before the
MR OK gate; add an optional `auditor` role if the person wants a written
judgment of the ledger.>

```yaml
attest: 1
goal: "<the case in one sentence: what it delivers>"
why: "<one line: why now>"
workflow: attest-case
base: case/<case>          # roles are cut from it at dispatch; you merge onto it
profiles:                  # settings several roles share; a role's own fields win
  claude-build:
    agent: claude
    model: opus
    effort: high
    flags: [--permission-mode, acceptEdits]
    text: workflow:builder # the workflow's builder rules, then the role's section
  codex-build:
    agent: codex
    model: <model>
    effort: high
    flags: [-a, on-request, -s, workspace-write]
    text: workflow:builder
audit:                     # optional; the audit stage runs before the MR OK gate
  mode: shadow             # shadow records and never refuses; enforce blocks high risk and asks on medium
  provider: heuristic      # heuristic (offline, default) | typesafe (Jev endpoint) | off (no ledger)
  questions: [plan.risk, plan.clarity, result.fidelity, merge.risk, teardown.safety]
roles:                     # one role = one window, one worktree, one branch
  api:
    use: codex-build
    goal: "<one line: what this role delivers>"
    touches: [src/api/]    # a trailing slash means the whole directory
  web:
    use: claude-build
    model: sonnet
    goal: "<one line>"
    touches: [web/src/]
    depends_on: [api]      # opens once api's result says done
  review:
    agent: claude
    model: sonnet
    effort: high
    flags: [--permission-mode, acceptEdits]
    goal: "Review each branch as it lands"
    touches: []            # changes no files
    reviews: [api, web]
    text: workflow:reviewer
  # auditor:             # optional: add it to audit the ledger before the MR gate
  #   use: claude-build
  #   goal: "Judge the audit ledger and the case's risk"
  #   touches: []
  #   group: audit       # counts under the Audit stage in the panel
  #   depends_on: [review]
  #   text: workflow:auditor
```

Each role names its `agent` (`claude`, `codex`, or an adapter in
`.attest/agents/`) and its own `flags`, which must pin the agent's permission
(Claude Code: `--permission-mode`; Codex: `-a` and `-s`): a role never inherits
it. `model` and `effort` are passed as written. Keep each value on one line.
`audit.mode` is `shadow` or `enforce`; `audit.provider` is `heuristic`,
`typesafe` or `off`; `audit.questions` lists the Jev decisions the audit stage
records, and a shorter or longer list is allowed. An `auditor` role, when
present, should carry `touches: []` and `group: audit`, and needs its
`## Role: auditor` section with the case-specific questions; it is dispatched
at the audit stage and changes no code. If a role turns out to need a file it
did not declare, update this plan; a changed plan is approved again before the
next dispatch.

## Role: api

<What the role does, what it must not change, and how it proves its work: a
command, or an app path to drive.>

## Role: web

<...>

## Role: review

<Review each branch as it lands, in the order they land. What to check beyond
the reviewer rules.>
