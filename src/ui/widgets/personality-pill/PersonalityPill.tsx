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
 * The WHOLE band is the toggle: avatar, name and chevron share one
 * tap target (the chevron - and the authoring "✕" that replaces it -
 * are purely decorative cues). This maximises discoverability on
 * mobile - users naturally tap the avatar/name to change persona. The
 * only nested control is the avatar's regenerate badge, which stops
 * propagation.
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
 * realtime client picks up the new instructions + voice on the next
 * reconnect. Editing a custom persona lives on the grid tiles (a
 * pencil badge), not here.
 */
import { useState } from 'react';
import { Alert, Box, ButtonBase, Snackbar, Stack, Typography, useTheme } from '@mui/material';
import { alpha } from '@mui/material/styles';
import KeyboardArrowDownIcon from '@mui/icons-material/KeyboardArrowDown';
import CloseRoundedIcon from '@mui/icons-material/CloseRounded';
import AutoFixHighRoundedIcon from '@mui/icons-material/AutoFixHighRounded';

import {
  type Personality,
  useActivePersonality,
  useAvatarPendingSince,
  useIsAvatarPending,
  usePersonaDraft,
} from '@/features/personalities';
import CookingMonogram from '@/ui/design/CookingMonogram';
import ShimmerText from '@/ui/design/ShimmerText';
import PieTimer from '@/ui/design/PieTimer';
import { FONT_WEIGHT, TYPO } from '@/ui/design/tokens';

interface PersonalityPillProps {
  /** Whether the personality grid is currently displayed in the
   *  host's body slot. Drives the chevron rotation + aria-expanded. */
  open: boolean;
  /** Toggle handler called on every tap of the band. The host is
   *  expected to flip its `open` state in response. */
  onToggle: () => void;
  /**
   * Close the open authoring form. Fired by tapping the band while a
   * form is open (the trailing "✕" is just the visual cue). The "create"
   * ENTRY point no longer lives here - it's a dedicated CTA card at the
   * top of the store - so this control is shown only while a form is
   * open (see `creating` / `editingPersona`). Kept named `onCreate` for
   * call-site stability; in practice the host wires it to a "toggle
   * form" handler that closes whatever form is open.
   */
  onCreate: () => void;
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
   * mid-call (which would force a stop+start of the realtime client
   * and audibly cut Reachy off mid-sentence). The band stays
   * mounted and keeps showing the active persona; a tap surfaces a
   * short snackbar explaining the lock instead of silently ignoring
   * the gesture.
   */
  disabled?: boolean;
}

export function PersonalityPill({
  open,
  onToggle,
  onCreate,
  creating = false,
  editingPersona = null,
  disabled = false,
}: PersonalityPillProps) {
  const theme = useTheme();
  const active = useActivePersonality();
  // Transient "why is this locked" hint, shown when the user taps the
  // band while a live conversation holds the picker closed. Without
  // it the tap would be silently swallowed and the band would feel
  // broken (the lock is otherwise only exposed via aria-label).
  const [lockedHint, setLockedHint] = useState(false);
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
    ? draft.name.trim() || (creating ? 'Create your personality' : shown.name)
    : creating
      ? 'Create your personality'
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
  // Real bake start time (from the store) so the progress pie reflects actual
  // elapsed time and survives band remounts instead of restarting.
  const cookingSince = useAvatarPendingSince(creating ? '' : shown.id);

  // Tap anywhere on the band:
  //   - form open  -> close the form (the whole band acts as the "✕",
  //     which stays as the visual cue at the right edge),
  //   - live call  -> surface the locked hint instead of toggling,
  //   - otherwise  -> toggle the picker.
  const handleBandClick = (): void => {
    if (authoring) {
      onCreate();
      return;
    }
    if (disabled) {
      setLockedHint(true);
      return;
    }
    onToggle();
  };

  return (
    <>
    {/* THE toggle: the WHOLE band is one tap target (avatar + name +
        chevron). Rendered as a div-based ButtonBase so the nested "✕" /
        regenerate controls (which stop propagation) stay valid and keep
        their own pointer events. While locked (live call) the band stays
        tappable ONLY to surface the locked hint - no ripple, so it
        doesn't falsely read as an actionable control. */}
    <ButtonBase
      component="div"
      onClick={handleBandClick}
      focusRipple={!disabled}
      disableRipple={disabled}
      // `aria-controls` would be ideal but the grid is rendered
      // conditionally in the host with no stable id; `aria-expanded` alone
      // still reads as "this control toggles a related region".
      aria-expanded={authoring ? undefined : open}
      aria-label={
        authoring
          ? 'Close the form'
          : disabled
            ? `Personality: ${active.name}. Locked while talking - end the conversation to change.`
            : open
              ? 'Close personality picker'
              : `Personality: ${active.name}. Tap to open the picker.`
      }
      sx={{
        display: 'flex',
        width: '100%',
        minWidth: 0,
        alignItems: 'center',
        justifyContent: 'flex-start',
        gap: 2,
        px: 3,
        py: 0.75,
        color: 'text.primary',
        textAlign: 'left',
        cursor: 'pointer',
        WebkitTapHighlightColor: 'transparent',
        // The band keeps full opacity while a live call locks the picker -
        // only the chevron greys out, so the active persona stays
        // perfectly legible mid-conversation.
        opacity: 1,
        // The ripple must wash the WHOLE band surface - including the
        // disc's outer ring, even the part that spills below the band's
        // divider - while the white inner circle + the persona
        // illustration mask it out and stay untouched. Two tricks:
        //
        // 1. STACKING: the disc paints its layers in this shared
        //    stacking context (ring 1, mask 2, white face 4, artwork 5,
        //    regenerate badge 6); slotting the ripple at 3 puts the wash
        //    above the band background + ring but UNDER the opaque face,
        //    so it visually flows "around" the circle. (Default ripple
        //    zIndex is 0, i.e. fully hidden behind the disc's mask
        //    layer - which read as two separate surfaces.)
        //
        // 2. SHAPE: the TouchRipple root is an `overflow: hidden` rect
        //    pinned to the ButtonBase, so by default the wash clips at
        //    the divider and never reaches the ring's spill below it.
        //    We extend its bottom past the spill, then CSS-mask it to
        //    the union (mask-composite's initial `add`) of the band
        //    rectangle and the disc's outer circle, so the wash hugs
        //    the divider and bulges around the disc.
        //
        //    Geometry (from the disc's own metrics below): the 100px
        //    disc sits with its bottom 24px below the band's bottom
        //    edge, and its ring (box-shadow) adds 10px more -> the
        //    extension is 34px. Circle centre: x = 24px padding + 50px
        //    radius = 74px; y = 24px spill - 50px radius = 26px above
        //    the band bottom = calc(100% - 60px) of the extended box.
        //    Outer radius = 50px disc + 10px ring = 60px.
        '& .MuiTouchRipple-root': {
          zIndex: 3,
          color: 'primary.main',
          bottom: -34,
          maskImage: [
            'linear-gradient(#000, #000)',
            'radial-gradient(circle at 74px calc(100% - 60px), #000 60px, transparent 61px)',
          ].join(', '),
          maskSize: '100% calc(100% - 34px), 100% 100%',
          maskRepeat: 'no-repeat',
          maskPosition: 'top left',
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
          // Transparent layout shell; the visible disc is painted by the Face
          // layer below (white circle + band-coloured ring) with the avatar
          // artwork stacked on top.
          //
          // Deliberately NOT a stacking context (no zIndex / isolation):
          // the layers' z-indices must resolve in the same context as the
          // band's TouchRipple (zIndex 3), so the ripple can interleave
          // BETWEEN the mask (2) and the white Face (4) - the wash flows
          // around the disc (band surface + outer ring) while the inner
          // circle and the persona illustration mask it out. Isolating
          // the disc would make it atomic and force the ripple entirely
          // under (invisible) or over (washing the avatar) the whole
          // thing.
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
        {/* Layer 4 - Face: the white disc. Opaque white so it stays crisp over
            both the band and the body, with a faint inner edge for definition.
            Sits ABOVE the band's ripple (3) so the wash never tints the inner
            circle - it flows around the disc instead. */}
        <Box
          sx={{
            position: 'absolute',
            inset: 0,
            zIndex: 4,
            borderRadius: '50%',
            backgroundColor: theme.palette.background.paper,
            boxShadow: 'inset 0 0 0 1px rgba(0, 0, 0, 0.06)',
          }}
        />
        {/* Layer 5 - the avatar artwork (image or cooking monogram), above
            the Face AND the band's ripple (3) so the illustration stays
            crisp while the wash flows around the disc beneath it. */}
        <Box
          sx={{ position: 'absolute', inset: 0, zIndex: 5, display: 'grid', placeItems: 'center' }}
        >
        {avatarCooking ? (
          // While a fresh sticker bakes, show a deterministic monogram (the
          // persona's initial) under a soft shimmer - the persona is already
          // usable, so this reads as "present, portrait on its way" rather
          // than "loading, wait". The real image fades in once it lands.
          <CookingMonogram name={(draftActive ? draft.name : shown.name) || ''} size={100} />
        ) : creating && !draftAvatar ? (
          // Authoring a NEW persona, no avatar baking yet: show the monogram
          // placeholder. The shimmer only kicks in once the user has typed a
          // name - while it's still the neutral "?" the disc stays static, so
          // nothing animates before there's actually a persona taking shape.
          <CookingMonogram
            name={draftActive ? draft.name : ''}
            size={100}
            shimmer={(draftActive ? draft.name : '').trim().length > 0}
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
              zIndex: 6,
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
          // "Working" cue: a tiny pie that fills over the ~80s bake, left of a
          // shimmer text (phase-locked to / counter-phase with the disc).
          <Stack direction="row" spacing={0.625} sx={{ alignItems: 'center' }}>
            <PieTimer size={11} startedAt={cookingSince ?? undefined} />
            <ShimmerText sx={{ fontSize: TYPO.xs, fontWeight: FONT_WEIGHT.medium, lineHeight: 1.2 }}>
              Generating image…
            </ShimmerText>
          </Stack>
        )}
        {/* The persona's tagline used to live here too; it was
            redundant with the dropdown grid (each card already
            shows it under the avatar) and made the sub-header band
            taller than it needed to be. The eyebrow + name carry
            enough identity for the band; the picker grid is the
            place to read the full pitch. */}
      </Stack>
      {/* Trailing cue: ONE 40px slot at the band's right edge. While a
          form is open it holds the "✕"; otherwise the chevron. BOTH are
          purely decorative (plain Boxes, no hover / ripple of their
          own): the WHOLE band is the single tap target that closes the
          form or toggles the picker, and a nested hover state would
          wrongly suggest a separate control. Same footprint in both
          states so the swap never shifts the layout. */}
      <Box sx={{ display: 'flex', alignItems: 'center', flexShrink: 0, transform: 'translateY(6px)' }}>
      {authoring ? (
        <Box
          aria-hidden
          sx={{
            flexShrink: 0,
            width: 40,
            height: 40,
            display: 'grid',
            placeItems: 'center',
            // Same right-edge nudge as the chevron so the glyphs swap
            // exactly in place.
            mr: -1,
            color: 'primary.main',
          }}
        >
          <CloseRoundedIcon sx={{ fontSize: 24 }} />
        </Box>
      ) : (
        /* Chevron: purely DECORATIVE (the whole band is the tap
           target), so it's a plain Box, not a button. It rotates with
           `open` and greys out while a live call locks the picker. */
        <Box
          aria-hidden
          sx={{
            flexShrink: 0,
            width: 40,
            height: 40,
            display: 'grid',
            placeItems: 'center',
            // Half the slot's intrinsic right gap (8 -> 4px) so the chevron
            // sits closer to the band edge.
            mr: -1,
            color: disabled ? 'action.disabled' : 'primary.main',
            transition: 'color 0.18s ease',
          }}
        >
          <KeyboardArrowDownIcon
            sx={{
              fontSize: 24,
              transition: 'transform 0.18s ease',
              transform: open ? 'rotate(180deg)' : 'rotate(0deg)',
            }}
          />
        </Box>
      )}
      </Box>
    </ButtonBase>
    {/* Locked hint: same Snackbar+Alert pattern as the apps tab's
        pin-cap toast, raised above the bottom nav. OUTSIDE the band's
        ButtonBase so taps on the alert (e.g. its close button) don't
        bubble into the band's click handler and re-trigger the hint. */}
    <Snackbar
      open={lockedHint}
      autoHideDuration={3500}
      onClose={() => setLockedHint(false)}
      anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      sx={{ bottom: { xs: 88, sm: 88 } }}
    >
      <Alert
        severity="info"
        variant="filled"
        onClose={() => setLockedHint(false)}
        sx={{ fontSize: TYPO.xs }}
      >
        End the conversation to change personality.
      </Alert>
    </Snackbar>
    </>
  );
}
