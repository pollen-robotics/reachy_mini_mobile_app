/**
 * Sticky action plate at the bottom of the create surface.
 *
 *  - Hero:   a single full-width "Bring it to life" CTA.
 *  - Create: a single full-width "Create & use" CTA.
 *  - Edit:   Delete + Save side by side. Tapping Delete arms a two-step
 *            confirmation that takes over the whole row, so a destructive
 *            commit is never one tap away from Save.
 *
 * Every screen that can act puts its primary button HERE rather than inline in
 * the scrolling column. Two reasons: it's what the rest of the app does (cf.
 * the store intro's bottom-pinned "Got it"), and a pinned plate stays above
 * the on-screen keyboard, which an inline button does not.
 */
import type { ReactNode } from 'react';
import { Box, Button, Stack } from '@mui/material';
import AutoAwesomeOutlinedIcon from '@mui/icons-material/AutoAwesomeOutlined';
import DeleteOutlineRoundedIcon from '@mui/icons-material/DeleteOutlineRounded';
import SaveRoundedIcon from '@mui/icons-material/SaveRounded';

import { LAYOUT } from '@/ui/design/tokens';

import { ctaSx } from './constants';

/** The plate itself: full-bleed divider + padding, content capped and centred.
 *  Shared so every screen's actions sit on a pixel-identical shelf. */
function ActionPlate({ children }: { children: ReactNode }) {
  return (
    <Box
      sx={{
        pl: 3,
        pr: 2,
        pt: 2,
        // Breathing room under the CTA so it doesn't sit flush on the body
        // slot's bottom edge. The host adds the home-indicator inset below.
        pb: 2,
        borderTop: t => `1px solid ${t.palette.divider}`,
        bgcolor: 'background.default',
      }}
    >
      <Box sx={{ maxWidth: LAYOUT.contentMaxWidth, mx: 'auto' }}>{children}</Box>
    </Box>
  );
}

export interface CreatePersonalityHeroActionsProps {
  /** Nothing typed yet, or a generation / idea roll already in flight. */
  disabled: boolean;
  onGenerate: () => void;
}

/**
 * The hero's CTA. Same plate and same `ctaSx` as "Create & use" on purpose:
 * the two are the terminal action of the same funnel, so a different radius or
 * weight between them would read as two unrelated screens.
 */
export function CreatePersonalityHeroActions({
  disabled,
  onGenerate,
}: CreatePersonalityHeroActionsProps) {
  return (
    <ActionPlate>
      <Button
        fullWidth
        variant="outlined"
        color="primary"
        size="large"
        disabled={disabled}
        onClick={onGenerate}
        endIcon={<AutoAwesomeOutlinedIcon />}
        sx={ctaSx}
      >
        Bring it to life
      </Button>
    </ActionPlate>
  );
}

export interface CreatePersonalityActionsProps {
  isEdit: boolean;
  confirmingDelete: boolean;
  canSubmit: boolean;
  editDirty: boolean;
  onSubmit: () => void;
  onDelete: () => void;
  /** Cancel the armed delete confirmation. */
  onKeep: () => void;
}

export function CreatePersonalityActions({
  isEdit,
  confirmingDelete,
  canSubmit,
  editDirty,
  onSubmit,
  onDelete,
  onKeep,
}: CreatePersonalityActionsProps) {
  return (
    <ActionPlate>
      {!isEdit ? (
        <Button
          fullWidth
          variant="outlined"
          color="primary"
          size="large"
          disabled={!canSubmit}
          onClick={onSubmit}
          sx={ctaSx}
        >
          Create & use
        </Button>
      ) : confirmingDelete ? (
        <Stack direction="row" spacing={1}>
          <Button
            fullWidth
            variant="outlined"
            color="primary"
            size="large"
            onClick={onKeep}
            sx={ctaSx}
          >
            Keep
          </Button>
          <Button
            fullWidth
            variant="outlined"
            color="error"
            size="large"
            startIcon={<DeleteOutlineRoundedIcon />}
            onClick={onDelete}
            sx={ctaSx}
          >
            Delete forever
          </Button>
        </Stack>
      ) : (
        <Stack direction="row" spacing={1} sx={{ alignItems: 'stretch' }}>
          <Button
            variant="outlined"
            color="error"
            size="large"
            startIcon={<DeleteOutlineRoundedIcon />}
            onClick={onDelete}
            sx={{ ...ctaSx, flexShrink: 0, px: 2 }}
          >
            Delete
          </Button>
          <Button
            variant="outlined"
            color="primary"
            size="large"
            disabled={!canSubmit || !editDirty}
            onClick={onSubmit}
            startIcon={<SaveRoundedIcon />}
            sx={{ ...ctaSx, flex: 1 }}
          >
            Save
          </Button>
        </Stack>
      )}
    </ActionPlate>
  );
}
