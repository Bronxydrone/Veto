#!/usr/bin/env python3
"""Render real command output into terminal-style PNGs.

These are not screenshots of a browser (that is impossible in this sandbox), they
are images of the actual stdout of the commands, produced so the demo post can
ship pictures without a human at a camera. The text is not edited: the renderer
only strips ANSI codes and colours lines it recognises.

Usage:
    python scripts/render_terminal.py docs/artifacts/demo.txt docs/shots/demo.png "npm run demo"
    python scripts/render_terminal.py docs/artifacts/attack.txt docs/shots/attack.png "npm run attack"
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ANSI = re.compile(r"\x1b\[[0-9;]*m")

BG = (13, 16, 23)
CHROME = (22, 27, 34)
BORDER = (48, 54, 61)
FG = (214, 222, 235)
DIM = (125, 136, 150)
GREEN = (63, 185, 127)
RED = (248, 81, 73)
AMBER = (210, 153, 34)
CYAN = (86, 182, 194)

# Tokens that are coloured wherever they appear. Uppercase chips come from the CLI
# narrative; lowercase verdicts from the attack table.
KEYWORDS = re.compile(
    r"(NEEDS APPROVAL)"
    r"|(?<![\w-])(deny|DENY|allow|ALLOW|require_approval|ok|PASS|SKIP|FAIL|verified|BROKEN|match)(?![\w-])"
)
RED_WORDS = {"deny", "DENY", "FAIL", "BROKEN"}
GREEN_WORDS = {"allow", "ALLOW", "ok", "PASS", "verified", "match"}
AMBER_WORDS = {"require_approval", "NEEDS APPROVAL", "SKIP"}


def strip_ansi(text: str) -> str:
    return ANSI.sub("", text)


def runs(line: str) -> list[tuple[str, tuple[int, int, int]]]:
    """Split a line into (text, colour) runs, preserving every character."""
    # "counterparty allow list" is a wall name, not an allow verdict.
    colour_allow = "allow list" not in line
    out: list[tuple[str, tuple[int, int, int]]] = []
    position = 0
    for match in KEYWORDS.finditer(line):
        word = match.group(0)
        colour = None
        if word in RED_WORDS:
            colour = RED
        elif word in GREEN_WORDS:
            colour = GREEN if (word.lower() != "allow" or colour_allow) else None
        elif word in AMBER_WORDS:
            colour = AMBER
        if match.start() > position:
            out.append((line[position : match.start()], FG))
        out.append((word, colour or FG))
        position = match.end()
    if position < len(line):
        out.append((line[position:], FG))
    return out or [(line, FG)]


def line_colour(line: str) -> tuple[int, int, int]:
    """Whole-line colour for lines that are not table rows (headers, notes)."""
    stripped = line.strip()
    if stripped.startswith(("DENY", "x", "FAIL")):
        return RED
    if stripped.startswith("VETO"):
        return FG
    return FG


def render(text: str, out_path: Path, title: str) -> tuple[int, int]:
    lines = strip_ansi(text).splitlines()
    if lines and lines[-1] == "":
        lines.pop()

    font_size = 26
    font = ImageFont.truetype("C:/Windows/Fonts/consola.ttf", font_size)
    bold = ImageFont.truetype("C:/Windows/Fonts/consolab.ttf", font_size)

    char_w = font.getlength("M")
    pad = 28
    chrome_h = 46
    line_h = int(font_size * 1.42)

    width = int(max(font.getlength(line) for line in lines) + pad * 2 + char_w)
    width = max(width, 900)
    height = chrome_h + len(lines) * line_h + pad

    image = Image.new("RGB", (width, height), BG)
    draw = ImageDraw.Draw(image)

    # window chrome
    draw.rectangle([0, 0, width, chrome_h], fill=CHROME)
    draw.line([0, chrome_h, width, chrome_h], fill=BORDER)
    for index, colour in enumerate([(255, 95, 86), (255, 189, 46), (39, 201, 63)]):
        cx = 24 + index * 22
        draw.ellipse([cx - 7, chrome_h // 2 - 7, cx + 7, chrome_h // 2 + 7], fill=colour)
    draw.text((100, chrome_h // 2 - font_size // 2 - 4), title, font=font, fill=DIM)

    for index, line in enumerate(lines):
        y = chrome_h + pad // 2 + index * line_h
        x = pad
        for piece, colour in runs(line):
            if colour in (GREEN, RED, AMBER):
                draw.text((x, y), piece, font=bold, fill=colour)
            else:
                draw.text((x, y), piece, font=font, fill=colour)
            x += font.getlength(piece)

    draw.rectangle([0, 0, width - 1, height - 1], outline=BORDER)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    image.save(out_path, "PNG")
    return width, height


def read_text_auto(path: Path) -> str:
    """PowerShell redirection writes UTF-16LE on Windows, so sniff the BOM."""
    raw = path.read_bytes()
    if raw.startswith((b"\xff\xfe", b"\xfe\xff")):
        return raw.decode("utf-16").lstrip("\ufeff")
    return raw.decode("utf-8-sig", errors="replace")


if __name__ == "__main__":
    if len(sys.argv) != 4:
        print(__doc__)
        raise SystemExit(2)
    source, target, window_title = Path(sys.argv[1]), Path(sys.argv[2]), sys.argv[3]
    size = render(read_text_auto(source), target, window_title)
    print(f"wrote {target} ({size[0]}x{size[1]})")
