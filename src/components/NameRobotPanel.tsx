/**
 * Inline panel for picking / changing a robot's human-readable name.
 *
 * Designed to be reused from three call sites without the daemon ever
 * caring which one fired the request:
 *
 *   1. WiFi onboarding (mandatory gate before reaching the dashboard).
 *      The default `reachy_mini` label is too ambiguous when the user
 *      owns more than one robot, so we force a rename here while we
 *      already have a verified LAN connection.
 *
 *   2. Settings (optional, for "rename later"). Same component, opened
 *      from a Settings entry; closeable when the existing name is not
 *      the literal default.
 *
 *   3. ScanScreen disambiguation (when two robots in the user's fleet
 *      collide on the same name). The card surfaces the duplicate with
 *      a soft warning so the user can fix it inline.
 *
 * The panel does not own a screen layout: it renders a centred Stack
 * meant to drop into a parent screen / dialog. The parent decides the
 * surrounding chrome (back button, stepper, etc.).
 */

import { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  Stack,
  TextField,
  Typography,
} from '@mui/material';

import {
  RobotNameError,
  setRobotNameOverLan,
  type RobotNameInfo,
} from '../daemon/daemonRobotName';
import {
  formatRobotNameError,
  ROBOT_NAME_MAX_LEN,
  validateRobotName,
} from '../daemon/robotName';

interface NameRobotPanelProps {
  /** LAN IP / hostname of the daemon (used by the underlying daemonFetch). */
  host: string;
  /** Initial value displayed in the input. Empty string is fine. */
  initialName: string;
  /**
   * Other names already used in the user's fleet. When the trimmed input
   * matches one of these, we surface a *soft* warning - the user is
   * still allowed to confirm so two robots with the same nickname don't
   * become an unrecoverable error. Comparison is case-insensitive and
   * whitespace-trimmed, mirroring how the ScanScreen disambiguation
   * logic groups duplicates.
   */
  existingNames?: readonly string[];
  /** Called with the freshly-applied name once the daemon confirmed it. */
  onSaved: (info: RobotNameInfo) => void;
  /**
   * Optional cancel hook. Mandatory entry points (onboarding, default
   * name) should leave this undefined to remove the escape hatch; the
   * Settings entry point passes a real callback.
   */
  onCancel?: () => void;
  /**
   * Optional skip hook. When provided, surfaces a "Skip for now" button
   * that lets the user proceed without picking a name. Discovery still
   * disambiguates them via the install_id suffix, so skipping is a
   * supported, no-regret path: the user can pick a label later from
   * Settings. Onboarding flows that pass `onSaved` only (no `onSkip`)
   * keep the original "name now or back out" behaviour.
   */
  onSkip?: () => void;
  /** Title above the input. Defaults to "Name your Reachy". */
  title?: string;
  /** Subtitle / explanation. Override for the rename-later flow. */
  subtitle?: string;
  /** Submit button label. Defaults to "Continue". */
  submitLabel?: string;
}

const NORMALIZE = (s: string): string => s.trim().toLowerCase();

export default function NameRobotPanel({
  host,
  initialName,
  existingNames = [],
  onSaved,
  onCancel,
  onSkip,
  title = 'Name your Reachy',
  subtitle = 'Pick a short name (1-32 characters) so you can tell your robots apart in the list. You can rename later from Settings.',
  submitLabel = 'Continue',
}: NameRobotPanelProps) {
  const [value, setValue] = useState<string>(initialName);
  const [submitting, setSubmitting] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);

  // Re-run validation on every keystroke so the user sees the inline
  // hint without needing to submit. The server still validates again on
  // POST: this is purely a UX shortcut.
  const validation = useMemo(() => validateRobotName(value), [value]);
  const inlineError = formatRobotNameError(validation);

  const trimmed = validation.kind === 'ok' ? validation.trimmed : '';

  // Soft uniqueness warning. We don't block the user: collisions are
  // a UX problem, not a correctness one, and the daemon has no way to
  // verify uniqueness across an arbitrary HF fleet. The warning makes
  // the conflict visible while leaving the decision to the user.
  const collidesWithFleet = useMemo(() => {
    if (!trimmed) return false;
    const target = NORMALIZE(trimmed);
    return existingNames.some(other => NORMALIZE(other) === target);
  }, [trimmed, existingNames]);

  // Reset the server error whenever the user edits the value: the
  // previous failure no longer applies to the candidate they're typing.
  useEffect(() => {
    setServerError(null);
  }, [value]);

  const canSubmit = !submitting && validation.kind === 'ok';

  const handleSubmit = async (): Promise<void> => {
    if (!canSubmit) return;
    setSubmitting(true);
    setServerError(null);
    try {
      const info = await setRobotNameOverLan(host, trimmed);
      onSaved(info);
    } catch (e) {
      // RobotNameError carries a user-friendly message we can pipe
      // straight into the Alert. Anything else degrades to a generic
      // "Could not save - try again" so we never crash the screen.
      if (e instanceof RobotNameError) {
        setServerError(e.message);
      } else {
        setServerError(
          e instanceof Error ? e.message : 'Could not save the name. Try again.',
        );
      }
      setSubmitting(false);
      return;
    }
    setSubmitting(false);
  };

  const helperText = inlineError ?? `${trimmed.length}/${ROBOT_NAME_MAX_LEN}`;

  return (
    <Stack
      spacing={2.5}
      sx={{ width: '100%', maxWidth: 420, mx: 'auto' }}
      component="form"
      onSubmit={(ev: React.FormEvent) => {
        ev.preventDefault();
        void handleSubmit();
      }}
    >
      <Box>
        <Typography variant="h5" sx={{ fontWeight: 600, mb: 1 }}>
          {title}
        </Typography>
        <Typography variant="body2" color="text.secondary">
          {subtitle}
        </Typography>
      </Box>

      <TextField
        autoFocus
        fullWidth
        value={value}
        onChange={ev => setValue(ev.target.value)}
        placeholder="Living-room Reachy"
        inputProps={{ maxLength: ROBOT_NAME_MAX_LEN + 8 /* let "too-long" surface */, 'aria-label': 'Robot name' }}
        error={value.length > 0 && validation.kind !== 'ok'}
        helperText={helperText}
        disabled={submitting}
      />

      {collidesWithFleet && (
        <Alert severity="warning" variant="outlined">
          Another Reachy in your fleet is already named {`"${trimmed}"`}. You can
          still use it, but the listing will show duplicates.
        </Alert>
      )}

      {serverError && (
        <Alert severity="error" variant="outlined">
          {serverError}
        </Alert>
      )}

      <Stack direction="row" spacing={1.5} justifyContent="flex-end">
        {onCancel && (
          <Button
            type="button"
            variant="text"
            onClick={onCancel}
            disabled={submitting}
          >
            Cancel
          </Button>
        )}
        {onSkip && (
          <Button
            type="button"
            variant="text"
            onClick={onSkip}
            disabled={submitting}
          >
            Skip for now
          </Button>
        )}
        <Button
          type="submit"
          variant="contained"
          disabled={!canSubmit}
          startIcon={
            submitting ? <CircularProgress size={16} color="inherit" /> : null
          }
        >
          {submitLabel}
        </Button>
      </Stack>
    </Stack>
  );
}
