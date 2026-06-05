/**
 * Create-mode landing ("describe a vibe and let the model author it").
 *
 * A centred hero: an illustration, a multiline vibe box with a label-less
 * "Randomize" die tucked inside it, the "Generate" CTA (with cycling status
 * phrases + a faux progress sliver while it runs), and a "write it myself"
 * on-ramp into the manual form. Picking any path flips the parent into the
 * classic form. Purely presentational - all state/handlers come from props.
 */
import { useEffect, useState } from 'react';
import {
  Box,
  Button,
  IconButton,
  InputAdornment,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import AutoAwesomeOutlinedIcon from '@mui/icons-material/AutoAwesomeOutlined';

import reachyCreateProfile from '@/assets/reachy-create-profile.svg';
import { FONT_WEIGHT, RADIUS, TYPO } from '@/ui/design/tokens';

import { VIBE_MAX, diceBtnSx, genBtnSx } from './constants';

/** Pip coordinates (on a 24×24 grid) for each die face, so the "Randomize"
 *  die can actually land on a different number each roll instead of being a
 *  fixed 5-pip glyph. */
const DIE_PIPS: Record<number, ReadonlyArray<readonly [number, number]>> = {
  1: [[12, 12]],
  2: [[8, 8], [16, 16]],
  3: [[8, 8], [12, 12], [16, 16]],
  4: [[8, 8], [16, 8], [8, 16], [16, 16]],
  5: [[8, 8], [16, 8], [12, 12], [8, 16], [16, 16]],
  6: [[8, 8], [16, 8], [8, 12], [16, 12], [8, 16], [16, 16]],
};

function randomDieFace(exclude?: number): number {
  let n = 1 + Math.floor(Math.random() * 6);
  if (exclude && n === exclude) n = (n % 6) + 1;
  return n;
}

/** An outlined die face (matches the old `CasinoOutlinedIcon` aesthetic:
 *  rounded square outline + filled pips), but with a `value`-driven pip
 *  layout so the number visibly changes. Scales with `fontSize` via `1em`. */
function DieFace({ value }: { value: number }) {
  const pips = DIE_PIPS[value] ?? DIE_PIPS[1];
  return (
    <Box
      component="svg"
      viewBox="0 0 24 24"
      fill="none"
      sx={{ width: '1em', height: '1em', display: 'block' }}
    >
      <rect x={3} y={3} width={18} height={18} rx={4} stroke="currentColor" strokeWidth={1.6} />
      {pips.map(([cx, cy], i) => (
        <circle key={i} cx={cx} cy={cy} r={1.7} fill="currentColor" />
      ))}
    </Box>
  );
}

export interface CreatePersonalityHeroProps {
  vibe: string;
  onVibeChange: (value: string) => void;
  generating: boolean;
  rolling: boolean;
  genError: string | null;
  onGenerate: () => void;
  onRandom: () => void;
  /** Flip into the manual form ("I'll write it myself"). */
  onWriteManually: () => void;
}

export function CreatePersonalityHero({
  vibe,
  onVibeChange,
  generating,
  rolling,
  genError,
  onGenerate,
  onRandom,
  onWriteManually,
}: CreatePersonalityHeroProps) {
  // The visible die face. It cycles rapidly while a roll is in flight, then
  // settles on whatever it last landed on - so the number genuinely changes.
  const [dieFace, setDieFace] = useState(() => randomDieFace());
  useEffect(() => {
    if (!rolling) return;
    const id = window.setInterval(() => setDieFace(f => randomDieFace(f)), 90);
    return () => window.clearInterval(id);
  }, [rolling]);

  // Roll: nudge the face immediately (so even an instant roll shows a new
  // number) then kick off the actual randomise; the cycle effect above takes
  // over for the duration of the shake.
  const handleRandom = () => {
    setDieFace(f => randomDieFace(f));
    onRandom();
  };
  return (
    <Stack
      spacing={2.5}
      sx={{
        // Auto margins on a flex-column item centre it on BOTH axes; degrades
        // to top-anchored + scroll when content is taller than the slot.
        my: 'auto',
        mx: 'auto',
        alignItems: 'center',
        textAlign: 'center',
        width: '100%',
        maxWidth: 440,
        pt: 0,
        pb: 2,
      }}
    >
      <Stack spacing={1} sx={{ alignItems: 'center' }}>
        {/* On-brand "create a profile" illustration (same asset as the
            store's create card), a calm static hero. */}
        <Box
          component="img"
          src={reachyCreateProfile}
          alt=""
          aria-hidden
          draggable={false}
          sx={{
            width: 112,
            height: 112,
            flexShrink: 0,
            mb: 1,
            objectFit: 'contain',
            userSelect: 'none',
          }}
        />
        <Typography
          sx={{
            fontSize: TYPO.hero,
            fontWeight: FONT_WEIGHT.bold,
            letterSpacing: '-0.5px',
            lineHeight: 1.2,
          }}
        >
          Create your agent
        </Typography>
        <Typography
          sx={{
            fontSize: TYPO.body,
            color: 'text.secondary',
            lineHeight: 1.5,
            maxWidth: 300,
          }}
        >
          Describe a vibe in a line - Reachy writes the character, picks a
          voice, and brings it to life.
        </Typography>
      </Stack>

      {/* Vibe box with the label-less "Randomize" die tucked inside it. */}
      <TextField
        value={vibe}
        onChange={e => onVibeChange(e.target.value.slice(0, VIBE_MAX))}
        placeholder={
          'e.g. "a grumpy French chef robot who thinks it earned a Michelin star"'
        }
        fullWidth
        multiline
        rows={3}
        disabled={generating || rolling}
        autoFocus
        onKeyDown={e => {
          // Cmd/Ctrl+Enter submits the box; plain Enter stays a newline.
          if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
            e.preventDefault();
            onGenerate();
          }
        }}
        slotProps={{
          input: {
            sx: { borderRadius: `${RADIUS.md}px`, alignItems: 'flex-start' },
            endAdornment: (
              <InputAdornment position="end" sx={{ alignSelf: 'flex-start', mt: 0.5 }}>
                <IconButton
                  onClick={handleRandom}
                  disabled={generating || rolling}
                  aria-label="Randomize the description"
                  sx={{
                    ...diceBtnSx,
                    // While shaking it's `disabled`, but we keep it visible and
                    // tint it a light grey (rather than the dim default) so the
                    // roll reads as "working" without grabbing attention.
                    '&.Mui-disabled': rolling
                      ? { color: 'text.disabled', opacity: 1 }
                      : undefined,
                    '@keyframes diceShake': {
                      '0%, 100%': { transform: 'translateY(0) rotate(0deg)' },
                      '20%': { transform: 'translateY(-1px) rotate(-15deg)' },
                      '50%': { transform: 'translateY(0) rotate(0deg)' },
                      '80%': { transform: 'translateY(-1px) rotate(15deg)' },
                    },
                  }}
                >
                  <Box
                    sx={{
                      display: 'flex',
                      fontSize: 24,
                      animation: rolling
                        ? 'diceShake 0.4s ease-in-out infinite'
                        : 'none',
                    }}
                  >
                    <DieFace value={dieFace} />
                  </Box>
                </IconButton>
              </InputAdornment>
            ),
          },
        }}
      />
      {genError && (
        <Typography sx={{ fontSize: TYPO.xs, color: 'warning.main' }}>
          {genError}
        </Typography>
      )}
      <Button
        variant="outlined"
        color="primary"
        size="medium"
        fullWidth
        disabled={generating || rolling || vibe.trim().length === 0}
        onClick={onGenerate}
        endIcon={<AutoAwesomeOutlinedIcon />}
        sx={{ ...genBtnSx, maxWidth: 280 }}
      >
        Generate
      </Button>

      {/* Manual on-ramp: flip into the form for users who'd rather author
          by hand. Same flip the generators use, so there's a single
          continuous screen rather than two disjoint views. */}
      <Button
        variant="text"
        color="primary"
        disabled={generating || rolling}
        onClick={onWriteManually}
        disableRipple
        sx={{
          alignSelf: 'center',
          textTransform: 'none',
          fontSize: TYPO.sm,
          fontWeight: FONT_WEIGHT.medium,
          textDecoration: 'underline',
          textUnderlineOffset: 3,
          p: 0,
          minWidth: 0,
          '&:hover': { textDecoration: 'underline', bgcolor: 'transparent' },
        }}
      >
        I&rsquo;ll write it myself
      </Button>
    </Stack>
  );
}
