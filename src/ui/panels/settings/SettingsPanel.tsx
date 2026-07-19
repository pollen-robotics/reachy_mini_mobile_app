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
import { Box, Stack, Typography, alpha } from '@mui/material';
import ChevronRightRoundedIcon from '@mui/icons-material/ChevronRightRounded';
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined';
import SettingsOutlinedIcon from '@mui/icons-material/SettingsOutlined';

import { useDaemonState } from '@/features/daemon-state';
import AudioControlCard from '@/ui/widgets/audio-controls/AudioControlCard';
import { FONT_WEIGHT, RADIUS, TYPO } from '@/ui/design/tokens';

export interface SettingsPanelProps {
  /** Whether the daemon has reported its audio state at least once.
   *  Gates the volume sliders so they can't be dragged against an
   *  unreachable daemon (values fall back to 50 until then). */
  audioReady: boolean;
  /** Drill into the "About & diagnostics" sub-page (the host swaps this
   *  panel for `<RobotInfoPanel>`). Surfaced as a tappable row at the
   *  end of the panel. */
  onOpenAbout: () => void;
}

export function SettingsPanel({ audioReady, onOpenAbout }: SettingsPanelProps) {
  // Daemon-side audio state (volumes + mute toggles).
  const daemon = useDaemonState();

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
