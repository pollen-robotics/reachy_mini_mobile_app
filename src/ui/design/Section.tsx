/**
 * Grouped section header + framed body.
 *
 * Visual primitive shared by every "metadata sub-card" surface in
 * the mobile shell:
 *
 *   CONNECTION              ← uppercase, letter-spaced sub-header
 *   ┌──────────────────┐
 *   │ ● LAN     11 Mbps│   ← caller-owned children (rows, etc.)
 *   │ Remote IP  …     │
 *   └──────────────────┘
 *
 * The header label uses the small caps-ish typography we use across
 * the app (matching `RobotPanel.title` and the in-overlay subheaders),
 * and the body sits inside a rounded card with a divider border +
 * paper bg so consecutive children read as one grouped unit.
 *
 * Two consumers today: `RobotInfoPanel` (debug-grade signals) and
 * `HelpAndSupportOverlay` (help / community / legal links). Extracted
 * here so both surfaces share the same visual rhythm without one
 * importing UI from the other.
 */
import { Box, Stack, Typography } from '@mui/material';
import type { ReactNode } from 'react';

import { FONT_WEIGHT, RADIUS, TYPO } from './tokens';

interface SectionProps {
  /**
   * Section label rendered above the framed body in uppercase /
   * letter-spaced typography. Pass `null` to suppress the header
   * and render a "headerless" framed card (rare; useful when the
   * Section is the first surface and the host already carries
   * the heading).
   */
  label: string | null;
  /**
   * Inner content. Typically a vertical stack of rows; the rows
   * own their own dividers (`:not(:last-of-type) { borderBottom }`
   * is the convention) so the section doesn't need to inject
   * separators between siblings.
   */
  children: ReactNode;
}

export default function Section({ label, children }: SectionProps) {
  return (
    <Stack spacing={0.75}>
      {label !== null && (
        <Typography
          component="h3"
          sx={{
            fontSize: TYPO.tiny,
            fontWeight: FONT_WEIGHT.semibold,
            color: 'text.secondary',
            letterSpacing: '0.6px',
            textTransform: 'uppercase',
            lineHeight: 1.2,
            pl: 0.25,
          }}
        >
          {label}
        </Typography>
      )}
      <Box
        sx={(theme) => ({
          borderRadius: `${RADIUS.lg}px`,
          border: `1px solid ${theme.palette.divider}`,
          bgcolor: theme.palette.background.paper,
          overflow: 'hidden',
        })}
      >
        {children}
      </Box>
    </Stack>
  );
}
