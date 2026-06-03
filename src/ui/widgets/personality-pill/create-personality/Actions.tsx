/**
 * Sticky action plate at the bottom of the form.
 *
 *  - Create: a single full-width "Create & use" CTA.
 *  - Edit:   Delete + Save side by side. Tapping Delete arms a two-step
 *            confirmation that takes over the whole row, so a destructive
 *            commit is never one tap away from Save.
 *
 * Only rendered once the form is open (the create landing can't submit).
 */
import { Box, Button, Stack } from '@mui/material';
import DeleteOutlineRoundedIcon from '@mui/icons-material/DeleteOutlineRounded';
import SaveRoundedIcon from '@mui/icons-material/SaveRounded';

import { LAYOUT } from '@/ui/design/tokens';

import { ctaSx } from './constants';

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
    <Box
      sx={{
        pl: 3,
        pr: 2,
        pt: 2,
        // Breathing room under the CTA so it doesn't sit flush on the body
        // slot's bottom edge.
        pb: 2,
        borderTop: t => `1px solid ${t.palette.divider}`,
        bgcolor: 'background.default',
      }}
    >
      <Box sx={{ maxWidth: LAYOUT.contentMaxWidth, mx: 'auto' }}>
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
      </Box>
    </Box>
  );
}
