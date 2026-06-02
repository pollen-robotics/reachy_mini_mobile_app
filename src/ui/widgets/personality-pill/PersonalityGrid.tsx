/**
 * PersonalityGrid - 2-column card picker that REPLACES the orb
 * area while open.
 *
 *   ┌────────────┐  ┌────────────┐
 *   │     ◉      │  │     ◉      │
 *   │   Reachy   │  │  Noir Det  │   ← active card has a primary
 *   │  friendly… │  │  smoky…    │     ring + tinted bg
 *   └────────────┘  └────────────┘
 *   ┌────────────┐  ┌────────────┐
 *   │     ◉      │  │     ◉      │
 *   │  Mars Rov  │  │ Vict Butl  │
 *   │  wakes up… │  │ polite…    │
 *   └────────────┘  └────────────┘
 *   ...
 *
 * Mounts in the slot otherwise occupied by the orb area, so the
 * user picks a personality from a "casting page" rather than a
 * cramped dropdown. Selecting a card mutates the personality store
 * and immediately closes the picker (host's `onClose`).
 *
 * The grid scrolls vertically when the catalog overflows the
 * available height; the columns stay at 2 regardless of viewport
 * width so the cards keep a comfortable touch target on phones.
 *
 * Pure presentational component: receives no engine state, just
 * the personality store + an onClose callback.
 */
import { useState } from 'react';
import { Box, Stack, Typography, alpha, useTheme } from '@mui/material';
import CheckIcon from '@mui/icons-material/Check';
import AddRoundedIcon from '@mui/icons-material/AddRounded';
import DeleteOutlineRoundedIcon from '@mui/icons-material/DeleteOutlineRounded';

import {
  type Personality,
  removeCustomPersonality,
  setActivePersonality,
  useActivePersonality,
  usePersonalitiesCatalog,
} from '@/features/personalities';

import { CreatePersonalityModal } from './CreatePersonalityModal';

interface PersonalityGridProps {
  /** Fired right after the user picks a card. The host clears its
   *  open state in response and the orb area swaps back in. */
  onClose: () => void;
}

export function PersonalityGrid({ onClose }: PersonalityGridProps) {
  const catalog = usePersonalitiesCatalog();
  const active = useActivePersonality();

  // Whether the "author your own persona" overlay is mounted. Kept
  // local to the grid (rather than lifted to the host) because the
  // overlay is `position: fixed` and self-contained: it doesn't need
  // the host to swap any body slot, it just floats above everything.
  const [creating, setCreating] = useState(false);

  const handlePick = (id: string) => {
    if (id !== active.id) setActivePersonality(id);
    onClose();
  };

  // Remove a custom persona. We don't auto-close the picker here: the
  // user is curating their list and likely wants to keep browsing /
  // deleting. `removeCustomPersonality` already falls the active id
  // back to the default when the deleted persona was active.
  const handleDelete = (id: string) => {
    removeCustomPersonality(id);
  };

  return (
    <Box
      sx={{
        // Fill the slot we were given by the host (which itself
        // had `flex: 1; minHeight: 0` so the orb area used to
        // breathe full-height). Vertical scroll kicks in when the
        // 2-col grid overflows the available height.
        flex: 1,
        minHeight: 0,
        overflowY: 'auto',
        // `100vw` + negative margin = full-bleed escape so the
        // grid touches the screen edges, matching the sub-header
        // band above. Without this, the grid would be capped at
        // the parent column's `maxWidth: 420` on tablets.
        width: '100vw',
        mx: 'calc(50% - 50vw)',
        bgcolor: 'background.default',
      }}
    >
      <Box
        sx={{
          // Re-centre + cap so the cards don't stretch to absurd
          // widths on tablet / desktop viewports.
          maxWidth: 720,
          mx: 'auto',
          px: 3,
          py: 3,
          display: 'grid',
          gridTemplateColumns: 'repeat(2, 1fr)',
          gap: 3,
        }}
      >
        {catalog.map((persona) => (
          <PersonaCard
            key={persona.id}
            persona={persona}
            isActive={persona.id === active.id}
            onClick={() => handlePick(persona.id)}
            onDelete={
              persona.kind === 'custom' ? () => handleDelete(persona.id) : undefined
            }
          />
        ))}
        {/* Trailing CTA card: opens the author-your-own overlay. Sits
            last so the built-in lineup reads first; styled as a
            dashed-plate affordance so it never gets mistaken for a
            real persona. */}
        <CreatePersonaCard onClick={() => setCreating(true)} />
      </Box>

      {creating && (
        <CreatePersonalityModal
          onCancel={() => setCreating(false)}
          onCreated={() => {
            setCreating(false);
            // The new persona is now active (set inside the modal);
            // close the picker so the user lands back on the orb.
            onClose();
          }}
        />
      )}
    </Box>
  );
}

/* ──────────────────────────────────────────────────────────────────
 * One card in the grid: avatar + name + tagline.
 * ────────────────────────────────────────────────────────────────── */

interface PersonaCardProps {
  persona: Personality;
  isActive: boolean;
  onClick: () => void;
  /** Present only for custom personas: renders a small delete affordance
   *  in the card's top-left corner. Built-ins pass `undefined`. */
  onDelete?: () => void;
}

function PersonaCard({ persona, isActive, onClick, onDelete }: PersonaCardProps) {
  const theme = useTheme();
  return (
    <Box
      component="button"
      type="button"
      onClick={onClick}
      aria-pressed={isActive}
      aria-label={`Use personality ${persona.name}`}
      sx={{
        // `<button>` reset so we can style this as a card without
        // the browser's native button chrome.
        appearance: 'none',
        border: 0,
        cursor: 'pointer',
        font: 'inherit',
        color: 'text.primary',
        position: 'relative',
        // Surface treatment aligned with the rest of the app's
        // cards (camera tile in `RobotTabView`, app cards in
        // `AppCard`): paper bg, hairline divider border, NO shadow
        // by default. The cards read as "list items" rather than
        // "elevated tiles", which fits the conversation tab's
        // overall calm rhythm.
        //
        // The active state still uses a primary ring + a soft
        // primary wash on the bg so the picked persona stands out.
        bgcolor: isActive
          ? `color-mix(in srgb, ${theme.palette.primary.main} 8%, ${theme.palette.background.paper})`
          : 'background.paper',
        // `borderRadius: 1.5` on MUI's 8px scale = 12px, matching
        // the theme's `RADIUS.lg` used everywhere else (camera box,
        // audio cards, app cards). The previous `3` (= 24px) felt
        // out of family.
        borderRadius: 1.5,
        boxShadow: isActive
          ? `inset 0 0 0 2px ${theme.palette.primary.main}`
          : `inset 0 0 0 1px ${theme.palette.divider}`,
        // Tile aspect: each card holds the avatar + label + tagline
        // in a roughly square footprint. The min-height + the
        // tagline's 2-line clamp keep every row aligned even when
        // names / taglines vary in length.
        minHeight: 196,
        px: 2,
        pt: 2.5,
        pb: 2,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'flex-start',
        gap: 1.5,
        // Pressed feedback: tiny scale-down so the tap feels
        // physical. No hover-side shadow change - the bg tint on
        // hover below carries the affordance instead.
        transition:
          'transform 0.1s ease, box-shadow 0.18s ease, background-color 0.18s ease',
        '&:hover': {
          // Light bg darken on hover (mirrors the pill's behaviour
          // and the pattern used by app cards) instead of a shadow
          // change, so the surface stays flat against its
          // neighbours.
          bgcolor: isActive
            ? `color-mix(in srgb, ${theme.palette.primary.main} 12%, ${theme.palette.background.paper})`
            : theme.palette.mode === 'dark'
              ? 'rgba(255, 255, 255, 0.04)'
              : 'rgba(0, 0, 0, 0.025)',
        },
        '&:active': {
          transform: 'scale(0.97)',
        },
        '&:focus': { outline: 'none' },
        '&:focus-visible': {
          boxShadow: `inset 0 0 0 2px ${theme.palette.primary.main}, 0 0 0 3px color-mix(in srgb, ${theme.palette.primary.main} 30%, transparent)`,
        },
        '-webkit-tap-highlight-color': 'transparent',
      }}
    >
      {/* Avatar disc - the visual anchor of the card. 88px so the
          illustration genuinely reads as the persona's "face",
          not a tiny thumbnail. The disc sits in a soft tinted
          well so the illustration has a "stage" against the
          card's flat paper bg. */}
      {/* Avatar disc + oversize SVG (RobotAvatar pattern). The
          disc keeps its 107px footprint; the SVG renders at 155%
          so the head body lands at the disc's centre and the
          antennas / hats / accessories spill above the rim.
          `overflow: visible` lets that spill show. */}
      <Box
        sx={{
          width: 107,
          height: 107,
          borderRadius: '50%',
          bgcolor: theme.palette.mode === 'dark'
            ? 'rgba(255, 255, 255, 0.04)'
            : 'rgba(0, 0, 0, 0.025)',
          position: 'relative',
          overflow: 'visible',
          flexShrink: 0,
        }}
      >
        <Box
          component="img"
          src={persona.avatar}
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
        spacing={0.5}
        sx={{
          width: '100%',
          alignItems: 'center',
          flex: 1,
          // Push the typography block to grow into available space
          // so cards with shorter taglines still fill the same
          // height as their neighbours.
          justifyContent: 'flex-start',
        }}
      >
        <Typography
          sx={{
            fontWeight: 600,
            fontSize: 15,
            lineHeight: 1.2,
            color: isActive ? 'primary.main' : 'text.primary',
            // Single-line ellipsis - long names land in the
            // existing dropdown row (RIP) flow; on a card they
            // would wrap and break the grid's row alignment.
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            width: '100%',
            textAlign: 'center',
          }}
        >
          {persona.name}
        </Typography>
        {persona.tagline && (
          <Typography
            sx={{
              fontSize: 12,
              fontStyle: 'italic',
              color: 'text.secondary',
              lineHeight: 1.4,
              textAlign: 'center',
              // Two-line clamp + reserved height so every card in
              // a row aligns even when the tagline is one line
              // ("Friendly, concise.") or three.
              display: '-webkit-box',
              WebkitLineClamp: 2,
              WebkitBoxOrient: 'vertical',
              overflow: 'hidden',
              minHeight: '2.8em',
              px: 0.5,
            }}
          >
            {persona.tagline}
          </Typography>
        )}
      </Stack>

      {/* Active check badge: outlined primary disc with a check
          icon pinned top-right. Outlined (transparent fill +
          primary 2px ring + primary check) so it echoes the
          card's own primary ring without becoming a heavy filled
          dot - the wash + ring + primary name already carry the
          "this is selected" signal, the badge is the cherry on
          top. Only shown on the active card so inactive cards
          stay clean. */}
      {isActive && (
        <Box
          sx={{
            position: 'absolute',
            top: 10,
            right: 10,
            width: 24,
            height: 24,
            borderRadius: '50%',
            bgcolor: 'background.paper',
            color: 'primary.main',
            display: 'grid',
            placeItems: 'center',
            boxShadow: theme => `inset 0 0 0 2px ${theme.palette.primary.main}`,
          }}
          aria-hidden
        >
          <CheckIcon sx={{ fontSize: 14 }} />
        </Box>
      )}

      {/* Delete affordance for custom personas only. Rendered as a
          `span` (not a real `<button>`) because the card root is
          already a `<button>` and nesting interactive buttons is
          invalid HTML; we restore button semantics with role +
          tabIndex + key handlers and stop propagation so a tap on
          the trash icon never also triggers the card's "pick"
          handler. */}
      {onDelete && (
        <Box
          component="span"
          role="button"
          tabIndex={0}
          aria-label={`Delete personality ${persona.name}`}
          onClick={e => {
            e.stopPropagation();
            onDelete();
          }}
          onKeyDown={e => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              e.stopPropagation();
              onDelete();
            }
          }}
          sx={{
            position: 'absolute',
            top: 8,
            left: 8,
            width: 28,
            height: 28,
            borderRadius: '50%',
            display: 'grid',
            placeItems: 'center',
            cursor: 'pointer',
            color: 'text.secondary',
            bgcolor: theme.palette.mode === 'dark'
              ? 'rgba(255, 255, 255, 0.06)'
              : 'rgba(0, 0, 0, 0.04)',
            transition: 'color 0.15s ease, background-color 0.15s ease',
            '&:hover': {
              color: theme.palette.error.main,
              bgcolor: alpha(theme.palette.error.main, 0.12),
            },
            '&:focus-visible': {
              outline: `2px solid ${theme.palette.primary.main}`,
              outlineOffset: 2,
            },
          }}
        >
          <DeleteOutlineRoundedIcon sx={{ fontSize: 16 }} />
        </Box>
      )}
    </Box>
  );
}

/* ──────────────────────────────────────────────────────────────────
 * Trailing "Create your own" card. Same footprint as a PersonaCard
 * but with a dashed primary plate + `+` glyph so it reads as an
 * affordance, not a persona. Mirrors the apps tab's
 * `AppCreateYourOwnTile` CTA treatment.
 * ────────────────────────────────────────────────────────────────── */

interface CreatePersonaCardProps {
  onClick: () => void;
}

function CreatePersonaCard({ onClick }: CreatePersonaCardProps) {
  const theme = useTheme();
  return (
    <Box
      component="button"
      type="button"
      onClick={onClick}
      aria-label="Create a custom personality"
      sx={{
        appearance: 'none',
        border: 0,
        cursor: 'pointer',
        font: 'inherit',
        color: 'text.primary',
        bgcolor: 'background.paper',
        borderRadius: 1.5,
        boxShadow: `inset 0 0 0 1px ${theme.palette.divider}`,
        minHeight: 196,
        px: 2,
        pt: 2.5,
        pb: 2,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 1.5,
        transition: 'transform 0.1s ease, background-color 0.18s ease',
        '&:hover': {
          bgcolor: theme.palette.mode === 'dark'
            ? 'rgba(255, 255, 255, 0.04)'
            : 'rgba(0, 0, 0, 0.025)',
        },
        '&:active': { transform: 'scale(0.97)' },
        '&:focus': { outline: 'none' },
        '&:focus-visible': {
          boxShadow: `inset 0 0 0 2px ${theme.palette.primary.main}, 0 0 0 3px color-mix(in srgb, ${theme.palette.primary.main} 30%, transparent)`,
        },
        '-webkit-tap-highlight-color': 'transparent',
      }}
    >
      <Box
        sx={{
          width: 72,
          height: 72,
          borderRadius: '50%',
          display: 'grid',
          placeItems: 'center',
          color: 'primary.main',
          bgcolor: alpha(theme.palette.primary.main, 0.1),
          border: `1px dashed ${alpha(theme.palette.primary.main, 0.4)}`,
        }}
      >
        <AddRoundedIcon sx={{ fontSize: 34 }} />
      </Box>
      <Stack spacing={0.5} sx={{ alignItems: 'center' }}>
        <Typography
          sx={{ fontWeight: 600, fontSize: 15, color: 'primary.main', textAlign: 'center' }}
        >
          Create your own
        </Typography>
        <Typography
          sx={{
            fontSize: 12,
            fontStyle: 'italic',
            color: 'text.secondary',
            textAlign: 'center',
          }}
        >
          Write your own prompt
        </Typography>
      </Stack>
    </Box>
  );
}
