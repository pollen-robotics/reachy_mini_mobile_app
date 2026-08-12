import { useRef, useState } from 'react';
import { TextField } from '@mui/material';
import CheckRoundedIcon from '@mui/icons-material/CheckRounded';

import { MAX_ROBOT_NAME_LENGTH } from '@/features/robot-session/sdk-types';
import { ButtonSpinner, PrimaryButton, StepScaffold } from '../shared';

/**
 * "Give Me a Name" step - the wizard's last human step. The robot is already
 * awake and on screen (shared persistent viz), so naming reads as meeting it.
 *
 * The draft is CONTROLLED by the shell (`value` / `onChange`): the step remounts
 * on every step transition (AnimatePresence keys on the step), so keeping the
 * text here would wipe it - lifting it to the shell lets it survive.
 *
 * Saving renames over the live WebRTC session (`onRename` → `setRobotName`),
 * not the BLE setup channel: by the time this wizard runs the robot is online
 * and the daemon is up to date (the mandatory update gate ran first). The
 * rename is best-effort - a slow/failed save (old daemon, transport hiccup)
 * must never trap the user on the last step - so we advance regardless once the
 * call settles, and the closing celebration greets whatever name landed.
 */
export default function NameStep({
  value,
  onChange,
  onRename,
  onNext,
}: {
  /** Controlled draft, lifted to the shell so it survives step-transition remounts. */
  value: string;
  onChange: (name: string) => void;
  /** Persist the chosen name over the session; resolves the saved name (or
   *  `null` on failure). Also updates the session's optimistic display name so
   *  the closing "meet" line reflects it. */
  onRename: (name: string) => Promise<string | null>;
  onNext: () => void;
}) {
  const [saving, setSaving] = useState(false);
  // Ref latch, not just the `saving` state: React flushes state asynchronously,
  // so a fast double-tap or Enter-then-tap could fire the rename twice before
  // the disabled state re-renders. The ref flips synchronously and is the real
  // guard; `saving` only drives the button UI.
  const savingRef = useRef(false);
  const trimmed = value.trim();

  const save = () => {
    if (savingRef.current || trimmed.length === 0) return;
    savingRef.current = true;
    setSaving(true);
    void (async () => {
      // Swallow failures: naming is non-critical and the finale must play.
      await onRename(trimmed).catch(() => null);
      onNext();
    })();
  };

  return (
    <StepScaffold
      // No overlay: the shared persistent viz keeps the awake robot on screen
      // while the user names it.
      title="Give Me a Name"
      caption="Pick a name for me! If you can't decide, Reachy Mini is a great choice."
      feedback={
        <TextField
          value={value}
          onChange={e => onChange(e.target.value.slice(0, MAX_ROBOT_NAME_LENGTH))}
          onKeyDown={e => {
            // Ignore Enter mid-IME-composition (e.g. Pinyin/Kana candidate
            // selection) so committing a candidate doesn't also submit.
            if (e.key === 'Enter' && !e.nativeEvent.isComposing) save();
          }}
          placeholder="Reachy Mini"
          autoFocus
          fullWidth
          disabled={saving}
          slotProps={{ htmlInput: { maxLength: MAX_ROBOT_NAME_LENGTH, 'aria-label': 'Robot name' } }}
          sx={{
            maxWidth: 320,
            // Card-like surface: `background.paper` reads white in light mode and
            // the elevated dark surface in dark mode, so it always stands out
            // from the wizard's `background.default` backdrop like the other cards.
            '& .MuiOutlinedInput-root': { bgcolor: 'background.paper' },
          }}
        />
      }
      actions={
        saving ? (
          <PrimaryButton disabled startIcon={<ButtonSpinner />}>
            Saving…
          </PrimaryButton>
        ) : (
          <PrimaryButton startIcon={<CheckRoundedIcon />} onClick={save} disabled={trimmed.length === 0}>
            Save name
          </PrimaryButton>
        )
      }
    />
  );
}
