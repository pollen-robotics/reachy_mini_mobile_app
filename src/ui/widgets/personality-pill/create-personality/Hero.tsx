/**
 * Create-mode landing ("describe a vibe and let the model author it").
 *
 * A centred hero: an illustration, a multiline vibe box with a label-less
 * "Randomize" die tucked inside it, the "Generate" CTA (with cycling status
 * phrases + a faux progress sliver while it runs), and a "write it myself"
 * on-ramp into the manual form. Picking any path flips the parent into the
 * classic form. Purely presentational - all state/handlers come from props.
 */
import {
  Box,
  Button,
  CircularProgress,
  IconButton,
  InputAdornment,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import AutoAwesomeOutlinedIcon from '@mui/icons-material/AutoAwesomeOutlined';
import CasinoOutlinedIcon from '@mui/icons-material/CasinoOutlined';

import reachyCreateProfile from '@/assets/reachy-create-profile.svg';
import { FONT_WEIGHT, RADIUS, TYPO } from '@/ui/design/tokens';

import { GEN_STEPS, VIBE_MAX, diceBtnSx, genBtnSx } from './constants';

export interface CreatePersonalityHeroProps {
  vibe: string;
  onVibeChange: (value: string) => void;
  generating: boolean;
  rolling: boolean;
  /** Which generator is running (gates the spinner/phrases). */
  genMode: 'describe' | 'random' | null;
  genStep: number;
  genProgress: number;
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
  genMode,
  genStep,
  genProgress,
  genError,
  onGenerate,
  onRandom,
  onWriteManually,
}: CreatePersonalityHeroProps) {
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
        py: 2,
      }}
    >
      <Stack spacing={1.25} sx={{ alignItems: 'center' }}>
        {/* On-brand "create a profile" illustration (same asset as the
            store's create card), a calm static hero. */}
        <Box
          component="img"
          src={reachyCreateProfile}
          alt=""
          aria-hidden
          draggable={false}
          sx={{
            width: 132,
            height: 132,
            flexShrink: 0,
            mb: 1.5,
            objectFit: 'contain',
            userSelect: 'none',
          }}
        />
        <Typography
          sx={{
            fontSize: TYPO.lg,
            fontWeight: FONT_WEIGHT.bold,
            letterSpacing: '-0.3px',
            lineHeight: 1.25,
          }}
        >
          Dream up a character
        </Typography>
        <Typography sx={{ fontSize: TYPO.sm, color: 'text.secondary', maxWidth: 320 }}>
          Toss out an idea and watch Reachy bring it to life.
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
                  onClick={onRandom}
                  disabled={generating || rolling}
                  aria-label="Randomize the description"
                  sx={diceBtnSx}
                >
                  {rolling ? (
                    <CircularProgress size={18} color="inherit" />
                  ) : (
                    <CasinoOutlinedIcon />
                  )}
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
        endIcon={
          genMode === 'describe' ? (
            <CircularProgress size={16} color="inherit" />
          ) : (
            <AutoAwesomeOutlinedIcon />
          )
        }
        sx={{ ...genBtnSx, maxWidth: 280, position: 'relative', overflow: 'hidden' }}
      >
        {/* Light progress sliver pinned to the button's top edge. Purely
            indicative - the real call duration is unknown. */}
        {genMode === 'describe' && (
          <Box
            aria-hidden
            sx={{
              position: 'absolute',
              top: 0,
              left: 0,
              height: 2,
              width: `${genProgress * 100}%`,
              bgcolor: 'primary.main',
              opacity: 0.5,
              transition: 'width 0.12s linear',
            }}
          />
        )}
        {genMode === 'describe' ? GEN_STEPS[genStep] : 'Generate'}
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
