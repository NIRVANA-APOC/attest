#!/usr/bin/env python3
"""Compose the 60-second Attest live-run demo from the committed real captures.

Every slide is built from a real screenshot in docs/media/live-*.png and the
numbers recorded in the live run log/ledger. No mock frame is drawn; the video
only adds captions, layout, fades and a slow push-in.

    python3 tools/video/make-demo.py --python .tools/venv/bin/python
    # writes docs/media/attest-demo.mp4 and docs/media/attest-demo-poster.png

Needs ffmpeg and Pillow + fontTools (the same venv tools/screenshot uses).
"""
import argparse
import json
import shutil
import subprocess
import tempfile
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = Path(__file__).resolve().parents[2]
MEDIA = ROOT / "docs" / "media"
W, H, FPS = 1920, 1080, 30
PAPER = (8, 10, 15)
PANEL = (14, 18, 26)
INK = (235, 238, 245)
MUTED = (148, 158, 175)
FAINT = (94, 105, 124)
LINE = (32, 40, 55)
ACCENT = (111, 168, 255)
GREEN = (152, 195, 121)
YELLOW = (229, 192, 123)
CORAL = (242, 155, 122)

INTER = "/usr/share/fonts/inter/Inter.ttc"
MONO = "/usr/share/fonts/TTF/JetBrainsMono-Regular.ttf"
MONO_BOLD = "/usr/share/fonts/TTF/JetBrainsMono-Bold.ttf"


def font(path, size, index=0):
    return ImageFont.truetype(path, size, index=index)


REG = font(INTER, 22, 0)
MED = font(INTER, 22, 10)
BOLD = font(INTER, 34, 14)
HEAD = font(INTER, 40, 14)
TITLE = font(INTER, 128, 14)
SUB = font(INTER, 22, 0)
SMALL = font(INTER, 18, 0)
TINY = font(INTER, 15, 0)
MONO18 = font(MONO, 18)
MONO15 = font(MONO, 15)
MONO13 = font(MONO, 13)


def text(draw, xy, value, f, fill=INK, anchor=None):
    draw.text(xy, value, font=f, fill=fill, anchor=anchor)


def wrap(draw, value, f, width):
    words = value.split()
    lines, line = [], ""
    for word in words:
        candidate = f"{line} {word}".strip()
        if draw.textlength(candidate, font=f) <= width:
            line = candidate
        else:
            if line:
                lines.append(line)
            line = word
    if line:
        lines.append(line)
    return lines


def background():
    img = Image.new("RGB", (W, H), PAPER)
    d = ImageDraw.Draw(img)
    for y in range(H):
        t = y / (H - 1)
        colour = (int(8 + 5 * t), int(10 + 7 * t), int(15 + 10 * t))
        d.line([(0, y), (W, y)], fill=colour)
    glow = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    g = ImageDraw.Draw(glow)
    g.ellipse((-420, -520, 1000, 620), fill=(58, 112, 210, 34))
    g.ellipse((1200, 500, 2300, 1400), fill=(22, 92, 74, 22))
    glow = glow.filter(ImageFilter.GaussianBlur(140))
    img = Image.alpha_composite(img.convert("RGBA"), glow).convert("RGB")
    d = ImageDraw.Draw(img)
    for x in range(0, W, 48):
        d.line([(x, 0), (x, H)], fill=(16, 21, 30), width=1)
    for y in range(0, H, 48):
        d.line([(0, y), (W, y)], fill=(16, 21, 30), width=1)
    return img


def rounded(img, radius=16):
    mask = Image.new("L", img.size, 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, img.width - 1, img.height - 1), radius=radius, fill=255)
    out = img.convert("RGBA")
    out.putalpha(mask)
    return out


def screenshot(path, box):
    x, y, width, height = box
    src = Image.open(path).convert("RGB")
    scale = min(width / src.width, height / src.height)
    size = (round(src.width * scale), round(src.height * scale))
    shot = rounded(src.resize(size, Image.LANCZOS), 14)
    sx = x + (width - size[0]) // 2
    sy = y + (height - size[1]) // 2
    shadow = Image.new("RGBA", (size[0] + 80, size[1] + 80), (0, 0, 0, 0))
    ImageDraw.Draw(shadow).rounded_rectangle((40, 40, 40 + size[0], 40 + size[1]), radius=18, fill=(0, 0, 0, 160))
    shadow = shadow.filter(ImageFilter.GaussianBlur(24))
    return shot, (sx, sy), shadow, (sx - 40, sy - 40 + 10)


def chrome(img, step, total, top_left="ATTEST", top_right="2026-11-15 · LIVE RUN"):
    d = ImageDraw.Draw(img)
    text(d, (72, 34), top_left, font(INTER, 24, 16), INK)
    text(d, (72 + d.textlength(top_left, font=font(INTER, 24, 16)) + 14, 39), "LIVE RUN", MONO15, FAINT)
    text(d, (W - 72, 40), top_right, MONO15, FAINT, anchor="ra")
    if step is not None:
        text(d, (W - 72, 68), f"{step:02d} / {total:02d}", MONO13, ACCENT, anchor="ra")
    d.line([(72, 82), (W - 72, 82)], fill=LINE, width=1)


def callout(img, title, notes):
    x, y, width, height = 1352, 106, 496, 842
    layer = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    d.rounded_rectangle((0, 0, width - 1, height - 1), radius=16, fill=(12, 16, 23, 255), outline=(28, 36, 50, 255), width=1)
    d.rectangle((0, 0, 3, height - 1), fill=ACCENT)
    text(d, (28, 28), "AT A GLANCE", MONO13, FAINT)
    text(d, (28, 56), title, font(INTER, 26, 14), INK)
    y2 = 116
    for note in notes:
        d.ellipse((31, y2 + 8, 39, y2 + 16), fill=ACCENT)
        for line in wrap(d, note, font(INTER, 20, 0), width - 70):
            text(d, (52, y2), line, font(INTER, 20, 0), MUTED)
            y2 += 27
        y2 += 18
    img.alpha_composite(layer, (x, y))


def caption(img, step, title, subtitle, accent=ACCENT):
    d = ImageDraw.Draw(img)
    y = 968
    d.rectangle((72, y + 4, 76, y + 96), fill=accent)
    text(d, (96, y), step, MONO15, accent)
    text(d, (96, y + 26), title, font(INTER, 34, 14), INK)
    text(d, (96, y + 78), subtitle, font(INTER, 19, 0), MUTED)
    text(d, (W - 72, H - 34), "github.com/NIRVANA-APOC/Attest", MONO13, FAINT, anchor="ra")
    # Progress rail: a thin segment per chapter keeps the time visible.
    d.line([(72, H - 18), (W - 72, H - 18)], fill=(25, 31, 42), width=3)


def note_panel(img):
    d = ImageDraw.Draw(img)
    d.rounded_rectangle((72, 106, 1296, 948), radius=18, outline=(30, 38, 52), width=1)


def slide(img, meta):
    base = background().convert('RGBA')
    chrome(base, meta.get("step"), meta.get("total"), top_right=meta.get("top_right", "2026-11-15 · LIVE RUN"))
    if meta.get("shot"):
        note_panel(base)
        shot, pos, shadow, spos = screenshot(meta["shot"], (72, 106, 1224, 842))
        base.alpha_composite(shadow, spos)
        base.alpha_composite(shot, pos)
    if meta.get("notes"):
        callout(base, meta.get("callout", "THE RUN"), meta["notes"])
    caption(base, meta.get("chapter", ""), meta.get("title", ""), meta.get("subtitle", ""), meta.get("accent", ACCENT))
    return base.convert('RGB')


def intro():
    img = background()
    d = ImageDraw.Draw(img)
    chrome(img, None, None, top_right="REAL RUN · 2026-11-15")
    text(d, (W // 2, 300), "Attest", TITLE, INK, anchor="mm")
    text(d, (W // 2, 420), "A real 60-second run", font(INTER, 44, 12), INK, anchor="mm")
    text(d, (W // 2, 480), "Claude Code + Codex · deepseek-flash · hosted Jev", font(INTER, 24, 0), MUTED, anchor="mm")
    badges = [
        ("2 real builders", GREEN),
        ("1 real reviewer", YELLOW),
        ("13 ledger records", ACCENT),
        ("9 Jev decisions", CORAL),
    ]
    x = 360
    for label, colour in badges:
        width = int(d.textlength(label, font=font(INTER, 18, 12))) + 40
        d.rounded_rectangle((x, 590, x + width, 638), radius=24, fill=(15, 20, 29), outline=colour, width=1)
        text(d, (x + 20, 603), label, font(INTER, 18, 12), colour)
        x += width + 18
    text(d, (W // 2, 760), "2026-11-15 · 20:09–20:13 Asia/Shanghai", MONO15, FAINT, anchor="mm")
    text(d, (W // 2, 810), "Real terminal panes. Real commits. Real TypeSafe calls.", font(INTER, 20, 0), MUTED, anchor="mm")
    return img


def end_card():
    img = background()
    d = ImageDraw.Draw(img)
    chrome(img, None, None, top_right="ATTEST 0.1.0")
    text(d, (W // 2, 360), "Signals, not authorization.", font(INTER, 58, 14), INK, anchor="mm")
    text(d, (W // 2, 450), "The evidence is in the repo.", font(INTER, 28, 0), MUTED, anchor="mm")
    url = "github.com/NIRVANA-APOC/Attest"
    width = int(d.textlength(url, font=MONO_BOLD and font(MONO_BOLD, 30))) + 72
    d.rounded_rectangle((W // 2 - width // 2, 530, W // 2 + width // 2, 600), radius=14, fill=(15, 20, 29), outline=ACCENT, width=1)
    text(d, (W // 2, 565), url, font(MONO_BOLD, 30), ACCENT, anchor="mm")
    text(d, (W // 2, 690), "README · 9 live screenshots · audit ledger · user guide", font(INTER, 21, 0), MUTED, anchor="mm")
    text(d, (W // 2, 740), "Claude Code 2.1.325 · Codex 0.169.0 · deepseek-flash · jev-1.14.0", font(INTER, 18, 0), FAINT, anchor="mm")
    return img


SCENES = [
    {"key": "intro", "duration": 4.0, "image": intro},
    {"key": "plan", "duration": 7.5, "step": 1, "shot": "live-plan-gate.png", "accent": ACCENT,
     "chapter": "01 / PLAN GATE", "title": "A person approves the plan — not the agents.",
     "subtitle": "Goal, done-when, role split, touches; approval binds the plan hash.",
     "callout": "THE PLAN", "notes": ["3 roles · 3 windows", "Claude ×2 · Codex ×1", "touches don’t overlap", "plan hash recorded"]},
    {"key": "build", "duration": 6.5, "step": 2, "shot": "live-build-working.png", "accent": GREEN,
     "chapter": "02 / PARALLEL BUILD", "title": "Two real agents, two worktrees, one panel.",
     "subtitle": "Independent roles start at once; each has a branch, pane and result file.",
     "callout": "THE BUILD", "notes": ["search → Claude Code", "theme → Codex", "both on deepseek-flash", "working in parallel"]},
    {"key": "claude", "duration": 6.0, "step": 3, "shot": "live-claude-builder.png", "accent": CORAL,
     "chapter": "03 / CLAUDE CODE", "title": "search: filterItems + tests.",
     "subtitle": "Read the brief, wrote src/search.js + tests, ran the suite, committed, stopped.",
     "callout": "REAL RESULT", "notes": ["18 seconds", "npm test 5/5", "commit d47fd6b", "status: done"]},
    {"key": "codex", "duration": 6.0, "step": 4, "shot": "live-codex-builder.png", "accent": ACCENT,
     "chapter": "04 / CODEX", "title": "theme: resolveTheme + tests.",
     "subtitle": "Same brief protocol, different harness: src/theme.js + tests, commit, result file.",
     "callout": "REAL RESULT", "notes": ["23 seconds", "npm test 3/3", "commit c494da5", "status: done"]},
    {"key": "review", "duration": 6.0, "step": 5, "shot": "live-review.png", "accent": YELLOW,
     "chapter": "05 / REVIEW", "title": "A second real agent checks both branches.",
     "subtitle": "It runs both branches and the combined tree, then writes evidence — no code changes.",
     "callout": "THE VERDICT", "notes": ["PASS", "done_when 1–3", "2m37s", "files match touches"]},
    {"key": "log", "duration": 5.0, "step": 6, "shot": "live-log.png", "accent": MUTED,
     "chapter": "06 / RUN LOG", "title": "Every step leaves a record.",
     "subtitle": "The LOG page reads the append-only run log; the audit ledger lives beside it.",
     "callout": "THE LOG", "notes": ["5 events", "2 commits", "gate + dispatches", "JSONL, append-only"]},
    {"key": "diff", "duration": 5.0, "step": 7, "shot": "live-diff-merged.png", "accent": GREEN,
     "chapter": "07 / MERGE", "title": "Only reviewed branches reach the case branch.",
     "subtitle": "The diff is read from the branches; nothing is copied from a transcript.",
     "callout": "THE DIFF", "notes": ["search +31 lines", "theme +13 lines", "review: no changes", "one merge per role"]},
    {"key": "audit", "duration": 9.0, "step": 8, "shot": "live-audit.png", "accent": CORAL,
     "chapter": "08 / JEV AUDIT", "title": "The orchestration audits itself.",
     "subtitle": "Plan risk, role boundaries, result fidelity and merge risk — hash-chained.",
     "callout": "HOSTED JEV", "notes": ["TypeSafe · jev-1.14.0", "13 records · 9 decisions", "2 outcomes · Brier 0.19", "role.boundary 0.78 high", "shadow: recorded, not enforced"]},
    {"key": "mr", "duration": 5.0, "step": 9, "shot": "live-mr-gate.png", "accent": YELLOW,
     "chapter": "09 / MR OK", "title": "The CLI stops at the gate.",
     "subtitle": "The audit verdict is in the question; a person's approval is the only next step.",
     "callout": "THE GATE", "notes": ["no push", "no MR", "no merge", "a person decides"]},
    {"key": "end", "duration": 4.5, "image": end_card},
]


def make_scenes(out):
    total = sum(s["duration"] for s in SCENES)
    paths = []
    for index, meta in enumerate(SCENES):
        if "image" in meta:
            img = meta["image"]()
        else:
            img = slide(None, {**meta, "total": 9, "shot": MEDIA / meta["shot"]})
        path = out / f"{index:02d}-{meta['key']}.png"
        img.save(path)
        paths.append((path, meta["duration"], meta["key"]))
    return paths, total


def run(cmd):
    print("+", " ".join(str(x) for x in cmd))
    subprocess.run(cmd, check=True)


def make_video(scenes, out, final):
    clips = []
    for index, (path, duration, key) in enumerate(scenes):
        clip = out / f"{index:02d}-{key}.mp4"
        frames = max(2, round(duration * FPS))
        run([
            "ffmpeg", "-y", "-loop", "1", "-i", str(path),
            "-vf", f"zoompan=z='min(zoom+0.00032,1.045)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d={frames}:s={W}x{H}:fps={FPS}",
            "-t", f"{duration}", "-frames:v", str(frames), "-an",
            "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p", str(clip),
        ])
        clips.append((clip, duration))

    inputs = []
    for clip, _ in clips:
        inputs += ["-i", str(clip)]
    filters = []
    current = "[0:v]"
    offset = 0.0
    transition = 0.5
    for index in range(1, len(clips)):
        offset += clips[index - 1][1] - transition
        out_label = f"[x{index}]"
        filters.append(f"{current}[{index}:v]xfade=transition=fade:duration={transition}:offset={offset:.3f}{out_label}")
        current = out_label
    total = sum(d for _, d in clips) - transition * (len(clips) - 1)
    filters.append(f"{current}fade=t=in:st=0:d=0.6,fade=t=out:st={total - 0.9:.3f}:d=0.9[vout]")
    run([
        "ffmpeg", "-y", *inputs,
        "-filter_complex", ";".join(filters), "-map", "[vout]",
        "-c:v", "libx264", "-preset", "slow", "-crf", "20", "-pix_fmt", "yuv420p",
        "-movflags", "+faststart", "-r", str(FPS), str(final),
    ])
    return total


def poster(scene_paths, out):
    # A play badge over the audit slide makes a useful GitHub link preview.
    audit = Image.open(MEDIA / "live-audit.png").convert("RGB")
    base = background().convert('RGBA')
    d = ImageDraw.Draw(base)
    chrome(base, 8, 9, top_right="REAL RUN · 2026-11-15")
    note_panel(base)
    shot, pos, shadow, spos = screenshot(MEDIA / "live-audit.png", (72, 106, 1224, 842))
    base.alpha_composite(shadow, spos)
    base.alpha_composite(shot, pos)
    callout(base, "HOSTED JEV", ["TypeSafe · jev-1.14.0", "13 records · 9 decisions", "2 outcomes · Brier 0.19", "shadow: recorded, not enforced"])
    caption(base, "A REAL 60-SECOND RUN", "The orchestration audits itself.", "Watch the real Claude Code + Codex run →", CORAL)
    overlay = Image.new("RGBA", (W, H), (0, 0, 0, 135))
    base = Image.alpha_composite(base.convert("RGBA"), overlay)
    d = ImageDraw.Draw(base)
    cx, cy, r = W // 2, 500, 82
    d.ellipse((cx - r, cy - r, cx + r, cy + r), fill=(10, 13, 20, 235), outline=ACCENT, width=3)
    d.polygon([(cx - 22, cy - 34), (cx - 22, cy + 34), (cx + 42, cy)], fill=INK)
    text(d, (cx, cy + 112), "60 seconds · 1080p", MONO18, INK, anchor="ma")
    path = MEDIA / "attest-demo-poster.png"
    base.convert("RGB").save(path)
    print("poster", path)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--work", default=str(ROOT / ".scratch" / "video"))
    parser.add_argument("--python", default="python3", help="unused; kept for symmetry with tools/screenshot")
    args = parser.parse_args()
    work = Path(args.work)
    if work.exists():
        shutil.rmtree(work)
    scenes_dir = work / "scenes"
    scenes_dir.mkdir(parents=True)
    scenes, total = make_scenes(scenes_dir)
    print(f"{len(scenes)} scenes · {total:.1f}s before crossfades")
    final = MEDIA / "attest-demo.mp4"
    length = make_video(scenes, work, final)
    print(f"video {final} · {length:.1f}s")
    poster(scenes, work)
    probe = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration,size", "-of", "json", str(final)], capture_output=True, text=True, check=True)
    print(json.dumps(json.loads(probe.stdout), indent=2))


if __name__ == "__main__":
    main()
