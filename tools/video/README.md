# The 60-second demo video

`docs/media/attest-demo.mp4` is a 59.5-second, 1080p, silent, captioned cut of
the real 2026-11-15 run. Every slide is a committed capture
(`docs/media/live-*.png`) or a composed title/end card; the numbers are from the
live run log and audit ledger. Nothing in the video is a mock frame.

## What it shows

| Time | Scene |
| --- | --- |
| 0:00 | Title: a real run with Claude Code + Codex on `deepseek-flash` and hosted Jev |
| 0:04 | Plan gate: three roles, disjoint touches, plan hash approval |
| 0:11 | Parallel build: both role cards working in the real panel |
| 0:18 | Claude Code result: 18 s, 5/5 tests, commit `d47fd6b` |
| 0:24 | Codex result: 23 s, 3/3 tests, commit `c494da5` |
| 0:30 | Reviewer PASS: `done_when` 1–3, 2 m 37 s |
| 0:36 | Run log: append-only events, commits and gates |
| 0:41 | Merged diff: +31 search, +13 theme, review changes nothing |
| 0:46 | AUDIT: hosted TypeSafe, `jev-1.14.0`, 13 records, 9 decisions, Brier 0.19 |
| 0:55 | MR OK gate: no push, no MR, no merge; a person decides |
| 0:59 | End card: signals, not authorization; the repository URL |

## Rebuild

Needs `ffmpeg`, Python 3, Pillow and fontTools (the same venv used by
`tools/screenshot`):

```sh
python3 -m venv .tools/venv
.tools/venv/bin/pip install pillow fonttools
.tools/venv/bin/python tools/video/make-demo.py --work .scratch/video
```

It writes:

- `docs/media/attest-demo.mp4` — H.264, 1920×1080, 30 fps, ~22 MB
- `docs/media/attest-demo-poster.png` — the linked poster frame

The script uses `docs/media/live-plan-gate.png`, `live-build-working.png`,
`live-claude-builder.png`, `live-codex-builder.png`, `live-review.png`,
`live-log.png`, `live-diff-merged.png`, `live-audit.png` and `live-mr-gate.png`.
The source images come from the real run; no API keys are read or embedded.

## Editing

Captions, durations, callouts and the scene order are the `SCENES` list at the
bottom of `make-demo.py`. Keep the numbers in sync with `README.md` and
`docs/dev/jev-live-verification.md`. The video is intentionally silent; if you
add audio, keep a separate track and do not claim it was captured from the run.
