/**
 * Conversation tab body when the conversation runs ON THE ROBOT.
 *
 * The phone no longer captures audio or runs the AI; this panel is a remote
 * control for the on-robot conversation app, driven over the data channel
 * (`useConvApp`). Replaces the phone-side `ConversationPanel` (orb + local
 * pipeline) in `RobotSessionScreen`.
 */
import { Box, Button, CircularProgress, MenuItem, Select, Stack, Typography } from '@mui/material';

import { useConvApp } from '@/features/conv-app/useConvApp';
import type { ConvAppStatus } from '@/features/conv-app/client';
import type { RobotSessionHandle } from '@/features/robot-session/useRobotSession';
import Section from '@/ui/design/Section';
import { FONT_WEIGHT, TYPO } from '@/ui/design/tokens';
import { ConversationOrb, type OrbState } from '@/ui/panels/conversation/orb/ConversationOrb';

interface Props {
  session: RobotSessionHandle;
  active: boolean;
}

/** Map the on-robot turn state (+ backend status) to an orb visual state. */
function toOrbState(turn: string | null, status: ConvAppStatus | null): OrbState {
  if (status && !status.backend_connected) return 'connecting';
  switch (turn) {
    case 'listening':
      return 'listening';
    case 'thinking':
      return 'processing';
    case 'speaking':
      return 'ai-speaking';
    default:
      return 'ready';
  }
}

/** One-line caption under the orb. */
function orbCaption(
  turn: string | null,
  micMuted: boolean | null,
  status: ConvAppStatus | null
): string {
  if (micMuted) return 'Muted';
  if (status && !status.backend_connected) return 'Connecting…';
  switch (turn) {
    case 'listening':
      return 'Listening';
    case 'thinking':
      return 'Thinking';
    case 'speaking':
      return 'Speaking';
    default:
      return 'Ready';
  }
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <Box
      sx={theme => ({
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 1.5,
        px: 2,
        py: 1.5,
        '&:not(:last-of-type)': { borderBottom: `1px solid ${theme.palette.divider}` },
      })}
    >
      <Typography sx={{ fontSize: TYPO.body }}>{label}</Typography>
      {children}
    </Box>
  );
}

export function ConvAppControlPanel({ session, active }: Props) {
  const enabled = session.hasReachedReady && active;
  const conv = useConvApp(session, enabled);

  return (
    <Box sx={{ flex: 1, minHeight: 0, overflowY: 'auto', px: 2.5, py: 2, width: '100%' }}>
      <Stack spacing={3} sx={{ maxWidth: 480, mx: 'auto' }}>
        <Typography sx={{ fontSize: TYPO.lg, fontWeight: FONT_WEIGHT.semibold }}>
          Conversation
        </Typography>

        {!enabled ? (
          <Stack sx={{ py: 4, alignItems: 'center' }}>
            <CircularProgress size={24} sx={{ color: 'grey.500' }} />
          </Stack>
        ) : !conv.running ? (
          <Stack spacing={2} sx={{ py: 4, alignItems: 'center' }}>
            <Typography sx={{ fontSize: TYPO.body, color: 'text.secondary' }}>
              The conversation app is not running on the robot.
            </Typography>
            <Button
              variant="contained"
              disabled={conv.start.isPending || conv.appStatusLoading}
              onClick={() => conv.start.mutate()}
            >
              {conv.start.isPending ? 'Starting…' : 'Start conversation'}
            </Button>
            {conv.start.isError && (
              <Typography sx={{ fontSize: TYPO.xs, color: 'error.main' }}>
                {(conv.start.error as Error).message}
              </Typography>
            )}
          </Stack>
        ) : (
          <>
            {/* Orb reflects the on-robot turn state (conversation.turn events);
                tapping it toggles the robot's mic, like the old phone orb. */}
            <Stack spacing={1} sx={{ alignItems: 'center', py: 1 }}>
              <ConversationOrb
                state={toOrbState(conv.turnState, conv.status)}
                disabled={conv.micMuted === null || conv.setMic.isPending}
                ariaLabel="Conversation status (tap to mute)"
                onClick={() => conv.setMic.mutate(conv.micMuted === false)}
              />
              <Typography sx={{ fontSize: TYPO.body, color: 'text.secondary' }}>
                {orbCaption(conv.turnState, conv.micMuted, conv.status)}
              </Typography>
            </Stack>

            <Section label="Status">
              <Row label="Backend">
                <Typography sx={{ fontSize: TYPO.body, color: 'text.secondary' }}>
                  {conv.status
                    ? conv.status.backend_connected
                      ? (conv.status.backend ?? 'connected')
                      : (conv.status.backend_connection_state ?? 'connecting…')
                    : '…'}
                </Typography>
              </Row>
            </Section>

            {conv.personalities && (
              <Section label="Personality">
                <Row label="Active">
                  <Select
                    size="small"
                    value={conv.personalities.current}
                    disabled={conv.personalities.locked || conv.applyPersonality.isPending}
                    onChange={e => conv.applyPersonality.mutate(e.target.value)}
                    sx={{ minWidth: 160, fontSize: TYPO.body }}
                  >
                    {conv.personalities.choices.map(p => (
                      <MenuItem key={p} value={p} sx={{ fontSize: TYPO.body }}>
                        {p}
                      </MenuItem>
                    ))}
                  </Select>
                </Row>
              </Section>
            )}

            {conv.voices && conv.voices.list.length > 0 && (
              <Section label="Voice">
                <Row label="Active">
                  <Select
                    size="small"
                    value={conv.voices.current}
                    disabled={conv.applyVoice.isPending}
                    onChange={e => conv.applyVoice.mutate(e.target.value)}
                    sx={{ minWidth: 160, fontSize: TYPO.body }}
                  >
                    {conv.voices.list.map(v => (
                      <MenuItem key={v} value={v} sx={{ fontSize: TYPO.body }}>
                        {v}
                      </MenuItem>
                    ))}
                  </Select>
                </Row>
              </Section>
            )}

            <Button
              variant="outlined"
              color="inherit"
              disabled={conv.stop.isPending}
              onClick={() => conv.stop.mutate()}
            >
              {conv.stop.isPending ? 'Stopping…' : 'Stop conversation'}
            </Button>
          </>
        )}
      </Stack>
    </Box>
  );
}
