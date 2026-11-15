# Attest 0.1.0 verification

Independent verification by `qa` (task-6). This file is a living record: the
baseline was measured first, then every independently added test, finding and
owner-assigned failure is appended as the other owners land their work. The
requirement matrix at the bottom is the acceptance summary.

- Baseline commit: `a495ded` (repo state when QA started, 2026-11-15 18:18 +08:00)
- Host: Linux x64, Node `v26.13.1`, npm `12.2.2`, tmux `3.8`, git `2.56.1`
- Workspace npm cache used for every install: `<repo>/.npm-cache`
- Reproduce everything below with:
  `npx tsc -p tsconfig.json --noEmit && npm run build && npm test && node scripts/check-names.mjs`
  (equivalently `npm run check`), plus the focused commands named per section.

## 1. Baseline at a495ded

| Check | Command | Result |
| --- | --- | --- |
| type-check | `npx tsc -p tsconfig.json --noEmit` | clean (`tsc: clean`), exit 0 |
| identity scan | `node scripts/check-names.mjs` | `check-names: clean (98 files)`, exit 0 |
| build + full suite | `npm test` | 179 tests, 179 pass, 0 fail, 0 skipped, 0 todo; test duration 11.4 s; exit 0 |
| build | `npm run build` (run by `npm test` and `npm pack` prepack) | `dist/cli.js` + 35 modules built, `dist/cli.js` executable |

The baseline is green. Everything after this point is incremental verification
of the modules that land on top of it.

## 2. Independently added tests

Status values: `pass` (green now), `blocked` (feature not wired yet, owning
agent named), `fail` (reproduced defect, owner-assigned).

| # | Work item | Test file / case | Status |
| --- | --- | --- | --- |
| T1 | End-to-end fake-adapter case flow | `tests/commands-integration.node.mjs` — "end-to-end fake agents: case new → check → approve → dispatch → wait → status → send → close → teardown" | **pass** (tmux 3.8): real git repo, `.attest/agents/fake.yaml` shell adapter writes `.attest/result.md`; case worktree on `case/e2e`, plan check, terminal-only approve refusal, gate/approve loop, role worktree on `role/e2e/api` clean + brief, wait/status/send/second result, close keeps branch, early teardown refused on pending gates, non-force teardown removes role trees/branches and keeps pushed `case/e2e`; exit codes 0/1/2 asserted |
| T2 | Audit CLI end-to-end (verify/report/show/outcome/calibrate) | `tests/commands-integration.node.mjs` — "audit CLI: verify/report/show/outcome/calibrate over a real ledger, JSON shapes, exit codes and a tampered record" | **pass**: records seeded through the real `dist/jev/ledger.js`; verify 0 + appended verify record; report text/`--json` shape (`case/chain/mode/provider/counts/bands/risk/decisions`) and `--write` → `docs/cases/audit/audit.md`; show by seq and id; outcome with `--note`/`--json`; calibrate "insufficient" then Brier/bins/suggestions at 5 outcomes; usage exit 2 |
| T3 | Ledger tamper detection | same T2 case: second record edited after sealing | **pass**: `verify` exit 1 `BROKEN at record 1: hash mismatch`, `--json` `{ok:false,brokenAt:1,length:1}`, `report` exit 1, `outcome` refused with `audit ledger is broken at record 1` |
| T2b | Workflow audit stage | `tests/commands-integration.node.mjs` — "stage audit verifies the chain…" and "…in enforce mode stops on a blocked result…" | **pass**: `stage audit` appends its verify record, records `result.fidelity` for the dispatched role, writes the report, then moves the stage; a later tamper makes it exit 1 at record 1 without a new stage event; enforce mode + failed result exits 1, records a high-band decision, moves no stage and writes no report |
| T4 | Panel AUDIT page rendering | `tests/panel-live.node.mjs` — "panel AUDIT page renders the Jev ledger…" and "…explains a missing ledger and reports a tampered chain…" | **pass**: real hash-chained ledger written through `dist/jev/ledger.js`; model.audit chain/counts/risk/mode/provider/calibration; 96x40 page shows chain verified, 3 records, bands, newest-first decisions, digest, Brier; j opens the older decision; a middle-record edit reports `chain broken at record 1` and shows only the 1 record before it; a missing ledger explains the `audit:` block and `attest stage audit` |
| T5 | Packaging: `npm pack`, tarball install, CLI smoke, skill install/remove safety | `tests/release.node.mjs` — first two cases | **pass**: `npm pack --ignore-scripts` tarball with dist + skills + NOTICE + LICENSE and no src/tests/caches; install into a throwaway project from the workspace cache; `npx attest --version` = 0.1.0; `--help` lists setup/case/open/up/check/approve/gate/stage/dispatch/status/send/wait/close/teardown/panel/audit; unknown command exit 2; `setup` installs the skill into an isolated HOME, `--remove` removes it, second remove says "Not installed", and an unmarked directory is refused and preserved |
| T6 | Identity audit (repo, built package, tarball file list, installed package) | `tests/release.node.mjs` — third case | **pass after F1 fix**: zero occurrences of the project word/misspelling/people across every repo text file (src, dist, docs, assets, skills, examples, tests, scripts, .github), tarball paths and installed package |
| T7 | Documentation contract (commands in help, image exists/type, bilingual screenshot parity) | `tests/docs-contract.node.mjs` | **pass**: README.md, README.zh-CN.md, docs/guide.md, docs/guide.zh-CN.md, docs/jev-audit[-.zh-CN].md exist; 16/16 (READMEs) and 11/11 (guides) unique `attest <cmd>` in code are real `--help` commands; both READMEs reference the identical 5 `docs/media/*.png` + banner, and each screenshot is a real PNG (2448x1648, 459–577 kB) — English AUDIT page and Chinese case page were visually inspected |
| T8 | Missing unit coverage for the renamed domain (plan validation, resolver order, log fold, state reads, panel input) | reviewed `tests/plan.node.mjs` (11 cases: template, profile merge, permission pinning, names/agents/text/touches/sections, overlap+cycles, reviewer grouping, tree order, fences, check, findPlan), `tests/state.node.mjs` (8: log fold/approval invalidation, plan hash, result front matter, diff, word diff, role state, teardown lifecycle), `tests/commands.node.mjs` (37 incl. dispatch/send/status/wait/close/stage/gates/open/up/teardown), `tests/panel-live.node.mjs` (25 incl. parser/input/paint) | **pass, no gap added**: the renamed domain is covered above the acceptance bar; QA added the nine independent cases T1–T9 instead of duplicating them |
| T9 | Regression: sixth tab changes `tab` cycling | `tests/panel-live.node.mjs` — `key('6') → tab 6`, `tab 5 + Tab → 6`, `tab 6 + Tab → 1` | **pass** (`node --test tests/draw.node.mjs tests/panel-live.node.mjs` = 60 pass, tui's goldens including `audit.txt` green) |

## 3. Findings (owner-assigned)

| # | Finding | Evidence | Owner | Status |
| --- | --- | --- | --- | --- |
| F1 | `tests/release.node.mjs` identity audit found the retired project's GitHub owner handle at `.github/ISSUE_TEMPLATE/config.yml:4` (a `github.com/<retired-owner>/attest/security/advisories/new` URL). `docs/dev/contracts.md` §1 forbids the old name, its misspellings and "its people"; `scripts/check-names.mjs` only assembles the project word and one misspelling, so `npm run check` cannot catch a person handle. Reproduce: `node --test tests/release.node.mjs` (identity case lists the file and line). | test output: `.github/ISSUE_TEMPLATE/config.yml:4` | docs | **fixed** (contact-link entry removed; identity case re-ran green) |
| F2 | `attest stage audit` was a bare stage marker: it appended the stage event and printed `Stage: audit`, but did not verify the chain, record a fidelity decision per result, or write the report, while `docs/dev/contracts.md` §6.5 and `skills/attest-case/SKILL.md` §6 promise those checks. Reproduced on a case with a result file: no `result.fidelity` decision, no `audit.md`, exit 0. | `src/commands.ts` `const stage` vs contracts §6.5 / SKILL §6 | lead (commands.ts) | **fixed** (lead added `auditStage`: verify, `recordResultAudit` per finished role, enforce-mode stop, report write); QA's T2b proves the behaviour and the tamper/enforce refusals |
| F3 | `picocolors` is a declared dependency, is in NOTICE and both READMEs + contracts §5 say it is used for terminal colour, but no code imported it; the panel colours via the bespoke cell renderer, so the tarball shipped an unused runtime dependency and the docs claim was false. | `package.json:41`, `NOTICE:9`, `README.md:219`, `README.zh-CN.md:208`, `docs/dev/contracts.md:128` | lead (src/commands.ts) | **fixed** (option b): `src/commands.ts` now imports `picocolors` and colours refusal/usage errors and `attest status` role states, gated by `r.outputTTY && process.stdout.isTTY`; non-TTY output stays byte-identical (verified: `printf '' | node dist/cli.js status` = plain `No open cases.
`); `npm run check` stays green and release/identity tests pass on the rebuilt package |

## 4. Requirement matrix (final acceptance)

| Requirement | Evidence | Verdict |
| --- | --- | --- |
| Functionality: case lifecycle, plan/gates, roles/worktrees/panes, send/wait/status/close/teardown, command surface, exit codes | T1, T2, T2b; `npm run check` 257/257; `npx tsc` clean; `npm pack` + tarball install smoke; `attest check examples/demo/.../plan.md` clean (4 roles) and skill template clean (3 roles) | **pass** |
| TUI/UX completeness: six pages (CASE/PLAN/FLOW/ROLES/DIFF/AUDIT), keys 1-6 + Tab, min 40x10, goldens, clicks/help/message row, zh | T4, T9; draw+panel-live 60 pass; `audit.txt` golden present; screenshots `panel-audit-en.png`, `panel-case-zh.png` show 6 tabs and real content | **pass** |
| Jev audit feature: typed Noul/Choice/Score decisions, heuristic + optional typesafe provider, shadow/enforce policy with fail-safe, hash-chained ledger, `audit verify/report/show/outcome/calibrate`, `stage audit`, panel view + calibration | T2, T2b, T3, T4; `tests/jev.node.mjs` 64/64; audit CLI tamper `BROKEN at record 1: hash mismatch`; enforce-mode stage refusal | **pass** |
| Bilingual README + real screenshots: en/zh parallel docs, PNG/SVG assets, commands documented = implemented, real panel captures | T7 pass; README/README.zh-CN/guide/guide.zh-CN/jev-audit/jev-audit.zh-CN + CONTRIBUTING/CHANGELOG/ROADMAP/SECURITY exist; same 5 screenshot set in both READMEs; real 2448x1648 panel captures incl. English AUDIT page and Chinese case page; assets/logo.svg + banner.svg | **pass** |
| Third-party library policy: mature library for commodity work, bespoke modules justified, NOTICE current | all six deps imported and used: yaml (`src/yaml.ts`), zod (`agents/state/typesafe`), execa (`run/statusline`), string-width (`canvas`), p-retry (`typesafe`), picocolors (`commands`, TTY-gated after F3); bespoke canvas/panel, log fold, ledger, decision protocol justified in contracts §5; NOTICE lists exactly the six deps | **pass** |

## 5. Transient coordination state (not findings)

- T0 resolved: the `src/run.ts` TS2322 seen while core landed the execa
  adoption is gone. After core's diff plumbing change, `tests/panel-live.node.mjs`'s
  fake git also answers `diff --numstat -z` (test-only adaptation; assertions
  unchanged).
- docs-contract false positive resolved on the QA side: commands are parsed only
  from shell lines (comments stripped) and inline code spans that start with
  `attest`, so `# ... your build of attest on the PATH` no longer counts as a
  command. Remaining T7 red is the real missing `docs/media/*.png`.

## 6. Residual risks

- Packaging install uses the workspace npm cache (`--prefer-offline`); a fresh
  CI without that cache needs registry access for the runtime deps.
- tmux integration cases skip when `tmux` is absent; this host has tmux 3.8 and
  they run. The audit/E2E cases use a scratch tmux socket and kill it afterwards.
- The panel AUDIT test seeds a ledger through the real ledger module, so a
  deliberate format change fails it by design; that is the intent.
- The heuristic provider is a deterministic approximation, not the hosted Jev
  model; calibration is only as meaningful as the recorded outcomes (documented
  in `docs/jev-audit.md`). No test claims otherwise.
- Screenshots are captured from the real panel; the docs-contract test can only
  prove PNG validity/size/parity, not visual quality.

## 7. Final full check (all owners landed)

Run after the last source/doc changes of every owner:

```
$ ./check.sh
tsc: clean
check-names: clean (184 files)
ℹ tests 257
ℹ pass 257
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
EXIT:0
```

- Release evidence: `npm pack --ignore-scripts` → `attest-0.1.0.tgz`, 161,357 B,
  57 files (46 `dist/**/*.js` modules incl. 13 Jev modules), containing `dist/cli.js`, `skills/attest-case/SKILL.md`, `NOTICE`,
  `LICENSE` (and no `src/`, `tests/`, caches or docs/dev). Installed into a
  throwaway project from the workspace cache; `npx attest --version` = `0.1.0`.
- Tamper evidence: `attest audit verify` after editing record 1 exits 1 with
  `BROKEN at record 1: hash mismatch`; `--json` gives `{ok:false,brokenAt:1,length:1}`;
  `report` exits 1 and appending an outcome is refused with
  `audit ledger is broken at record 1`. `attest stage audit` on the same ledger
  exits 1 at record 1 and does not move the stage.
- Identity evidence: repo text files, built `dist/`, tarball file list and the
  installed package contain zero occurrences of the retired project word,
  misspelling or people; `scripts/check-names.mjs` clean over 184 files.
- Focused reruns for a maintainer:
  `node --test tests/commands-integration.node.mjs` (case/audit/stage E2E),
  `node --test tests/panel-live.node.mjs` (panel + AUDIT page),
  `node --test tests/release.node.mjs` (pack/install/identity),
  `node --test tests/docs-contract.node.mjs` (docs/bilingual/screenshots),
  `node --test tests/jev.node.mjs` (Jev engine).
