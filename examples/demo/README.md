# Demo case: storefront search and dark theme

A complete, valid example of an Attest case plan, kept at the path a real
case uses in its worktree:

[`docs/cases/storefront-search/plan.md`](docs/cases/storefront-search/plan.md)

It is the sample the README screenshots are captured from, and the reference
to copy when you want to see the whole workflow without inventing a case.

## What it demonstrates

- **Four roles.** Two builders (`search` on Codex, `theme` on Claude Code), one
  reviewer on a different model, and the optional `auditor` role, which
  carries `touches: []` and `group: audit` and is dispatched only at the audit
  stage.
- **An `audit:` block.** Shadow mode with the offline `heuristic` provider, so
  the audit stage records decisions in the ledger without refusing anything;
  the questions list names the decisions the template records.
- **Five done-when criteria**, including the visual acceptance item that only
  the person can tick, and three open decisions with recommendations in the
  plan's top half.
- **A split by coupling, not by file.** The header is a hub touched by one
  role; the theme owns the token layer and the global stylesheet, so the two
  builders run in parallel without overlapping `touches`.
- **Role sections** with what each role must not change and how it proves the
  work (commands and app paths), so the reviewer and the auditor can retrace
  the evidence.

## Validate it

From the repository root:

```sh
npm run build
node dist/cli.js check examples/demo/docs/cases/storefront-search/plan.md
```

The plan is checked with the built-in `claude` and `codex` agents and must
print `clean (4 roles: search, theme, review, auditor)`. `npm test` keeps the
template clean too; this demo is a fuller, practical example.

## How the README screenshots use it

The README screenshots are real panel output, not mockups. The capture
workflow in `tools/screenshot/capture.mjs` builds a scratch repository,
creates the case with the real CLI, and copies this plan to
`docs/cases/storefront-search/plan.md` in the case worktree (it uses this
path by default). It then approves the plan gate, dispatches the roles with
the demo adapters, advances the stages and captures the panel on the case
page and the audit page. The case in the screenshots is this plan; if it
changes here, re-run the capture.

## Run it for real

The role `touches` point at a storefront layout (`storefront/src/...`); treat
it as a sketch for your repository:

1. `attest case new storefront-search` in your repository and open the panel.
2. Copy this `plan.md` over the template in the case worktree
   (`.attest/cases/storefront-search/docs/cases/storefront-search/plan.md`),
   then align `touches`, `base` and the role sections with your code.
3. `attest check`, commit the plan in the case worktree, and approve it in the
   panel.
4. Dispatch `search` and `theme`, then `review` as branches land. When both
   branches are merged, run `attest stage audit` and
   `attest audit report --write`, read the report, and optionally dispatch
   `auditor`. Record the outcome, open the MR OK gate, and let the person
   merge.

The audit stage and the auditor role are described in the workflow skill's
[`SKILL.md`](../../skills/attest-case/SKILL.md); the plan format is in
[`docs/guide.md`](../../docs/guide.md) and the
[`template`](../../skills/attest-case/templates/plan.md).
