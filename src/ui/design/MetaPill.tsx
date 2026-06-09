/**
 * Shared meta-pill primitives for the session identity row.
 *
 * A meta pill is a small, light-bordered tag (icon/glyph + text) used
 * both in the post-connect topbar (`<IdentityChipBar>`) and the
 * pre-connect discovery list (`<ScanScreen>`), so a robot keeps the
 * exact same visual taxonomy before and after the user picks it.
 *
 *   [⌁ Lite]   [LAN]   [▮▮▮ 38 ms]
 *
 * `VariantTag` is the always-on first pill: the USB / Wi-Fi icon plus
 * the product SKU it maps onto (`Lite` / `Wireless`).
 */
import { Box, Typography } from '@mui/material';
import type { ReactNode } from 'react';

import { TransportChip, transportLabelOf } from './TransportChip';
import { FONT_WEIGHT, RADIUS, TYPO } from './tokens';

/** Uniform pill height so the meta row lines up cleanly. */
export const META_PILL_HEIGHT_PX = 24;

/**
 * Self-contained, light-bordered pill holding one meta module
 * (icon/glyph + text). Subtle but present: a 1px hairline + a faint
 * tint, no heavy fill. An optional `tone` tints the border + content
 * (Relay warning, Connecting info); omitted = neutral.
 */
export function MetaPill({
  children,
  tone,
  pl = 0.875,
}: {
  children: ReactNode;
  tone?: string;
  /** Left padding override - the icon-led variant pill tightens this
   *  so the glyph's own whitespace doesn't read as extra padding. */
  pl?: number;
}) {
  return (
    <Box
      sx={theme => ({
        display: 'inline-flex',
        alignItems: 'center',
        gap: 0.5,
        height: META_PILL_HEIGHT_PX,
        pl,
        pr: 0.875,
        flexShrink: 0,
        borderRadius: `${RADIUS.sm}px`,
        border: `1px solid ${tone ?? theme.palette.divider}`,
        bgcolor: theme.palette.mode === 'dark' ? 'rgba(255,255,255,0.03)' : 'rgba(0,0,0,0.02)',
        color: tone ?? 'text.secondary',
      })}
    >
      {children}
    </Box>
  );
}

/** Text inside a meta pill, inheriting the pill's (possibly toned) colour. */
export function TagLabel({ children }: { children: ReactNode }) {
  return (
    <Typography
      component="span"
      sx={{
        fontSize: TYPO.micro,
        fontWeight: FONT_WEIGHT.medium,
        letterSpacing: '0.2px',
        color: 'inherit',
        whiteSpace: 'nowrap',
        lineHeight: 1,
      }}
    >
      {children}
    </Typography>
  );
}

/**
 * Product-variant pill: USB / Wi-Fi icon + the SKU it maps onto
 * (`Lite` / `Wireless`). Always-on, neutral - it's stable identity,
 * not a health signal. Shared by the topbar and the discovery list.
 */
export function VariantTag({ transport }: { transport: string }) {
  return (
    <MetaPill pl={0.5}>
      <TransportChip transport={transport} iconOnly />
      <TagLabel>{transportLabelOf(transport)}</TagLabel>
    </MetaPill>
  );
}
