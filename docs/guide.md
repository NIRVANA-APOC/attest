# attest user guide

[← Back to the overview](../README.md) · [简体中文](guide.zh-CN.md)

[Plans](#the-plan) · [Commands](#commands) · [Panel](#the-panel) · [Agents](#agents) · [Known limits](#known-limits)

## The plan

Markdown around one fenced yaml block; each role's task is a
`## Role: <name>` section in the Markdown. The template is
[`skills/attest-case/templates/plan.md`](../skills/attest-case/templates/plan.md).

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
roles:                                # one role = one window, worktree and branch
  api:
    agent: codex
    model: gpt-6.1-sol
    effort: high
    flags: [-a, on-request, -s, workspace-write]
    goal: "Rotate the token on refresh; refuse a reused one"
    touches: [src/api/refresh.ts, src/api/errors.ts]
  web:
    use: claude-build
    model: sonnet
    goal: "Sign the user out when a refresh is refused"
    touches: [web/src/session/]
    depends_on: [api]                 # opens once api's result says done
  review:
    use: claude-build
    goal: "Review each branch as it lands"
    touches: []                       # changes no files
    reviews: [api, web]
    text: workflow:reviewer
```

`attest check` refuses: an unknown agent; `flags` that do not pin the
agent's permission (Claude Code: `--permission-mode`; Codex: `-a` and `-s`);
a role with no text or no `touches`; an unknown `depends_on`, `reviews` or
profile; a dependency cycle; two roles whose `touches` overlap without a
`depends_on` between them. `model` and `effort` are passed as written.

## Commands

All take `-m, --case <name>`. Without it, a command acts on the case
bound to the pane it runs in (a panel follows its orchestrator's), else on
the `case/<name>` branch checked out where it runs; otherwise it refuses
and lists the open cases with their worktrees. `-m` reads the plan from
the case's worktree from anywhere, but refuses to name another case
than the pane's own. Exit 0 on success, 1 when refused (with the reasons), 2
on usage errors.

| Command | What it does |
|---|---|
| `setup [--remove]` | install the workflow skill for each harness found |
| `case new <name> [--base <ref>]` | create the case's worktree on `case/<name>` with the plan template, bind this pane to it and open its panel |
| `open [--planning]` | show this pane's case's panel beside it (one per case); without a case it refuses and lists the open ones, except with `--planning`, which shows a panel waiting for `case new`; `open -m <name>` from an unbound pane makes it that case's orchestrator, only once the previous orchestrator pane is gone or dead |
| `up -m <name> [--orch claude\|codex]` | `case new`, then open the orchestrator in the case worktree and the panel |
| `panel` | the live panel (`up` runs it; `--once --plain` prints one frame) |
| `check` | check the plan and the user adapters |
| `approve` | approve the plan, from a terminal only |
| `gate <id> ["question"] [--no-wait]` | ask the person in the panel; prints `approve` or `change: <text>` |
| `stage <id>` | move the panel's stage strip (ids from the workflow's `stages.yaml`) |
| `dispatch <role>` | open a role: worktree, branch, brief, pane |
| `status [--json] [--watch]` | each role's state, commits, changes outside `touches`, result; with no case resolved, the open cases with their worktree, orchestrator pane and panel pane |
| `send <role> <text…>` | type into a role's window, only when it is ready |
| `wait --role <r> [--ready] \| --gate <id> [--timeout s]` | wait for a result, readiness or an answer |
| `close <role> \| --all` | close attest's panes; worktrees and branches stay |
| `teardown [--force]` | close role panes and the case's panel, remove role worktrees, role branches, the case worktree and temporary case briefs/results; preserve the case branch and log |

An open case has a worktree on its `case/<name>` branch or a log, and
no teardown event. Explicit `-m` opens any case, including a finished
one. Until its orchestrator is bound, the panel waits for one.

Once the MR is merged and its `merged` gate approved, run `attest teardown -m
<case>`. It closes role panes and the case's panel, and unbinds the
orchestrator's pane, which stays open. It refuses while any gate the
workflow declares is not approved, and refuses dirty or untracked work,
commits unmerged into the plan's `base` case branch, and an unpushed
case branch, unless `--force`. Panes with a different owner marker are skipped. Repeating it
with explicit `-m` reports nothing left. The MR head and log stay available.

Use `attest wait --role <r> --ready --timeout 60` after dispatch or before
sending new work. It succeeds on ready, stops with the dialog on waits, and
fails if the pane is gone or the timeout expires.

A role finishes by writing `.attest/result.md` in its worktree, with front
matter `status: done | blocked | failed` and `summary: "<one line>"`.

## The panel

Title bar, tabs (`1 CASE`, `2 ROLES`, `3 PLAN`, `4 LOG`, `5 DIFF`), the
needs-you strip (an open gate, each role waiting on you), then roles, stages
and activity on the left and the flow plus the selected role's detail with
its window live on the right. ↑↓ or j/k select a role, `o` opens its pane,
`s` sends it a message (a dead key while it waits on you), `d` diff, `v`
plan, `a` / `c` answer a gate, `?` help, `q` quits. Clicks work where tmux
passes the mouse (`set -g mouse on`).

`中/EN` at the right of the title bar, or `L`, switches the panel between
English and Chinese. The choice is saved in `~/.config/attest/settings.json`;
until you make one, a `zh` locale starts the panel in Chinese. It also sets
the language the agents write in for you: the plan, gate questions and
results. Roles dispatched later get it in their brief, and the orchestrator
is told when you switch mid-case. What is already written stays as it is,
and what attest reads (headings, YAML, `status:`, CLI output) stays English.

## Agents

Built in: `claude` and `codex`. An adapter says how to start the agent with
a first prompt, how to pass model and effort, which flags pin its
permission, and which screen patterns mean waits on you, working and ready.
Add one as `~/.config/attest/agents/<name>.yaml` or
`<repo>/.attest/agents/<name>.yaml` (the repository's wins); `src/agents.ts`
holds the built-ins in the same shape.

A built-in role's turn comes from its agent, not its screen. Claude roles
start with lifecycle hooks in `--settings` (`UserPromptSubmit`,
`PercaseRequest`, `PostToolBatch`, `Stop`, and the idle notice after an
interrupt) that write `.attest/activity.json`; Codex roles are read from
their own session log (`task_started`, `task_complete`, `turn_aborted`).
Only that report makes a role ready for `send`. A Claude role's hooks also
report when it waits on you: `PercaseRequest` opens the wait (an approval
or a question), the next tool batch ends it as answered, and a deny or Esc,
which runs no hook, ends it with the interrupt row in the role's transcript.
Each wait's end is kept in the record (the last 50).
Otherwise, while a turn runs, the screen patterns tell waiting on an
approval from working; before the first report they stand in, but never as
ready. An adapter with `usage` unset is read from its screen alone.

The orchestrator is told, not polled. Every attest command it runs records
its agent session in the run log: Claude Code's `CLAUDE_CODE_SESSION_ID` or
Codex's `CODEX_THREAD_ID`, accepted only when that agent is an ancestor of
the command, and the pane to type to (tmux, or herdr's `HERDR_PANE_ID`).
When a role's agent reports its turn over with a result written, the
person answers a gate in the panel, or the person answers a Claude role's
wait in its window (`Role review was answered in its window and went on
working.`, or `… was stopped in its window …` after a deny or Esc), the
panel types one line into the orchestrator after the orchestrator's own
turn has ended, read from its transcript (Claude's `turn_duration` or
interrupt row) or session log (Codex). Every answered wait is told once,
oldest first, unless the role's finish was told, work was sent to it, or it
wrote a result since. Each line is logged as a `notice`, so none repeats or
is lost across panel restarts. A case with no recorded session falls back to
the old screen-checked gate answers.

Codex roles open without the "Trust this folder?" dialog: each is started
with `-c projects={"<main checkout>"={trust_level="trusted"}}`, the entry
answering the dialog would save (Codex keys trust by the repository root),
for that run only; `~/.codex/config.toml` is not changed.

Codex roles using `workspace-write` receive `--add-dir` grants for their own
Git worktree metadata, shared `objects`, and `refs/heads/role/<case>` plus
its reflogs. This allows commits without granting the whole common Git
directory or main-branch refs. Case refs and objects are shared, so this
is not isolation between roles in the same case. The approval/sandbox
flags remain the ones in the plan. See the [Codex CLI reference](https://developers.openai.com/codex/cli/reference).

## Where things live

| What | Where | In git |
|---|---|---|
| the case worktree | `.attest/cases/<case>` on `case/<case>` | no |
| the plan | `docs/cases/<case>/plan.md` in the case worktree | yes |
| the run log (approvals, gates, stages, dispatches) | `<git-common-dir>/attest/<case>/log.jsonl` | no |
| the role's launch brief | `<worktree>/.attest/brief.md` (archived beside the run log as `brief-<role>.md`) | no |
| role worktrees | `.attest/worktrees/<case>/<role>` (`/.attest/` is excluded) | no |
| a role's result | `<worktree>/.attest/result.md` | no |

## Known limits

- The log is advisory, as any file is: it stops a forgetful dispatch, not a
  model set on writing it by hand.
- Screen patterns come from Claude Code 2.1.310 and Codex 0.162.1 in
  English. They no longer decide when a built-in role is ready, only whether
  a running turn waits on you; a screen attest does not recognise is
  `unknown` and is never typed into.
- Codex logs no approval request, so a Codex role waiting on one shows as
  waits only while its screen pattern matches; either way it is not ready.
  Its answer is not told to the orchestrator.
- Context use comes from each role's transcript. Codex logs its window; for
  Claude, attest launches the role with a status line (`--settings`) that
  saves the window Claude Code reports to `.attest/context.json`, then runs
  the status line you configured, so yours still shows. Until it first runs,
  the panel assumes 200k, or 1M once the context passes 200k.

## Development

From a clone: `npm ci && npm run build && npm link` puts your build of
`attest` on the `PATH`. `./check.sh` (or `npm test`) builds and runs the tests under plain Node; CI
runs them on macOS and Linux with Node 20 and 22. `src/` holds everything:
the plan (`plan.ts`, `yaml.ts`, `touches.ts`), the adapters (`agents.ts`),
the log and the live reads (`log.ts`, `state.ts`), the commands
(`commands.ts`, `role-commands.ts`, `command-context.ts`, `cases.ts`,
`panes.ts`, `setup.ts`), and the panel (`model.ts`, `draw.ts`, `canvas.ts`, `panel*.ts`).
