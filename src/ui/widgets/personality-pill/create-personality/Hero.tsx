/**
 * Create-mode landing ("describe a personality and let the model author it").
 *
 * A centred hero: an illustration, a question-shaped title, a one-sentence
 * pitch, the vibe CARD (see below), and a "write it myself" on-ramp into the
 * manual form. The primary CTA is NOT here - it lives in the bottom action
 * plate with every other screen's (see `Actions.tsx`). Purely presentational,
 * all state/handlers come from props.
 *
 * The vibe card
 * ─────────────
 * The input, the "Surprise me" idea button and the character counter are ONE
 * surface: a white `background.paper` card with a divider hairline, which is
 * the app's house treatment for content islands on the grey canvas (cf. the
 * store intro's marquee tiles). Two things this buys over the previous
 * outlined `TextField` plus a bare meta row underneath it:
 *
 *   - The field stops being the only hard-bordered box on the screen, which
 *     it had no business being when it isn't the primary action.
 *   - "Surprise me" and the counter visibly BELONG to the input. Loose under
 *     the field they read as page-level chrome, and the counter in particular
 *     looked like stray debug output. Inside the card, the die is scoped to
 *     the thing it rewrites and the count to the thing it measures.
 *
 * The die stays labelled and stays out of the input itself: it only drafts a
 * one-line IDEA, whereas the plate's CTA authors the whole personality, so the
 * two must not read as interchangeable magic.
 */
import { useEffect, useState } from 'react';
import { Box, Button, InputBase, Stack, Typography } from '@mui/material';

import reachyCreateProfile from '@/assets/reachy-create-profile.svg';
import { FONT_WEIGHT, RADIUS, TYPO } from '@/ui/design/tokens';

import { VIBE_MAX, ideaBtnSx } from './constants';

/** Illustration size. Bigger than the body text's rhythm would suggest on
 *  purpose: it's the screen's only figure, and at the previous 112px it read
 *  as an icon that had wandered up from a list rather than as a hero. */
const ILLUSTRATION_PX = 140;

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
  const inert = generating || rolling;
  return (
    <Stack
      sx={{
        // Auto margins on a flex-column item centre it on BOTH axes; degrades
        // to top-anchored + scroll when content is taller than the slot.
        my: 'auto',
        mx: 'auto',
        alignItems: 'center',
        textAlign: 'center',
        width: '100%',
        maxWidth: 440,
        pb: 2,
      }}
    >
      {/* On-brand "create a profile" illustration (same asset as the
          store's create card), a calm static hero. */}
      <Box
        component="img"
        src={reachyCreateProfile}
        alt=""
        aria-hidden
        draggable={false}
        sx={{
          width: ILLUSTRATION_PX,
          height: ILLUSTRATION_PX,
          flexShrink: 0,
          objectFit: 'contain',
          userSelect: 'none',
        }}
      />
      {/* Question-shaped title, so the card below reads as visibly being its
          answer rather than as a form to fill in. `balance` evens out the two
          lines at any width instead of leaving one orphan word. */}
      <Typography
        sx={{
          mt: 3,
          fontSize: TYPO.hero,
          fontWeight: FONT_WEIGHT.bold,
          letterSpacing: '-0.5px',
          lineHeight: 1.2,
          textWrap: 'balance',
        }}
      >
        Who should Reachy be?
      </Typography>
      {/* Names the three things that will actually be authored, so the
          (~1 min) portrait bake isn't a surprise, and leaves "bring it to
          life" free for the CTA instead of spending it here. */}
      <Typography
        sx={{
          mt: 1,
          fontSize: TYPO.body,
          color: 'text.secondary',
          lineHeight: 1.5,
          maxWidth: 300,
        }}
      >
        One sentence is enough. Reachy writes the personality, picks the
        voice, and draws the portrait.
      </Typography>

      {/* THE VIBE CARD (see the file header). One paper island holding the
          input plus its two satellites. The generous `mt` is what separates
          the "pitch" group above from the "answer" group here - the previous
          flat 2.5 spacing between every element grouped nothing. */}
      <Box
        sx={{
          mt: 4,
          width: '100%',
          textAlign: 'left',
          bgcolor: 'background.paper',
          border: t => `1px solid ${t.palette.divider}`,
          borderRadius: `${RADIUS.xl}px`,
          // Focus lives on the CARD, not the inner input: the input has no
          // border of its own to light up. Painted as a border colour swap +
          // an inset ring so the 2px-looking emphasis costs no layout shift.
          transition: 'border-color 0.15s ease, box-shadow 0.15s ease',
          '&:focus-within': {
            borderColor: 'primary.main',
            boxShadow: t => `inset 0 0 0 1px ${t.palette.primary.main}`,
          },
          opacity: inert ? 0.7 : 1,
        }}
      >
        <InputBase
          value={vibe}
          onChange={e => onVibeChange(e.target.value.slice(0, VIBE_MAX))}
          // No `e.g.` wrapper and no quotes: on a 3-row mobile box they cost a
          // whole line, and "robot" was redundant (it already is one).
          placeholder="a grumpy French chef who thinks he earned a Michelin star"
          multiline
          rows={3}
          disabled={inert}
          onKeyDown={e => {
            // Cmd/Ctrl+Enter submits the box; plain Enter stays a newline.
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
              e.preventDefault();
              onGenerate();
            }
          }}
          // `InputBase` rather than a `TextField`: we want the raw input with
          // no decoration of its own, since the card around it IS the
          // decoration. A TextField would fight us with its own border /
          // underline and its notch machinery.
          sx={{
            width: '100%',
            px: 2,
            pt: 1.75,
            fontSize: TYPO.body,
            lineHeight: 1.5,
            // MUI's default placeholder is `opacity: 0.42`, which on a white
            // card reads as barely-there. Pin it to the same tone as the
            // pitch above so the example is actually legible.
            '& .MuiInputBase-input::placeholder': {
              color: 'text.secondary',
              opacity: 0.75,
            },
          }}
        />

        {/* Card footer: the die (left, the action) and the count (right, the
            measure). The count is ALWAYS on, "0 / 240" included: it's the only
            place the clamp is stated, so hiding it until the first keystroke
            meant the budget only showed up once you'd started spending it. */}
        <Stack direction="row" sx={{ alignItems: 'center', pl: 1.25, pr: 2, pb: 1.25 }}>
          <Button
            variant="text"
            onClick={handleRandom}
            disabled={inert}
            disableRipple
            startIcon={
              <Box
                sx={{
                  display: 'flex',
                  fontSize: 18,
                  animation: rolling
                    ? 'diceShake 0.4s ease-in-out infinite'
                    : 'none',
                  '@keyframes diceShake': {
                    '0%, 100%': { transform: 'translateY(0) rotate(0deg)' },
                    '20%': { transform: 'translateY(-1px) rotate(-15deg)' },
                    '50%': { transform: 'translateY(0) rotate(0deg)' },
                    '80%': { transform: 'translateY(-1px) rotate(15deg)' },
                  },
                }}
              >
                <DieFace value={dieFace} />
              </Box>
            }
            sx={{
              ...ideaBtnSx,
              // Mid-roll the button is `disabled`, but we keep it legible in a
              // light grey (not the dim default) so the shake reads as
              // "working" without shouting. The label never changes - a
              // "Rolling…" swap would resize the button and shift the row.
              '&.Mui-disabled': rolling
                ? { color: 'text.disabled', opacity: 1 }
                : undefined,
            }}
          >
            Surprise me
          </Button>
          <Typography
            sx={{
              ml: 'auto',
              fontSize: TYPO.micro,
              fontVariantNumeric: 'tabular-nums',
              color: vibe.length >= VIBE_MAX ? 'warning.main' : 'text.secondary',
              opacity: 0.7,
            }}
          >
            {vibe.length} / {VIBE_MAX}
          </Typography>
        </Stack>
      </Box>

      {genError && (
        <Typography sx={{ mt: 1.5, fontSize: TYPO.xs, color: 'warning.main' }}>
          {genError}
        </Typography>
      )}

      {/* Manual on-ramp: flip into the form for users who'd rather author
          by hand. Same flip the generators use, so there's a single
          continuous screen rather than two disjoint views. Now the only
          free-floating action in the column, the CTA having moved to the
          bottom plate - so there's no ambiguity about which is primary. */}
      <Button
        variant="text"
        color="primary"
        disabled={inert}
        onClick={onWriteManually}
        disableRipple
        sx={{
          mt: 3.5,
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
