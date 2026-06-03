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
import { Box, ButtonBase, Stack, Typography, useTheme } from '@mui/material';
import { alpha } from '@mui/material/styles';
import KeyboardArrowDownIcon from '@mui/icons-material/KeyboardArrowDown';
import CloseRoundedIcon from '@mui/icons-material/CloseRounded';
import AutoFixHighRoundedIcon from '@mui/icons-material/AutoFixHighRounded';
import EditOutlinedIcon from '@mui/icons-material/EditOutlined';

import {
  type Personality,
  useActivePersonality,
  useIsAvatarPending,
  usePersonaDraft,
} from '@/features/personalities';
import CookingMonogram from '@/ui/design/CookingMonogram';
import { FONT_WEIGHT, TYPO } from '@/ui/design/tokens';

interface PersonalityPillProps {
  /** Whether the personality grid is currently displayed in the
   *  host's body slot. Drives the chevron rotation + aria-expanded. */
  open: boolean;
  /** Toggle handler called on every tap of the band. The host is
   *  expected to flip its `open` state in response. */
  onToggle: () => void;
  /**
   * Close the open authoring form. Wired to the band's trailing "✕",
   * which is the only way out of the create/edit form. The "create"
   * ENTRY point no longer lives here - it's a dedicated CTA card at the
   * top of the store - so this control is shown only while a form is
   * open (see `creating` / `editingPersona`). Kept named `onCreate` for
   * call-site stability; in practice the host wires it to a "toggle
   * form" handler that closes whatever form is open.
   */
  onCreate: () => void;
  /**
   * Open the editor for the ACTIVE persona. Surfaced as a small pencil
   * in the band (the "select") and only when the active persona is a
   * custom one (built-ins aren't editable). The host wires this to its
   * "open edit form" handler.
   */
  onEditActive?: (persona: Personality) => void;
  /**
   * Whether the create-a-personality form is currently open. Flips the
   * band into "authoring" mode: the active-persona avatar becomes a
   * neutral "?" placeholder (no persona is selected yet, one is being
   * authored) and the trailing "+" morphs into a "✕" that closes the
   * form. The band itself stays visible the whole time so the user
   * keeps a stable anchor + an obvious way out of the form.
   */
  creating?: boolean;
  /**
   * When set, the band is in "editing" mode for this custom persona:
   * the avatar + name reflect the persona under edit, the eyebrow
   * reads "Editing", and (like create) the trailing "+" becomes a "✕"
   * that closes the editor. Mutually exclusive with `creating` in
   * practice (the host only opens one form at a time).
   */
  editingPersona?: Personality | null;
  /**
   * Disable the picker entirely. Used by the host while a live
   * conversation is running so the user can't switch personas
   * mid-call (which would force a stop+start of the OpenAI client
   * and audibly cut Reachy off mid-sentence). The band stays
   * mounted and keeps showing the active persona, but loses its
   * hover / press affordances + the chevron + the "+".
   */
  disabled?: boolean;
}

export function PersonalityPill({
  open,
  onToggle,
  onCreate,
  onEditActive,
  creating = false,
  editingPersona = null,
  disabled = false,
}: PersonalityPillProps) {
  const theme = useTheme();
  const active = useActivePersonality();
  // "A form is open" - covers both authoring a new persona and editing
  // an existing one. Drives the inert toggle, the hidden chevron, and
  // the trailing "✕".
  const authoring = creating || editingPersona !== null;
  // Persona shown in the band: the one under edit when editing, else
  // the active one. (Create mode shows a "?" placeholder instead.)
  const shown = editingPersona ?? active;

  // Live authoring draft published by the open form. While a form is
  // open the band mirrors it: the title tracks the typed name and the
  // disc shows the avatar (+ its regenerate control) - because the
  // avatar lives ONLY here on the band, never inside the form body.
  const draft = usePersonaDraft();
  const draftActive = authoring && draft !== null;
  const draftAvatar = draftActive ? draft.avatar : null;
  // Title mirrors the live name while authoring (falling back to the
  // static label until the user types one); otherwise the shown persona.
  const title = draftActive
    ? draft.name.trim() || (creating ? 'Create a personality' : shown.name)
    : creating
      ? 'Create a personality'
      : shown.name;
  // Regenerate control (edit only): the band hosts the avatar's
  // regenerate button now, anchored on the disc, since the avatar never
  // appears in the form body.
  const regenerate = draftActive ? draft.regenerate : null;

  // Is the shown persona's avatar baking? We OR two sources so the
  // illustration is aware of an in-flight generation REGARDLESS of UI
  // state:
  //   - the registry (`useIsAvatarPending`): the persona's background
  //     bake, which persists across opening/closing the editor or
  //     switching views (a regenerate kicked off then "left" still shows
  //     here until the new image lands), and
  //   - the live draft's cooking flag: the editor's own in-progress bake
  //     before it has been adopted into the registry.
  // Either being true keeps the cooking ring on. Create mode has no
  // persona id yet, so the registry watches nothing (draft owns it).
  const registryCooking = useIsAvatarPending(creating ? '' : shown.id);
  const avatarCooking = (draftActive ? draft.cooking : false) || registryCooking;

  return (
    // Row wrapper. The band itself is NOT a button: only the chevron (the
    // toggle) and the trailing pen/✕ are tappable. The identity area is a
    // passive "speaker label", so the avatar + name no longer compete for
    // taps with the small controls.
    <Box sx={{ display: 'flex', width: '100%', alignItems: 'stretch' }}>
    <Box
      sx={{
        display: 'flex',
        flex: 1,
        minWidth: 0,
        alignItems: 'center',
        gap: 2,
        px: 3,
        py: 0.75,
        color: 'text.primary',
        textAlign: 'left',
        // Dim the whole band while a live call locks the picker, echoing the
        // (now hidden) chevron's disabled state.
        transition: 'opacity 0.18s ease',
        opacity: disabled ? 0.55 : 1,
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
          width: 100,
          height: 100,
          flexShrink: 0,
          position: 'relative',
          // Anchor the (bigger) disc to the band's bottom and pull it
          // down with a negative bottom margin so it slightly breaks past
          // the band's divider line. The matching small negative top
          // margin keeps the band's overall height close to the original
          // 68px disc - only the disc grows + spills, not the whole band.
          alignSelf: 'flex-end',
          mt: '10px',
          mb: '-30px',
          zIndex: 1,
          // Transparent layout shell; the visible disc is painted by the Face
          // layer below (white circle + band-coloured ring) with the avatar
          // artwork stacked on top.
          isolation: 'isolate',
          overflow: 'visible',
          display: 'grid',
          placeItems: 'center',
        }}
      >
        {/* Layer 1 - Border ring: a band-coloured gap (6px) capped by a thin
            divider-coloured hairline, drawn as box-shadow around the disc. The
            Mask above hides its top arc, so the hairline only shows on the
            part poking below the band - matching the band's own 1px border. */}
        <Box
          sx={{
            position: 'absolute',
            inset: 0,
            zIndex: 1,
            borderRadius: '50%',
            boxShadow: [
              `0 0 0 9px ${theme.palette.background.default}`,
              `0 0 0 10px ${theme.palette.divider}`,
            ].join(', '),
          }}
        />
        {/* Layer 2 - Mask: a band-background rectangle covering the disc down
            to the band's divider line (~24px above the disc bottom given the
            current mt/mb). It hides the border ring's upper arc; sitting BELOW
            the white face it never tints the circle itself. */}
        <Box
          sx={{
            position: 'absolute',
            left: -16,
            right: -16,
            top: -44,
            bottom: 24,
            zIndex: 2,
            backgroundColor: theme.palette.background.default,
          }}
        />
        {/* Layer 3 - Face: the white disc. Opaque white so it stays crisp over
            both the band and the body, with a faint inner edge for definition. */}
        <Box
          sx={{
            position: 'absolute',
            inset: 0,
            zIndex: 3,
            borderRadius: '50%',
            backgroundColor: theme.palette.background.paper,
            boxShadow: 'inset 0 0 0 1px rgba(0, 0, 0, 0.06)',
          }}
        />
        {/* Layer 4 - the avatar artwork (image or cooking monogram), above the
            Face so the whole thing reads as a single disc. */}
        <Box
          sx={{ position: 'absolute', inset: 0, zIndex: 4, display: 'grid', placeItems: 'center' }}
        >
        {avatarCooking ? (
          // While a fresh sticker bakes, show a deterministic monogram (the
          // persona's initial) under a soft shimmer - the persona is already
          // usable, so this reads as "present, portrait on its way" rather
          // than "loading, wait". The real image fades in once it lands.
          <CookingMonogram name={(draftActive ? draft.name : shown.name) || ''} size={100} />
        ) : creating && !draftAvatar ? (
          // Authoring a NEW persona, no avatar baking yet: show the
          // monogram of the typed name as soon as there is one (identity
          // from the first frame), falling back to a neutral "?" while the
          // name is still empty. No shimmer here - nothing is cooking.
          <CookingMonogram
            name={draftActive ? draft.name : ''}
            size={100}
            shimmer={false}
          />
        ) : (
          <Box
            component="img"
            src={draftAvatar ?? shown.avatar}
            alt=""
            aria-hidden
            draggable={false}
            sx={{
              position: 'absolute',
              height: 'auto',
              left: '50%',
              top: '50%',
              pointerEvents: 'none',
              userSelect: 'none',
              width: '140%',
              transform: 'translate(-50%, -57%)',
              opacity: 1,
              transition: 'opacity 0.2s ease',
            }}
          />
        )}
        </Box>
        {/* Regenerate badge (edit only): the avatar's regenerate control
            lives here on the band, anchored to the disc, since the avatar
            never appears in the form body. A nested role="button" span
            (the disc sits inside the inert toggle ButtonBase, which keeps
            pointer-events for its children) re-bakes a fresh sticker.
            While a regeneration is in flight (cooking - which now starts
            the instant the button is hit, covering the theme-craft
            latency) the badge fades + scales OUT and reappears only once
            the fresh image lands: clear "it's working" feedback and no way
            to double-fire mid-bake. */}
        {regenerate && (
          <Box
            component="span"
            role="button"
            tabIndex={avatarCooking ? -1 : 0}
            aria-hidden={avatarCooking || undefined}
            aria-label="Regenerate avatar"
            onClick={e => {
              e.stopPropagation();
              if (!avatarCooking) regenerate();
            }}
            onKeyDown={e => {
              if ((e.key === 'Enter' || e.key === ' ') && !avatarCooking) {
                e.preventDefault();
                e.stopPropagation();
                regenerate();
              }
            }}
            sx={{
              position: 'absolute',
              right: -3,
              bottom: -3,
              zIndex: 5,
              width: 34,
              height: 34,
              marginRight:"-7.5px",
              borderRadius: '50%',
              display: 'grid',
              placeItems: 'center',
              // Outlined look: paper-filled disc with a primary ring, so it
              // reads as a light "edit" affordance rather than a heavy solid
              // dot fighting the avatar for attention.
              bgcolor: 'background.paper',
              color: 'primary.main',
              border: t => `1px solid ${alpha(t.palette.primary.main, 0.55)}`,
              // Hidden (faded + shrunk away, non-interactive) for the whole
              // regeneration; springs back when the new avatar is ready.
              opacity: avatarCooking ? 0 : 1,
              transform: avatarCooking ? 'scale(0.4)' : 'scale(1)',
              pointerEvents: avatarCooking ? 'none' : 'auto',
              cursor: 'pointer',
              transition: 'transform 0.2s ease, opacity 0.2s ease',
              '&:active': { transform: 'scale(0.9)' },
            }}
          >
            <AutoFixHighRoundedIcon sx={{ fontSize: 18 }} />
          </Box>
        )}
      </Box>
      <Stack
        sx={{
          flex: 1,
          minWidth: 0,
          alignItems: 'flex-start',
          justifyContent: 'center',
          gap: 0.25,
          // Nudge the label/name slightly down so it sits lower in the
          // band, optically aligned with the disc that now spills past the
          // bottom. Transform (not margin) so it doesn't affect band height.
          transform: 'translateY(6px)',
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
            // The eyebrow stays STABLE through a bake (Personality /
            // Editing / New): swapping it to "Generating image…" made the
            // band's identity flicker and read less clearly. The cooking
            // cue now lives on its own discreet line under the name.
            color: 'text.secondary',
            opacity: 0.7,
            textTransform: 'uppercase',
            letterSpacing: '0.8px',
            lineHeight: 1.1,
            display: 'inline-flex',
            alignItems: 'center',
            gap: 0.5,
            // Tiny -2px nudge so the eyebrow + name pair reads as
            // a single composed unit rather than two stacked
            // paragraphs separated by air.
            mb: '-2px',
          }}
        >
          {creating ? 'New' : editingPersona ? 'Editing' : 'Personality'}
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
          {title}
        </Typography>
        {/* Discreet cooking cue: lives UNDER the name (where the tagline
            used to) instead of hijacking the eyebrow, so the band's
            identity (Personality / <name>) never changes mid-bake - just
            a quiet "Generating image…" with a softly pulsing wand. */}
        {avatarCooking && (
          <Typography
            component="span"
            sx={{
              fontSize: TYPO.xs,
              fontWeight: FONT_WEIGHT.medium,
              color: 'primary.main',
              lineHeight: 1.2,
              display: 'inline-flex',
              alignItems: 'center',
              gap: 0.5,
              '@keyframes eyebrowCookPulse': {
                '0%, 100%': { opacity: 0.55 },
                '50%': { opacity: 1 },
              },
              animation: 'eyebrowCookPulse 1.4s ease-in-out infinite',
            }}
          >
            <AutoFixHighRoundedIcon sx={{ fontSize: 13 }} />
            Generating image…
          </Typography>
        )}
        {/* The persona's tagline used to live here too; it was
            redundant with the dropdown grid (each card already
            shows it under the avatar) and made the sub-header band
            taller than it needed to be. The eyebrow + name carry
            enough identity for the band; the picker grid is the
            place to read the full pitch. */}
      </Stack>
      {/* Trailing control slot: a FIXED-width slot, always mounted, that
          swaps its content IN PLACE so nothing to its right (the chevron)
          ever drifts:
            - while a form is open  -> a "✕" that closes it (create OR edit),
            - browsing a CUSTOM persona -> the edit pencil (built-ins aren't
              editable), so editing the active persona lives right here since
              the band IS the "select",
            - otherwise empty (slot kept to hold the layout still).
          Both controls are nested role="button"/ButtonBase inside the band:
          the band renders as a <div> (component="div"), so this is valid and
          they keep pointer events even while the band toggle is disabled. */}
      {/* Trailing action cluster: the pen/✕ and the chevron grouped TIGHT
          (gap 0.25) exactly like the topbar's info/power IconButton pair, so
          they read as one cluster. Wrapping them in their own flex box means
          the band's `gap: 2` only separates this cluster from the identity
          text - it no longer pushes the chevron far from the pen. */}
      <Box sx={{ display: 'flex', alignItems: 'center', flexShrink: 0, gap: 0.25, transform: 'translateY(6px)' }}>
      <Box
        sx={{
          position: 'relative',
          flexShrink: 0,
          width: 40,
          height: 40,
        }}
      >
        {authoring ? (
          <ButtonBase
            onMouseDown={e => e.stopPropagation()}
            onClick={e => {
              e.stopPropagation();
              onCreate();
            }}
            focusRipple
            aria-label="Close the form"
            sx={{
              width: '100%',
              height: '100%',
              borderRadius: '50%',
              color: 'primary.main',
              transition: 'transform 0.12s ease, background-color 0.15s ease',
              '&:hover': {
                bgcolor: theme => alpha(theme.palette.primary.main, 0.1),
              },
              '&:active': { transform: 'scale(0.92)' },
            }}
          >
            <CloseRoundedIcon sx={{ fontSize: 24 }} />
          </ButtonBase>
        ) : onEditActive && !disabled && active.kind === 'custom' ? (
          <ButtonBase
            onMouseDown={e => e.stopPropagation()}
            onClick={e => {
              e.stopPropagation();
              onEditActive(active);
            }}
            focusRipple
            aria-label={`Edit ${active.name}`}
            sx={{
              width: '100%',
              height: '100%',
              borderRadius: '50%',
              color: 'primary.main',
              transition: 'transform 0.12s ease, background-color 0.15s ease',
              '&:hover': {
                bgcolor: theme => alpha(theme.palette.primary.main, 0.1),
              },
              '&:active': { transform: 'scale(0.9)' },
            }}
          >
            <EditOutlinedIcon sx={{ fontSize: 24 }} />
          </ButtonBase>
        ) : null}
      </Box>
      {/* Bare chevron in primary colour - no chip wrapper. Kept VISIBLE
          while a form is open too (only the trailing control to its left
          swaps pencil <-> ✕), so the chevron acts as a fixed anchor and
          never drifts. The fixed-width Box also lets the disabled (live
          call) state fade to opacity 0 WITHOUT collapsing its slot, which
          would otherwise force the persona name's ellipsis to recompute
          and flicker the layout the moment a conversation starts. */}
      <ButtonBase
        // THE toggle: the chevron is now the only tappable part of the
        // identity row (the band around it is passive). Reacts exactly like
        // the edit/close buttons - primary hover wash, press-scale, ripple.
        onClick={onToggle}
        disabled={disabled || authoring}
        focusRipple
        // `aria-controls` would be ideal but the grid is rendered
        // conditionally in the host with no stable id; `aria-expanded` alone
        // still reads as "this control toggles a related region".
        aria-expanded={open}
        aria-label={
          disabled
            ? `Personality: ${active.name}. Locked while talking - end the conversation to change.`
            : open
              ? 'Close personality picker'
              : `Personality: ${active.name}. Tap to open the picker.`
        }
        sx={{
          flexShrink: 0,
          width: 40,
          height: 40,
          borderRadius: '50%',
          // Half the slot's intrinsic right gap (8 -> 4px) so the chevron
          // sits closer to the band edge. Negative margin (not padding) so
          // the circular hover/ripple stays centred on the glyph.
          mr: -1,
          // Greyed (not primary) while a form is open: the toggle is
          // intentionally inert during authoring (the ✕ is the exit), so a
          // primary-tinted chevron would falsely read as tappable.
          color: authoring ? 'action.disabled' : 'primary.main',
          transition:
            'background-color 0.15s ease, opacity 0.18s ease, color 0.18s ease, transform 0.12s ease',
          // Only hidden while disabled (live call). During authoring it
          // stays put (greyed) as the layout anchor.
          opacity: disabled ? 0 : 1,
          '&:hover': { bgcolor: theme => alpha(theme.palette.primary.main, 0.1) },
          '&:active': { transform: 'scale(0.9)' },
          '&.Mui-disabled': { color: authoring ? 'action.disabled' : 'primary.main' },
          '& .MuiTouchRipple-root': { color: 'primary.main' },
        }}
      >
        <KeyboardArrowDownIcon
          sx={{
            fontSize: 24,
            transition: 'transform 0.18s ease',
            transform: open ? 'rotate(180deg)' : 'rotate(0deg)',
          }}
        />
      </ButtonBase>
      </Box>
    </Box>
    </Box>
  );
}
