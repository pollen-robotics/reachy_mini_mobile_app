/**
 * PersonalityPill - hero band that introduces the active persona
 * AND toggles the personality picker grid below.
 *
 *   ╭─────╮  Noir Detective                ▾   (closed)
 *   │  ◉  │  Smoky, suspicious, one
 *   ╰─────╯  sentence per answer.
 *
 *   ╭─────╮  Noir Detective                ▴   (open: chevron flips)
 *   │  ◉  │  ...                                The grid replaces the
 *   ╰─────╯                                     orb area in the host.
 *
 * Despite the legacy name, this is no longer a pill - it's a
 * full-bleed "hero band" that hosts the active persona's identity
 * AND a toggle. The toggle switches the host's view between the
 * orb area and the personality grid (see PersonalityGrid).
 *
 * Controlled by the host
 * ──────────────────────
 * Open / closed state lives in the host (`ConversationPanel`)
 * because the host is also the one swapping the body content
 * between orb and grid - the band shouldn't own state it doesn't
 * read. We expose `open` + `onToggle` and wire the chevron rotation
 * + the aria-expanded value off them.
 *
 * Selection flow
 * ──────────────
 * The band ITSELF doesn't pick a personality - it just opens the
 * grid. The grid mutates the personality store on tap; the
 * conversation panel above watches the active id and triggers
 * `restartConversation()` if a session is live, so the running
 * OpenAI client picks up the new instructions + voice on the next
 * reconnect.
 */
import {
  Box,
  ButtonBase,
  Stack,
  Typography,
  useTheme,
} from '@mui/material';
import KeyboardArrowDownIcon from '@mui/icons-material/KeyboardArrowDown';

import { useActivePersonality } from '@/features/personalities';
import { FONT_WEIGHT, TYPO } from '@/ui/design/tokens';

interface PersonalityPillProps {
  /** Whether the personality grid is currently displayed in the
   *  host's body slot. Drives the chevron rotation + aria-expanded. */
  open: boolean;
  /** Toggle handler called on every tap of the band. The host is
   *  expected to flip its `open` state in response. */
  onToggle: () => void;
  /**
   * Disable the picker entirely. Used by the host while a live
   * conversation is running so the user can't switch personas
   * mid-call (which would force a stop+start of the OpenAI client
   * and audibly cut Reachy off mid-sentence). The band stays
   * mounted and keeps showing the active persona, but loses its
   * hover / press affordances + the chevron.
   */
  disabled?: boolean;
}

export function PersonalityPill({
  open,
  onToggle,
  disabled = false,
}: PersonalityPillProps) {
  const theme = useTheme();
  const active = useActivePersonality();

  return (
    <ButtonBase
      onClick={onToggle}
      disabled={disabled}
      focusRipple
      // `aria-controls` would be ideal here but we don't have a
      // stable id for the grid (it's rendered conditionally in the
      // host); aria-expanded alone is still meaningful and read by
      // screen readers as "this control toggles a related region".
      aria-expanded={open}
      aria-label={
        disabled
          ? `Personality: ${active.name}. Locked while talking - end the conversation to change.`
          : open
            ? 'Close personality picker'
            : `Personality: ${active.name}. Tap to open the picker.`
      }
      sx={{
        display: 'flex',
        width: '100%',
        alignItems: 'center',
        gap: 2,
        px: 3,
        py: 1.75,
        color: 'text.primary',
        textAlign: 'left',
        // Hover / pressed feedback - subtle so the band stays
        // calm. The orb below is the primary CTA, this is just
        // a "speaker label" you can tap. Both feedbacks are
        // suppressed when disabled so the band doesn't tease an
        // affordance it can't honour.
        transition: 'background-color 0.15s ease, opacity 0.18s ease',
        opacity: disabled ? 0.55 : 1,
        cursor: disabled ? 'not-allowed' : 'pointer',
        '&:hover': disabled
          ? {}
          : {
              bgcolor: theme.palette.mode === 'dark'
                ? 'rgba(255, 255, 255, 0.04)'
                : 'rgba(0, 0, 0, 0.025)',
            },
        '&:active': disabled
          ? {}
          : {
              bgcolor: theme.palette.mode === 'dark'
                ? 'rgba(255, 255, 255, 0.07)'
                : 'rgba(0, 0, 0, 0.05)',
            },
        // MUI's `<ButtonBase disabled>` adds `pointer-events: none`
        // which would also block the `not-allowed` cursor we set
        // above. Re-enable just the cursor so the user gets visual
        // feedback that the band is intentionally inert (vs. dead
        // / broken).
        '&.Mui-disabled': {
          pointerEvents: 'auto',
          color: 'text.primary',
        },
      }}
    >
      {/* Avatar disc + oversize SVG (RobotAvatar pattern). The
          disc keeps its 68px footprint, but the illustration
          inside is rendered at 155% so the head body sits dead
          centre and the antennas / hat / accessories spill above
          the rim. `overflow: visible` lets the spill show, while
          the disc background still draws the perfect 68px circle
          behind it. The translate(-50%, -60%) shifts the SVG up
          so the head ends up at the disc's centre rather than
          the SVG's geometric centre (the bottom ~17% of the
          source SVGs is empty whitespace). */}
      <Box
        sx={{
          width: 68,
          height: 68,
          flexShrink: 0,
          position: 'relative',
          borderRadius: '50%',
          bgcolor: theme.palette.mode === 'dark'
            ? 'rgba(255, 255, 255, 0.04)'
            : 'rgba(0, 0, 0, 0.025)',
          boxShadow: 'inset 0 0 0 1px rgba(0, 0, 0, 0.06)',
          overflow: 'visible',
        }}
      >
        <Box
          component="img"
          src={active.avatar}
          alt=""
          aria-hidden
          draggable={false}
          sx={{
            position: 'absolute',
            width: '140%',
            height: 'auto',
            left: '50%',
            top: '50%',
            transform: 'translate(-50%, -57%)',
            pointerEvents: 'none',
            userSelect: 'none',
          }}
        />
      </Box>
      <Stack
        sx={{
          flex: 1,
          minWidth: 0,
          alignItems: 'flex-start',
          justifyContent: 'center',
          gap: 0.25,
        }}
      >
        {/* Eyebrow label: lifts the band's purpose out of ambiguity.
            Without it, the avatar + name read as "this is the robot
            you're talking to", which collides with the robot identity
            chip in the top toolbar. With it, the band reads as
            "PERSONALITY: <name>" - one line of micro-typography
            does the entire semantic disambiguation.
            Same uppercase / letter-spacing / tiny size as the
            Section labels in RobotTabView so the typographic
            family stays consistent across tabs. */}
        <Typography
          component="span"
          sx={{
            // Quieter eyebrow: smaller (`micro` = 10.4px),
            // medium-weight (not semibold), more tracked, faded.
            // The name below carries the identity - the eyebrow
            // just disambiguates "what kind of thing this is",
            // so it should whisper, not announce.
            fontSize: TYPO.micro,
            fontWeight: FONT_WEIGHT.medium,
            color: 'text.secondary',
            opacity: 0.7,
            textTransform: 'uppercase',
            letterSpacing: '0.8px',
            lineHeight: 1.1,
            // Tiny -2px nudge so the eyebrow + name pair reads as
            // a single composed unit rather than two stacked
            // paragraphs separated by air.
            mb: '-2px',
          }}
        >
          Personality
        </Typography>
        <Typography
          sx={{
            fontWeight: 600,
            fontSize: 16,
            lineHeight: 1.2,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            width: '100%',
          }}
        >
          {active.name}
        </Typography>
        {/* The persona's tagline used to live here too; it was
            redundant with the dropdown grid (each card already
            shows it under the avatar) and made the sub-header band
            taller than it needed to be. The eyebrow + name carry
            enough identity for the band; the picker grid is the
            place to read the full pitch. */}
      </Stack>
      {/* Chevron sits inside a soft round chip - reads as a focal
          "tap-to-open" affordance instead of a free-floating
          glyph. The chip subtly tints toward the primary on
          hover so the band's interactivity is unambiguous.
          When disabled we keep the chip MOUNTED and just fade it
          to opacity 0 (instead of `display: none`). Otherwise the
          flex row's reserved width changes between enabled and
          disabled states, which forces the persona name + tagline
          ellipsis to recompute at a different cut point - visible
          as a layout flicker the moment the conversation starts. */}
      {/* Bare chevron in primary colour - no chip wrapper. The
          fixed-width Box is kept so the disabled state can fade
          to opacity 0 WITHOUT collapsing its slot (which would
          force the persona name's ellipsis to recompute and
          flicker the layout the moment a conversation starts). */}
      <Box
        aria-hidden
        sx={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
          width: 32,
          color: 'primary.main',
          transition: 'transform 0.18s ease, opacity 0.18s ease',
          transform: open ? 'rotate(180deg)' : 'rotate(0deg)',
          opacity: disabled ? 0 : 1,
        }}
      >
        <KeyboardArrowDownIcon sx={{ fontSize: 24 }} />
      </Box>
    </ButtonBase>
  );
}
