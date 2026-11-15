# Contributing

Thanks for helping with Attest. Issues and pull requests are both welcome.

## Before you start

- **Bug?** Open an issue with what you ran, what you expected and what happened.
  `attest status --json`, the panel's `4 LOG` page and the run log
  (`<git-common-dir>/attest/<case>/log.jsonl`) usually say a lot; paste the
  relevant part. If audit is involved, include `attest audit report` (and never a
  real API key).
- **Security problem?** Do not open a public issue. See [SECURITY.md](SECURITY.md).
- **Larger change** — a new command, a new built-in agent, a change to the plan
  format, the ledger format or the panel's output contract — open an issue first.
  Those surfaces are contracts for users, tests and screenshots.
- Read [ROADMAP.md](ROADMAP.md): the rule there decides what belongs in code and
  what belongs in the workflow skill.

## Set up

```sh
git clone <repo> && cd Attest
npm ci
npm run build && npm link     # your build of `attest` on the PATH
./check.sh                    # type-check, identity scan, build, every test
```

Requirements for the full suite: Node.js 20+, git, and tmux (the real-tmux
tests skip without it; CI installs tmux on both Linux and macOS). Node 20 and
22 are supported.

The one check is `./check.sh` (`npm run check`): `tsc --noEmit`, the identity
scan, the build, then every `node:test` suite through `npm test`. CI runs it on
Linux and macOS, and once with all locale variables empty, because agents often
run Attest from a shell without a UTF-8 locale.

## Repository map

| Area | Files | Owns |
| --- | --- | --- |
| CLI surface | `src/cli.ts`, `src/commands.ts`, `src/panel-open.ts`, `src/command-context.ts` | command dispatch, usage, exit codes, option parsing |
| Planning | `src/plan.ts`, `src/check.ts`, `src/touches.ts`, `src/yaml.ts` | plan format, validation, the `audit:` block pass-through |
| Cases, panes, roles | `src/cases.ts`, `src/panes.ts`, `src/role-commands.ts`, `src/orchestrator.ts`, `src/notices.ts`, `src/activity.ts`, `src/setup.ts` | worktrees, tmux panes, briefs, dispatch/send/wait, skill install |
| Live reads | `src/state.ts`, `src/log.ts`, `src/usage.ts`, `src/diff.ts`, `src/screen.ts`, `src/statusline.ts`, `src/agents.ts`, `src/run.ts` | run log, results, commits, diffs, context, adapter loading |
| Panel | `src/model.ts`, `src/draw.ts`, `src/canvas.ts`, `src/motion.ts`, `src/panel.ts`, `src/panel-input.ts`, `src/panel-model.ts`, `src/i18n.ts` | the six pages, cells and motion, input, English/Chinese |
| Audit | `src/jev/**` | typed decisions, providers, policy, ledger, calibration, reports, panel view |
| Workflow skill | `skills/attest-case/**` | plan template, `stages.yaml`, builder/reviewer/auditor role texts |
| Tests and checks | `tests/**`, `scripts/check-names.mjs` | suites, goldens, identity scan |
| Docs, assets, screenshots | `README*.md`, `docs/**`, `assets/**`, `tools/**` | user-facing text and real captures |

Shared files: `package.json`, `check.sh`, `tsconfig*.json`. Keep a pull request
to one concern; ask before changing a contract that other modules depend on
(plan keys, log events, ledger records, panel text used by goldens).

## Checks you should run

- `./check.sh` — everything. A pull request that changes behaviour without a
  failing-before test is usually missing the test.
- **Panel goldens.** `tests/draw.node.mjs` compares plain-text frames at fixed
  sizes. They are the UI contract. After a deliberate visual change:
  `UPDATE_GOLDENS=1 node --test tests/draw.node.mjs`, then read the diff before
  committing. Do not regenerate them to hide an accidental change.
- **Docs contract.** `node --test tests/docs-contract.node.mjs` checks that every
  command shown in the docs is a real `attest --help` command, that every local
  image reference exists, and that the two READMEs reference the same set of
  screenshots.
- **Identity scan.** `node scripts/check-names.mjs` refuses the retired project
  identity in any text file. It runs as part of `./check.sh`.
- **Real tmux.** Tests under `tests/commands-integration.node.mjs` and
  `tests/panel-live.node.mjs` start real tmux sessions on an isolated socket;
  they skip when tmux is absent but must pass on a machine that has it.

## Adding an agent adapter

Any terminal agent can be a role through an adapter file: `~/.config/attest/
agents/<name>.yaml` or `<repo>/.attest/agents/<name>.yaml` (the repository's
wins; a file replaces the built-in adapter with that name in full). The format
is documented in [the user guide](docs/guide.md#agent-adapters). To add a
**built-in** adapter:

1. Add the entry to `src/agents.ts` with `command`, model/effort argv templates,
   permission flag groups, `prompt: 'last-arg'`, `paste: 'bracketed'`, badge and
   screen patterns. Screen patterns come from the agent's real screens, not from
   imagination.
2. Pin its permission properly: every group in `permission` must be satisfiable
   by the role's `flags`; `attest check` reports the unset groups.
3. Add fixtures and a test: adapter parsing and `unsetPermission` live in
   `tests/agents.node.mjs`; screen-state tests belong beside the existing ones.
4. If the agent publishes its own turn/context signal, wire it in `usage.ts`
   (`claude`/`codex` style) instead of relying on screen patterns. The screen is
   only a fallback for whether a running turn waits on a person.
5. Update `docs/guide.md` and `docs/guide.zh-CN.md` in the same pull request.

## The screenshot workflow

`docs/media/*.png` are real panel frames, not mockups. They are produced by
`tools/screenshot/capture.mjs`, which builds a scratch repository, drives the
real CLI and a real `attest panel` process in tmux, captures ANSI frames with
`tmux capture-pane -ep`, and renders them with Pillow. Agent *binaries* are
scripted stand-ins so the frames can be reproduced without Claude Code or Codex
signed in; the case, plan, approvals, log, commits, results and audit ledger are
real. Read [tools/screenshot/README.md](tools/screenshot/README.md) for the
requirements and options.

After a visual change that a screenshot should show, recapture:

```sh
node tools/screenshot/capture.mjs --python .tools/venv/bin/python
```

Then look at every PNG you are about to commit. Never edit a captured frame by
hand; change the case or the harness and recapture.

## Documentation workflow

- `README.md` and `README.zh-CN.md` are parallel documents: same sections, same
  screenshot set, no section missing in one language. Same for
  `docs/guide*.md` and `docs/jev-audit*.md`.
- Document only the implemented surface. If a command, flag or plan field does
  not exist, do not describe it. The docs-contract test enforces the command
  side; reviewers enforce the rest.
- Write real sentences for Attest. Do not copy the project this one grew out
  of; identifiers, features and limitations are Attest's own.
- When a design decision is about trust or safety, say what it does **not**
  prove. The audit docs are the model for that tone.

## Pull requests

- Explain what changed and how you checked it; paste `./check.sh` output.
- Keep the diff reviewable; separate a rename or a formatting sweep from a
  behaviour change.
- Do not weaken a test to make it pass. If a test is wrong, say why in the PR.
- Update `CHANGELOG.md` only for user-visible changes.
