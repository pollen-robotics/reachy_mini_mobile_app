#!/usr/bin/env python3
"""
Regenerate every platform icon from a single PNG master.

Why this exists
---------------
Tauri's `tauri icon` workflow assumes a PNG master and produces the
iOS AppIcon set, the Windows Store tiles, the Android launcher tiles,
and the desktop bundle icons (`.ico`, `.icns`). We don't use it
directly because:

  1. We want the macOS desktop variants (Dock + Finder) to ship with
     a transparent margin and rounded "squircle" corners (matching the
     Apple HIG template). Tauri renders flush squares.
  2. We want a single, version-controlled source (`reachy-app-icon.png`)
     to drive every output, so design tweaks land in one place.

For every other platform the icon is just the master resized into the
target's dimensions, exactly like Tauri would do.

Targets
-------
  - macOS desktop (squircle, transparent margin):
    `icon.png`, `32x32.png`, `64x64.png`, `128x128.png`,
    `128x128@2x.png`, `icon.icns`.
  - iOS AppIcon set (full-bleed square; iOS applies its own mask at
    runtime):
    every `AppIcon-*.png` under
    `src-tauri/gen/apple/Assets.xcassets/AppIcon.appiconset/`.
  - Windows Store tiles + StoreLogo (full-bleed square):
    `Square*Logo.png`, `StoreLogo.png`, `icon.ico` (multi-size).
  - Android launcher (foreground + legacy raster, full-bleed square):
    every `ic_launcher.png`, `ic_launcher_round.png` and
    `ic_launcher_foreground.png` under
    `src-tauri/icons/android/mipmap-*/`.

Usage
-----
    python3 scripts/recompose-platform-icons.py
    python3 scripts/recompose-platform-icons.py \
        --source src/assets/reachy-app-icon.png

Source PNG must be square; aspect ratio is not corrected here.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

try:
    from PIL import Image, ImageDraw
except ImportError:
    print("error: Pillow is required (pip install Pillow)", file=sys.stderr)
    sys.exit(2)


DEFAULT_SOURCE = Path("src/assets/reachy-app-icon.png")

# macOS desktop variants need the squircle treatment so the Dock and
# Finder render with native rounded corners + a transparent margin.
DESKTOP_SQUIRCLE_TARGETS = (
    "32x32.png",
    "64x64.png",
    "128x128.png",
    "128x128@2x.png",
    "icon.png",
)

# Windows Store tiles render as-is, full-bleed.
WINDOWS_SQUARE_TARGETS = (
    "Square30x30Logo.png",
    "Square44x44Logo.png",
    "Square71x71Logo.png",
    "Square89x89Logo.png",
    "Square107x107Logo.png",
    "Square142x142Logo.png",
    "Square150x150Logo.png",
    "Square284x284Logo.png",
    "Square310x310Logo.png",
    "StoreLogo.png",
)

ANDROID_MIPMAP_DIRS = (
    "android/mipmap-mdpi",
    "android/mipmap-hdpi",
    "android/mipmap-xhdpi",
    "android/mipmap-xxhdpi",
    "android/mipmap-xxxhdpi",
)

# All three Android raster targets get the same treatment: a flat
# resize of the master PNG. The adaptive-icon's foreground intentionally
# carries the full art too (no transparent margin), so the XML
# background underneath is never visible - this matches a master that
# already includes its own background fill.
ANDROID_RASTER_TARGETS = (
    "ic_launcher.png",
    "ic_launcher_round.png",
    "ic_launcher_foreground.png",
)

ICO_SIZES = (16, 24, 32, 48, 64, 128, 256)
ICNS_SIZE = 1024  # Pillow ICNS encoder will derive smaller subimages

# macOS app icon template (Apple HIG, Big Sur+):
#   - the visible squircle covers ~80.5% of the canvas (824/1024)
#   - the corner radius is ~22.5% of the squircle's side
#   - the remaining margin is fully transparent
SQUIRCLE_INNER_FRACTION = 0.805
SQUIRCLE_RADIUS_FRACTION = 0.225


def load_source_rgba(path: Path) -> Image.Image:
    img = Image.open(path)
    if img.mode != "RGBA":
        img = img.convert("RGBA")
    return img


def resize_square(source: Image.Image, side: int) -> Image.Image:
    if source.size == (side, side):
        return source.copy()
    return source.resize((side, side), Image.LANCZOS)


def squircle(source: Image.Image, side: int) -> Image.Image:
    """Render a macOS-style icon: a transparent canvas with a centered
    rounded-rectangle (squircle approximation) carved out of the master.
    The squircle interior is the master content; the corners and margin
    are fully transparent."""
    canvas_side = side
    inner_side = max(1, int(round(canvas_side * SQUIRCLE_INNER_FRACTION)))
    radius = max(0, int(round(inner_side * SQUIRCLE_RADIUS_FRACTION)))

    inner = resize_square(source, inner_side)

    mask = Image.new("L", (inner_side, inner_side), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        (0, 0, inner_side, inner_side), radius=radius, fill=255
    )
    # If the inner content has its own alpha, multiply it with the mask
    # so we don't accidentally make transparent pixels opaque again.
    if inner.mode == "RGBA":
        existing = inner.split()[-1]
        combined = Image.eval(mask, lambda v: v)
        combined = Image.merge("L", (combined,))
        inner_alpha = Image.eval(existing, lambda v: v)
        inner_alpha = Image.merge("L", (inner_alpha,))
        # Multiply masks: out_alpha = mask * existing / 255
        from PIL import ImageChops

        new_alpha = ImageChops.multiply(combined, inner_alpha)
        inner.putalpha(new_alpha)
    else:
        inner.putalpha(mask)

    out = Image.new("RGBA", (canvas_side, canvas_side), (0, 0, 0, 0))
    offset = (canvas_side - inner_side) // 2
    out.paste(inner, (offset, offset), inner)
    return out


def overwrite(target: Path, image: Image.Image) -> None:
    if image.mode != "RGBA":
        image = image.convert("RGBA")
    image.save(target, format="PNG", optimize=True)


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Regenerate platform icons from a single PNG master."
    )
    parser.add_argument(
        "--source",
        default=str(DEFAULT_SOURCE),
        type=Path,
        help=f"Source PNG (default: {DEFAULT_SOURCE}).",
    )
    parser.add_argument(
        "--icons-dir",
        default="src-tauri/icons",
        type=Path,
        help="Path to the icons folder (default: src-tauri/icons).",
    )
    parser.add_argument(
        "--apple-icon-set",
        default="src-tauri/gen/apple/Assets.xcassets/AppIcon.appiconset",
        type=Path,
        help="Path to the Apple AppIcon.appiconset folder.",
    )
    args = parser.parse_args()

    if not args.source.exists():
        print(f"error: source not found: {args.source}", file=sys.stderr)
        return 1
    if not args.icons_dir.is_dir():
        print(f"error: icons dir not found: {args.icons_dir}", file=sys.stderr)
        return 1

    source = load_source_rgba(args.source)
    sw, sh = source.size
    if sw != sh:
        print(
            f"warning: source {args.source} is not square ({sw}x{sh}); the "
            f"resize will distort. Re-export the master square.",
            file=sys.stderr,
        )

    print(f"source: {args.source}  size={sw}x{sh}")

    rewritten = 0
    missing = 0

    # 1) Top-level icons (squircle for macOS desktop, square for Windows).
    for name in DESKTOP_SQUIRCLE_TARGETS + WINDOWS_SQUARE_TARGETS:
        path = args.icons_dir / name
        if not path.exists():
            missing += 1
            print(f"  missing: {path}")
            continue
        with Image.open(path) as cur:
            target_side = max(cur.size)
        if name in DESKTOP_SQUIRCLE_TARGETS:
            out = squircle(source, target_side)
            tag = "squircle"
        else:
            out = resize_square(source, target_side)
            tag = "square"
        overwrite(path, out)
        rewritten += 1
        print(f"  rewritten ({tag}): {path}  ({target_side}x{target_side})")

    # 2) Android launcher (full-bleed square - foreground included).
    for folder in ANDROID_MIPMAP_DIRS:
        for name in ANDROID_RASTER_TARGETS:
            path = args.icons_dir / folder / name
            if not path.exists():
                missing += 1
                continue
            with Image.open(path) as cur:
                target_side = max(cur.size)
            out = resize_square(source, target_side)
            overwrite(path, out)
            rewritten += 1
            print(f"  rewritten (square): {path}  ({target_side}x{target_side})")

    # 3) Apple AppIcon set (full-bleed square; iOS masks at runtime).
    if args.apple_icon_set.is_dir():
        for path in sorted(args.apple_icon_set.glob("AppIcon-*.png")):
            with Image.open(path) as cur:
                target_side = max(cur.size)
            out = resize_square(source, target_side)
            overwrite(path, out)
            rewritten += 1
            print(f"  rewritten (square): {path}  ({target_side}x{target_side})")
    else:
        print(f"  skip Apple icon set (not found): {args.apple_icon_set}")

    # 4) icon.ico - multi-size, full-bleed square (Windows Explorer doesn't
    # mask icons).
    ico_path = args.icons_dir / "icon.ico"
    if ico_path.exists():
        max_side = max(ICO_SIZES)
        base = resize_square(source, max_side)
        base.save(ico_path, format="ICO", sizes=[(s, s) for s in ICO_SIZES])
        rewritten += 1
        print(f"  rewritten (square): {ico_path}  ({len(ICO_SIZES)} sizes)")

    # 5) icon.icns - macOS gets the squircle treatment.
    icns_path = args.icons_dir / "icon.icns"
    if icns_path.exists():
        base = squircle(source, ICNS_SIZE)
        try:
            base.save(icns_path, format="ICNS")
            rewritten += 1
            print(f"  rewritten (squircle): {icns_path}")
        except OSError as exc:
            print(f"  warning: ICNS save failed ({exc}); skipping", file=sys.stderr)

    print(f"\ndone: rewrote {rewritten}, missing {missing}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
