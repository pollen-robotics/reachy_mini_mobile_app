#!/usr/bin/env python3
"""
Regenerate the carousel reachies under `src/assets/reachies/top-sided/`.

Why this exists
---------------
The mobile shell's empty-state carousel (`IntroPanel` in
`src/ui/panels/apps-list/AppsTabView.tsx`, via
`src/ui/widgets/reachies-carousel/ReachiesCarousel.tsx`) used to load 5 PNG
stickers from `src/assets/reachies/small-top-sided/`. That folder had two
problems:

  1. Only 5 personas in the rotation (cooking-chief, farmer, fisherman,
     jazzman, rich), all looped on a ~1s timer so the user quickly notices
     the repetition.
  2. Each PNG was 512×512, which is right at the edge of what a retina
     phone (DPR 3) can render crisp when the hero box is scaled with
     `transform: scale(~1.6)`; the visible result was a slight blur.

The canonical source set lives in `reachy-mini-website/src/assets/reachies/
original/` (25 personas, 1024×1024 PNG, ~16 MB total). Bundling that as-is
into a mobile app would be wasteful. This script re-frames every source on
its alpha bounding box (so the sticker fills the canvas in the same
"top-sided" way the legacy assets did) and re-encodes to WebP@768 with
alpha. Result: 24 personas in ~1.1 MB.

Pipeline per source
-------------------
  1. Open as RGBA.
  2. Crop a *common* square centred on the canvas centre (NOT on the
     per-sticker alpha bbox). The artists already centred every persona
     inside the 1024x1024 source canvas, so respecting that anchor is
     what keeps the eyes aligned at the same height across every frame
     of the carousel. The side length is computed once across the full
     set as `2 * max(half_W, half_H) + 2 * PADDING_PX`, with `half_W`
     and `half_H` taken from the most extreme sticker (the magician's
     pointy hat reaches ~y=129, ~383 px above the canvas centre).
  3. Resize to `TARGET`×`TARGET` with Lanczos.
  4. Encode WebP (lossy, method=6, q=`WEBP_QUALITY`, alpha preserved).

If we centred on each sticker's own bbox instead, a tall sticker (big
hat) and a wide sticker (large brim) would end up with their visual
eye-line at very different heights inside the 768 frame, and the
carousel would visibly jitter at every crossfade. Centring on the
canvas keeps the artists' alignment intact at the cost of a slightly
larger transparent margin, which is what the carousel's `zoom` param
already exists to compensate for.

The carousel auto-discovers files via Vite's `import.meta.glob`, so adding
or renaming an output rebuilds the rotation without touching any JS.

Usage
-----
    python3 scripts/build-reachies-top-sided.py
    python3 scripts/build-reachies-top-sided.py --dry-run
    python3 scripts/build-reachies-top-sided.py --only jazzman astronaut

Requires Pillow >= 10 (the WebP encoder is in the standard wheel since 9.x).
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from PIL import Image


HERE = Path(__file__).resolve().parent
REPO_ROOT = HERE.parent.parent

# Source canonical PNGs (committed in the website repo; the desktop app
# carries an identical copy). We pick the website variant because it is
# the surface artists update first when refreshing the personas.
SRC = REPO_ROOT / "reachy-mini-website" / "src" / "assets" / "reachies" / "original"

# Output: the folder consumed by `ReachiesCarousel`'s `import.meta.glob`.
DST = HERE.parent / "src" / "assets" / "reachies" / "top-sided"

TARGET = 768
# Padding added on each side of the *common* crop square (fraction of the
# square's side, so 0.06 = 6% padding per edge = 12% padding total).
# Tuned so the magician's pointy hat (the most extreme persona) still has
# ~50 px of transparent breathing room above the tip; smaller values make
# the hat tip kiss the top edge, larger values push every other persona
# towards the centre and make them feel "lost" in the frame.
PADDING_FRAC = 0.06
ALPHA_THRESHOLD = 16
WEBP_QUALITY = 88

# `plumber.png` is the only source that depicts a full body (overalls +
# tools + legs) instead of the helmet/head framing every other persona
# uses. It clashes visually with the rest of the carousel, so we skip it.
# `plumber 2.png` is the head-only variant; we publish it under the
# canonical `plumber` slug so the carousel still has a plumber-themed
# entry without exposing the "_2" suffix to the user.
SOURCE_OVERRIDES: dict[str, str | None] = {
    "plumber": None,
    "plumber 2": "plumber",
}


def alpha_bbox(img: Image.Image) -> tuple[int, int, int, int] | None:
    """Return the (x0, y0, x1, y1) bbox of pixels above ALPHA_THRESHOLD,
    or None if the image is fully transparent."""
    assert img.mode == "RGBA", f"expected RGBA, got {img.mode}"
    alpha = img.split()[3]
    mask = alpha.point(lambda v: 255 if v > ALPHA_THRESHOLD else 0)
    return mask.getbbox()


def compute_common_crop_side(sources: list[Path]) -> int:
    """Pre-scan the full source set to find the smallest square side that
    contains every sticker when the crop is centred on the canvas centre.

    Returns the padded side length in source pixels (= the per-edge
    padding is already baked in).
    """
    max_half = 0
    worst: str | None = None
    for src in sources:
        # Skip sources we're not publishing - their geometry shouldn't
        # influence the common crop.
        if slugify(src.name) == "":
            continue
        with Image.open(src) as raw:
            img = raw.convert("RGBA")
        w, h = img.size
        cx_c, cy_c = w // 2, h // 2
        bbox = alpha_bbox(img)
        if not bbox:
            continue
        x0, y0, x1, y1 = bbox
        half = max(cx_c - x0, x1 - cx_c, cy_c - y0, y1 - cy_c)
        if half > max_half:
            max_half = half
            worst = src.stem

    side_min = 2 * max_half
    side_padded = int(round(side_min * (1 + 2 * PADDING_FRAC)))
    print(
        f"common crop: side_min={side_min}px (driven by {worst}), "
        f"with {int(PADDING_FRAC * 100)}% padding per edge -> {side_padded}px"
    )
    return side_padded


def crop_centred_on_canvas(img: Image.Image, side: int) -> Image.Image:
    """Crop a square `side` x `side` centred on the canvas centre.

    Out-of-bounds areas (when the source is smaller than `side` or the
    crop window spills past the edge) are filled with transparent, which
    is what we want for sticker PNGs that already use alpha to delimit
    the artwork.
    """
    w, h = img.size
    cx_c, cy_c = w // 2, h // 2
    half = side // 2
    crop_box = (cx_c - half, cy_c - half, cx_c - half + side, cy_c - half + side)
    canvas = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    src_crop = img.crop(crop_box)
    canvas.paste(src_crop, (0, 0), src_crop)
    return canvas


def process(src_path: Path, dst_path: Path, crop_side: int) -> tuple[int, int]:
    """Return (orig_kb, out_kb) for reporting."""
    with Image.open(src_path) as raw:
        img = raw.convert("RGBA")
    cropped = crop_centred_on_canvas(img, crop_side)
    resized = cropped.resize((TARGET, TARGET), Image.Resampling.LANCZOS)
    dst_path.parent.mkdir(parents=True, exist_ok=True)
    resized.save(
        dst_path,
        format="WEBP",
        quality=WEBP_QUALITY,
        method=6,
        lossless=False,
    )
    return src_path.stat().st_size // 1024, dst_path.stat().st_size // 1024


def slugify(name: str) -> str:
    """Normalise filenames: lower-case, spaces -> '-', honour overrides.

    Returns an empty string for entries explicitly mapped to `None` in
    `SOURCE_OVERRIDES`, signalling "skip this source".
    """
    stem = Path(name).stem.strip().lower()
    if stem in SOURCE_OVERRIDES:
        override = SOURCE_OVERRIDES[stem]
        if override is None:
            return ""
        stem = override
    stem = stem.replace(" ", "-")
    return f"{stem}.webp"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="List planned conversions without writing files.",
    )
    parser.add_argument(
        "--only",
        nargs="*",
        help="Optional list of source basenames (no extension) to process.",
    )
    args = parser.parse_args()

    if not SRC.exists():
        print(f"source folder missing: {SRC}", file=sys.stderr)
        return 1

    sources = sorted(SRC.glob("*.png"))
    if args.only:
        keep = {n.lower() for n in args.only}
        sources = [s for s in sources if s.stem.lower() in keep]

    if not sources:
        print("no PNG sources to process", file=sys.stderr)
        return 1

    # Compute the common crop side once over the *full* source set so
    # `--only` runs reproduce the same framing as a full batch. Tying
    # the crop to the subset would silently shift the framing of any
    # persona regenerated alone.
    full_sources = sorted(SRC.glob("*.png"))
    crop_side = compute_common_crop_side(full_sources)

    total_in = 0
    total_out = 0
    processed = 0
    for src in sources:
        slug = slugify(src.name)
        if not slug:
            print(f"SKIP {src.name:30s} (excluded via SOURCE_OVERRIDES)")
            continue
        dst = DST / slug
        if args.dry_run:
            print(f"DRY  {src.name:30s} -> {dst.relative_to(REPO_ROOT)}")
            continue
        in_kb, out_kb = process(src, dst, crop_side)
        total_in += in_kb
        total_out += out_kb
        processed += 1
        print(f"OK   {src.name:30s} -> {dst.name:30s}  {in_kb:5d}KB -> {out_kb:4d}KB")

    if not args.dry_run:
        denom = max(total_in, 1)
        print(
            f"\nTotal: {processed} files, "
            f"{total_in / 1024:.1f}MB -> {total_out / 1024:.1f}MB "
            f"({(1 - total_out / denom) * 100:.0f}% smaller)"
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
