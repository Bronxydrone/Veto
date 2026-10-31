#!/usr/bin/env python3
"""Compose the slides for the demo video from the already-rendered artefacts.

Each slide is a 1600x1000 card: a header strip with a step number and a claim, the
real command output below it (unmodified), and a footer with the project line. The
images come from `docs/shots/*.png`, so nothing here can invent a number.

The slides are then encoded by `scripts/make_demo_video.ps1` with ffmpeg.
"""
from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

W, H = 1600, 1000
BG = (13, 16, 23)
PANEL = (18, 22, 30)
BORDER = (48, 54, 61)
FG = (230, 237, 243)
DIM = (139, 148, 158)
GREEN = (63, 185, 127)
RED = (248, 81, 73)
AMBER = (210, 153, 34)

FONT_DIR = "C:/Windows/Fonts"
TITLE = ImageFont.truetype(f"{FONT_DIR}/segoeuib.ttf", 44)
SUB = ImageFont.truetype(f"{FONT_DIR}/segoeui.ttf", 26)
MONO = ImageFont.truetype(f"{FONT_DIR}/consola.ttf", 22)
FOOT = ImageFont.truetype(f"{FONT_DIR}/segoeui.ttf", 20)

SLIDES = [
    (
        "Veto",
        "A spending firewall for AI agent wallets on NEAR",
        "agents can spend, they just cannot spend everything",
        None,
        GREEN,
    ),
    (
        "1. The product, in five decisions",
        "one payment allowed · three refused · one escalated to the owner",
        "npm run mvp",
        "mvp.png",
        FG,
    ),
    (
        "2. The policy decides before the money moves",
        "allow · deny · human approval · every reason recorded",
        "npm run demo",
        "demo.png",
        FG,
    ),
    (
        "3. 29 ways to escape, 26 refused",
        "per-tx caps, allow lists, slippage, redirected quotes, key changes",
        "npm run attack",
        "attack.png",
        FG,
    ),
    (
        "4. The walls are on-chain, not in the agent",
        "the agent's only key can call spend(); the contract recomputes the limits",
        "node scripts/testnet-demo.ts",
        "testnet.png",
        FG,
    ),
    (
        "5. Every refusal says why, on-chain too",
        "28/28 conformance checks against the deployed contract, incl. the kill switch",
        "npm run chain:conformance",
        "conformance.png",
        FG,
    ),
    (
        "Veto",
        "policy firewall for AI agents · NEAR HACKATHON",
        "github.com/Bronxydrone/veto",
        None,
        GREEN,
    ),
]


def contain(image: Image.Image, box_w: int, box_h: int) -> Image.Image:
    ratio = min(box_w / image.width, box_h / image.height)
    size = (max(1, int(image.width * ratio)), max(1, int(image.height * ratio)))
    return image.resize(size, Image.LANCZOS)


def make_slide(index: int, title: str, subtitle: str, footer: str, image_name: str | None, accent) -> Image.Image:
    image = Image.new("RGB", (W, H), BG)
    draw = ImageDraw.Draw(image)

    # header
    draw.rectangle([0, 0, W, 132], fill=PANEL)
    draw.line([0, 132, W, 132], fill=BORDER)
    draw.rectangle([0, 0, 6, 132], fill=accent)
    draw.text((44, 28), title, font=TITLE, fill=FG)
    draw.text((46, 86), subtitle, font=SUB, fill=DIM)

    # body
    if image_name:
        shot = Image.open(Path("docs/shots") / image_name).convert("RGB")
        body = contain(shot, W - 120, H - 132 - 150)
        x = (W - body.width) // 2
        y = 132 + 34
        image.paste(body, (x, y))
        draw.rectangle([x - 1, y - 1, x + body.width, y + body.height], outline=BORDER)
    else:
        draw.text((46, 132 + 120), "policy as data  ·  enforced on-chain  ·  audit chain", font=SUB, fill=accent)

    # footer
    draw.line([0, H - 62, W, H - 62], fill=BORDER)
    draw.text((44, H - 44), footer, font=FOOT, fill=DIM)
    draw.text((W - 200, H - 44), f"{index + 1}/{len(SLIDES)}", font=FOOT, fill=DIM)
    return image


def main() -> None:
    out = Path("docs/shots/video")
    out.mkdir(parents=True, exist_ok=True)
    for index, (title, subtitle, footer, image_name, accent) in enumerate(SLIDES):
        slide = make_slide(index, title, subtitle, footer, image_name, accent)
        target = out / f"slide{index:02d}.png"
        slide.save(target, "PNG")
        print("wrote", target)


if __name__ == "__main__":
    main()
