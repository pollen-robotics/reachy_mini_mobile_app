/**
 * Canonical "illustrated state" layout.
 *
 * The single source of truth for the app's full-screen, single-purpose
 * states - errors, empty states, blocking gates, wizard steps - that
 * share the same vertical recipe:
 *
 *   illustration (hero)
 *   title
 *   description (optional)
 *   actions     (optional: buttons / links)
 *
 * Standardises the illustration size, the type scale (title / body),
 * the centred column max-width and the inter-block rhythm so every such
 * surface reads as one family instead of each drifting with its own
 * hand-rolled sizes.
 *
 * Scope: this component owns ONLY the inner centred column. The caller
 * provides the centring + safe-area context (e.g. a flex parent with
 * `justifyContent: center`), so the same block works inside a tab body,
 * a fixed overlay, or a scrollable screen.
 */
import type { ReactNode } from 'react';
import { Box, Stack, Typography } from '@mui/material';

import { LAYOUT } from './tokens';

interface IllustratedStateProps {
  /**
   * Hero visual. Either an image `src` string (rendered into a square
   * `<img>` for you) or an arbitrary node (a carousel, a spinner, an
   * MUI icon) when the state needs something other than a static image.
   */
  illustration: string | ReactNode;
  /** Alt text when `illustration` is an image src. Empty = decorative. */
  illustrationAlt?: string;
  /** Square illustration size in px. Defaults to the hero size (160). */
  illustrationSize?: number;
  /** Main heading. Rendered as an `<h2>`. */
  title: ReactNode;
  /** Optional supporting line under the title. */
  description?: ReactNode;
  /** Optional actions (buttons / links), stacked under the text. */
  children?: ReactNode;
}

export default function IllustratedState({
  illustration,
  illustrationAlt = '',
  illustrationSize = LAYOUT.heroSize,
  title,
  description,
  children,
}: IllustratedStateProps) {
  return (
    <Stack
      sx={{
        width: '100%',
        maxWidth: 360,
        alignItems: 'center',
        textAlign: 'center',
        gap: 2,
      }}
    >
      <Box
        sx={{
          width: illustrationSize,
          height: illustrationSize,
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        {typeof illustration === 'string' ? (
          <Box
            component="img"
            src={illustration}
            alt={illustrationAlt}
            aria-hidden={illustrationAlt === '' ? true : undefined}
            sx={{
              width: '100%',
              height: '100%',
              objectFit: 'contain',
              display: 'block',
              userSelect: 'none',
              pointerEvents: 'none',
            }}
          />
        ) : (
          illustration
        )}
      </Box>

      <Stack spacing={1} sx={{ alignItems: 'center' }}>
        {/* `h3` is the theme's canonical screen-title variant
            (TYPO.xxl bold); `component="h2"` keeps the heading level
            correct for the document outline. */}
        <Typography variant="h3" component="h2" sx={{ color: 'text.primary', m: 0 }}>
          {title}
        </Typography>
        {description ? (
          <Typography
            variant="body1"
            sx={{ color: 'text.secondary', maxWidth: 320, wordBreak: 'break-word' }}
          >
            {description}
          </Typography>
        ) : null}
      </Stack>

      {children ? (
        <Stack spacing={1} sx={{ width: '100%', alignItems: 'center', mt: 1 }}>
          {children}
        </Stack>
      ) : null}
    </Stack>
  );
}
