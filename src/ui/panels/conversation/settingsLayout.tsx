/**
 * Layout primitives of the Settings panel, shared by its sections
 * (`ConversationSettingsPanel`, `NfcSettingsSection`). Mirror the store's
 * "section header + paper card" rhythm so the two body-swap surfaces feel
 * like siblings.
 */
import { Box, Stack, Typography, alpha } from '@mui/material';

import { FONT_WEIGHT, RADIUS, TYPO } from '@/ui/design/tokens';

export function Section({
  label,
  blurb,
  children,
}: {
  label: string;
  blurb?: string;
  children: React.ReactNode;
}) {
  return (
    <Box>
      <Stack sx={{ px: 3, mb: 1.25 }}>
        <Typography
          sx={{
            fontSize: TYPO.lg,
            fontWeight: FONT_WEIGHT.semibold,
            letterSpacing: '-0.2px',
            lineHeight: 1.2,
          }}
        >
          {label}
        </Typography>
        {blurb && (
          <Typography sx={{ fontSize: TYPO.xs, color: 'text.secondary', mt: 0.25 }}>
            {blurb}
          </Typography>
        )}
      </Stack>
      {children}
    </Box>
  );
}

/** Top-tier group heading ("Robot" / "Conversation") that splits the
 *  panel into its two scopes. Sized ABOVE the `Section` labels
 *  (`TYPO.xl` vs `TYPO.lg`) so the hierarchy reads top-down:
 *  panel title (xxl) > group (xl) > section (lg) > rows. */
export function GroupLabel({ children }: { children: React.ReactNode }) {
  return (
    <Typography
      sx={{
        px: 3,
        // Pull the following section up so the heading hugs its own
        // group (the Stack's `spacing={4}` would otherwise leave it
        // floating equidistant between groups, breaking the grouping).
        mb: -2,
        fontSize: TYPO.xl,
        fontWeight: FONT_WEIGHT.bold,
        letterSpacing: '-0.2px',
        lineHeight: 1.2,
        color: 'text.primary',
      }}
    >
      {children}
    </Typography>
  );
}

/** Paper card wrapper with the app's "white island on grey" look,
 *  inset by the standard `px: 3` gutter. */
export function Card({ children }: { children: React.ReactNode }) {
  return (
    <Box sx={{ px: 3 }}>
      <Box
        sx={theme => ({
          borderRadius: `${RADIUS.lg}px`,
          bgcolor: 'background.paper',
          border: `1px solid ${theme.palette.divider}`,
          overflow: 'hidden',
        })}
      >
        {children}
      </Box>
    </Box>
  );
}

interface RowProps {
  children: React.ReactNode;
  /** Render as a tappable button (rows that act) vs a static div. */
  as?: 'div' | 'button';
  /** Draw a top hairline (for stacked rows inside a Card). */
  divider?: boolean;
  /** Standalone paper card row (its own surface + border), used for the
   *  clear-memory affordance which sits outside the grouped Card. */
  card?: boolean;
  disabled?: boolean;
  onClick?: () => void;
  'aria-label'?: string;
  'aria-pressed'?: boolean;
}

export function Row({
  children,
  as = 'div',
  divider = false,
  card = false,
  disabled = false,
  ...rest
}: RowProps) {
  const interactive = as === 'button';
  return (
    <Box
      component={interactive ? 'button' : 'div'}
      type={interactive ? 'button' : undefined}
      disabled={interactive ? disabled : undefined}
      {...rest}
      sx={theme => ({
        width: '100%',
        display: 'flex',
        alignItems: 'center',
        gap: 1.5,
        px: 2,
        py: 1.5,
        textAlign: 'left',
        appearance: 'none',
        font: 'inherit',
        color: 'text.primary',
        bgcolor: card ? 'background.paper' : 'transparent',
        border: card ? `1px solid ${theme.palette.divider}` : 'none',
        borderRadius: card ? `${RADIUS.lg}px` : 0,
        borderTop: divider ? `1px solid ${theme.palette.divider}` : 'none',
        cursor: interactive && !disabled ? 'pointer' : 'default',
        opacity: disabled ? 0.5 : 1,
        transition: 'background-color 0.12s ease',
        WebkitTapHighlightColor: 'transparent',
        ...(interactive && !disabled
          ? { '&:hover': { bgcolor: alpha(theme.palette.text.primary, 0.03) } }
          : {}),
      })}
    >
      {children}
    </Box>
  );
}

export function ghostBtnSx(color: string) {
  return {
    flex: 1,
    appearance: 'none',
    cursor: 'pointer',
    font: 'inherit',
    py: 1,
    borderRadius: `${RADIUS.md}px`,
    bgcolor: 'transparent',
    border: `1px solid ${alpha(color, 0.4)}`,
    color,
    fontSize: TYPO.sm,
    fontWeight: FONT_WEIGHT.medium,
    WebkitTapHighlightColor: 'transparent',
    '&:active': { transform: 'scale(0.99)' },
  } as const;
}
