/**
 * ConversationSettingsPanel - the "cog" surface for conversation-scoped
 * options.
 *
 * Rendered in the conversation body slot (same body-swap the
 * `PersonalityStore` uses): the persistent personality band stays
 * above, the orb area is replaced by this panel, and the bottom strip
 * stays put with its cog shown active. Opened only while a conversation
 * is stopped (the strip cog is disabled while live), so every option
 * here is read by the engine at the next conversation start - there is
 * no live-apply path to reason about.
 *
 * Three groups:
 *   - Language: the conversation language (moved here out of the bottom
 *     strip). Single-select list reused from the `conversation-language`
 *     catalog.
 *   - Vision: a toggle gating the passive scene-awareness module.
 *   - Memory: a toggle gating long-term memory + a destructive
 *     "Clear memory" with a two-step confirm.
 */
import { useState } from 'react';
import { Box, Button, ButtonBase, ButtonGroup, Stack, Typography, alpha, useTheme } from '@mui/material';
import DeleteOutlineRoundedIcon from '@mui/icons-material/DeleteOutlineRounded';
import SettingsOutlinedIcon from '@mui/icons-material/SettingsOutlined';
import MicNoneOutlinedIcon from '@mui/icons-material/MicNoneOutlined';

import {
  LANGUAGES,
  setActiveLanguageId,
  useActiveLanguageId,
  type LanguageId,
} from '@/features/conversation-language';
import {
  setMemoryEnabled,
  setRealtimeBackend,
  setVisionEnabled,
  useMemoryEnabled,
  useRealtimeBackend,
  useVisionEnabled,
} from '@/features/conversation-settings';
import type { RealtimeBackendKind } from '@/features/conversation/engine/realtime/types';
import { useMemoryStore } from '@/features/conversation/hooks/useMemoryStore';
import { OutlinedSwitch } from '@/ui/design/OutlinedSwitch';
import { FONT_WEIGHT, RADIUS, TYPO } from '@/ui/design/tokens';

/** Selectable realtime providers, in display order. Labels are
 *  user-facing; ids match `RealtimeBackendKind`. */
const REALTIME_BACKENDS: ReadonlyArray<{
  id: RealtimeBackendKind;
  label: string;
}> = [
  { id: 'openai', label: 'OpenAI' },
  { id: 'huggingface', label: 'Hugging Face' },
];

export function ConversationSettingsPanel() {
  const theme = useTheme();
  const activeLanguageId = useActiveLanguageId();
  const visionEnabled = useVisionEnabled();
  const memoryEnabled = useMemoryEnabled();
  const realtimeBackend = useRealtimeBackend();
  const { facts, clear } = useMemoryStore();

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
          so this title is the user's anchor that they're in the
          conversation settings surface (and the strip cog stays lit as
          the way out). No separator - it sits flush over the scrolling
          content. */}
      <Box sx={{ flexShrink: 0, px: 3, pt: 3.5, pb: 1 }}>
        <Stack sx={{ flexDirection: 'row', alignItems: 'center', gap: 1 }}>
          {/* Composite glyph: a microphone (the conversation) badged with
              a small cog at the bottom-right (its settings). The badge
              sits on a `background.default` disc so the cog reads cleanly
              over the mic. */}
          <Box
            sx={{
              position: 'relative',
              width: 26,
              height: 26,
              flexShrink: 0,
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: 'text.secondary',
            }}
          >
            <MicNoneOutlinedIcon sx={{ fontSize: 24 }} />
            <Box
              sx={{
                position: 'absolute',
                right: -3,
                bottom: -2,
                width: 15,
                height: 15,
                borderRadius: '50%',
                bgcolor: 'background.default',
                display: 'grid',
                placeItems: 'center',
              }}
            >
              <SettingsOutlinedIcon sx={{ fontSize: 12 }} />
            </Box>
          </Box>
          <Typography
            component="h2"
            sx={{
              fontSize: TYPO.xxl,
              fontWeight: FONT_WEIGHT.bold,
              letterSpacing: '-0.3px',
              lineHeight: 1.2,
            }}
          >
            Conversation settings
          </Typography>
        </Stack>
      </Box>

      <Box sx={{ flex: 1, minHeight: 0, overflowY: 'auto', pt: 2, pb: 4 }}>
        <Stack spacing={4}>
          {/* REALTIME BACKEND - which provider powers the live voice
              session. Single-line ButtonGroup single-select. Read by the
              engine at the next conversation start, so no live-apply path.
              First param: it's the most structural choice in this panel. */}
          <Section
            label="Realtime backend"
            blurb="Which provider powers the live voice conversation. Applies on the next conversation."
          >
            <Box sx={{ px: 3 }}>
              <ButtonGroup
                fullWidth
                disableElevation
                color="primary"
                aria-label="Realtime backend"
                sx={{ '& .MuiButtonGroup-grouped': { borderColor: theme.palette.primary.main } }}
              >
                {REALTIME_BACKENDS.map(opt => {
                  const active = opt.id === realtimeBackend;
                  return (
                    <Button
                      key={opt.id}
                      onClick={() => setRealtimeBackend(opt.id)}
                      aria-pressed={active}
                      aria-label={`Use the ${opt.label} realtime backend`}
                      variant="outlined"
                      color="primary"
                      disableRipple
                      sx={{
                        textTransform: 'none',
                        fontSize: TYPO.sm,
                        fontWeight: active ? FONT_WEIGHT.bold : FONT_WEIGHT.semibold,
                        py: 1,
                        color: 'primary.main',
                        borderColor: 'primary.main',
                        opacity: active ? 1 : 0.55,
                        bgcolor: active
                          ? 'background.paper'
                          : alpha(theme.palette.primary.main, 0.12),
                        WebkitTapHighlightColor: 'transparent',
                        '&:hover': {
                          borderColor: 'primary.main',
                          bgcolor: active
                            ? 'background.paper'
                            : alpha(theme.palette.primary.main, 0.16),
                        },
                      }}
                    >
                      {opt.label}
                    </Button>
                  );
                })}
              </ButtonGroup>
            </Box>
          </Section>

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
                    onClick={() => facts.length > 0 && setConfirmingClear(true)}
                    aria-label="Clear memory"
                    disabled={facts.length === 0}
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
                      opacity: facts.length === 0 ? 0.5 : 1,
                      cursor: facts.length === 0 ? 'default' : 'pointer',
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
