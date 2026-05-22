#!/usr/bin/env python3
"""
Recompose every platform icon over a solid background color.

Why this exists
---------------
Tauri's `tauri icon` generates the iOS AppIcon set, Windows Store tiles
and desktop bundle icons (`.ico`, `.icns`) by compositing the
transparent source `icon.png` onto a white background. For our app we
want them on a black background instead (cf. the matching change to
`src-tauri/icons/android/values/ic_launcher_background.xml`).

This script reads the transparent source (PNG or SVG), then overwrites
every platform icon by:

  1. Resizing the master to the target's existing dimensions.
  2. Compositing it onto the chosen `--bg` color.
  3. Saving the result back in place.

It also regenerates `icon.ico` (multi-size) and `icon.icns` (macOS) from
the same source.

Source selection
----------------
By default, the script picks the first that exists, in this order:

  1. `src/assets/reachy-app-icon.svg` - dedicated app-icon master (NOT
     `reachy-icon.svg`, which is used for in-app UI illustrations).
     Rasterized at `--render-size` (default 2048) via `rsvg-convert`.
  2. `src-tauri/icons/icon-source-transparent.png` - backup of the
     original transparent PNG master (created on first run).
  3. `src-tauri/icons/icon.png` - live master (a one-time backup is made
     before any rewrite).

You can override with `--source path/to/icon.{svg,png}`.

SVG rasterization requires `rsvg-convert` (Homebrew: `brew install
librsvg`). If unavailable, fall back to a PNG source.

Targets
-------
  - top-level icons in `src-tauri/icons/`: `32x32.png`, `64x64.png`,
    `128x128.png`, `128x128@2x.png`, `icon.png`, all `Square*Logo.png`,
    `StoreLogo.png`, `icon.ico`, `icon.icns`.
  - iOS AppIcon set: every `AppIcon-*.png` under
    `src-tauri/gen/apple/Assets.xcassets/AppIcon.appiconset/`.
  - Android legacy raster (API < 26 fallback): every
    `ic_launcher.png` and `ic_launcher_round.png` under
    `src-tauri/icons/android/mipmap-*/`.

Android adaptive foreground
---------------------------
The `mipmap-*/ic_launcher_foreground.png` files are also regenerated
from the source, but kept TRANSPARENT (no background composite) so the
XML background shows through. After this script runs, run
`pad-android-foreground.py` to apply the safe-zone padding and
centroid-based centering.

  Recommended pipeline:
    python3 scripts/recompose-platform-icons.py --bg "#000000"
    python3 scripts/pad-android-foreground.py

Source preservation
-------------------
On first run, the script copies the transparent `icon.png` to
`icon-source-transparent.png` and reads that backup on every
subsequent run. So you can iterate on `--bg` non-destructively.

If you ever re-run `tauri icon` (which regenerates everything from
`icon.png`), Tauri will composite over white again - just re-run this
script after to put the black background back.

Usage
-----
    python3 scripts/recompose-platform-icons.py --bg "#000000"
"""

from __future__ import annotations

import argparse
import io
import shutil
import subprocess
import sys
from pathlib import Path

try:
    from PIL import Image, ImageDraw
except ImportError:
    print("error: Pillow is required (pip install Pillow)", file=sys.stderr)
    sys.exit(2)


# NOTE: this is the dedicated app-icon master, distinct from
# `src/assets/reachy-icon.svg` (which is used in-app for UI illustrations
# - splash, robot avatars, etc.). The app-icon master is a minimal
# "black-on-black with glowing eyes" variant tuned for the OS launcher
# context, where the icon sits inside a small rounded tile and needs
# strong silhouette readability rather than full robot detail.
DEFAULT_SVG_SOURCE = Path("src/assets/reachy-app-icon.svg")


# Files that need the macOS squircle treatment (transparent canvas with a
# centered squircle filled with the bg color, source compositted on top).
# These are the desktop bundle icons that Tauri uses for the macOS .app and
# the Linux desktop entry; iOS / Windows / Android tiles must stay full-bleed
# squares because their respective OS shells either apply their own mask
# (iOS, Android adaptive) or expect square art (Windows tiles).
DESKTOP_SQUIRCLE_TARGETS = (
    "32x32.png",
    "64x64.png",
    "128x128.png",
    "128x128@2x.png",
    "icon.png",
)

# Files that stay as full-bleed squares (filled corner-to-corner with bg).
# Windows Store tiles + StoreLogo render as-is on the OS, so they need
# square art that occupies the whole canvas.
DESKTOP_SQUARE_TARGETS = (
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

TOPLEVEL_TARGETS = DESKTOP_SQUIRCLE_TARGETS + DESKTOP_SQUARE_TARGETS

ANDROID_MIPMAP_DIRS = (
    "android/mipmap-mdpi",
    "android/mipmap-hdpi",
    "android/mipmap-xhdpi",
    "android/mipmap-xxhdpi",
    "android/mipmap-xxxhdpi",
)

ANDROID_LEGACY_TARGETS = (
    "ic_launcher.png",
    "ic_launcher_round.png",
)

ICO_SIZES = (16, 24, 32, 48, 64, 128, 256)
ICNS_SIZE = 1024  # upscaled if source is smaller; Pillow handles internal subimages

# macOS app icon template (Apple HIG, Big Sur+):
#   - the visible squircle covers ~80.5% of the icon canvas (824/1024)
#   - the corner radius is ~22.5% of the squircle's side (185/824 ~= iOS 22.37%)
#   - the remaining margin is fully transparent (no background fill there)
# These are the values Apple ships in their own AppIcon.iconset templates.
SQUIRCLE_INNER_FRACTION = 0.805
SQUIRCLE_RADIUS_FRACTION = 0.225


def hex_to_rgb(value: str) -> tuple[int, int, int]:
    s = value.strip().lstrip("#")
    if len(s) == 3:
        s = "".join(c * 2 for c in s)
    if len(s) != 6:
        raise ValueError(f"invalid hex color: {value!r}")
    return int(s[0:2], 16), int(s[2:4], 16), int(s[4:6], 16)


def composite(source: Image.Image, size: tuple[int, int], bg: tuple[int, int, int]) -> Image.Image:
    """Resize `source` to `size` and composite onto solid `bg`. Returns RGBA
    (fully opaque, alpha=255 everywhere). Tauri's `tauri::generate_context!`
    macro requires RGBA PNGs at the icon paths it ingests, so do NOT
    convert to RGB here even though every pixel is opaque."""
    if source.size == size:
        resized = source
    else:
        resized = source.resize(size, Image.LANCZOS)
    canvas = Image.new("RGBA", size, bg + (255,))
    return Image.alpha_composite(canvas, resized)


def composite_macos_squircle(
    source: Image.Image,
    size: tuple[int, int],
    bg: tuple[int, int, int],
    inner_fraction: float = SQUIRCLE_INNER_FRACTION,
    radius_fraction: float = SQUIRCLE_RADIUS_FRACTION,
) -> Image.Image:
    """Render the macOS-style app icon: a centered squircle (rounded
    rectangle) of side `inner_fraction * canvas`, filled with `bg`, with
    `source` composited on top, the squircle corners radiused at
    `radius_fraction * inner_side`, and the remaining canvas margin fully
    transparent.

    macOS does NOT auto-round app icons (unlike iOS) - the icon ships its
    own rounded silhouette. Pillow's `rounded_rectangle` is a circular-arc
    approximation of Apple's continuous squircle, but at icon sizes the
    visual difference is negligible.
    """
    canvas_w, canvas_h = size
    inner_w = max(1, int(round(canvas_w * inner_fraction)))
    inner_h = max(1, int(round(canvas_h * inner_fraction)))
    radius = max(0, int(round(min(inner_w, inner_h) * radius_fraction)))

    if source.size != (inner_w, inner_h):
        resized = source.resize((inner_w, inner_h), Image.LANCZOS)
    else:
        resized = source

    inner = Image.new("RGBA", (inner_w, inner_h), bg + (255,))
    inner = Image.alpha_composite(inner, resized)

    # Build squircle alpha mask and use it as the new alpha channel.
    mask = Image.new("L", (inner_w, inner_h), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        (0, 0, inner_w, inner_h), radius=radius, fill=255
    )
    inner.putalpha(mask)

    out = Image.new("RGBA", (canvas_w, canvas_h), (0, 0, 0, 0))
    ox = (canvas_w - inner_w) // 2
    oy = (canvas_h - inner_h) // 2
    out.paste(inner, (ox, oy), inner)
    return out


def overwrite_png(target: Path, image: Image.Image) -> None:
    image.save(target, format="PNG", optimize=True)


def rasterize_svg(svg_path: Path, render_size: int) -> Image.Image:
    """Render `svg_path` to a `render_size`x`render_size` RGBA Pillow image
    via `rsvg-convert`."""
    if shutil.which("rsvg-convert") is None:
        raise RuntimeError(
            "rsvg-convert not found in PATH. Install with `brew install "
            "librsvg`, or pass a PNG via --source."
        )
    cmd = [
        "rsvg-convert",
        "-w", str(render_size),
        "-h", str(render_size),
        "-a",  # keep aspect ratio
        "-f", "png",
        str(svg_path),
    ]
    proc = subprocess.run(cmd, check=True, capture_output=True)
    return Image.open(io.BytesIO(proc.stdout)).convert("RGBA")


def load_source(source_path: Path, render_size: int) -> Image.Image:
    """Load `source_path` as RGBA. Rasterize SVG if needed."""
    if source_path.suffix.lower() == ".svg":
        return rasterize_svg(source_path, render_size)
    return Image.open(source_path).convert("RGBA")


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Recompose platform icons onto a solid background color."
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
    parser.add_argument(
        "--bg",
        default="#000000",
        help="Background color hex (default: #000000).",
    )
    parser.add_argument(
        "--source",
        default=None,
        type=Path,
        help=(
            "Source PNG or SVG. Default lookup order: src/assets/reachy-icon.svg "
            "if it exists, then <icons-dir>/icon-source-transparent.png, then "
            "<icons-dir>/icon.png (with a one-time backup)."
        ),
    )
    parser.add_argument(
        "--render-size",
        default=2048,
        type=int,
        help=(
            "Resolution at which to rasterize an SVG source (square). "
            "Larger = better quality on the 1024x1024 App Store icon but "
            "slower. Default: 2048."
        ),
    )
    args = parser.parse_args()

    bg = hex_to_rgb(args.bg)
    icons_dir: Path = args.icons_dir
    if not icons_dir.is_dir():
        print(f"error: icons dir not found: {icons_dir}", file=sys.stderr)
        return 1

    if args.source is not None:
        source_path = args.source
    elif DEFAULT_SVG_SOURCE.exists():
        source_path = DEFAULT_SVG_SOURCE
    else:
        backup = icons_dir / "icon-source-transparent.png"
        live = icons_dir / "icon.png"
        if backup.exists():
            source_path = backup
        else:
            shutil.copy2(live, backup)
            print(f"  backup: {live} -> {backup}")
            source_path = backup

    if not source_path.exists():
        print(f"error: source not found: {source_path}", file=sys.stderr)
        return 1

    source = load_source(source_path, args.render_size)
    alpha = source.split()[-1].getextrema()
    if alpha == (255, 255):
        print(
            f"warning: source {source_path} is fully opaque; if you intended "
            f"a transparent master, restore from a backup.",
            file=sys.stderr,
        )

    print(f"source: {source_path}  size={source.size[0]}x{source.size[1]}")
    print(f"bg: {args.bg} -> rgb{bg}")

    rewritten = 0
    missing = 0

    # 1) Top-level icons. Squircle for macOS desktop; full-bleed square
    # for Windows tiles + StoreLogo.
    for name in TOPLEVEL_TARGETS:
        path = icons_dir / name
        if not path.exists():
            missing += 1
            print(f"  missing: {path}")
            continue
        with Image.open(path) as cur:
            size = cur.size
        if name in DESKTOP_SQUIRCLE_TARGETS:
            out = composite_macos_squircle(source, size, bg)
            tag = "squircle"
        else:
            out = composite(source, size, bg)
            tag = "square"
        overwrite_png(path, out)
        rewritten += 1
        print(f"  rewritten ({tag}): {path}  ({size[0]}x{size[1]})")

    # 2a) Android legacy raster icons (kept coherent with the rest, even
    # though minSdk 26 means they're effectively dead code).
    for folder in ANDROID_MIPMAP_DIRS:
        for name in ANDROID_LEGACY_TARGETS:
            path = icons_dir / folder / name
            if not path.exists():
                missing += 1
                continue
            with Image.open(path) as cur:
                size = cur.size
            out = composite(source, size, bg)
            overwrite_png(path, out)
            rewritten += 1
            print(f"  rewritten: {path}  ({size[0]}x{size[1]})")

    # 2b) Android adaptive-icon foreground: kept TRANSPARENT (no bg) so the
    # XML background shows through. The robot fills the canvas here; running
    # `pad-android-foreground.py` afterwards applies the safe-zone padding.
    for folder in ANDROID_MIPMAP_DIRS:
        path = icons_dir / folder / "ic_launcher_foreground.png"
        if not path.exists():
            missing += 1
            continue
        with Image.open(path) as cur:
            size = cur.size
        if source.size == size:
            out_fg = source.copy()
        else:
            out_fg = source.resize(size, Image.LANCZOS)
        out_fg.save(path, format="PNG", optimize=True)
        rewritten += 1
        print(f"  rewritten (transparent): {path}  ({size[0]}x{size[1]})")

    # 3) Apple AppIcon set.
    if args.apple_icon_set.is_dir():
        for path in sorted(args.apple_icon_set.glob("AppIcon-*.png")):
            with Image.open(path) as cur:
                size = cur.size
            out = composite(source, size, bg)
            overwrite_png(path, out)
            rewritten += 1
            print(f"  rewritten: {path}  ({size[0]}x{size[1]})")
    else:
        print(f"  skip Apple icon set (not found): {args.apple_icon_set}")

    # 4) icon.ico (multi-size).
    ico_path = icons_dir / "icon.ico"
    if ico_path.exists():
        max_size = max(ICO_SIZES)
        base = composite(source, (max_size, max_size), bg)
        base.save(
            ico_path,
            format="ICO",
            sizes=[(s, s) for s in ICO_SIZES],
        )
        rewritten += 1
        print(f"  rewritten: {ico_path}  ({len(ICO_SIZES)} sizes)")

    # 5) icon.icns - macOS gets the squircle treatment so the Dock and
    # Finder render with native rounded corners + transparent margin.
    icns_path = icons_dir / "icon.icns"
    if icns_path.exists():
        base = composite_macos_squircle(source, (ICNS_SIZE, ICNS_SIZE), bg)
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
