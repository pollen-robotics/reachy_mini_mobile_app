/**
 * SettingsPanel - the "cog" Settings surface.
 *
 * Opens from the topbar cog, rendered as a fixed overlay below the
 * session topbar (the cog glyph swaps to `✕` while open). Robot-level
 * options only: the conversation-scoped settings (language, personality,
 * voice, memory) live ON THE ROBOT now and are driven from the
 * conversation tab over JSON-RPC.
 *
 * Groups, top to bottom:
 *   - Audio: speaker + microphone volume. These act on the daemon's
 *     audio devices, so they read/apply live.
 *   - About: drill-in to connection / software / account / live logs.
 */
import { useCallback, useEffect, useState } from 'react';
import { Box, CircularProgress, Stack, TextField, Typography, alpha, useTheme } from '@mui/material';
import ChevronRightRoundedIcon from '@mui/icons-material/ChevronRightRounded';
import CheckRoundedIcon from '@mui/icons-material/CheckRounded';
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined';
import LogoutRoundedIcon from '@mui/icons-material/LogoutRounded';
import SettingsOutlinedIcon from '@mui/icons-material/SettingsOutlined';

import { useDaemonState } from '@/features/daemon-state';
import { MAX_ROBOT_NAME_LENGTH } from '@/features/robot-session/sdk-types';
import AudioControlCard from '@/ui/widgets/audio-controls/AudioControlCard';
import { FONT_WEIGHT, RADIUS, TYPO } from '@/ui/design/tokens';

/** How long after the last keystroke to auto-commit the rename. */
const RENAME_DEBOUNCE_MS = 700;

export interface SettingsPanelProps {
  /** Whether the daemon has reported its audio state at least once.
   *  Gates the volume sliders so they can't be dragged against an
   *  unreachable daemon (values fall back to 50 until then). */
  audioReady: boolean;
  /** Drill into the "About & diagnostics" sub-page (the host swaps this
   *  panel for `<RobotInfoPanel>`). Surfaced as a tappable row at the
   *  end of the panel. */
  onOpenAbout: () => void;
  /** Current display name of the connected robot; seeds the rename field
   *  and the sign-out confirm copy. */
  robotName: string;
  /** Persist a new robot name over the data channel (SDK `setRobotName()`).
   *  Resolves with the daemon's stored name, or `null` if unreachable. */
  renameRobot: (name: string) => Promise<string | null>;
  /** Sign this robot out of Hugging Face (SDK `signOut()`). Resolves `true`
   *  on success, `false` on a daemon-side failure, `null` if unreachable. */
  signOutRobot: () => Promise<boolean | null>;
  /** Called once the robot sign-out went through, so the host can leave the
   *  session (the robot unregisters from central). */
  onSignedOutRobot: () => void;
}

export function SettingsPanel({
  audioReady,
  onOpenAbout,
  robotName,
  renameRobot,
  signOutRobot,
  onSignedOutRobot,
}: SettingsPanelProps) {
  const theme = useTheme();
  // Daemon-side audio state (volumes + mute toggles).
  const daemon = useDaemonState();

  // Rename flow. The field is seeded with the current display name and
  // auto-saves (no Save button): editing schedules a debounced rename
  // (Enter / blur commit immediately), the right edge shows a spinner then
  // a "Saved" check. `lastSaved` guards the auto-save from re-firing for a
  // value we already persisted.
  const [nameDraft, setNameDraft] = useState(robotName);
  const [renameStep, setRenameStep] = useState<'idle' | 'busy' | 'done'>('idle');
  const [renameError, setRenameError] = useState<string | null>(null);
  const [lastSaved, setLastSaved] = useState<string | null>(null);
  const trimmedName = nameDraft.trim();
  const nameDirty =
    trimmedName.length > 0 && trimmedName !== robotName && trimmedName !== lastSaved;

  const handleRename = useCallback(async () => {
    const trimmed = nameDraft.trim();
    const dirty = trimmed.length > 0 && trimmed !== robotName && trimmed !== lastSaved;
    if (!dirty || renameStep === 'busy') return;
    setRenameStep('busy');
    setRenameError(null);
    try {
      const saved = await renameRobot(trimmed);
      // `null` = channel closed / daemon too old / rejected: the rename
      // never landed, so keep the draft and surface a recoverable error.
      if (saved === null) {
        setRenameError('Could not reach the robot. Stay on the same network and try again.');
        setRenameStep('idle');
        return;
      }
      setLastSaved(saved);
      setNameDraft(saved);
      setRenameStep('done');
    } catch (err) {
      setRenameError(err instanceof Error ? err.message : 'Rename failed.');
      setRenameStep('idle');
    }
  }, [nameDraft, robotName, lastSaved, renameStep, renameRobot]);

  // Debounced auto-save: commit a beat after the user stops typing. Re-armed
  // on every edit; skipped once the draft matches what we last persisted.
  useEffect(() => {
    if (!nameDirty || renameStep === 'busy') return;
    const t = window.setTimeout(() => {
      void handleRename();
    }, RENAME_DEBOUNCE_MS);
    return () => window.clearTimeout(t);
  }, [nameDirty, renameStep, handleRename]);

  // Sign-out-robot flow. `idle` -> tap reveals `confirming` (two-step) ->
  // `busy` while the daemon call is in flight. On failure we drop back to
  // `confirming` and surface `signOutError`.
  const [signOutStep, setSignOutStep] = useState<'idle' | 'confirming' | 'busy'>('idle');
  const [signOutError, setSignOutError] = useState<string | null>(null);

  const handleSignOutRobot = async () => {
    setSignOutStep('busy');
    setSignOutError(null);
    try {
      const result = await signOutRobot();
      // `false` is an explicit daemon-side failure; `true` (acked) and
      // `null` (channel closed by the relay drop right after the ack) both
      // mean the sign-out went through, so we leave the session.
      if (result === false) {
        setSignOutError('The robot rejected the sign-out. Please try again.');
        setSignOutStep('confirming');
        return;
      }
      onSignedOutRobot();
    } catch (err) {
      setSignOutError(err instanceof Error ? err.message : 'Sign-out failed.');
      setSignOutStep('confirming');
    }
  };

  return (
    <Box
      sx={{
        flex: 1,
        minHeight: 0,
        width: '100vw',
        mx: 'calc(50% - 50vw)',
        bgcolor: 'background.default',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
      }}
    >
      {/* Header. The settings overlay hides the band above, so this
          title is the user's anchor that they're in the robot Settings
          surface (and the topbar cog stays lit as the way out). */}
      <Box sx={{ flexShrink: 0, px: 3, pt: 3.5, pb: 1 }}>
        <Stack sx={{ flexDirection: 'row', alignItems: 'center', gap: 1 }}>
          <SettingsOutlinedIcon sx={{ fontSize: 24, color: 'text.secondary', flexShrink: 0 }} />
          <Typography
            component="h2"
            sx={{
              fontSize: TYPO.xxl,
              fontWeight: FONT_WEIGHT.bold,
              letterSpacing: '-0.3px',
              lineHeight: 1.2,
            }}
          >
            Settings
          </Typography>
        </Stack>
      </Box>

      <Box sx={{ flex: 1, minHeight: 0, overflowY: 'auto', pt: 2, pb: 4 }}>
        <Stack spacing={4}>
          {/* AUDIO - robot-level. Speaker + microphone volume act on the
              daemon's audio devices. Each row is a pure icon+slider
              (`AudioControlCard`); the Card provides the surface. */}
          <Section label="Audio" blurb="Speaker and microphone volume.">
            <Card>
              <Row divider={false}>
                <AudioControlCard
                  kind="speaker"
                  value={daemon.speakerVolume ?? 50}
                  onChange={daemon.setSpeakerVolume}
                  onToggleMute={daemon.toggleSpeakerMute}
                  disabled={!audioReady}
                />
              </Row>
              <Row divider>
                <AudioControlCard
                  kind="microphone"
                  value={daemon.microphoneVolume ?? 50}
                  onChange={daemon.setMicrophoneVolume}
                  onToggleMute={daemon.toggleMicrophoneMute}
                  disabled={!audioReady}
                />
              </Row>
            </Card>
          </Section>

          {/* NAME - robot-level identity. Rename over the data channel
              (SDK `setRobotName`); the daemon stores it and applies it live
              (status + central relay + mDNS, no restart). Auto-saves. */}
          <Section
            label="Name"
            blurb="The name shown in your robot list. Updates right away, no restart needed."
          >
            <Box sx={{ px: 3 }}>
              <Stack spacing={1}>
                <TextField
                  value={nameDraft}
                  onChange={e => {
                    setNameDraft(e.target.value.slice(0, MAX_ROBOT_NAME_LENGTH));
                    if (renameStep === 'done') setRenameStep('idle');
                    if (renameError) setRenameError(null);
                  }}
                  onKeyDown={e => {
                    if (e.key === 'Enter') void handleRename();
                  }}
                  onBlur={() => void handleRename()}
                  placeholder={robotName}
                  fullWidth
                  size="medium"
                  slotProps={{
                    htmlInput: { maxLength: MAX_ROBOT_NAME_LENGTH, 'aria-label': 'Robot name' },
                    input: {
                      endAdornment: (
                        <RenameStatus step={renameStep} hasError={Boolean(renameError)} />
                      ),
                    },
                  }}
                  sx={{ '& .MuiOutlinedInput-root': { bgcolor: 'background.paper' } }}
                />
                {renameError && (
                  <Typography sx={{ fontSize: TYPO.xs, color: 'error.main', lineHeight: 1.4 }}>
                    {renameError}
                  </Typography>
                )}
              </Stack>
            </Box>
          </Section>

          {/* ABOUT & DIAGNOSTICS. Drills into the info panel
              (connection / software / account / live logs). */}
          <Section label="About">
            <Card>
              <Row as="button" onClick={onOpenAbout} aria-label="Open about and diagnostics">
                <InfoOutlinedIcon
                  sx={{ fontSize: TYPO.xl, color: 'text.secondary', flexShrink: 0 }}
                />
                <Stack sx={{ flex: 1, minWidth: 0 }}>
                  <Typography sx={{ fontSize: TYPO.body, fontWeight: FONT_WEIGHT.medium }}>
                    About &amp; diagnostics
                  </Typography>
                  <Typography sx={{ fontSize: TYPO.xs, color: 'text.secondary', mt: 0.25 }}>
                    Connection, software, account and live logs.
                  </Typography>
                </Stack>
                <ChevronRightRoundedIcon
                  sx={{ fontSize: TYPO.xl, color: 'text.disabled', flexShrink: 0 }}
                />
              </Row>
            </Card>
          </Section>

          {/* ACCOUNT - destructive "sign this Reachy out of Hugging Face":
              clears the robot's own token so it unregisters from central and
              disappears from the owner's list until set up again. Two-step
              confirm. Reaches the daemon over the data channel. */}
          <Section
            label="Account"
            blurb="Unlink this Reachy from your Hugging Face account. You'll need to set it up again to use it."
          >
            <Card>
              <Box sx={{ px: 2, py: 2 }}>
                {signOutStep === 'idle' ? (
                  <Box
                    component="button"
                    type="button"
                    onClick={() => {
                      setSignOutError(null);
                      setSignOutStep('confirming');
                    }}
                    aria-label={`Sign out ${robotName}`}
                    sx={{
                      ...ghostBtnSx(theme.palette.error.main),
                      flex: 'none',
                      width: '100%',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      gap: 1,
                      px: 2,
                      py: 1.5,
                      border: `1.5px solid ${alpha(theme.palette.error.main, 0.45)}`,
                      fontSize: TYPO.body,
                      fontWeight: FONT_WEIGHT.semibold,
                      bgcolor: alpha(theme.palette.error.main, 0.05),
                      '&:hover': { bgcolor: alpha(theme.palette.error.main, 0.08) },
                    }}
                  >
                    <LogoutRoundedIcon sx={{ fontSize: TYPO.lg, flexShrink: 0 }} />
                    <Box component="span">Sign out this Reachy</Box>
                  </Box>
                ) : (
                  <Stack spacing={1.5}>
                    <Typography sx={{ fontSize: TYPO.sm, color: 'text.secondary', lineHeight: 1.4 }}>
                      Sign {robotName} out of Hugging Face? It will disappear from your robots until
                      you set it up again.
                    </Typography>
                    <Stack direction="row" spacing={1}>
                      <Box
                        component="button"
                        type="button"
                        onClick={() => {
                          setSignOutStep('idle');
                          setSignOutError(null);
                        }}
                        disabled={signOutStep === 'busy'}
                        sx={{
                          ...ghostBtnSx(theme.palette.primary.main),
                          py: 1.5,
                          fontSize: TYPO.body,
                          fontWeight: FONT_WEIGHT.semibold,
                          border: `1.5px solid ${alpha(theme.palette.primary.main, 0.45)}`,
                        }}
                      >
                        Cancel
                      </Box>
                      <Box
                        component="button"
                        type="button"
                        onClick={handleSignOutRobot}
                        disabled={signOutStep === 'busy'}
                        sx={{
                          ...ghostBtnSx(theme.palette.error.main),
                          py: 1.5,
                          fontSize: TYPO.body,
                          fontWeight: FONT_WEIGHT.semibold,
                          border: `1.5px solid ${alpha(theme.palette.error.main, 0.45)}`,
                        }}
                      >
                        {signOutStep === 'busy' ? 'Signing out…' : 'Sign out'}
                      </Box>
                    </Stack>
                    {signOutError && (
                      <Typography sx={{ fontSize: TYPO.xs, color: 'error.main', lineHeight: 1.4 }}>
                        {signOutError}
                      </Typography>
                    )}
                  </Stack>
                )}
              </Box>
            </Card>
          </Section>
        </Stack>
      </Box>
    </Box>
  );
}

/* ──────────────────────────────────────────────────────────────────
 * Layout primitives, local to this panel. Mirror the app's "section
 * header + paper card" rhythm.
 * ────────────────────────────────────────────────────────────────── */

function Section({
  label,
  blurb,
  children,
}: {
  label: string;
  blurb?: string;
  children: React.ReactNode;
}) {
  return (
    <Box>
      <Stack sx={{ px: 3, mb: 1.25 }}>
        <Typography
          sx={{
            fontSize: TYPO.lg,
            fontWeight: FONT_WEIGHT.semibold,
            letterSpacing: '-0.2px',
            lineHeight: 1.2,
          }}
        >
          {label}
        </Typography>
        {blurb && (
          <Typography sx={{ fontSize: TYPO.xs, color: 'text.secondary', mt: 0.25 }}>
            {blurb}
          </Typography>
        )}
      </Stack>
      {children}
    </Box>
  );
}

/** Paper card wrapper with the app's "white island on grey" look,
 *  inset by the standard `px: 3` gutter. */
function Card({ children }: { children: React.ReactNode }) {
  return (
    <Box sx={{ px: 3 }}>
      <Box
        sx={theme => ({
          borderRadius: `${RADIUS.lg}px`,
          bgcolor: 'background.paper',
          border: `1px solid ${theme.palette.divider}`,
          overflow: 'hidden',
        })}
      >
        {children}
      </Box>
    </Box>
  );
}

interface RowProps {
  children: React.ReactNode;
  /** Render as a tappable button (rows that act) vs a static div. */
  as?: 'div' | 'button';
  /** Draw a top hairline (for stacked rows inside a Card). */
  divider?: boolean;
  disabled?: boolean;
  onClick?: () => void;
  'aria-label'?: string;
}

function Row({ children, as = 'div', divider = false, disabled = false, ...rest }: RowProps) {
  const interactive = as === 'button';
  return (
    <Box
      component={interactive ? 'button' : 'div'}
      type={interactive ? 'button' : undefined}
      disabled={interactive ? disabled : undefined}
      {...rest}
      sx={theme => ({
        width: '100%',
        display: 'flex',
        alignItems: 'center',
        gap: 1.5,
        px: 2,
        py: 1.5,
        textAlign: 'left',
        appearance: 'none',
        font: 'inherit',
        color: 'text.primary',
        bgcolor: 'transparent',
        border: 'none',
        borderTop: divider ? `1px solid ${theme.palette.divider}` : 'none',
        cursor: interactive && !disabled ? 'pointer' : 'default',
        opacity: disabled ? 0.5 : 1,
        transition: 'background-color 0.12s ease',
        WebkitTapHighlightColor: 'transparent',
        ...(interactive && !disabled
          ? { '&:hover': { bgcolor: alpha(theme.palette.text.primary, 0.03) } }
          : {}),
      })}
    >
      {children}
    </Box>
  );
}

/** In-field rename status shown at the input's right edge (endAdornment):
 *  a spinner while the auto-save is in flight, a "Saved" check once it
 *  lands, nothing at rest / on error (the error line renders below). */
function RenameStatus({
  step,
  hasError,
}: {
  step: 'idle' | 'busy' | 'done';
  hasError: boolean;
}) {
  if (step === 'busy') {
    return <CircularProgress size={16} thickness={5} sx={{ color: 'text.secondary', mr: -0.25 }} />;
  }
  if (step === 'done' && !hasError) {
    return (
      <Stack
        direction="row"
        spacing={0.5}
        sx={{ alignItems: 'center', flexShrink: 0, mr: -0.25, color: 'success.main' }}
      >
        <CheckRoundedIcon sx={{ fontSize: 16 }} />
        <Typography component="span" sx={{ fontSize: TYPO.xs, fontWeight: FONT_WEIGHT.semibold }}>
          Saved
        </Typography>
      </Stack>
    );
  }
  return null;
}

/** Outlined ghost-button style tinted by `color` (confirm/cancel actions). */
function ghostBtnSx(color: string) {
  return {
    flex: 1,
    appearance: 'none',
    cursor: 'pointer',
    font: 'inherit',
    py: 1,
    borderRadius: `${RADIUS.md}px`,
    bgcolor: 'transparent',
    border: `1px solid ${alpha(color, 0.4)}`,
    color,
    fontSize: TYPO.sm,
    fontWeight: FONT_WEIGHT.medium,
    WebkitTapHighlightColor: 'transparent',
    '&:active': { transform: 'scale(0.99)' },
  } as const;
}
