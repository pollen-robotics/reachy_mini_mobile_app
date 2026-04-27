/**
 * Memory dialog - lets the user inspect and prune what Reachy
 * remembers about them.
 *
 * Why a dialog (and not a settings page)
 * ──────────────────────────────────────
 * The mobile app intentionally has very few full screens; everything
 * post-discovery sits inside a single MUI shell with a top bar and a
 * tab strip. A modal `Dialog` matches the existing visual idiom
 * (`ForgetWifiDialog`, `RemoteSignInScreen`'s sub-prompts) and lets
 * the user open / close memory inspection without leaving the
 * conversation.
 *
 * Two-step destructive actions
 * ────────────────────────────
 * Per-fact deletes are one-tap (small surface, easy to redo). The
 * "Clear all" button uses an inline confirm (the second tap commits)
 * to avoid a nested dialog while still preventing slip-of-the-finger
 * data loss.
 *
 * Pure UI: all state lives in `memoryStore` via `useMemoryStore`.
 * Closing and reopening the dialog reflects whatever the model
 * stored mid-conversation without manual refresh.
 */
import { useEffect, useMemo, useState } from 'react';
import {
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  List,
  ListItem,
  ListItemText,
  Stack,
  Typography,
  useTheme,
} from '@mui/material';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import PsychologyOutlinedIcon from '@mui/icons-material/PsychologyOutlined';

import { useMemoryStore } from '../../conversation/useMemoryStore';
import type { MemoryFact } from '../../conversation/memory';

export interface MemoryDialogProps {
  open: boolean;
  onClose: () => void;
}

/**
 * Format a timestamp as a coarse relative label ("just now",
 * "2 days ago"). We deliberately avoid a date-fns dependency: the
 * resolution we want is human-skim, not exact.
 */
function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  const sec = Math.max(0, Math.round(diff / 1000));
  if (sec < 60) return 'just now';
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  if (day < 30) return `${day}d ago`;
  const month = Math.round(day / 30);
  if (month < 12) return `${month}mo ago`;
  const year = Math.round(month / 12);
  return `${year}y ago`;
}

export function MemoryDialog({ open, onClose }: MemoryDialogProps) {
  const theme = useTheme();
  const { facts, remove, clear } = useMemoryStore();
  // Two-step confirm for "Clear all" - second click within ~5s
  // commits, otherwise the button reverts to its default label.
  const [confirmingClear, setConfirmingClear] = useState(false);

  // Reset the confirm-clear state any time the dialog is reopened
  // so a stale "Confirm" button doesn't ambush the user.
  useEffect(() => {
    if (!open) setConfirmingClear(false);
  }, [open]);

  // Auto-cancel the confirm after a short window to avoid the user
  // accidentally tapping "Clear all" much later thinking it's the
  // first tap.
  useEffect(() => {
    if (!confirmingClear) return undefined;
    const timer = window.setTimeout(() => setConfirmingClear(false), 5000);
    return () => window.clearTimeout(timer);
  }, [confirmingClear]);

  const sortedFacts = useMemo(
    () => [...facts].sort((a, b) => b.createdAt - a.createdAt),
    [facts],
  );

  const handleClearClick = () => {
    if (!confirmingClear) {
      setConfirmingClear(true);
      return;
    }
    clear();
    setConfirmingClear(false);
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      fullWidth
      maxWidth="xs"
      slotProps={{
        paper: {
          sx: { borderRadius: 3 },
        },
      }}
    >
      <DialogTitle sx={{ pb: 1 }}>
        <Stack direction="row" alignItems="center" spacing={1.25}>
          <PsychologyOutlinedIcon
            fontSize="small"
            sx={{ color: 'text.secondary' }}
          />
          <Typography component="span" sx={{ fontWeight: 700 }}>
            Memory
          </Typography>
          <Typography
            component="span"
            variant="caption"
            sx={{ color: 'text.secondary', ml: 'auto' }}
          >
            {sortedFacts.length} {sortedFacts.length === 1 ? 'item' : 'items'}
          </Typography>
        </Stack>
      </DialogTitle>

      <DialogContent dividers sx={{ p: 0 }}>
        {sortedFacts.length === 0 ? (
          <EmptyState />
        ) : (
          <List dense disablePadding>
            {sortedFacts.map((fact) => (
              <FactRow
                key={fact.id}
                fact={fact}
                onRemove={() => remove(fact.id)}
                divider={fact.id !== sortedFacts[sortedFacts.length - 1].id}
              />
            ))}
          </List>
        )}
      </DialogContent>

      <DialogActions sx={{ px: 2, py: 1.5, gap: 1 }}>
        <Button
          size="small"
          color="error"
          variant={confirmingClear ? 'contained' : 'text'}
          onClick={handleClearClick}
          disabled={sortedFacts.length === 0}
          sx={{ textTransform: 'none', fontWeight: 600 }}
        >
          {confirmingClear ? 'Tap again to confirm' : 'Clear all'}
        </Button>
        <Box sx={{ flex: 1 }} />
        <Button
          size="small"
          onClick={onClose}
          sx={{ textTransform: 'none', fontWeight: 600 }}
        >
          Done
        </Button>
      </DialogActions>

      {/* Footer caption: explains where the data lives and how it's
          used, so the user has a clear mental model. theme is only
          used for the divider color so the caption blends with the
          DialogActions row. */}
      <Box
        sx={{
          px: 2,
          pb: 1.5,
          pt: 0,
          borderTop: `1px solid ${theme.palette.divider}`,
        }}
      >
        <Typography
          variant="caption"
          color="text.secondary"
          sx={{ display: 'block', lineHeight: 1.4, mt: 1 }}
        >
          Reachy decides what to save during your conversations. Memories
          live on this device only and are sent to the realtime model at
          the start of each session.
        </Typography>
      </Box>
    </Dialog>
  );
}

function EmptyState() {
  return (
    <Stack
      alignItems="center"
      justifyContent="center"
      spacing={1}
      sx={{ py: 5, px: 3, textAlign: 'center' }}
    >
      <PsychologyOutlinedIcon
        sx={{ fontSize: 36, color: 'text.disabled' }}
      />
      <Typography
        variant="body2"
        sx={{ fontWeight: 600, color: 'text.secondary' }}
      >
        No memories yet
      </Typography>
      <Typography
        variant="caption"
        color="text.secondary"
        sx={{ maxWidth: 240 }}
      >
        Tell Reachy something about yourself during a conversation. It
        will save anything stable that helps it know you better.
      </Typography>
    </Stack>
  );
}

function FactRow({
  fact,
  onRemove,
  divider,
}: {
  fact: MemoryFact;
  onRemove: () => void;
  divider: boolean;
}) {
  const theme = useTheme();
  return (
    <ListItem
      sx={{
        alignItems: 'flex-start',
        py: 1.25,
        px: 2,
        borderBottom: divider ? `1px solid ${theme.palette.divider}` : 'none',
      }}
      secondaryAction={
        <IconButton
          edge="end"
          aria-label={`Forget memory: ${fact.text}`}
          size="small"
          onClick={onRemove}
          sx={{ color: 'text.secondary' }}
        >
          <DeleteOutlineIcon fontSize="small" />
        </IconButton>
      }
    >
      <ListItemText
        primary={fact.text}
        secondary={relativeTime(fact.createdAt)}
        primaryTypographyProps={{
          fontSize: '0.9rem',
          lineHeight: 1.35,
        }}
        secondaryTypographyProps={{
          fontSize: '0.7rem',
          color: 'text.disabled',
        }}
      />
    </ListItem>
  );
}
