# The Attest user guide

[← Back to the overview](../README.md) · [简体中文](guide.zh-CN.md) · [The Jev audit](jev-audit.md)

[Install](#install-and-first-run) · [The case](#the-case) · [The plan](#the-plan-format) · [Commands](#command-reference) · [The panel](#the-panel) · [Adapters](#agent-adapters) · [Files](#where-things-live) · [Limits](#known-limits) · [Development](#development-and-checks)

Attest turns one person and a description of a change into a planned, built,
reviewed and audited case. The orchestrator agent writes the plan with you;
each role then works as a real Claude Code or Codex session in its own tmux
window, git worktree and branch; a panel beside the orchestrator shows the work
and stops at your gates. This guide covers the implemented 0.1.0 surface: the
plan format, every command and option, the panel, adapters, where files live,
and what the tool does not do.

## Install and first run

Requirements: **macOS, Linux or WSL2**, **tmux**, **Node.js 20+**, **git**, and
**Claude Code and/or Codex** installed and signed in. Roles are interactive
terminals; Attest does not wrap or replace the agents.

```sh
git clone <repo> && cd Attest
npm ci && npm run build && npm link   # 0.1.0 is not published to npm; build from source
attest setup
```

`attest setup` installs the `attest-case` workflow skill for the harnesses it
finds (`~/.claude/skills/attest-case` and/or `~/.agents/skills/attest-case`).
It refuses to overwrite or remove a directory it did not install (it marks its
own installs), so an existing skill tree is left alone. `attest setup --remove`
removes only marked installs.

Open Claude Code or Codex **inside tmux, in the repository you want to change**,
and ask for the work as a case. The skill's description matches phrases such as
"attest case", "run this as an attest case", "split this into roles", "开几个
agent 并行做". The agent writes the plan and opens the panel.

Or start from the terminal:

```sh
attest up -m <case> --orch claude     # create the case, start the orchestrator and the panel
```

`attest up` requires tmux and the chosen harness on `PATH`, installs the skill
if that harness lacks it, creates the case worktree, opens the orchestrator in
it, and opens the panel beside it. When you are not already inside tmux it
attaches to the new session. Use `--orch codex` to start a Codex orchestrator.

## The case

A **case** is one orchestrated unit of work. It lives on its own branch
`case/<case>` and in its own worktree under `.attest/` in the repository, so
your checkout stays on your branch. Several cases can run at once, in one
repository or across repositories.

```sh
attest case new auth-refresh            # worktree + plan template, bound to this pane
attest check -m auth-refresh            # validate the plan and adapters
attest gate plan "Approve this split?"  # ask the person in the panel
attest approve -m auth-refresh          # or approve from the panel with `a`
attest stage build
attest dispatch api
```

The plan template is written to `docs/cases/<case>/plan.md` in the case's
worktree, with `base:` already set to the case branch: each role's worktree is
cut from it at dispatch, so a role sees what was merged before it. The case
branch is what the orchestrator merges onto; it is pushed for the MR and is
preserved by teardown. The case's run log and audit ledger live beside the git
common dir, outside git (see [Where things live](#where-things-live)).

A case is *open* while it has a worktree on its branch or a run log and no
`teardown` event. Explicit `-m` can reach a finished case too (for example to
repeat a safe teardown, which reports that nothing is left).

## The plan format

`plan.md` is Markdown around one fenced YAML block. The Markdown sections are
what the person reads at the plan gate; the YAML block is what Attest enforces.

### The Markdown

| Section | Used for |
| --- | --- |
| `# <case>: <title>` | the case title (the panel and reports use it) |
| `## Intent` | what the person wants and why; link the issue |
| `## Done when` | checkable one-line criteria; the reviewer reports which passed |
| `## Out of scope` | what the case deliberately does not do |
| `## Decisions for you` | numbered questions with `**Recommended: <option>**`; approving takes the recommendations |
| `## How the work is split` | the reasoning for the split (prose; no parsing) |
| `## Role: <name>` | a role's instructions when the role has no `text:` reference |

The panel shows the goal, why, done-when items, roles, decisions and
out-of-scope at the plan gate, and renders the whole plan on the PLAN page. A
`## Role:` section that names no role in the YAML block is a plan problem.

### The YAML block

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
  codex-build:
    agent: codex
    model: gpt-6.1-sol
    effort: high
    flags: [-a, on-request, -s, workspace-write]
    text: workflow:builder
audit:
  mode: shadow
  provider: heuristic
  questions: [plan.risk, plan.clarity, role.boundary, result.fidelity, merge.risk, teardown.safety]
roles:
  api:
    use: codex-build
    goal: "Rotate the token on refresh; refuse a reused one"
    touches: [src/api/]
  web:
    use: claude-build
    model: sonnet
    goal: "Sign the user out when a refresh is refused"
    touches: [web/src/]
    depends_on: [api]
  review:
    use: claude-build
    goal: "Review each branch as it lands"
    touches: []
    reviews: [api, web]
    text: workflow:reviewer
```

| Key | Meaning |
| --- | --- |
| `attest` | format version; must be `1` when present |
| `goal` | the case in one sentence (the panel's top-right line) |
| `why` | one line on why now |
| `workflow` | the workflow skill name (default `attest-case`); decides `stages.yaml` and `workflow:` role texts |
| `base` | the branch roles are cut from at dispatch and the orchestrator merges onto. `case new` writes `case/<case>` |
| `profiles` | named bundles of role settings; a role's own fields win; a profile cannot `use` another |
| `audit` | optional Jev audit configuration (see below) |
| `roles` | one entry per role: one window, one worktree, one branch |

Role fields:

| Key | Meaning |
| --- | --- |
| `use` | a profile whose settings this role starts from |
| `agent` | `claude`, `codex`, or an adapter name under `.attest/agents/` |
| `model` | passed to the agent as written (Claude Code: `--model`; Codex: `-m`) |
| `effort` | passed as written (Claude Code: `--effort`; Codex: `-c model_reasoning_effort=…`) |
| `flags` | the agent's own flags. They must **pin its permission**; it is never inherited |
| `goal` | one line: what this role delivers |
| `touches` | files or directories this role may change; a trailing `/` covers the directory. `[]` means it changes no files |
| `depends_on` | roles that must be `done` before this role may be dispatched |
| `reviews` | roles whose branches this role reviews (informational for the reviewer role and the flow diagram) |
| `text` | `workflow:<name>` (the skill's `roles/<name>.md`) or a repository path; appended to the role's brief. A `## Role:` section body is used when `text` is absent |
| `skills` | extra skill names for the role's brief (workflow-defined) |
| `group` | the stage group the role belongs to; default `build`, or `review` when it changes nothing and reviews someone. `group: audit` puts a role under the audit stage |

`attest check` refuses, with one line per problem:

- an unknown agent, or `flags` that leave one of the adapter's permission groups
  unset (Claude Code: `--permission-mode`; Codex: `-a` and `-s`);
- a role with no `text` and no `## Role:` section;
- an unknown `depends_on`, `reviews` or profile;
- a dependency cycle;
- two roles whose `touches` can name the same file while neither depends on the
  other;
- a missing role text file, an unreadable YAML block, an unknown key in the
  plan or a role, or a role name that is not lower-case letters/digits/`-`.

`model` and `effort` are passed as written; nothing is inferred from them.

### The audit block

```yaml
audit:
  mode: shadow          # shadow | enforce
  provider: heuristic   # heuristic | typesafe | off
  questions: [plan.risk, plan.clarity, role.boundary, result.fidelity, merge.risk, teardown.safety]
```

Omitted fields default to `shadow`, `heuristic` and every decision id; an
explicit `questions: []` records nothing. Unknown values fall back to the safe
default rather than failing the plan, and the problems are reported by
`attest audit report`. `ATTEST_JEV_MODE` and `ATTEST_JEV_PROVIDER` override the
block for experiments; the remote provider is configured with
`ATTEST_JEV_API_KEY`, `ATTEST_JEV_BASE_URL`, `ATTEST_JEV_MODEL` and
`ATTEST_JEV_TIMEOUT_MS`, and has been live-verified against the hosted
`/v1/systemone` endpoint (see
[the live evidence](dev/jev-live-verification.md)). Decisions, the trust
boundary and calibration are explained in [the Jev audit](jev-audit.md).

## Command reference

All commands accept `-m, --case <name>`. Resolution order: the explicit `-m`;
the case this pane is bound to; the case whose panel names this pane's
orchestrator; the `case/<name>` branch checked out where the command runs.
With no case resolved, a command lists the open cases with their worktrees
instead of guessing. `-m` reads the plan from the case's worktree from
anywhere, but refusing to name a different case than the pane's own binding.

Exit codes are part of the interface: **0** success, **1** refused (the reasons
are printed), **2** usage error (the message and usage are printed to stderr).

| Command | Options | What it does |
| --- | --- | --- |
| `setup` | `--remove` | install (or remove) the `attest-case` skill for each harness found; marked installs only |
| `case new <name>` | `--base <ref>` | create the case worktree on `case/<name>` from `HEAD` or `--base`, write the plan template, bind this pane, open the panel; refuses from a pane already running another case |
| `open` | `--planning`, `-m` | show the case's panel beside this agent; one panel per case. `--planning` opens a panel that waits for `case new`; `open -m` from an unbound pane may take over a case whose orchestrator pane is gone |
| `up` | `-m <case>`, `--orch claude\|codex` | create the case, start the orchestrator in its worktree, open the panel, attach when outside tmux |
| `check` | positional `[case\|folder\|plan]`, `-m` | validate the plan and the adapters; `clean (N roles: …)` or the problems |
| `approve` | `-m` | print the plan summary, list problems, ask `y/N`; requires stdin and stdout to be terminals, and refuses if the plan changed while the prompt was open |
| `gate <id>` | `"question"`, `--no-wait`, `-m` | append a gate-open event and ask the person in the panel; prints `approve` or `change: <text>`; `--no-wait` returns immediately |
| `stage <id>` | `-m` | move the stage strip; ids come from the workflow's `stages.yaml`; an unknown id is refused with the choices |
| `dispatch <role>` | `-m` | require the plan as it is now to be approved, require dependencies `done`, create the worktree and branch, write the brief, open the window, log the dispatch |
| `status` | `--json`, `--watch`, `-m` | per role: state, agent, branch, commits, changed files, files outside `touches`, result summary and problems; or the open cases |
| `send <role> <text…>` | text via stdin when omitted, `-m` | type into a role's window only when its agent reports ready; puts the old result aside first; refuses on a waiting, working or unknown screen and names `wait --ready` |
| `wait` | `--role <r> [--ready]`, `--gate <id>`, `--timeout <seconds>`, `-m` | wait for a role result (`done` exits 0, `blocked`/`failed` exit 1), for readiness, or for a gate answer (`approve` or `change: …`); Ctrl-C cancels cleanly; unread log lines refuse a reliable wait |
| `close <role>` | `--all`, `-m` | close attest's panes; worktrees and branches stay |
| `teardown` | `--force`, `-m` | after the workflow's gates are approved: close role panes and the case panel, remove role worktrees and branches, the case worktree and temporary briefs/results; preserve the case branch and log. Refuses dirty/untracked work, commits not merged into `base`, or an unpushed case branch unless `--force`; panes with another owner marker are skipped; a finished case requires `-m` and repeated teardown reports nothing left |
| `panel` | `--once`, `--plain`, `--no-anim`, `--width N`, `--height N`, `-m` | the live panel; `--once` prints one frame and exits (useful in scripts); `--plain` drops colour; `--no-anim` stops motion; the panel needs at least 40x10 |
| `audit verify` | `--json`, `-m` | verify the hash chain: `OK <n> records` (a successful non-empty verify appends an `audit-verify` record), `OK 0 records` on an empty ledger, `OK <n> records (incomplete final line ignored)` on a torn tail (neither appends), or `BROKEN at record <n>: <reason>` with exit 1 |
| `audit report` | `--json`, `--write`, `-m` | the case's audit summary: chain, mode/provider, counts, risk, one-sentence verdict, decision table, outcomes, calibration. Mode, provider and verdict come from the recorded actions (the plan/env config only labels an empty ledger). `--write` writes `docs/cases/<case>/audit.md` and prints `Wrote <path>`; `--json` then includes `written` (absolute path) or, on a broken chain, `writeRefused` — a broken ledger exits 1 and is never published as a report |
| `audit show <n>` | `--json`, `-m` | one decision by ledger sequence or by decision id (latest match): reason, state digest, answers, timing |
| `audit outcome <id\|seq>` | `<allow\|ask\|block\|defect\|pass>`, `--note`, `--json`, `-m` | append a human verdict for calibration; `expected` is the decision's recorded action, `observed` your verdict |
| `audit calibrate` | `--json`, `-m` | Brier score, reliability bins and advisory threshold suggestions; with fewer than five usable outcomes it reports `insufficient outcomes` and exits 0. A recalibration map needs at least 12 outcomes and a holdout split that improves the Brier score |

`attest stage audit` is the workflow's audit stage: it verifies the chain,
records a `result.fidelity` decision for every dispatched role that wrote a
result, writes the report, then moves the stage. A broken chain, or an
enforce-mode block, leaves the stage where it was. The panel's AUDIT page reads
the same ledger (see [the panel](#the-panel)).

Attest also installs two internal helper entry points for the lifecycle hooks
and status line it gives Claude Code roles. They are not part of the supported
command surface and are not listed in `attest --help`.

## The panel

Run `attest panel` yourself, or let `case new`, `open` and `up` open it. The
panel is a real terminal UI: it takes the full window, repaints only the cells
that change, and needs at least 40 columns and 10 rows.

Pages (`1`–`6`, `Tab` cycles, `d` jumps to the diff of the selected role, `v`
to the plan):

| Page | Contents |
| --- | --- |
| **1 CASE** | The needs-you strip (an open gate as a box, each waiting role as a line) at the top, then ROLES, STAGES and ACTIVITY on the left; FLOW and the selected role's detail with its live window on the right. The right column scrolls when it does not fit. |
| **2 ROLES** | One card per role: state, effort, context and tokens when the harness reports them, agent and model, branch, `touches`, committed and changed files, files outside `touches`, result summary. |
| **3 PLAN** | The plan as rendered Markdown with its problems; `f` toggles the full text; the summary view is the one the gate uses. |
| **4 LOG** | Every run-log event, oldest first, following the newest until you scroll up; `Enter` opens an event's fields. |
| **5 DIFF** | Each role's changed files as a tree, the selected file's commits and hunks, a minimap. |
| **6 AUDIT** | The ledger: chain status, mode and provider, the risk verdict, band counts, the decision list (newest first), the selected decision's reason and state digest, and calibration bars. |

Keys:

| Key | Action |
| --- | --- |
| `↑↓`, `j k` | select a role (CASE/ROLES), an event (LOG), a file (DIFF), a decision (AUDIT) |
| `Enter` | open the selected detail; on LOG expand the event's fields; on AUDIT expand the reason |
| `1`–`6`, `Tab` | switch pages |
| `o` | open the selected role's tmux window |
| `s` | send the selected role a message (disabled while it waits on you; answer it first) |
| `d` / `v` | go to the selected role's diff / the plan |
| `a` / `c` | approve the open gate / type a change for it |
| `f` | toggle the full plan on PLAN |
| `L` or the `中/EN` switch | change the panel language |
| `PgUp`/`PgDn`, wheel | scroll; `G`/`End` follows the newest log event again |
| `n` / `N` | next/previous file on DIFF |
| `?` | help; `q` or Ctrl-C quits |

Gates. The plan gate is the first gate every workflow has; dispatch requires
the plan as it is now (plan bytes plus every referenced role text) to be
approved, and any edit invalidates that approval. Approving takes the
`Decisions for you` recommendations. Other gates come from the workflow's
`stages.yaml` (`mr-ok`, `merged` in the default workflow); the orchestrator
opens them with `attest gate` and the panel shows them. A gate answer is
appended to the run log.

Language. `中/EN` (or `L`) switches the panel between English and Chinese. The
choice is saved in `~/.config/attest/settings.json`; until you choose, a `zh`
locale starts the panel in Chinese. It also sets the language agents write for
you (plan prose, gate questions, results); roles dispatched later get it in
their brief, and the orchestrator is told when you switch mid-case. What
already exists stays as written, and what Attest reads back (headings, YAML,
`status:`, CLI output) stays English.

Clicks work where tmux passes the mouse (`set -g mouse on`).

## Agent adapters

Built in: `claude` and `codex`. Add or override an adapter as
`~/.config/attest/agents/<name>.yaml` or `<repo>/.attest/agents/<name>.yaml`;
the repository's file wins, and a file replaces that adapter in full.

| Field | Meaning |
| --- | --- |
| `command` | the executable to run |
| `model` | argv template for the model value, e.g. `["--model", "{model}"]` |
| `effort` | argv template for the effort value |
| `permission` | flag groups; each group must be satisfied by at least one flag the role declares |
| `prompt` | must be `last-arg`: the first prompt is the last argument |
| `screen.waits` / `screen.working` / `screen.ready` | regex lists read from the pane's last 15 non-empty lines |
| `paste` | must be `bracketed`: messages are pasted with bracketed paste |
| `badge.glyph` / `badge.tone` | the one-cell badge and one of the panel's tones |
| `usage` | `claude` or `codex` when Attest can read the agent's own turn/context signal; omit to rely on the screen alone |

Built-in Claude Code roles are started with `--settings` that carry lifecycle
hooks (`UserPromptSubmit`, `PermissionRequest`, `PostToolBatch`, `Stop`,
`Notification`) and a status line. The hooks write `.attest/activity.json` in
the role's worktree: they decide when a turn is ready and when it is waiting on
the person (an approval or a question), so Attest does not type into a dialog.
The status line records the real context window in `.attest/context.json`, then
runs your own status line command, so yours still shows. Codex roles are read
from their own session log (`task_started`, `task_complete`, `turn_aborted`).

Two Codex details. Roles start with `-c projects=…trust_level="trusted"` for the
main checkout so the "Trust this folder?" dialog does not appear; your
`~/.codex/config.toml` is not changed. Roles using `-s workspace-write` get
`--add-dir` grants for their own git worktree metadata, shared objects, and the
case's loose refs/reflogs — enough to commit, not permission to write the main
branch. The approval and sandbox flags themselves are the ones in the plan.

`attest check` reports adapter problems (bad field, invalid regex, bad badge)
until they are fixed; the CLI refuses to act on a plan whose adapters do not
load.

## Where things live

Paths inside a target repository:

| What | Where | In git |
| --- | --- | --- |
| case worktree | `.attest/cases/<case>` on branch `case/<case>` | no |
| plan | `docs/cases/<case>/plan.md` in the case worktree | yes |
| audit report | `docs/cases/<case>/audit.md` in the case worktree | yes, when written |
| run log | `<git-common-dir>/attest/<case>/log.jsonl` | no |
| audit ledger | `<git-common-dir>/attest/<case>/audit.jsonl` | no |
| role worktrees | `.attest/worktrees/<case>/<role>` | no |
| role brief | `<worktree>/.attest/brief.md` (archived beside the log as `brief-<role>.md`) | no |
| role result | `<worktree>/.attest/result.md` | no |
| role activity / context | `<worktree>/.attest/activity.json`, `context.json` | no |
| reviews | `<worktree>/.attest/reviews/<role>.md` | no |
| agent adapters | `~/.config/attest/agents/*.yaml`, `<repo>/.attest/agents/*.yaml` | repository ones yes |
| panel language | `~/.config/attest/settings.json` | no |

The **run log** holds facts only: `gate-open`, `gate-answer`, `stage`,
`dispatch` (pane, worktree, branch, argv, agent), `send`, `close`, `up`,
`teardown`, `orchestrator` (the agent session and pane to notify), `notice`
(lines typed into the orchestrator) and `lang`. Live state (working, waiting,
idle, commits, diff) is read fresh each poll from tmux, git and the role's own
files. The log is advisory as any file is: it stops a forgetful dispatch, not
a model set on editing it by hand.

A role finishes by writing `.attest/result.md` in its worktree, with front
matter:

```markdown
---
status: done            # done | blocked | failed
summary: "One line the panel and status show"
done_when: ['1', '2']   # optional, reviewers: which criteria this review found met
---
```

A reviewer with earlier results puts each aside (archived beside the log as
`result-<role>-<uuid>.md`), so `attest send` to it starts a new result rather
than reusing the old one.

## Known limits

- **The run log is advisory.** Attest reads facts; it does not audit the
  agent's process. A model that edits the log by hand can confuse dispatch
  bookkeeping, though it cannot bypass the plan approval or the gates' recorded
  answers without also being visible in the ledger and report.
- **Screen patterns are a fallback.** Built-in roles' turns are decided by the
  agent's own signal, not the screen. The screen patterns come from Claude Code
  2.1.310 and Codex 0.162.1 in English; they decide only whether a running turn
  waits on a person. An unrecognised screen is `unknown` and is never typed
  into.
- **Codex logs no approval request.** A Codex role waiting on an approval shows
  as waiting only while its screen pattern matches; either way it is not ready,
  and its answer is not reported to the orchestrator.
- **Context use is read where possible.** Claude Code reports its window
  through the installed status line; Codex logs its own. Until the first
  report, the panel assumes 200k, or 1M once context passes 200k.
- **Audit is a signal layer.** The ledger is tamper-evident, not tamper-proof;
  the offline heuristic is labelled as such and needs recorded outcomes to
  calibrate; a remote provider can be manipulated by adversarial state. Read
  [the Jev audit](jev-audit.md) before relying on it for anything that matters.
- **One machine, one user.** Roles share the case's git refs and objects, so
  commits work; that is not isolation between roles. The boundary is tmux plus
  git worktrees, not a sandbox. Roles run with the permissions in the plan;
  Attest does not add its own sandboxing.
- **A person is in the loop by design.** The CLI never pushes an MR, merges a
  branch or approves a gate for you. `attest approve` and the panel's `a` need
  a terminal.

## Development and checks

From a clone:

```sh
npm ci
npm run build        # tsc + dist/cli.js
npm run check        # tsc --noEmit, identity scan, build and the full test suite
```

`./check.sh` is the one check: type-check, identity scan, build, and every test
under plain Node, including panel goldens and real-tmux integration tests (they
skip when tmux is absent). CI runs the suite on Linux and macOS with Node 20
and 22, and once with an empty locale to catch locale-dependent output.

- **Panel goldens.** `tests/draw.node.mjs` compares plain-text frames. After a
  deliberate visual change: `UPDATE_GOLDENS=1 node --test tests/draw.node.mjs`
  and read the diff before committing.
- **Identity scan.** `scripts/check-names.mjs` refuses the retired project
  identity anywhere in the repository; `npm run check` runs it.
- **Screenshots.** `docs/media/*.png` are real `attest panel` frames captured
  from tmux and rendered with Pillow. The agent sessions in them are scripted
  demo adapters, and their audit decisions use the offline `heuristic` provider;
  no vendor agent or hosted Jev API is shown. See
  [tools/screenshot](../tools/screenshot/README.md) for the pipeline and its
  requirements.
- **Docs contract.** `tests/docs-contract.node.mjs` checks that commands shown
  in the docs exist in `attest --help`, that every local image reference
  exists, and that the two READMEs reference the same screenshots.

`src/` is small, plain TypeScript with no framework. Modules by concern: plan
(`plan.ts`, `yaml.ts`, `touches.ts`, `check.ts`), cases and panes (`cases.ts`,
`panes.ts`, `role-commands.ts`, `orchestrator.ts`, `notices.ts`, `setup.ts`),
live reads and the log (`state.ts`, `log.ts`, `usage.ts`, `diff.ts`,
`screen.ts`, `statusline.ts`, `agents.ts`), the panel (`model.ts`, `draw.ts`,
`canvas.ts`, `motion.ts`, `panel.ts`, `panel-input.ts`, `panel-model.ts`,
`i18n.ts`), and the audit subsystem (`src/jev/**`). `docs/dev/contracts.md` is
the coordination contract for the module boundaries and data formats.
