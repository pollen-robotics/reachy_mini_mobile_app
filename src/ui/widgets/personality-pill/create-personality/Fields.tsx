/**
 * The classic persona form: name + tagline and the system-prompt
 * "Instructions" box that grows to fill the leftover height. In create mode
 * it's fronted by a "back to vibe generator" link; edit mode opens straight
 * here. Purely presentational - all state and handlers come from props.
 *
 * There is no voice picker: built-in personas ship a curated voice per
 * backend and the generator authors one for custom personas, so the synth
 * voice is never hand-picked here.
 */
import { Button, Stack, TextField } from '@mui/material';
import ChevronLeftRoundedIcon from '@mui/icons-material/ChevronLeftRounded';

import { FONT_WEIGHT, LAYOUT, RADIUS, TYPO } from '@/ui/design/tokens';

import { NAME_MAX, TAGLINE_MAX, shrinkLabelSlotProps } from './constants';

export interface CreatePersonalityFieldsProps {
  isEdit: boolean;
  name: string;
  onNameChange: (value: string) => void;
  tagline: string;
  onTaglineChange: (value: string) => void;
  instructions: string;
  onInstructionsChange: (value: string) => void;
  /** Create mode only: return to the vibe-generator hero. */
  onBack: () => void;
}

export function CreatePersonalityFields({
  isEdit,
  name,
  onNameChange,
  tagline,
  onTaglineChange,
  instructions,
  onInstructionsChange,
  onBack,
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
      {/* Create-mode back link: returns to the "describe it" hero. The typed
          vibe and any generated fields stay in state, so going back to
          re-roll never loses work. Edit mode has no generator, so no link. */}
      {!isEdit && (
        <Button
          variant="text"
          color="primary"
          onClick={onBack}
          startIcon={<ChevronLeftRoundedIcon />}
          disableRipple
          sx={{
            alignSelf: 'flex-start',
            textTransform: 'none',
            fontSize: TYPO.sm,
            fontWeight: FONT_WEIGHT.semibold,
            p: 0,
            minWidth: 0,
            '&:hover': { bgcolor: 'transparent' },
          }}
        >
          Back to vibe generator
        </Button>
      )}

      {/* Identity: name + tagline. The avatar - and its regenerate control -
          live on the persistent personality band above. The synth voice is
          not authored here (built-ins ship one per backend; the generator
          picks one for custom personas). */}
      <Stack spacing={2}>
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
          slotProps={{
            ...shrinkLabelSlotProps,
            input: { sx: { borderRadius: `${RADIUS.md}px` } },
          }}
        />
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
