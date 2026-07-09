/**
 * ConversationSettingsPanel - the "cog" Settings surface.
 *
 * Despite the legacy name, this is the robot's Settings panel: it opens
 * from the topbar cog and leads with robot-level options, then the
 * conversation-scoped ones. Rendered as a fixed overlay below the
 * session topbar (the cog glyph swaps to `✕` while open).
 *
 * Groups, top to bottom:
 *   - Audio (robot-level): speaker + microphone volume. These act on the
 *     daemon's audio devices, not on any single conversation, so they
 *     read/apply live regardless of conversation state.
 *   - Language (conversation): the language Reachy speaks/listens in.
 *     Single-select chips from the `conversation-language` catalog.
 *   - Privacy & memory (conversation): a vision toggle gating passive
 *     scene-awareness, a long-term-memory toggle, and a destructive
 *     "Clear memory" with a two-step confirm.
 */
import { useState } from 'react';
import { Box, ButtonBase, Stack, Typography, alpha, useTheme } from '@mui/material';
import ChevronRightRoundedIcon from '@mui/icons-material/ChevronRightRounded';
import DeleteOutlineRoundedIcon from '@mui/icons-material/DeleteOutlineRounded';
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined';
import SettingsOutlinedIcon from '@mui/icons-material/SettingsOutlined';

import {
  LANGUAGES,
  setActiveLanguageId,
  useActiveLanguageId,
  type LanguageId,
} from '@/features/conversation-language';
import {
  setMemoryEnabled,
  setVisionEnabled,
  useMemoryEnabled,
  useVisionEnabled,
} from '@/features/conversation-settings';
import { useMemoryStore } from '@/features/conversation-settings/useMemoryStore';
import { useDaemonState } from '@/features/daemon-state';
import { OutlinedSwitch } from '@/ui/design/OutlinedSwitch';
import AudioControlCard from '@/ui/widgets/audio-controls/AudioControlCard';
import { FONT_WEIGHT, RADIUS, TYPO } from '@/ui/design/tokens';

export interface ConversationSettingsPanelProps {
  /** Whether the daemon has reported its audio state at least once.
   *  Gates the volume sliders so they can't be dragged against an
   *  unreachable daemon (values fall back to 50 until then). */
  audioReady: boolean;
  /** Drill into the "About & diagnostics" sub-page (the host swaps this
   *  panel for `<RobotInfoPanel>`). Surfaced as a tappable row at the
   *  end of the panel. */
  onOpenAbout: () => void;
  /** `true` while a conversation is running (state ≠ `idle`). The
   *  conversation-scoped options (Language, Privacy & memory) are read
   *  by the engine at conversation start, so changing them mid-talk
   *  would silently no-op; we lock them while live and show a hint.
   *  Audio (robot-level, live) and About stay usable. */
  conversationLive: boolean;
}

export function ConversationSettingsPanel({
  audioReady,
  onOpenAbout,
  conversationLive,
}: ConversationSettingsPanelProps) {
  const theme = useTheme();
  const activeLanguageId = useActiveLanguageId();
  const visionEnabled = useVisionEnabled();
  const memoryEnabled = useMemoryEnabled();
  const { facts, clear } = useMemoryStore();

  // Daemon-side audio state (volumes + mute toggles). Read here so the
  // speaker / microphone sliders live alongside the other conversation
  // options instead of in a separate bottom strip.
  const daemon = useDaemonState();

  const [confirmingClear, setConfirmingClear] = useState(false);

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
      {/* Header. The settings overlay hides the personality band above,
          so this title is the user's anchor that they're in the robot
          Settings surface (and the topbar cog stays lit as the way
          out). No separator - it sits flush over the scrolling
          content. */}
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
          {/* ROBOT scope: device-level settings that apply regardless of
              any conversation (Audio) plus the diagnostics drill-in. */}
          <GroupLabel>Robot</GroupLabel>

          {/* AUDIO - robot-level. Speaker + microphone volume act on the
              daemon's audio devices, not on a single conversation, so
              they lead the panel as the robot section. Each row is a
              pure icon+slider (`AudioControlCard`); the Card provides
              the surface. */}
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

          {/* ABOUT & DIAGNOSTICS - robot-level. Drills into the old info
              panel (connection / software / account / live logs). Sits
              with Audio under the robot-level part of the panel, above
              the conversation group. */}
          <Section label="About">
            <Card>
              <Row as="button" onClick={onOpenAbout} aria-label="Open about and diagnostics">
                <InfoOutlinedIcon sx={{ fontSize: TYPO.xl, color: 'text.secondary', flexShrink: 0 }} />
                <Stack sx={{ flex: 1, minWidth: 0 }}>
                  <Typography sx={{ fontSize: TYPO.body, fontWeight: FONT_WEIGHT.medium }}>
                    About &amp; diagnostics
                  </Typography>
                  <Typography sx={{ fontSize: TYPO.xs, color: 'text.secondary', mt: 0.25 }}>
                    Connection, software, account and live logs.
                  </Typography>
                </Stack>
                <ChevronRightRoundedIcon sx={{ fontSize: TYPO.xl, color: 'text.disabled', flexShrink: 0 }} />
              </Row>
            </Card>
          </Section>

          {/* Group label marking the boundary between the robot-level
              sections above (Audio, About) and the conversation-scoped
              options below (Language, Privacy & memory). */}
          <GroupLabel>Conversation</GroupLabel>
          {/* These options are read by the engine when a conversation
              starts, so they're locked while one is running. */}
          {conversationLive && (
            <Typography
              sx={{ px: 3, fontSize: TYPO.xs, color: 'text.disabled', lineHeight: 1.4 }}
            >
              Locked while talking - stop the conversation to change these.
            </Typography>
          )}

          {/* LANGUAGE - compact wrapping chip row. A vertical 7-row list
              ate too much height; the chips fold the same options into
              ~1-2 rows (same pill treatment as the voice chips in
              CreatePersonalityModal) while keeping every option visible. */}
          <Section label="Language" blurb="The language Reachy speaks and listens in.">
            <Box sx={{ px: 3 }}>
              <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1 }}>
                {LANGUAGES.map(lang => {
                  const active = lang.id === activeLanguageId;
                  return (
                    <ButtonBase
                      key={lang.id}
                      onClick={() => setActiveLanguageId(lang.id as LanguageId)}
                      disabled={conversationLive}
                      aria-pressed={active}
                      aria-label={`Speak ${lang.nameEnglish}`}
                      sx={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 0.75,
                        pl: 1.25,
                        pr: 1.5,
                        py: 0.75,
                        borderRadius: `${RADIUS.sm}px`,
                        fontSize: TYPO.sm,
                        opacity: conversationLive && !active ? 0.45 : 1,
                        // Constant weight in both states: switching to
                        // semibold on active made the (bolder) text wider
                        // and nudged the neighbouring chips in x. Active
                        // is signalled by colour + bg + border instead.
                        fontWeight: FONT_WEIGHT.semibold,
                        color: active ? 'primary.main' : 'text.primary',
                        bgcolor: active
                          ? alpha(theme.palette.primary.main, 0.1)
                          : 'background.paper',
                        // Constant 1.5px border in BOTH states (only the
                        // colour changes) so toggling active never resizes
                        // the chip and shifts its neighbours - no flicker.
                        border: `1.5px solid ${
                          active ? theme.palette.primary.main : theme.palette.divider
                        }`,
                        transition: 'background-color 0.15s ease, border-color 0.15s ease',
                        WebkitTapHighlightColor: 'transparent',
                        '&:active': { transform: 'scale(0.97)' },
                      }}
                    >
                      <Box component="span" sx={{ fontSize: '1.15rem', lineHeight: 1 }}>
                        {lang.flag}
                      </Box>
                      {lang.nameNative}
                    </ButtonBase>
                  );
                })}
              </Box>
            </Box>
          </Section>

          {/* PRIVACY & MEMORY */}
          <Section
            label="Privacy & memory"
            blurb="Control what Reachy can see and remember."
          >
            <Card>
              <Row divider={false}>
                <Stack sx={{ flex: 1, minWidth: 0 }}>
                  <Typography sx={{ fontSize: TYPO.body, fontWeight: FONT_WEIGHT.medium }}>
                    Let Reachy see
                  </Typography>
                  <Typography sx={{ fontSize: TYPO.xs, color: 'text.secondary', mt: 0.25 }}>
                    Passive scene awareness: glances through the camera to react to your surroundings.
                  </Typography>
                </Stack>
                <OutlinedSwitch
                  checked={visionEnabled}
                  onChange={(_, checked) => setVisionEnabled(checked)}
                  disabled={conversationLive}
                  slotProps={{ input: { 'aria-label': 'Let Reachy see' } }}
                />
              </Row>
              <Row divider>
                <Stack sx={{ flex: 1, minWidth: 0 }}>
                  <Typography sx={{ fontSize: TYPO.body, fontWeight: FONT_WEIGHT.medium }}>
                    Long-term memory
                  </Typography>
                  <Typography sx={{ fontSize: TYPO.xs, color: 'text.secondary', mt: 0.25 }}>
                    Lets Reachy remember a few facts you share, across conversations.
                  </Typography>
                </Stack>
                <OutlinedSwitch
                  checked={memoryEnabled}
                  onChange={(_, checked) => setMemoryEnabled(checked)}
                  disabled={conversationLive}
                  slotProps={{ input: { 'aria-label': 'Long-term memory' } }}
                />
              </Row>

              {/* Clear memory: real danger button INSIDE this card,
                  directly below the toggle (same concern), no divider
                  between them - just a padded footer. Disabled when
                  there's nothing to clear so it never teases a no-op. */}
              <Box sx={{ px: 2, pb: 2 }}>
                {!confirmingClear ? (
                  <Box
                    component="button"
                    type="button"
                    onClick={() =>
                      !conversationLive && facts.length > 0 && setConfirmingClear(true)
                    }
                    aria-label="Clear memory"
                    disabled={facts.length === 0 || conversationLive}
                    sx={{
                      ...ghostBtnSx(theme.palette.error.main),
                      flex: 'none',
                      width: '100%',
                      display: 'flex',
                      alignItems: 'center',
                      gap: 1,
                      px: 2,
                      py: 1.5,
                      border: `1.5px solid ${alpha(theme.palette.error.main, 0.45)}`,
                      fontSize: TYPO.body,
                      fontWeight: FONT_WEIGHT.semibold,
                      bgcolor: alpha(theme.palette.error.main, 0.05),
                      opacity: facts.length === 0 || conversationLive ? 0.5 : 1,
                      cursor: facts.length === 0 || conversationLive ? 'default' : 'pointer',
                      '&:hover': { bgcolor: alpha(theme.palette.error.main, 0.08) },
                    }}
                  >
                    <DeleteOutlineRoundedIcon sx={{ fontSize: TYPO.lg, flexShrink: 0 }} />
                    <Box component="span" sx={{ flexShrink: 0 }}>
                      Clear memory
                    </Box>
                    <Box
                      component="span"
                      sx={{ ml: 'auto', color: 'text.disabled', fontSize: TYPO.xs }}
                    >
                      {facts.length} {facts.length === 1 ? 'fact' : 'facts'}
                    </Box>
                  </Box>
                ) : (
                  <Stack direction="row" spacing={1}>
                    <Box
                      component="button"
                      type="button"
                      onClick={() => setConfirmingClear(false)}
                      sx={{
                        ...ghostBtnSx(theme.palette.primary.main),
                        py: 1.5,
                        fontSize: TYPO.body,
                        fontWeight: FONT_WEIGHT.semibold,
                        border: `1.5px solid ${alpha(theme.palette.primary.main, 0.45)}`,
                      }}
                    >
                      Keep
                    </Box>
                    <Box
                      component="button"
                      type="button"
                      onClick={() => {
                        clear();
                        setConfirmingClear(false);
                      }}
                      sx={{
                        ...ghostBtnSx(theme.palette.error.main),
                        py: 1.5,
                        fontSize: TYPO.body,
                        fontWeight: FONT_WEIGHT.semibold,
                        border: `1.5px solid ${alpha(theme.palette.error.main, 0.45)}`,
                      }}
                    >
                      Delete forever
                    </Box>
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
 * Layout primitives, local to this panel. Mirror the store's "section
 * header + paper card" rhythm so the two body-swap surfaces feel like
 * siblings.
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

/** Top-tier group heading ("Robot" / "Conversation") that splits the
 *  panel into its two scopes. Sized ABOVE the `Section` labels
 *  (`TYPO.xl` vs `TYPO.lg`) so the hierarchy reads top-down:
 *  panel title (xxl) > group (xl) > section (lg) > rows. */
function GroupLabel({ children }: { children: React.ReactNode }) {
  return (
    <Typography
      sx={{
        px: 3,
        // Pull the following section up so the heading hugs its own
        // group (the Stack's `spacing={4}` would otherwise leave it
        // floating equidistant between groups, breaking the grouping).
        mb: -2,
        fontSize: TYPO.xl,
        fontWeight: FONT_WEIGHT.bold,
        letterSpacing: '-0.2px',
        lineHeight: 1.2,
        color: 'text.primary',
      }}
    >
      {children}
    </Typography>
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
  /** Standalone paper card row (its own surface + border), used for the
   *  clear-memory affordance which sits outside the grouped Card. */
  card?: boolean;
  disabled?: boolean;
  onClick?: () => void;
  'aria-label'?: string;
  'aria-pressed'?: boolean;
}

function Row({
  children,
  as = 'div',
  divider = false,
  card = false,
  disabled = false,
  ...rest
}: RowProps) {
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
        bgcolor: card ? 'background.paper' : 'transparent',
        border: card ? `1px solid ${theme.palette.divider}` : 'none',
        borderRadius: card ? `${RADIUS.lg}px` : 0,
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
