---
name: attest-case
description: Run a multi-step software change as a attest case, with this session as the orchestrator. You write a plan with the person, they approve it in the attest panel, and each role then works in a real tmux window of its own (Claude Code or Codex), in its own git worktree and branch, in parallel where the files allow; a reviewer role checks each branch as it lands and you merge, then open the MR after the person's yes. Use it whenever the person wants work split across several agents or windows, says "attest", "case", "run this as a case", "split this into roles", "open the roles", "dispatch", "开几个 agent 并行做", or asks to plan, approve, build, review or land a case under docs/cases/, in Claude Code or in Codex. Not for a change one session can just make, and not for changing attest itself.
---

# Case

You are the orchestrator in the person's current agent session. The person
watches the panel beside you and the roles in the `roles-<case>` window,
and can talk to any role directly. You plan, dispatch, review the results, merge,
and stop at the person's gates. You do not write the roles' code.

The `attest` CLI enforces what keeps the work correct: no role opens before
the plan, as it is now, is approved; one role is one worktree, one branch and
one pane; nothing is typed into a window that is not ready; each role's
`flags` pin its permission. When a command refuses, it says why: fix the
cause, do not retry as is or work around it. Never type into a role window
yourself (no `tmux send-keys`); use `attest send`.

You don't wait on a timer. Once you have dispatched, sent work or opened a
gate, end your turn: when a role finishes, the person answers a gate in
the panel, or the person answers a role waiting on them in its window,
attest types one line into your session (`Role api finished: done: …`,
`mr-ok approved in the panel. …`, `Role api was answered in its window and
went on working.`, `Role api was stopped in its window: …`) after your current turn ends, and you continue from it. It knows your session from the attest commands
you run, so run them from this session. Never `sleep` to wait.
`attest gate --no-wait` opens a gate without blocking; `attest wait` is
for when you need an answer within the same turn.

How far to read, how to split, what to ask and how long your messages are
is your judgment; the steps below are the order things happen in.

## 1. Brief

Run `attest open --planning` first, in the foreground (harmless if already
open; never `attest up`, which starts a second orchestrator); pass its attach line to the
person when it gives one.

Find out what the person wants, why, what counts as done, and what is out of
scope. Read the code it touches. A question the code cannot answer becomes a
decision in the plan, with your recommendation; ask now only what blocks the
plan itself.

The plan is shown in the panel, not in the chat. Do not lay out an approach,
a role split or open decisions in the chat and ask whether to write them up,
even when the person asks what you think: write them into the plan and let
the panel show it. The chat carries only a blocking question, or a few lines
at the gate.

## 2. Plan

Run `attest case new <case>` (add `--base <ref>` when the case
should not start from the checkout's current branch). It creates the
case's own worktree on branch `case/<case>`, prints its path, and
writes the plan template to `docs/cases/<case>/plan.md` there with
`base:` already set to the case branch: each role's worktree is cut from
it at dispatch, so a role sees what you merged before it. It also binds this
session's pane to the case, so the commands below act on it without `-m`,
and other cases in the same repository can run beside it. The person's
checkout stays on its branch. Fill in the plan in the case worktree, by
its full path. When its output names the language the person reads, write
in it as it says; if the person switches the panel's language later, attest
tells you in a line.

- **A role is a window.** Name roles for what they do (`api`, `web`,
  `review`). Split by coupling, not by file: files that change together go
  to one role, and a hub file (shared types, config, a registry) is touched
  by one role only. Where two roles would share a file, first try to remove
  the sharing (split the file); only then order them with `depends_on`.
  Fewer, fuller roles beat many thin ones: each is a window the person
  watches.
- **Each role says who runs it**: `agent` (`claude`, `codex`, or an adapter
  in `.attest/agents/`), `model`, `effort`, and `flags`, which must pin its
  permission (Claude Code: `--permission-mode acceptEdits`; Codex:
  `-a on-request -s workspace-write`). Propose; the person decides at the
  gate. Propose a bypass mode only when the person asks for one.
  For Codex `workspace-write`, dispatch adds `--add-dir` for its Git index,
  shared objects and the case's refs/reflogs. This permits commits, not
  writes to the main branch; roles still share the case refs and objects.
- **Each role's text** is its `## Role: <name>` section: what to do, what
  not to change, how to prove it works. Builders also take
  `text: workflow:builder`.
- **One reviewer role by default**: `touches: []`, `reviews: [...]`,
  `text: workflow:reviewer`, on a different model from the builders where the
  person agrees. It reviews each branch as it lands.
- A change to how something looks needs a done-when criterion that the
  person has seen and approved it.
- **The top of the plan is what the person reads at the gate**, and the
  panel shows each done-when item on one line. Keep the intent to a few
  sentences and each done-when item to one checkable line, what and not how,
  usually three to six of them; the how goes in the role sections.

Run `attest check` until it is clean. Commit the plan in the case
worktree (`git -C <worktree> add` and `commit`).

## 3. Gate: plan OK?

Tell the person in a few plain lines what they are approving, the decisions
with your recommendations, and who runs each role. Then run
`attest gate plan "<one line>"`. The panel shows the plan gate: `a` approves
(and takes your recommendations), `c` sends their words back to you as
`change: <words>`, which sends you back to step 2: edit, check, commit, gate
again. Any later edit of `plan.md` or of a role text it references needs
approval again before the next dispatch.

## 4. Build

`attest stage build`, then `attest dispatch <role>` for every builder whose
`depends_on` are done; independent roles run at once, then end your turn;
each role's finish arrives as a line from attest. A role stuck on a dialog (a
permission, a question) shows in the panel as waiting on the person; tell
them which window if it stays, then end your turn: attest tells you once
they answer a Claude role there (a Codex role's answer shows only in
`attest status`). `attest status` shows every role.

When a builder's result says `done`, read `.attest/result.md` in its
worktree and check `attest status`: files changed outside its `touches`
fail it (send it back, or change the plan and get it approved again). Then
it goes to review. `blocked` or `failed`: read why, then answer it with
`attest send`, change the plan, or ask the person.

For startup readiness or before sending follow-up work, run
`attest wait --role <role> --ready --timeout 60`; a dialog or gone pane
ends the wait early so you can act on it.

## 5. Review, fix, merge

`attest stage review` once the first branch lands. Dispatch the reviewer,
then give it each branch in the order they land:
`attest send review "Review role/<case>/<role>: …"`. `attest send` puts
the role's old result aside first, so its next result is news again.

- PASS: merge the role's branch onto the case branch in the case
  worktree (`git -C <worktree> merge …`; one commit per role, subject
  `<role>: <what it does>`), then dispatch the roles that just became ready.
- Act-on findings: `attest send <builder> "<the findings, or the review
  file's path>"` to the same window, on the same branch; then review again.
  **One fix round, then you rule**: merge it, or hold it and tell the
  person why. No third review.

## 6. Gate: MR OK?

When every role is merged: `attest stage mr-ok`, then
`attest gate mr-ok "<what the MR delivers; open findings with your
recommendation>"`. Nothing is pushed before `approve`. A change sends you to
the fix loop or the plan.

## 7. Open the MR, then gate: merged?

`attest stage mr`; push the case branch (`git -C <worktree> push`) and
open one MR against the base branch, per the project's conventions. A
refused push: tell the person and stop. Then `attest stage merged` and
`attest gate merged "<the MR link>"`, and leave every role window open:
only a person merges the MR, and until they do, a change they ask for goes
to the same builder's window, then is pushed to the same MR. Opening the
MR does not finish the case.

## 8. Teardown once merged

On `approve` at `merged`: `attest stage teardown -m <case>`, then
`attest teardown -m <case>`; only then report the cleanup result.
Teardown refuses while any gate of the workflow is not approved, so it
cannot run before the merge.

Teardown removes case-owned role panes, worktrees, branches and temporary
briefs/results, and the case worktree, while keeping the case branch
(the MR head) and the log. It closes this case's panel and unbinds your
pane; your session stays open. Dirty or untracked files, unmerged commits and
an unpushed case branch refuse cleanup; resolve them before retrying, or
tell the person cleanup is blocked and ask before discarding them with
`--force`. Repeating teardown with explicit `-m` is safe.

## Telling the person

They hear from you at the gates and whenever something blocks: a
refusal you cannot fix, a role waiting on them, a role held after its fix
round, a plan change that needs approval again. Their language, short,
plain words, your recommendation. No step names or logs.
