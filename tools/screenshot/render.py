#!/usr/bin/env python3
"""Render one real tmux frame to a PNG for the Attest docs.

Input: a file captured with `tmux capture-pane -ep -t <pane>` from a running
`node dist/cli.js panel` process, so it carries the panel's own ANSI SGR
(truecolor) output. Output: a PNG on the panel's paper colour, one glyph per
terminal cell, 10x20 px per cell at scale 1 (20x40 at the default scale 2).

Glyphs are drawn with JetBrains Mono, and per character fall back to Noto Sans
Symbols 2, DejaVu Sans and Noto Sans CJK SC when JetBrains Mono lacks them, so
state glyphs, effort bars and agent badges render as they do in a terminal.
Wide characters take two cells.

Usage:
  python render.py frame.ansi out.png [--scale 2] [--trim]

Maintainers need Python 3.9+ with Pillow and fontTools:
  python3 -m venv .tools/venv
  .tools/venv/bin/pip install pillow fonttools
"""
from __future__ import annotations

import argparse
import re
import sys
import unicodedata
from pathlib import Path

try:
    from PIL import Image, ImageDraw, ImageFont
except ImportError:  # pragma: no cover - a clear message beats a traceback
    sys.exit("render.py needs Pillow: python3 -m venv .tools/venv && .tools/venv/bin/pip install pillow fonttools")

try:
    from fontTools.ttLib import TTCollection, TTFont
except ImportError:  # pragma: no cover
    TTCollection = TTFont = None

PAPER = (21, 24, 33)          # the panel's paper, src/canvas.ts PAPER
DEFAULT_FG = (232, 234, 240)  # src/canvas.ts TONES.bright

FONT_DIRS = {
    "mono": ("/usr/share/fonts/TTF/JetBrainsMono-Regular.ttf", 0),
    "mono-bold": ("/usr/share/fonts/TTF/JetBrainsMono-Bold.ttf", 0),
    "symbols": ("/usr/share/fonts/noto/NotoSansSymbols2-Regular.ttf", 0),
    "dejavu": ("/usr/share/fonts/TTF/DejaVuSans.ttf", 0),
    "cjk": ("/usr/share/fonts/noto-cjk/NotoSansCJK-Regular.ttc", 2),  # index 2 is SC
}

# Cell geometry: the panel draws a 120x40 grid of 10x20 px cells at scale 1.
CELL_W, CELL_H = 10, 20
# Draw this many pixels per final pixel, then downsample: crisp edges without
# fractional font sizes. JetBrains Mono's advance is 0.6 em, so the Latin font
# size is cell width / 0.6 and one glyph exactly fills one cell.
SUPERSAMPLE = 3


def _cmap(path: str, index: int) -> set[int]:
    if TTFont is None:
        return set()
    font = TTCollection(path).fonts[index] if path.endswith(".ttc") else TTFont(path)
    return set(font.getBestCmap())


def coverage() -> dict[str, set[int]]:
    out: dict[str, set[int]] = {}
    for name, (path, index) in FONT_DIRS.items():
        try:
            out[name] = _cmap(path, index)
        except Exception as error:  # a missing font must fail loudly
            sys.exit(f"render.py: cannot read font {path}: {error}")
    return out


COVER = coverage()


def is_wide(ch: str) -> bool:
    return unicodedata.east_asian_width(ch) in "WF"


def cells_of(text: str) -> list[tuple[str, int]]:
    """[(cluster, width)] with combining marks attached to the cell before them."""
    out: list[list] = []
    for ch in text:
        if unicodedata.combining(ch) and out:
            out[-1][0] += ch
            continue
        out.append([ch, 2 if is_wide(ch) else 1])
    return [(ch, width) for ch, width in out]


def xterm(n: int) -> tuple[int, int, int]:
    base = [
        (0, 0, 0), (128, 0, 0), (0, 128, 0), (128, 128, 0), (0, 0, 128), (128, 0, 128),
        (0, 128, 128), (192, 192, 192), (128, 128, 128), (255, 0, 0), (0, 255, 0),
        (255, 255, 0), (0, 0, 255), (255, 0, 255), (0, 255, 255), (255, 255, 255),
    ]
    if n < 16:
        return base[n]
    if n < 232:
        n -= 16
        r, g, b = n // 36, (n % 36) // 6, n % 6
        return (55 + r * 40, 55 + g * 40, 55 + b * 40)
    v = 8 + (n - 232) * 10
    return (v, v, v)


SGR = re.compile(r"\x1b\[([0-9;:]*)m")
CSI = re.compile(r"\x1b\[[0-9;?]*[A-Za-z]")


class Style:
    __slots__ = ("fg", "bg", "bold", "faint", "italic", "underline", "inverse")

    def __init__(self) -> None:
        self.reset()

    def reset(self) -> None:
        self.fg = None
        self.bg = None
        self.bold = False
        self.faint = False
        self.italic = False
        self.underline = False
        self.inverse = False

    def copy(self) -> "Style":
        other = Style()
        for slot in self.__slots__:
            setattr(other, slot, getattr(self, slot))
        return other


def apply_sgr(style: Style, params: str) -> None:
    parts = [p for p in params.replace(":", ";").split(";") if p != ""] or ["0"]
    i = 0
    while i < len(parts):
        p = parts[i]
        try:
            n = int(p)
        except ValueError:
            i += 1
            continue
        if n == 0:
            style.reset()
        elif n == 1:
            style.bold = True
        elif n == 2:
            style.faint = True
        elif n == 3:
            style.italic = True
        elif n == 4:
            style.underline = True
        elif n == 7:
            style.inverse = True
        elif n in (21, 22):
            style.bold = False
            style.faint = False
        elif n == 23:
            style.italic = False
        elif n == 24:
            style.underline = False
        elif n == 27:
            style.inverse = False
        elif n == 39:
            style.fg = None
        elif n == 49:
            style.bg = None
        elif 30 <= n <= 37:
            style.fg = xterm(n - 30)
        elif 90 <= n <= 97:
            style.fg = xterm(n - 90 + 8)
        elif 40 <= n <= 47:
            style.bg = xterm(n - 40)
        elif 100 <= n <= 107:
            style.bg = xterm(n - 100 + 8)
        elif n in (38, 48):
            target = "fg" if n == 38 else "bg"
            if i + 1 < len(parts) and parts[i + 1] == "2" and i + 4 < len(parts):
                try:
                    setattr(style, target, (int(parts[i + 2]), int(parts[i + 3]), int(parts[i + 4])))
                except ValueError:
                    pass
                i += 4
            elif i + 1 < len(parts) and parts[i + 1] == "5" and i + 2 < len(parts):
                try:
                    setattr(style, target, xterm(int(parts[i + 2])))
                except ValueError:
                    pass
                i += 2
        i += 1


Cell = tuple[str, int, Style]  # cluster, width, style


def parse(text: str) -> list[list[Cell]]:
    rows: list[list[Cell]] = [[]]
    style = Style()
    i = 0
    while i < len(text):
        match = SGR.match(text, i)
        if match:
            apply_sgr(style, match.group(1))
            i = match.end()
            continue
        if text[i] == "\x1b":
            skip = CSI.match(text, i)
            i = skip.end() if skip else i + 1
            continue
        ch = text[i]
        if ch == "\r":
            i += 1
            continue
        if ch == "\n":
            rows.append([])
            i += 1
            continue
        if ch == "\t":
            rows[-1].append((" ", 1, style.copy()))
            i += 1
            continue
        for cluster, width in cells_of(ch):
            rows[-1].append((cluster, width, style.copy()))
        i += 1
    while rows and not rows[-1]:
        rows.pop()
    while rows and all(cell[0] == " " and cell[2].bg is None for cell in rows[-1]):
        rows.pop()
    return rows


def width_of(row: list[Cell]) -> int:
    return sum(cell[1] for cell in row)


def blend(a: tuple[int, int, int], b: tuple[int, int, int], t: float) -> tuple[int, int, int]:
    return tuple(int(round(x + (y - x) * t)) for x, y in zip(a, b))  # type: ignore[return-value]


class Painter:
    def __init__(self, scale: int) -> None:
        self.scale = scale
        self.unit = SUPERSAMPLE
        self.cell_w = CELL_W * scale * self.unit
        self.cell_h = CELL_H * scale * self.unit
        self.latin = round(self.cell_w / 0.6)
        self.cjk = self.cell_w * 2
        self._fonts: dict[tuple[str, int], ImageFont.FreeTypeFont] = {}
        self._fit: dict[tuple[str, str], tuple[ImageFont.FreeTypeFont, bool]] = {}
        mono = self.font("mono", self.latin)
        ascent, descent = mono.getmetrics()
        self.baseline = (self.cell_h + ascent - descent) // 2

    def font(self, name: str, size: int) -> ImageFont.FreeTypeFont:
        key = (name, size)
        if key not in self._fonts:
            path, index = FONT_DIRS[name]
            self._fonts[key] = ImageFont.truetype(path, size, index=index)
        return self._fonts[key]

    def glyph_font(self, cluster: str) -> tuple[ImageFont.FreeTypeFont, bool]:
        """The font for one cluster, and whether it is a wide (two-cell) glyph."""
        if is_wide(cluster[0]):
            return self.font("cjk", self.cjk), True
        cp = ord(cluster[0])
        if cp in COVER["mono"]:
            return self.font("mono", self.latin), False
        name = "symbols" if cp in COVER["symbols"] else "dejavu" if cp in COVER["dejavu"] else "cjk" if cp in COVER["cjk"] else "mono"
        if name == "mono":
            return self.font("mono", self.latin), False
        key = (name, cluster)
        if key in self._fit:
            return self._fit[key]
        # A symbol that does not come from the cell-designed mono font is
        # scaled down until its ink fits one cell, so boxes and badges do not
        # bleed into their neighbours.
        probe = self.font(name, self.latin)
        bbox = probe.getbbox(cluster)
        font = probe
        if bbox:
            width, height = bbox[2] - bbox[0], bbox[3] - bbox[1]
            factor = min(1.0, (self.cell_w * 0.92) / max(1, width), (self.cell_h * 0.74) / max(1, height))
            font = self.font(name, max(8, round(probe.size * factor)))
        self._fit[key] = (font, False)
        return font, False

    def render(self, rows: list[list[Cell]]) -> Image.Image:
        cols = max((width_of(row) for row in rows), default=1)
        pad = 12 * self.scale * self.unit
        img = Image.new("RGB", (cols * self.cell_w + pad * 2, len(rows) * self.cell_h + pad * 2), PAPER)
        draw = ImageDraw.Draw(img)
        # Backgrounds first, so a background run never covers the glyphs beside it.
        for r, row in enumerate(rows):
            x = 0
            for _, width, style in row:
                bg = style.bg
                if bg is not None:
                    if style.inverse:
                        bg = style.fg or DEFAULT_FG
                    draw.rectangle(
                        [pad + x * self.cell_w, pad + r * self.cell_h,
                         pad + (x + width) * self.cell_w - 1, pad + (r + 1) * self.cell_h - 1],
                        fill=bg,
                    )
                x += width
        for r, row in enumerate(rows):
            x = 0
            for cluster, width, style in row:
                if cluster.strip() == "":
                    x += width
                    continue
                fg = style.fg or DEFAULT_FG
                if style.inverse:
                    fg = style.bg or PAPER
                if style.faint:
                    fg = blend(fg, PAPER, 0.5)
                font, wide = self.glyph_font(cluster)
                mono = self.font("mono", self.latin)
                if style.bold and font is mono:
                    font = self.font("mono-bold", self.latin)
                colour = tuple(fg)
                stroke = max(1, self.unit // 2) if style.bold and font is not mono and not wide else 0
                draw.text(
                    (pad + x * self.cell_w, pad + r * self.cell_h + self.baseline),
                    cluster,
                    font=font,
                    fill=colour,
                    anchor="ls",
                    stroke_width=stroke,
                    stroke_fill=colour,
                )
                if style.underline:
                    y = pad + r * self.cell_h + self.baseline + 2
                    draw.line([(pad + x * self.cell_w, y), (pad + (x + width) * self.cell_w - 1, y)], fill=colour)
                x += width
        if self.unit > 1:
            img = img.resize((img.width // self.unit, img.height // self.unit), Image.LANCZOS)
        return img


def main() -> None:
    ap = argparse.ArgumentParser(description="Render a tmux frame (ANSI) to a PNG.")
    ap.add_argument("frame", type=Path, help="file captured with tmux capture-pane -ep")
    ap.add_argument("out", type=Path, help="PNG to write")
    ap.add_argument("--scale", type=int, default=2, help="pixels per cell, 10x20 at scale 1 (default 2)")
    ap.add_argument("--trim", action="store_true", help="drop trailing blank rows (always on)")
    args = ap.parse_args()
    if not args.frame.is_file():
        sys.exit(f"render.py: no such frame: {args.frame}")
    rows = parse(args.frame.read_text(encoding="utf-8", errors="replace"))
    if not rows:
        sys.exit(f"render.py: {args.frame} is empty")
    painter = Painter(args.scale)
    img = painter.render(rows)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    img.save(args.out, optimize=True)
    cols = max(width_of(row) for row in rows)
    print(f"{args.out}: {img.width}x{img.height} ({cols}x{len(rows)} cells, scale {args.scale})")


if __name__ == "__main__":
    main()
