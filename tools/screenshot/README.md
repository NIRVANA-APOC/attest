# The screenshot harness

This directory produces the reproducible offline panel screenshots kept under
`docs/media/` (`panel-case-en.png`, etc.); the current `README.md` /
`README.zh-CN.md` instead embed a separate **real run** with real Claude Code
and Codex sessions and hosted Jev — see `docs/media/live-*.png` and
`docs/dev/jev-live-verification.md`. The reproducible set: `docs/media/panel-case-en.png`,
`panel-plan-en.png`, `panel-roles-en.png`, `panel-audit-en.png` and
`panel-case-zh.png` (120x40 terminal cells, rendered at 2x: 2448x1648 px each).
A sixth image, `panel-audit-live-en.png`, records a **live hosted Jev** decision
and is captured separately because it needs a TypeSafe credential; see
[The live Jev capture](#the-live-jev-capture).

They are **not mockups**. The case, plan, approvals, dispatches, commits,
results, run log and audit ledger all come from the real CLI and the real
modules; every frame is captured from a live `node dist/cli.js panel` process
running in tmux with `tmux capture-pane -ep`, then rendered by `render.py`.

What is scripted is the **agents**. `demo/agent.mjs` is a small stand-in
registered through repository adapter files for the demo case, so a maintainer
without Claude Code or Codex signed in can reproduce the frames. It prints a
plausible session tail and stays alive; the harness writes each role's real
commit and result file separately.

The demo case's `audit:` block uses `provider: heuristic`, so the audit frames
show Attest's offline provider, not a hosted Jev API; no external service is
called during a capture.

## Requirements

- **tmux**, **git**, **Node.js 20+**
- Python 3.9+ with **Pillow** and **fontTools**

```sh
python3 -m venv .tools/venv
.tools/venv/bin/pip install pillow fonttools
```

Fonts, on Linux (on other systems install equivalents and set paths at the top of
`render.py`):

- `/usr/share/fonts/TTF/JetBrainsMono-Regular.ttf` and `-Bold.ttf`
- `/usr/share/fonts/noto/NotoSansSymbols2-Regular.ttf`
- `/usr/share/fonts/TTF/DejaVuSans.ttf`
- `/usr/share/fonts/noto-cjk/NotoSansCJK-Regular.ttc` (index 2 = SC)

## Run it

From the repository root, after `npm run build`:

```sh
node tools/screenshot/capture.mjs --python .tools/venv/bin/python
```

Options:

| Option | Default | Meaning |
| --- | --- | --- |
| `--cli <path>` | `<repo>/dist/cli.js` | the built CLI the frames are captured from |
| `--out <dir>` | `<repo>/docs/media` | where the PNGs are written |
| `--work <dir>` | `$TMPDIR/attest-screenshots` | scratch repository, homes and frames |
| `--python <path>` | `python3` | Python with Pillow and fontTools |
| `--plan <path>` | `examples/demo/docs/cases/<case>/plan.md` | the case plan to run |
| `--case <name>` | `storefront-search` | the case name |
| `--socket <name>` | `attest-screenshot` | tmux socket used for the run |
| `--keep` | off | keep the scratch directory and tmux server for inspection |
| `--no-audit` | off | skip the audit page (for early runs before the Jev module lands) |

The harness refuses to delete anything that is not a screenshot work directory
(it writes a marker first), uses a dedicated tmux socket, and kills that server
at the end unless `--keep` is given.

## What it does

1. Builds a scratch storefront repository and commits it.
2. Writes repository adapter files that point the built-in `claude` and `codex`
   names at the scripted `agent.mjs`, for the demo case only.
3. Runs the real `attest case new`, writes
   `examples/demo/docs/cases/storefront-search/plan.md` into the case worktree,
   and checks it with `attest check` — a failing plan stops the run.
4. Opens `attest gate plan --no-wait` and captures the **plan gate** frame.
5. Approves from the terminal, stages `build`, dispatches `search` and `theme`,
   and gives each the commit and `.attest/result.md` a real role would leave.
6. Stages `review` and dispatches the reviewer, which the panel shows waiting on
   the person; captures the **case page**, **roles page** and the **Chinese case
   page** (a separate HOME with `{"language":"zh"}` in
   `~/.config/attest/settings.json`).
7. Finishes the review, runs the real `attest stage audit` (which verifies the
   chain, records `result.fidelity` decisions and writes
   `docs/cases/<case>/audit.md`), records human outcomes, opens the `mr-ok` gate,
   and captures the **audit page** on tab 6.
8. Renders every captured ANSI frame with `render.py` into `docs/media/`.

The case is the same one as [`examples/demo`](../../examples/demo/README.md);
if that plan changes, recapture the screenshots that show it.

## The live Jev capture

`panel-audit-live-en.png` is a real AUDIT page with `provider: typesafe`,
returned by `api.typesafe.ai` (`jev-1.14.0`). It is not produced by `capture.mjs`
because it needs `ATTEST_JEV_API_KEY` and makes two billed calls. To recreate it:

```sh
# in a scratch repo with a checked case whose plan says provider: typesafe
ATTEST_JEV_API_KEY=… node dist/cli.js gate plan "Live Jev check" --no-wait -m <case>
tmux -L live-shot new-session -d -s live -x 120 -y 40 \
  "cd <repo> && LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8 node <attest>/dist/cli.js panel -m <case> --no-anim"
tmux -L live-shot send-keys -t live 6       # AUDIT tab
tmux -L live-shot capture-pane -ep -t live > frame.ansi
python3 render.py frame.ansi panel-audit-live-en.png --scale 2
```

The key is read from the environment only and never appears in the frame or the
repository. The run is recorded in `docs/dev/jev-live-verification.md`.

## Rendering

`render.py` parses the SGR sequences in a `capture-pane -ep` frame (16/256/
truecolor, bold, faint, inverse, underline), then draws one glyph per terminal
cell on the panel's paper colour. It supersamples 3x and downsamples to 2x for
crisp edges, uses JetBrains Mono for Latin, and falls back per glyph to Noto
Sans Symbols 2, DejaVu Sans and Noto Sans CJK SC (so state glyphs, effort bars,
agent badges and box drawing render as they do in a terminal). Wide characters
take two cells.

```sh
python3 tools/screenshot/render.py frame.ansi out.png --scale 2
```

Cell size is 10x20 px at scale 1; scale 2 is used for the committed images.

## Adding or changing a frame

- To change the demo content, edit `examples/demo/.../plan.md` (workflow-owned),
  `demo/repo/**` (the starting repository), `demo/work/<role>/**` (what a role
  changed) or `demo/results/<role>.md` (what a role claims).
- To add a frame, capture it in `main()` (a `panelSession(...)` and `capture(...)`
  pair), then add it to the `media` map at the end so it is rendered.
- Never edit a PNG by hand. Change the input and recapture.
- Keep the README image set identical in both languages; the docs-contract test
  checks it.

## Notes

- The screenshots show a demo case with scripted agents; the README says so.
  Do not present a scripted adapter as a real Claude Code or Codex session.
- The frames are bytes from a real terminal, so they vary slightly with the
  clock and timestamps. That is expected; the layout and content are the point.
- If a run fails, `--keep` leaves the scratch repository, the frame files and
  the tmux server (`tmux -L attest-screenshot attach`) for inspection. Kill it
  with `tmux -L attest-screenshot kill-server`.
