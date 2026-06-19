/**
 * Shared presentation bits for the first wake-up wizard: the headline,
 * the outlined primary button, the low-key "X doesn't work" link and the
 * per-step troubleshooting view.
 */

import { Box, Button, Stack, Typography, alpha } from '@mui/material';
import ArrowBackIosNewIcon from '@mui/icons-material/ArrowBackIosNew';

import { openExternalUrl } from '@/shared/tauri/openUrl';
import { FONT_WEIGHT, RADIUS, TYPO } from '@/ui/design/tokens';
import { DISCORD_URL, FAQ_URL } from './constants';

export function Headline({ title, caption }: { title: string; caption?: string }) {
  return (
    <Stack spacing={0.75} sx={{ alignItems: 'center', textAlign: 'center' }}>
      <Typography sx={{ fontSize: TYPO.xxl, fontWeight: FONT_WEIGHT.semibold }}>{title}</Typography>
      {caption ? (
        <Typography sx={{ fontSize: TYPO.md, color: 'text.secondary', maxWidth: 320, lineHeight: 1.5 }}>
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

/** Underlined text link in primary colour. Used for the secondary
 *  "replay" / "X doesn't work" actions that sit under the main button. */
export function SubtleLink({
  label,
  onClick,
  disabled,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <Button
      onClick={onClick}
      disabled={disabled}
      sx={{
        textTransform: 'none',
        fontWeight: FONT_WEIGHT.medium,
        fontSize: TYPO.xs,
        color: 'primary.main',
        textDecoration: 'underline',
        '&:hover': { color: 'primary.main', opacity: 0.8, textDecoration: 'underline' },
      }}
    >
      {label}
    </Button>
  );
}

/** Low-key "X doesn't work" link that opens a step's troubleshooting view. */
export function TroubleLink({ label, onClick }: { label: string; onClick: () => void }) {
  return <SubtleLink label={label} onClick={onClick} />;
}

/** Thin separator between two inline links. */
export function LinkDivider() {
  return <Box sx={{ width: '1px', height: 14, bgcolor: 'divider' }} />;
}

function FooterLink({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <Button
      onClick={onClick}
      sx={{ textTransform: 'none', fontWeight: FONT_WEIGHT.medium, fontSize: TYPO.xs, color: 'primary.main' }}
    >
      {label}
    </Button>
  );
}

/** Per-step "something's wrong" view: numbered tips + FAQ/Discord footer. */
export function TroubleshootView({ title, tips, onBack }: { title: string; tips: string[]; onBack: () => void }) {
  return (
    <Stack spacing={2.5} sx={{ alignItems: 'center', width: '100%' }}>
      <Typography sx={{ fontSize: TYPO.xxl, fontWeight: FONT_WEIGHT.semibold, textAlign: 'center' }}>{title}</Typography>

      <Stack spacing={1.25} sx={{ width: '100%', maxWidth: 360 }}>
        {tips.map((tip, i) => (
          <Stack
            key={i}
            direction="row"
            spacing={1.5}
            sx={{
              alignItems: 'flex-start',
              px: 2,
              py: 1.5,
              borderRadius: `${RADIUS.lg}px`,
              bgcolor: theme => alpha(theme.palette.text.primary, 0.03),
              border: theme => `1px solid ${theme.palette.divider}`,
            }}
          >
            <Typography sx={{ fontSize: TYPO.lg, fontWeight: FONT_WEIGHT.bold, color: 'primary.main', lineHeight: 1.4 }}>
              {i + 1}
            </Typography>
            <Typography sx={{ fontSize: TYPO.sm, color: 'text.secondary', lineHeight: 1.5 }}>{tip}</Typography>
          </Stack>
        ))}
      </Stack>

      <Box sx={{ width: '100%', maxWidth: 360, borderTop: theme => `1px solid ${theme.palette.divider}`, pt: 1.5 }}>
        <Stack direction="row" spacing={1} sx={{ justifyContent: 'center', flexWrap: 'wrap' }}>
          <FooterLink label="Check the FAQ ↗" onClick={() => void openExternalUrl(FAQ_URL)} />
          <FooterLink label="Discord support ↗" onClick={() => void openExternalUrl(DISCORD_URL)} />
        </Stack>
      </Box>

      <Box sx={{ width: '100%', maxWidth: 320 }}>
        <PrimaryButton startIcon={<ArrowBackIosNewIcon sx={{ fontSize: 14 }} />} onClick={onBack}>
          Back to test
        </PrimaryButton>
      </Box>
    </Stack>
  );
}
