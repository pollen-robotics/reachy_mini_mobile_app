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
     canvas (default 0.55, well inside the 66/108 safe zone so the icon
     also sits cleanly inside the circular launcher mask).
  3. Pasting it centered onto a fresh transparent canvas of the original
     mipmap size and overwriting the file in place.

`--center-mode` controls the centering reference:

  - `bbox` (default): center the resized bbox on the canvas. Simple
    and predictable; works best for visually symmetric icons.
  - `centroid`: center on the alpha-weighted centroid of the resized
    content. Better for icons whose visual mass is offset from their
    geometric bbox (e.g. our Reachy logo, where the antennas elongate
    the bbox vertically without contributing meaningful visual weight).

The script is idempotent: re-running it on already-padded foregrounds
will scale the inner content to the same inner-fraction and produce
the same output (up to PNG encoding noise).

Usage
-----
    python3 scripts/pad-android-foreground.py \
        --icons-dir src-tauri/icons/android \
        --inner-fraction 0.55 \
        --center-mode centroid

By default it processes only `ic_launcher_foreground.png`. Run with
`--help` for all options.
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


def _alpha_centroid(img: Image.Image) -> tuple[float, float]:
    """Return the alpha-weighted centroid (cx, cy) of `img` (RGBA)."""
    alpha = img.split()[-1]
    w, h = alpha.size
    px = alpha.load()
    sum_a = 0
    sum_x = 0.0
    sum_y = 0.0
    for y in range(h):
        for x in range(w):
            a = px[x, y]
            if a:
                sum_a += a
                sum_x += x * a
                sum_y += y * a
    if sum_a == 0:
        return w / 2.0, h / 2.0
    return sum_x / sum_a, sum_y / sum_a


def pad_image(src: Path, inner_fraction: float, center_mode: str) -> str:
    """Rewrite `src` so its non-transparent content fits within the
    central `inner_fraction` of the canvas.

    `center_mode` is one of:
      - "bbox": center the resized bbox on the canvas (default-ish).
      - "centroid": center the alpha-weighted centroid (visual mass)
        on the canvas. Better for asymmetric icons.

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
    # Only rewrite if the content meaningfully exceeds the safe zone OR
    # if we're in centroid mode and the existing centering is bbox-based
    # (which we can't easily detect, so we always rewrite when not already
    # at the target size). In bbox mode the script remains idempotent
    # for repeated runs.
    if center_mode == "bbox" and current_ratio <= inner_fraction + ALREADY_PADDED_MARGIN:
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

    if center_mode == "centroid":
        cx, cy = _alpha_centroid(resized)
        offset_x = int(round(canvas_w / 2 - cx))
        offset_y = int(round(canvas_h / 2 - cy))
        # Clamp so the visible content stays fully on canvas (no partial crop).
        offset_x = max(0, min(canvas_w - new_w, offset_x))
        offset_y = max(0, min(canvas_h - new_h, offset_y))
    else:
        offset_x = (canvas_w - new_w) // 2
        offset_y = (canvas_h - new_h) // 2

    out = Image.new("RGBA", (canvas_w, canvas_h), (0, 0, 0, 0))
    out.paste(resized, (offset_x, offset_y), resized)
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
        default=0.55,
        help=(
            "Fraction of the canvas the visible content should occupy along "
            "its longest side. Android safe zone is 66/108 ~= 0.611, but the "
            "circular launcher mask only inscribes the central disc, so a "
            "square bbox at 0.611 has its corners clipped. Default 0.55 "
            "keeps the bbox well inside the inscribed circle."
        ),
    )
    parser.add_argument(
        "--center-mode",
        choices=("bbox", "centroid"),
        default="centroid",
        help=(
            "How to center the rescaled content on the canvas. 'bbox' "
            "centers the geometric bounding box (simple, predictable). "
            "'centroid' centers the alpha-weighted center of mass (better "
            "for asymmetric icons whose bbox is dominated by thin "
            "extremities like antennas). Default: centroid."
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
            result = pad_image(src, args.inner_fraction, args.center_mode)
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
        f"(inner_fraction={args.inner_fraction}, center_mode={args.center_mode})"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
