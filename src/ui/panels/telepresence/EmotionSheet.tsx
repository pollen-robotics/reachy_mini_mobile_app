/**
 * Bottom sheet behind the telepresence emotion button.
 *
 *   status line   ("Playing 😂 laughing…" / hint)
 *   Plutchik wheel (tap a family, 🎲 for random)
 *   emotion chips of the selected family, mild → strong
 *   dances (the non-Plutchik moves of the library)
 *
 * Emotions play daemon-side (see `useEmotionPlayer`); the sheet stays
 * open so the operator can chain them while watching the video above.
 */
import { useState } from 'react';
import { Box, Chip, Drawer, Stack, Typography } from '@mui/material';

import {
  EMOTIONS_BY_FAMILY,
  FAMILY_COLORS,
  FAMILY_LABELS,
  SPECIAL,
  randomEmotion,
  randomEmotionFromFamily,
  type EmotionDef,
  type EmotionPlayer,
  type PlutchikFamily,
} from '@/features/emotions';
import { FONT_WEIGHT, RADIUS, TYPO } from '@/ui/design/tokens';

import EmotionWheel from './EmotionWheel';

interface EmotionSheetProps {
  open: boolean;
  onClose: () => void;
  player: EmotionPlayer;
  /** Why emotions can't play right now (asleep, not live), or null. */
  blockedReason: string | null;
}

/** Intensity as 1-3 filled dots, so mild vs strong reads at a glance. */
function IntensityDots({ level, color }: { level: 1 | 2 | 3; color: string }) {
  return (
    <Stack direction="row" spacing="2px" aria-hidden sx={{ ml: 0.5 }}>
      {[1, 2, 3].map((i) => (
        <Box
          key={i}
          sx={{ width: 4, height: 4, borderRadius: '50%', bgcolor: i <= level ? color : 'action.disabled' }}
        />
      ))}
    </Stack>
  );
}

export default function EmotionSheet({ open, onClose, player, blockedReason }: EmotionSheetProps) {
  const [family, setFamily] = useState<PlutchikFamily | null>(null);
  const disabled = blockedReason !== null || player.busy;

  const play = (e: EmotionDef) => {
    if (!disabled) player.play(e);
  };

  const status = blockedReason
    ? blockedReason
    : player.playing
      ? `Playing ${player.playing.emoji} ${player.playing.label}…`
      : player.busy
        ? 'Reachy is moving…'
        : family
          ? `Pick a ${FAMILY_LABELS[family].toLowerCase()} emotion, or roll the dice.`
          : 'Pick a family on the wheel, or roll the dice.';

  const chip = (e: EmotionDef, color: string) => {
    const isPlaying = player.playing?.id === e.id;
    return (
      <Chip
        key={e.id}
        onClick={() => play(e)}
        disabled={disabled && !isPlaying}
        aria-label={`Play ${e.label}: ${e.description}`}
        label={
          <Stack direction="row" sx={{ alignItems: 'center' }}>
            <span aria-hidden style={{ fontSize: 18, marginRight: 6 }}>
              {e.emoji}
            </span>
            {e.label}
            {e.family !== SPECIAL && <IntensityDots level={e.intensity} color={color} />}
          </Stack>
        }
        sx={{
          height: 36,
          borderRadius: RADIUS.pill,
          fontSize: TYPO.sm,
          border: `1.5px solid ${isPlaying ? color : 'transparent'}`,
          bgcolor: isPlaying ? `${color}33` : 'action.hover',
          '&.Mui-disabled': { opacity: 0.45 },
        }}
      />
    );
  };

  return (
    <Drawer
      anchor="bottom"
      open={open}
      onClose={onClose}
      // Same layer as the settings sheet: above the telepresence view
      // (1250), below the session transition covers (1300).
      sx={{ zIndex: 1280 }}
      slotProps={{
        paper: {
          sx: {
            borderTopLeftRadius: RADIUS.xxl,
            borderTopRightRadius: RADIUS.xxl,
            maxHeight: '85vh',
            px: 2.5,
            pt: 1.5,
            pb: 'calc(var(--inset-bottom, env(safe-area-inset-bottom, 0px)) + 20px)',
          },
        },
        // Keep the live video readable behind the sheet.
        backdrop: { sx: { bgcolor: 'rgba(0,0,0,0.25)' } },
      }}
    >
      <Box sx={{ width: 36, height: 4, borderRadius: 2, bgcolor: 'divider', mx: 'auto', mb: 1.5 }} />
      <Stack spacing={2} sx={{ maxWidth: 480, width: '100%', mx: 'auto' }}>
        <Typography
          role="status"
          aria-live="polite"
          sx={{ fontSize: TYPO.sm, fontWeight: FONT_WEIGHT.semibold, textAlign: 'center', minHeight: 20 }}
        >
          {status}
        </Typography>

        <EmotionWheel
          selected={family}
          onSelect={(f) => setFamily((cur) => (cur === f ? null : f))}
          onRandom={() => play(family ? randomEmotionFromFamily(family) : randomEmotion())}
          disabled={disabled}
          size={Math.min(300, typeof window !== 'undefined' ? window.innerWidth - 64 : 300)}
        />

        {family && (
          <Stack spacing={1}>
            <Typography
              sx={{
                fontSize: TYPO.tiny,
                fontWeight: FONT_WEIGHT.bold,
                letterSpacing: '1px',
                textTransform: 'uppercase',
                color: 'text.secondary',
              }}
            >
              {FAMILY_LABELS[family]} · {EMOTIONS_BY_FAMILY[family].length}
            </Typography>
            <Stack direction="row" useFlexGap sx={{ flexWrap: 'wrap', gap: 1 }}>
              {EMOTIONS_BY_FAMILY[family].map((e) => chip(e, FAMILY_COLORS[family]))}
            </Stack>
          </Stack>
        )}

        <Stack spacing={1}>
          <Typography
            sx={{
              fontSize: TYPO.tiny,
              fontWeight: FONT_WEIGHT.bold,
              letterSpacing: '1px',
              textTransform: 'uppercase',
              color: 'text.secondary',
            }}
          >
            Dances
          </Typography>
          <Stack direction="row" useFlexGap sx={{ flexWrap: 'wrap', gap: 1 }}>
            {EMOTIONS_BY_FAMILY[SPECIAL].map((e) => chip(e, '#888'))}
          </Stack>
        </Stack>
      </Stack>
    </Drawer>
  );
}
