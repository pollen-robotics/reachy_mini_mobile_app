/**
 * The classic persona form: name + a voice picker that auditions on select
 * (sharing one row), a tagline, and the system-prompt "Instructions" box
 * that grows to fill the leftover height. Reached from the hero's "I'll write
 * it myself" on-ramp, or straight away in edit mode. Purely presentational -
 * all state and handlers (including voice playback) come from props.
 *
 * One-way door: there's no link back to the vibe hero. Authoring by hand and
 * describing a vibe are two different intents, and a "back" here read as a
 * navigation stack the rest of this flow doesn't have. The way out is the
 * band's "✕".
 */
import { Box, MenuItem, Stack, TextField } from '@mui/material';
import VolumeUpRoundedIcon from '@mui/icons-material/VolumeUpRounded';

import { AVAILABLE_VOICES, VOICE_DESCRIPTIONS } from '@/features/personalities';
import { LAYOUT, RADIUS } from '@/ui/design/tokens';

import { NAME_MAX, TAGLINE_MAX, shrinkLabelSlotProps } from './constants';

export interface CreatePersonalityFieldsProps {
  name: string;
  onNameChange: (value: string) => void;
  tagline: string;
  onTaglineChange: (value: string) => void;
  voice: string;
  /** Selecting a voice also auditions it (caller wires playback). */
  onVoiceChange: (value: string) => void;
  instructions: string;
  onInstructionsChange: (value: string) => void;
  /** The voice currently auditioning (pulses the speaker icon). */
  playingVoice: string | null;
}

export function CreatePersonalityFields({
  name,
  onNameChange,
  tagline,
  onTaglineChange,
  voice,
  onVoiceChange,
  instructions,
  onInstructionsChange,
  playingVoice,
}: CreatePersonalityFieldsProps) {
  return (
    <Stack
      spacing={2.25}
      sx={{
        maxWidth: LAYOUT.contentMaxWidth,
        mx: 'auto',
        width: '100%',
        // Fill the scroll body so Instructions can grow into the leftover
        // vertical space (but no further).
        flex: 1,
        minHeight: 0,
      }}
    >
      {/* Identity: name + voice share one row, tagline sits below. The
          avatar - and its regenerate control - live on the persistent
          personality band above. Picking a voice auditions it right away
          (a short bundled sample plays and the speaker icon pulses). */}
      <Stack spacing={2}>
        <Stack direction="row" spacing={1.5} sx={{ alignItems: 'flex-start' }}>
          <TextField
            label="Name"
            required
            value={name}
            onChange={e => onNameChange(e.target.value.slice(0, NAME_MAX))}
            fullWidth
            size="small"
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            sx={{ flex: 1, minWidth: 0 }}
            slotProps={{
              ...shrinkLabelSlotProps,
              input: { sx: { borderRadius: `${RADIUS.md}px` } },
            }}
          />
          <TextField
            select
            label="Voice"
            value={voice}
            onChange={e => onVoiceChange(e.target.value)}
            fullWidth
            size="small"
            sx={{
              flex: 1,
              minWidth: 0,
              '@keyframes voicePulse': {
                '0%, 100%': { opacity: 0.45 },
                '50%': { opacity: 1 },
              },
            }}
            slotProps={{
              ...shrinkLabelSlotProps,
              input: { sx: { borderRadius: `${RADIUS.md}px` } },
              select: {
                // Closed display: voice name + a pulsing speaker while that
                // voice's sample is auditioning.
                renderValue: selected => {
                  const v = selected as string;
                  if (!v) return '';
                  return (
                    <Box sx={{ display: 'flex', alignItems: 'center', width: '100%' }}>
                      <Box
                        component="span"
                        sx={{
                          textTransform: 'capitalize',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {v}
                      </Box>
                      {v === playingVoice && (
                        <VolumeUpRoundedIcon
                          sx={{
                            ml: 'auto',
                            fontSize: 18,
                            color: 'primary.main',
                            animation: 'voicePulse 0.7s ease-in-out infinite',
                          }}
                        />
                      )}
                    </Box>
                  );
                },
              },
            }}
          >
            {AVAILABLE_VOICES.map(v => (
              <MenuItem
                key={v}
                value={v}
                sx={{ alignItems: 'flex-start', py: 1, whiteSpace: 'normal' }}
              >
                <Box sx={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                  <Box component="span" sx={{ textTransform: 'capitalize', lineHeight: 1.3 }}>
                    {v}
                  </Box>
                  <Box
                    component="span"
                    sx={{ fontSize: 12, lineHeight: 1.3, color: 'text.secondary' }}
                  >
                    {VOICE_DESCRIPTIONS[v]}
                  </Box>
                </Box>
              </MenuItem>
            ))}
          </TextField>
        </Stack>
        <TextField
          label="Tagline"
          placeholder="a one-line vibe"
          value={tagline}
          onChange={e => onTaglineChange(e.target.value.slice(0, TAGLINE_MAX))}
          fullWidth
          size="small"
          autoComplete="off"
          spellCheck={false}
          slotProps={{
            ...shrinkLabelSlotProps,
            input: { sx: { borderRadius: `${RADIUS.md}px` } },
          }}
        />
      </Stack>

      {/* System prompt, shown inline (no "Advanced" drawer - the prompt is a
          first-class field). Grows to fill the leftover height with its own
          inner scroll. */}
      <Stack spacing={2.25} sx={{ flex: 1, minHeight: 0 }}>
        <TextField
          label="Instructions"
          required
          value={instructions}
          onChange={e => onInstructionsChange(e.target.value)}
          placeholder={
            'Tell Reachy who to be and how to talk. e.g. "You are a calm, ' +
            'slow-speaking zen guide. Pause between sentences. Keep replies ' +
            'short and warm, and never break character."'
          }
          fullWidth
          multiline
          slotProps={{
            ...shrinkLabelSlotProps,
            input: { sx: { borderRadius: `${RADIUS.md}px` } },
          }}
          sx={{
            flex: 1,
            minHeight: 0,
            display: 'flex',
            flexDirection: 'column',
            // Bound the input box to the leftover height (flex column chain),
            // then pin the textarea to 100% of it and force its own scroll.
            // MUI's TextareaAutosize sets an inline pixel height +
            // `overflow:hidden`; override both so the field neither spills
            // past the outline NOR swallows the scroll.
            '& .MuiInputBase-root.MuiInputBase-multiline': {
              flex: 1,
              minHeight: 0,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'stretch',
              p: 0,
            },
            '& .MuiInputBase-inputMultiline, & textarea': {
              flex: 1,
              minHeight: 0,
              height: '100% !important',
              overflowY: 'auto !important',
              overflowX: 'hidden',
              resize: 'none',
              boxSizing: 'border-box',
              px: 1.75,
              py: 1.5,
            },
          }}
        />
      </Stack>
    </Stack>
  );
}
