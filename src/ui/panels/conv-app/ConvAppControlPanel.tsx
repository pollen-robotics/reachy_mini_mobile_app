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
import type { RobotSessionHandle } from '@/features/robot-session/useRobotSession';
import Section from '@/ui/design/Section';
import { OutlinedSwitch } from '@/ui/design/OutlinedSwitch';
import { FONT_WEIGHT, TYPO } from '@/ui/design/tokens';

interface Props {
  session: RobotSessionHandle;
  active: boolean;
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
              {conv.turnState && (
                <Row label="Activity">
                  <Typography sx={{ fontSize: TYPO.body, color: 'text.secondary' }}>
                    {conv.turnState}
                  </Typography>
                </Row>
              )}
              <Row label="Microphone">
                <OutlinedSwitch
                  checked={conv.micMuted === false}
                  disabled={conv.micMuted === null || conv.setMic.isPending}
                  onChange={e => conv.setMic.mutate(!e.target.checked)}
                />
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
