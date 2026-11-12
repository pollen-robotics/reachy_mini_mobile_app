/**
 * Small presentational bits shared by the Bluetooth tools' steps
 * (`BleToolsScreen` and the views split out next to it), so every step
 * reads with the same headline / button / hero look.
 */
import { Box, Button, Stack, Typography, alpha } from '@mui/material';

import { FONT_WEIGHT, LAYOUT, RADIUS, TYPO } from '@/ui/design/tokens';

export function Headline({ title, caption }: { title: string; caption?: string }) {
  return (
    <Stack spacing={0.75} sx={{ alignItems: 'center', textAlign: 'center' }}>
      <Typography sx={{ fontSize: TYPO.xl, fontWeight: FONT_WEIGHT.semibold }}>{title}</Typography>
      {caption ? (
        <Typography sx={{ fontSize: TYPO.sm, color: 'text.secondary', maxWidth: 300, lineHeight: 1.5 }}>
          {caption}
        </Typography>
      ) : null}
    </Stack>
  );
}

export function PrimaryButton(props: React.ComponentProps<typeof Button>) {
  return (
    <Button
      variant="outlined"
      color="primary"
      fullWidth
      disableElevation
      {...props}
      sx={{
        textTransform: 'none',
        fontSize: TYPO.md,
        fontWeight: FONT_WEIGHT.semibold,
        borderRadius: `${RADIUS.md}px`,
        py: 1.25,
        ...props.sx,
      }}
    />
  );
}

export function TextButton(props: React.ComponentProps<typeof Button>) {
  return (
    <Button
      variant="text"
      {...props}
      sx={{ textTransform: 'none', fontWeight: FONT_WEIGHT.semibold, ...props.sx }}
    />
  );
}

export function IconHero({ children, tint }: { children: React.ReactNode; tint?: string }) {
  return (
    <Box
      sx={{
        width: LAYOUT.heroSizeSmall,
        height: LAYOUT.heroSizeSmall,
        borderRadius: RADIUS.circle,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        bgcolor: theme => alpha(tint ?? theme.palette.primary.main, 0.1),
        color: tint ?? 'primary.main',
      }}
    >
      {children}
    </Box>
  );
}

/** Framed card for the version / status rows. */
export function InfoCard({ children }: { children: React.ReactNode }) {
  return (
    <Stack
      spacing={1}
      sx={theme => ({
        width: '100%',
        maxWidth: 320,
        p: 2,
        borderRadius: `${RADIUS.md}px`,
        border: `1px solid ${theme.palette.divider}`,
        bgcolor: 'background.paper',
      })}
    >
      {children}
    </Stack>
  );
}
