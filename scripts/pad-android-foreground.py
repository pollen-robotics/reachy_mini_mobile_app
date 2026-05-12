#!/usr/bin/env python3
"""
Pad the Android adaptive-icon foreground PNGs to respect the launcher safe zone.

Why this exists
---------------
Android adaptive icons (`mipmap-anydpi-v26/ic_launcher.xml`) compose a
108dp foreground over a background, then the launcher (Pixel, Samsung,
MIUI, etc.) applies its own mask (circle, squircle, teardrop, ...).
Per the spec, only the central 66dp out of the 108dp foreground is
guaranteed to be visible after masking. Anything outside that safe zone
is liable to be cropped.

`tauri icon` generates `ic_launcher_foreground.png` by simply scaling
the source `icon.png` to the mipmap size with no extra padding, so any
brand icon whose design fills its canvas (like our Reachy logo with
antennas reaching to the top edge) ends up with its edges sliced off
on the home screen.

This script post-processes the generated `ic_launcher_foreground.png`
(and `ic_launcher_round.png`) in every `mipmap-*` folder by:

  1. Cropping each PNG to the bounding box of its non-transparent pixels.
  2. Scaling that bbox so its longest side is `--inner-fraction` of the
     canvas (default 0.62, i.e. 62% - inside the 66/108 safe zone with a
     small extra margin).
  3. Pasting it centered onto a fresh transparent canvas of the original
     mipmap size and overwriting the file in place.

The script is idempotent: re-running it on already-padded foregrounds
will scale the inner content to the same inner-fraction and produce
the same output (up to PNG encoding noise).

Usage
-----
    python3 scripts/pad-android-foreground.py \
        --icons-dir src-tauri/icons/android

By default it processes both `ic_launcher_foreground.png` and
`ic_launcher_round.png`. Run with `--help` for all options.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

try:
    from PIL import Image
except ImportError:
    print(
        "error: Pillow is required (pip install Pillow)",
        file=sys.stderr,
    )
    sys.exit(2)


# Mipmap density buckets that ship adaptive-icon foregrounds.
MIPMAP_DIRS = (
    "mipmap-mdpi",
    "mipmap-hdpi",
    "mipmap-xhdpi",
    "mipmap-xxhdpi",
    "mipmap-xxxhdpi",
)

DEFAULT_TARGETS = (
    # Only the adaptive-icon foreground needs padding. `ic_launcher.png`
    # and `ic_launcher_round.png` are legacy assets used as-is on API < 26
    # (we ship minSdk 26, so they're effectively dead code, but padding
    # them would shrink them inside their own canvas and look wrong if a
    # launcher ever falls back to them).
    "ic_launcher_foreground.png",
)


# Safety margin (in fraction of canvas side) above which we consider a
# foreground already padded and skip rewriting. We rewrite only if the
# current content overflows the safe zone by more than this margin.
ALREADY_PADDED_MARGIN = 0.02


def pad_image(src: Path, inner_fraction: float) -> str:
    """Rewrite `src` so its non-transparent content fits within the
    central `inner_fraction` of the canvas.

    Returns one of:
      - "padded": file rewritten with new padding
      - "skipped-already-padded": already inside safe zone (no rewrite)
      - "skipped-empty": no visible pixels at all
    """
    img = Image.open(src).convert("RGBA")
    canvas_w, canvas_h = img.size

    bbox = img.getbbox()
    if bbox is None:
        return "skipped-empty"

    cw = bbox[2] - bbox[0]
    ch = bbox[3] - bbox[1]
    current_ratio = max(cw, ch) / max(canvas_w, canvas_h)
    # Only rewrite if the content meaningfully exceeds the safe zone.
    # This makes the script idempotent in practice: re-running it on
    # already-padded foregrounds is a no-op (avoids byte-level churn
    # from repeated PNG resampling/encoding).
    if current_ratio <= inner_fraction + ALREADY_PADDED_MARGIN:
        return "skipped-already-padded"

    cropped = img.crop(bbox)

    target_long = int(round(min(canvas_w, canvas_h) * inner_fraction))
    if target_long <= 0:
        return "skipped-empty"

    if cw >= ch:
        new_w = target_long
        new_h = max(1, int(round(ch * (target_long / cw))))
    else:
        new_h = target_long
        new_w = max(1, int(round(cw * (target_long / ch))))

    resized = cropped.resize((new_w, new_h), Image.LANCZOS)

    out = Image.new("RGBA", (canvas_w, canvas_h), (0, 0, 0, 0))
    out.paste(resized, ((canvas_w - new_w) // 2, (canvas_h - new_h) // 2), resized)
    out.save(src, format="PNG", optimize=True)
    return "padded"


def main() -> int:
    parser = argparse.ArgumentParser(
        description=(
            "Pad Android adaptive-icon foregrounds so they fit inside the "
            "launcher safe zone (default 62% of canvas)."
        ),
    )
    parser.add_argument(
        "--icons-dir",
        default="src-tauri/icons/android",
        help="Path to the Android icons folder (default: src-tauri/icons/android).",
    )
    parser.add_argument(
        "--inner-fraction",
        type=float,
        default=0.62,
        help=(
            "Fraction of the canvas the visible content should occupy along "
            "its longest side. Android safe zone is 66/108 ~= 0.611; the "
            "default 0.62 leaves a tiny extra margin for round masks."
        ),
    )
    parser.add_argument(
        "--targets",
        nargs="*",
        default=list(DEFAULT_TARGETS),
        help=f"Filenames inside each mipmap-* folder to pad (default: {' '.join(DEFAULT_TARGETS)}).",
    )
    args = parser.parse_args()

    icons_dir = Path(args.icons_dir)
    if not icons_dir.is_dir():
        print(f"error: icons dir not found: {icons_dir}", file=sys.stderr)
        return 1

    if not (0.1 <= args.inner_fraction <= 0.95):
        print(
            f"error: --inner-fraction must be in [0.1, 0.95], got {args.inner_fraction}",
            file=sys.stderr,
        )
        return 1

    rewritten = 0
    skipped_already = 0
    skipped_empty = 0
    missing = 0

    for mipmap in MIPMAP_DIRS:
        mipmap_dir = icons_dir / mipmap
        if not mipmap_dir.is_dir():
            print(f"  skip: {mipmap_dir} (not a directory)")
            continue
        for fname in args.targets:
            src = mipmap_dir / fname
            if not src.exists():
                missing += 1
                continue
            result = pad_image(src, args.inner_fraction)
            if result == "padded":
                rewritten += 1
                print(f"  padded: {src}")
            elif result == "skipped-already-padded":
                skipped_already += 1
                print(f"  ok (already padded): {src}")
            else:
                skipped_empty += 1
                print(f"  skipped (empty): {src}")

    print(
        f"done: rewrote {rewritten}, already-padded {skipped_already}, "
        f"empty {skipped_empty}, missing {missing} "
        f"(inner_fraction={args.inner_fraction})"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
