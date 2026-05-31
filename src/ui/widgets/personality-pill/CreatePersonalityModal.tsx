/**
 * CreatePersonalityModal - full-screen "author your own persona" form.
 *
 * The personalities feature already ships the whole data layer
 * (`addCustomPersonality`, localStorage persistence, the `custom:<slug>`
 * id form) but never exposed a UI to author one. This overlay closes
 * that gap: it collects the four user-facing knobs of a persona
 * (name, tagline, instructions, voice, glow), hands them to
 * `addCustomPersonality`, then immediately makes the new persona the
 * active one so the next conversation picks it up.
 *
 * Visual contract
 * ───────────────
 * Full-screen overlay (`position: fixed; inset: 0`) mirroring the
 * `EulaConsentModal` / `HelpAndSupportOverlay` pattern rather than a
 * MUI `Dialog`, because the rest of the app does fullscreen-from-the-
 * root that way and `Dialog`'s focus-trap fights the WebView keyboard
 * on mobile.
 *
 * Layout: a sticky header (title + close), a scrollable body with a
 * live avatar preview + the form fields, and a sticky action plate
 * holding the primary "Create" CTA. The CTA stays disabled until the
 * two required fields (name + instructions) carry content.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Box,
  Button,
  IconButton,
  InputAdornment,
  Stack,
  TextField,
  Typography,
  alpha,
  useTheme,
} from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import VolumeUpRoundedIcon from '@mui/icons-material/VolumeUpRounded';
import DeleteOutlineRoundedIcon from '@mui/icons-material/DeleteOutlineRounded';

import {
  AVAILABLE_VOICES,
  DEFAULT_GLOW,
  type Personality,
  addCustomPersonality,
  getVoiceSampleUrl,
  removeCustomPersonality,
  setActivePersonality,
  updateCustomPersonality,
} from '@/features/personalities';
import { FONT_WEIGHT, LAYOUT, RADIUS, TYPO } from '@/ui/design/tokens';

interface CreatePersonalityModalProps {
  /**
   * Fired when the overlay should close WITHOUT having created a
   * persona (close button, backdrop, Escape). The host clears its
   * open state in response.
   */
  onCancel: () => void;
  /**
   * Fired right after a persona is created/updated AND made active.
   * On create the host typically closes both the overlay and the
   * picker so the user lands back on the orb; on edit it just closes
   * the form back to the picker.
   */
  onCreated: () => void;
  /**
   * Edit an existing custom persona instead of authoring a new one.
   * When set the form pre-fills from this persona, the CTA becomes
   * "Save & use" (writing back to the same id), and a destructive
   * "Delete" affordance appears. Null/undefined = create mode.
   */
  editing?: Personality | null;
  /**
   * Fired after the edited persona has been deleted (edit mode only).
   * The host closes the form back to the picker, where the card is
   * now gone.
   */
  onDeleted?: () => void;
  /**
   * Render in-flow inside the host's body slot instead of as a
   * full-screen `position: fixed` overlay. In embedded mode the
   * persistent personality band stays visible ABOVE this form and
   * owns the title + the close affordance (its "+" becomes a "✕"), so
   * the modal drops its own sticky header to avoid a duplicate title /
   * close. Used by `ConversationPanel`; the standalone fullscreen mode
   * is kept for any caller that wants the classic overlay.
   */
  embedded?: boolean;
}

const NAME_MAX = 24;
const TAGLINE_MAX = 60;

/** Shared look for the primary CTA (outlined primary, comfortable
 *  tap target). Reused so the standalone "Create & use" button and the
 *  "Save & use" button in the edit row stay byte-identical. */
const ctaSx = {
  textTransform: 'none',
  fontSize: TYPO.md,
  fontWeight: FONT_WEIGHT.semibold,
  py: 1.25,
  borderWidth: 1.5,
  '&:hover': { borderWidth: 1.5 },
  borderRadius: `${RADIUS.md}px`,
} as const;

export function CreatePersonalityModal({
  onCancel,
  onCreated,
  editing = null,
  onDeleted,
  embedded = false,
}: CreatePersonalityModalProps) {
  const theme = useTheme();
  const isEdit = editing !== null;

  // Seed from the persona under edit when present. Lazy initialisers
  // are enough because the host remounts the form (keyed by persona id
  // / "create") whenever the target changes.
  const [name, setName] = useState(() => editing?.name ?? '');
  const [tagline, setTagline] = useState(() => editing?.tagline ?? '');
  const [instructions, setInstructions] = useState(() => editing?.instructions ?? '');
  const [voice, setVoice] = useState<string>(
    () => editing?.voice || AVAILABLE_VOICES[0],
  );

  // Two-step delete confirmation (edit mode only): the first tap arms
  // it, the second commits. Deleting a custom persona destroys the
  // user's own work, so we make it deliberate rather than one-tap.
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  // Voice audition: tapping a voice chip both selects it AND plays a
  // short bundled sample so the user hears the voice before committing.
  // A single shared <Audio> element is reused; selecting another voice
  // (or re-tapping the same one) stops the previous clip first.
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [playingVoice, setPlayingVoice] = useState<string | null>(null);

  const stopSample = useCallback(() => {
    const audio = audioRef.current;
    if (audio) {
      audio.pause();
      audio.currentTime = 0;
    }
    setPlayingVoice(null);
  }, []);

  const selectVoice = useCallback(
    (v: string) => {
      setVoice(v);
      stopSample();
      const url = getVoiceSampleUrl(v);
      if (!url) return;
      const audio = new Audio(url);
      audioRef.current = audio;
      audio.addEventListener('ended', () =>
        setPlayingVoice(prev => (prev === v ? null : prev)),
      );
      setPlayingVoice(v);
      void audio.play().catch(() =>
        setPlayingVoice(prev => (prev === v ? null : prev)),
      );
    },
    [stopSample],
  );

  // Stop + release any in-flight clip when the form unmounts (e.g. the
  // user closes it via the band's "✕" while a sample is still playing).
  useEffect(
    () => () => {
      const audio = audioRef.current;
      if (audio) audio.pause();
      audioRef.current = null;
    },
    [],
  );

  const canSubmit = name.trim().length > 0 && instructions.trim().length > 0;

  const handleSubmit = () => {
    if (!canSubmit) return;
    const input = {
      name: name.trim(),
      tagline: tagline.trim(),
      instructions: instructions.trim(),
      voice,
      // Accent colour is no longer user-facing - the picker UI was
      // dropped (the avatar isn't tinted anywhere the user sees while
      // authoring). We still hand the data layer the default glow so
      // the persona shape stays unchanged.
      glow: DEFAULT_GLOW,
    };
    if (isEdit && editing) {
      updateCustomPersonality(editing.id, input);
      // Make the edited persona the active one ("Save & use"); the id
      // is stable across the update so this resolves cleanly.
      setActivePersonality(editing.id);
    } else {
      const created = addCustomPersonality(input);
      setActivePersonality(created.id);
    }
    onCreated();
  };

  const handleDelete = () => {
    if (!isEdit || !editing) return;
    if (!confirmingDelete) {
      setConfirmingDelete(true);
      return;
    }
    removeCustomPersonality(editing.id);
    (onDeleted ?? onCreated)();
  };

  // A char counter rendered as an end adornment so it sits INSIDE the
  // field, flush right, instead of as a helperText line under it (which
  // added a row of vertical chrome per field). `pr: 1` trims the input's
  // own right padding so the counter hugs the edge.
  const counterSlotProps = (len: number, max: number) => ({
    input: {
      sx: { borderRadius: `${RADIUS.md}px`, pr: 1 },
      endAdornment: (
        <InputAdornment position="end">
          <Typography
            sx={{
              fontSize: TYPO.xs,
              color: len >= max ? 'warning.main' : 'text.secondary',
              fontVariantNumeric: 'tabular-nums',
              whiteSpace: 'nowrap',
            }}
          >
            {len}/{max}
          </Typography>
        </InputAdornment>
      ),
    },
  });

  return (
    <Box
      role={embedded ? 'group' : 'dialog'}
      aria-modal={embedded ? undefined : 'true'}
      aria-label={embedded ? 'Create a personality' : undefined}
      aria-labelledby={embedded ? undefined : 'create-personality-title'}
      sx={
        embedded
          ? {
              // In-flow: fill the host's body slot, sitting BELOW the
              // persistent personality band (which owns title + close).
              // Full-bleed escape (`100vw` + negative margin) so we
              // break out of the host's `px` gutter - otherwise the
              // scroll container is inset and its scrollbar floats ~24px
              // off the app's right edge. The fields keep their own
              // inner padding for breathing room; only the scroll
              // surface goes edge-to-edge.
              flex: 1,
              minHeight: 0,
              width: '100vw',
              mx: 'calc(50% - 50vw)',
              bgcolor: 'background.default',
              color: 'text.primary',
              display: 'flex',
              flexDirection: 'column',
            }
          : {
              position: 'fixed',
              inset: 0,
              zIndex: 1500,
              bgcolor: 'background.default',
              color: 'text.primary',
              display: 'flex',
              flexDirection: 'column',
              pt: `calc(${LAYOUT.safeAreaTop} + 8px)`,
              pb: `calc(${LAYOUT.safeAreaBottom} + 8px)`,
            }
      }
    >
      {/* Sticky header: title + close. Lives outside the scroll body
          so it stays put while the form scrolls under it. Suppressed in
          embedded mode - the personality band above owns the title and
          the close affordance (its "+" morphs into a "✕"), so a second
          header here would just duplicate them. */}
      {!embedded && (
        <Stack
          direction="row"
          sx={{
            alignItems: 'center',
            justifyContent: 'space-between',
            px: 2,
            py: 1,
            borderBottom: t => `1px solid ${t.palette.divider}`,
          }}
        >
          <Typography
            id="create-personality-title"
            component="h2"
            sx={{
              fontSize: TYPO.xl,
              fontWeight: FONT_WEIGHT.bold,
              letterSpacing: '-0.3px',
            }}
          >
            {isEdit ? 'Edit personality' : 'Create a personality'}
          </Typography>
          <IconButton aria-label="Cancel" onClick={onCancel} edge="end" color="primary">
            <CloseIcon />
          </IconButton>
        </Stack>
      )}

      {/* Scrollable form body. No avatar/identity preview at the top:
          the persistent personality band above already stands in for
          the persona being authored, so a second preview here would
          just duplicate it. */}
      <Box sx={{ flex: 1, minHeight: 0, overflowY: 'auto', pl: 3, pr: 2, py: 3 }}>
        <Stack spacing={2.25} sx={{ maxWidth: LAYOUT.contentMaxWidth, mx: 'auto' }}>
          <TextField
            label="Name"
            required
            value={name}
            onChange={e => setName(e.target.value.slice(0, NAME_MAX))}
            placeholder="e.g. Zen Master, Pixel, Sir Reginald"
            fullWidth
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            slotProps={counterSlotProps(name.length, NAME_MAX)}
          />

          <TextField
            label="Tagline"
            value={tagline}
            onChange={e => setTagline(e.target.value.slice(0, TAGLINE_MAX))}
            placeholder={'A one-line vibe, e.g. "Calm and endlessly patient"'}
            fullWidth
            autoComplete="off"
            spellCheck={false}
            slotProps={counterSlotProps(tagline.length, TAGLINE_MAX)}
          />

          <TextField
            label="Instructions"
            required
            value={instructions}
            onChange={e => setInstructions(e.target.value)}
            placeholder={
              'Tell Reachy who to be and how to talk. e.g. "You are a calm, ' +
              'slow-speaking zen guide. Pause between sentences. Keep replies ' +
              'short and warm, and never break character."'
            }
            fullWidth
            multiline
            minRows={4}
            maxRows={12}
            slotProps={{ input: { sx: { borderRadius: `${RADIUS.md}px` } } }}
          />

          {/* Voice picker: the curated OpenAI Realtime voices as
              selectable chips. Single-select - the active chip carries
              a primary ring + tint, matching the persona-card active
              treatment. Tapping a chip also auditions it: a short
              sample plays and the speaker icon pulses while it does. */}
          <Stack spacing={1}>
            <Typography
              sx={{
                fontSize: TYPO.sm,
                fontWeight: FONT_WEIGHT.semibold,
                color: 'text.secondary',
              }}
            >
              Voice
              <Box component="span" sx={{ fontWeight: FONT_WEIGHT.medium, opacity: 0.7 }}>
                {'  -  tap to hear it'}
              </Box>
            </Typography>
            <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1 }}>
              {AVAILABLE_VOICES.map(v => {
                const selected = v === voice;
                const playing = v === playingVoice;
                return (
                  <Box
                    key={v}
                    component="button"
                    type="button"
                    onClick={() => selectVoice(v)}
                    aria-pressed={selected}
                    aria-label={`Voice ${v}, tap to hear a sample`}
                    sx={{
                      appearance: 'none',
                      cursor: 'pointer',
                      font: 'inherit',
                      textTransform: 'capitalize',
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 0.5,
                      pl: selected ? 1.25 : 1.75,
                      pr: 1.75,
                      py: 0.75,
                      borderRadius: `${RADIUS.pill}px`,
                      fontSize: TYPO.sm,
                      fontWeight: FONT_WEIGHT.medium,
                      color: selected ? 'primary.main' : 'text.primary',
                      bgcolor: selected
                        ? alpha(theme.palette.primary.main, 0.1)
                        : 'background.paper',
                      border: selected
                        ? `1.5px solid ${theme.palette.primary.main}`
                        : `1px solid ${theme.palette.divider}`,
                      transition: 'background-color 0.15s ease, border-color 0.15s ease',
                      '&:active': { transform: 'scale(0.97)' },
                      '@keyframes voicePulse': {
                        '0%, 100%': { opacity: 0.45, transform: 'scale(0.9)' },
                        '50%': { opacity: 1, transform: 'scale(1.1)' },
                      },
                    }}
                  >
                    {selected && (
                      <VolumeUpRoundedIcon
                        sx={{
                          fontSize: 16,
                          animation: playing ? 'voicePulse 0.7s ease-in-out infinite' : 'none',
                        }}
                      />
                    )}
                    {v}
                  </Box>
                );
              })}
            </Box>
          </Stack>

        </Stack>
      </Box>

      {/* Sticky action plate. */}
      <Box
        sx={{
          pl: 3,
          pr: 2,
          pt: 1.5,
          // Breathing room under the CTA so it doesn't sit flush on the
          // body slot's bottom edge (embedded mode has no safe-area pad
          // of its own; the fullscreen root adds its own below this).
          pb: 2,
          borderTop: t => `1px solid ${t.palette.divider}`,
          bgcolor: 'background.default',
        }}
      >
        <Box sx={{ maxWidth: LAYOUT.contentMaxWidth, mx: 'auto' }}>
          {/* Create: a single full-width primary CTA.
              Edit: Delete + Save SIDE BY SIDE. Tapping Delete arms a
              two-step confirmation that takes over the whole row (so a
              destructive commit is never one tap away from Save). */}
          {!isEdit ? (
            <Button
              fullWidth
              variant="outlined"
              color="primary"
              size="large"
              disabled={!canSubmit}
              onClick={handleSubmit}
              sx={ctaSx}
            >
              Create & use
            </Button>
          ) : confirmingDelete ? (
            <Stack spacing={1}>
              <Typography
                sx={{ fontSize: TYPO.xs, color: 'text.secondary', textAlign: 'center' }}
              >
                Delete &ldquo;{editing?.name}&rdquo;? This can&rsquo;t be undone.
              </Typography>
              <Stack direction="row" spacing={1}>
                <Button
                  fullWidth
                  variant="text"
                  color="inherit"
                  onClick={() => setConfirmingDelete(false)}
                  sx={{
                    textTransform: 'none',
                    fontSize: TYPO.sm,
                    fontWeight: FONT_WEIGHT.medium,
                    color: 'text.secondary',
                  }}
                >
                  Keep
                </Button>
                <Button
                  fullWidth
                  variant="contained"
                  color="error"
                  disableElevation
                  startIcon={<DeleteOutlineRoundedIcon />}
                  onClick={handleDelete}
                  sx={{
                    textTransform: 'none',
                    fontSize: TYPO.sm,
                    fontWeight: FONT_WEIGHT.semibold,
                    borderRadius: `${RADIUS.md}px`,
                  }}
                >
                  Delete forever
                </Button>
              </Stack>
            </Stack>
          ) : (
            <Stack direction="row" spacing={1} sx={{ alignItems: 'stretch' }}>
              <Button
                variant="outlined"
                color="error"
                size="large"
                onClick={handleDelete}
                aria-label="Delete this personality"
                sx={{
                  flexShrink: 0,
                  minWidth: 0,
                  px: 2,
                  textTransform: 'none',
                  fontSize: TYPO.md,
                  fontWeight: FONT_WEIGHT.semibold,
                  py: 1.25,
                  borderWidth: 1.5,
                  '&:hover': { borderWidth: 1.5 },
                  borderRadius: `${RADIUS.md}px`,
                }}
              >
                <DeleteOutlineRoundedIcon />
              </Button>
              <Button
                variant="outlined"
                color="primary"
                size="large"
                disabled={!canSubmit}
                onClick={handleSubmit}
                sx={{ ...ctaSx, flex: 1 }}
              >
                Save & use
              </Button>
            </Stack>
          )}
        </Box>
      </Box>
    </Box>
  );
}
