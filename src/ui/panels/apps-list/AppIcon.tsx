/**
 * App glyph renderer.
 *
 * Two-tier resolution that mirrors the catalog data model:
 *
 *   1. Custom image (`app.iconUrl`) - present when the Space ships
 *      `icon.svg` (preferred) or `icon.png` at the repo root. The
 *      catalog server detects this once per refresh (see
 *      `reachy-mini-website/server/index.js`, `findIconUrl()`) and
 *      publishes an absolute HF `resolve/main/` URL on the app
 *      entry.
 *
 *   2. Emoji fallback (`readAppEmoji(app)`) - the legacy
 *      front-matter glyph from `cardData.emoji`. Used when no
 *      custom icon exists, and as a runtime fallback if the image
 *      fails to load (e.g. the file was deleted between two
 *      catalog refreshes, the browser is offline mid-render, etc.).
 *
 * Render contract:
 *   - The component is a sized box: the parent decides `size` and
 *     the glyph fills it. Emoji renders at `size * 0.9` font-size
 *     so it visually matches a square image of the same width.
 *   - It is purely presentational - no click handler, no focus
 *     behaviour. Wrap it in a `<Box>` / `<Button>` at the call site
 *     to make it interactive.
 *
 * Performance:
 *   - The `<img>` element is mounted unconditionally when
 *     `iconUrl` is present. If the load fails we swap to the emoji
 *     via `onError`; the swap is local React state (`hasErrored`),
 *     no re-render storm, and the broken image never paints
 *     because we keep the emoji underneath and only toggle which
 *     one is visible.
 *   - `useApps()` warms the browser's image cache for every
 *     custom icon via `Image()` preloading as soon as the catalog
 *     payload arrives (see `iconCache.ts`). The preloader shares
 *     the loader pipeline with `<img>`, so tab switches re-mount
 *     against an already-decoded bitmap and paint without the
 *     ETag-revalidation flash that HF's missing `Cache-Control`
 *     would otherwise force.
 */
import { memo, useEffect, useState } from 'react';
import { Box } from '@mui/material';
import type { BoxProps } from '@mui/material';

import { readAppEmoji } from '@/features/apps/emoji';
import type { AppEntry } from '@/features/apps/types';

interface AppIconProps {
  app: AppEntry;
  /**
   * Glyph size in px used for the emoji fallback. Pick the size at
   * the call site (e.g. 44 in the pinned grid, 24 in the compact
   * tile header, 22 in the iframe overlay) so the emoji optically
   * matches its neighbours.
   *
   * The image branch uses `imageSize` (defaults to `size`) so a
   * polished custom asset can carry more visual weight than the
   * emoji baseline. See the `imageSize` prop below.
   */
  size: number;
  /**
   * Size in px when rendering a custom image (the app shipped
   * `icon.svg` / `icon.png` at the repo root). Defaults to `size`
   * for layout backward-compat. Pass a larger value at call sites
   * where the custom icon is the primary visual element (compact
   * tile header, pinned grid square) and the bumped emoji would
   * look chunky next to the surrounding text.
   *
   * Note: the wrapper `<Box>` sizes itself to whichever branch is
   * active (image vs emoji), so the surrounding layout reserves
   * exactly the rendered footprint and stays tight in both modes.
   */
  imageSize?: number;
  /**
   * Optional override for SVG glyphs specifically. When the
   * `iconUrl` resolves to an `.svg` file, the icon renders at this
   * size instead of `imageSize`. Lets call sites tame SVG glyphs
   * (which often ship with edge-to-edge artwork and no internal
   * padding) without shrinking PNG icons that already encode their
   * own margins. Falls back to `imageSize` when unset.
   */
  svgImageSize?: number;
  /**
   * Optional `sx` overrides forwarded to the wrapping `<Box>` -
   * useful when the parent needs to pin the icon to a flex slot
   * (`flexShrink: 0`, `mt: 0.25`, etc.) without subclassing
   * `AppIcon`.
   */
  sx?: BoxProps['sx'];
}

function AppIconImpl({
  app,
  size,
  imageSize = size,
  svgImageSize,
  sx,
}: AppIconProps) {
  // Track load failures so a stale `iconUrl` (file deleted between
  // catalog refreshes, hub hiccup, offline render, ...) degrades
  // gracefully to the emoji glyph. Reset whenever the URL changes
  // so retries on a fixed catalog actually re-attempt the image.
  const [hasErrored, setHasErrored] = useState(false);
  const iconUrl = app.iconUrl;

  // Reset the error flag whenever the URL itself changes so a
  // recovered icon (catalog refresh, re-publish) re-attempts a
  // load instead of staying locked on the emoji fallback.
  useEffect(() => {
    setHasErrored(false);
  }, [iconUrl]);

  const showImage = !!iconUrl && !hasErrored;
  const emoji = readAppEmoji(app);
  // SVG glyphs typically fill their viewBox edge-to-edge while PNGs
  // ship author-tuned padding, so the two formats need different
  // optical sizing. We strip any query string / hash before the
  // extension check so URLs like `icon.svg?revision=abc` still match.
  const isSvg =
    !!iconUrl &&
    /\.svg(?:[?#]|$)/i.test(iconUrl);
  const effectiveImageSize =
    isSvg && svgImageSize !== undefined ? svgImageSize : imageSize;
  // The wrapper sizes itself to the active branch so the parent
  // layout reserves exactly the rendered footprint (no whitespace
  // around an emoji when the call site bumped `imageSize` to 2x).
  const renderedSize = showImage ? effectiveImageSize : size;

  return (
    <Box
      aria-hidden
      sx={[
        {
          width: renderedSize,
          height: renderedSize,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          // Emoji text sits centred; image fills the box. The
          // `lineHeight: 1` keeps tall emojis (e.g. flags) from
          // adding extra vertical advance and pushing the glyph
          // off-centre versus a square image.
          lineHeight: 1,
          flexShrink: 0,
        },
        ...(Array.isArray(sx) ? sx : sx ? [sx] : []),
      ]}
    >
      {showImage ? (
        <Box
          component="img"
          src={iconUrl!}
          alt=""
          // Decode off the main thread when the browser supports
          // it; falls back to sync decode otherwise.
          decoding="async"
          loading="eager"
          onError={() => setHasErrored(true)}
          sx={{
            width: '100%',
            height: '100%',
            objectFit: 'contain',
            display: 'block',
            // No background, no border - the icon IS the glyph.
            // Authors who want a tinted plate ship it inside their
            // SVG/PNG so we don't double-frame everyone.
            userSelect: 'none',
            pointerEvents: 'none',
          }}
        />
      ) : (
        <Box
          component="span"
          sx={{
            // Slightly under 1:1 so an emoji visually fills the
            // same optical area as a square image of `size` px -
            // most emoji fonts leave ~5% inner padding.
            fontSize: Math.round(size * 0.9),
            lineHeight: 1,
          }}
        >
          {emoji}
        </Box>
      )}
    </Box>
  );
}

export default memo(AppIconImpl);
