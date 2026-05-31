/**
 * PersonalityStore - experimental "App-Store-style" picker.
 *
 * Alternative browse surface to `PersonalityCoverflow`: instead of a
 * single swipeable deck, the catalog is laid out as a vertical scroll
 * of horizontal rails, one per personality "family" (Assistants,
 * Characters, Oddballs), plus a "Yours" rail for custom personas.
 *
 * This mirrors the apps tab's rail rhythm (`AppRail` /
 * `AppCompactTile`) so the two browse surfaces of the app feel like
 * siblings.
 *
 * Self-contained + isolated: it reads the same personalities store
 * and exposes the same `onClose` contract as the coverflow, so it can
 * be swapped in/out from `ConversationPanel` in one line. The family
 * taxonomy lives here (not in the shared model) on purpose - it's a
 * presentation concern of this experiment, and keeping it local means
 * the coverflow + data layer stay untouched.
 *
 * Custom personas carry an always-visible "edit" pencil: editing your
 * own creation is a first-class, frequent action, so it lives right on
 * the card. Deletion is deliberately NOT here - it's a destructive
 * action on the user's own work, so it's tucked inside the editor (see
 * `CreatePersonalityModal`) where it takes an explicit confirmation.
 */
import { type ReactNode } from 'react';
import { Box, Stack, Typography, alpha, useTheme } from '@mui/material';
import EditRoundedIcon from '@mui/icons-material/EditRounded';
import AddRoundedIcon from '@mui/icons-material/AddRounded';

import {
  type Personality,
  setActivePersonality,
  useActivePersonality,
  usePersonalitiesCatalog,
} from '@/features/personalities';
import { FONT_WEIGHT, RADIUS, TYPO } from '@/ui/design/tokens';

interface PersonalityStoreProps {
  onClose: () => void;
  /** Open the editor for a custom persona (pencil tap). */
  onEdit: (persona: Personality) => void;
  /** Open the "author a new persona" form. Surfaced as a dedicated CTA
   *  card at the top of the store (the band no longer carries a "+"). */
  onCreate: () => void;
}

/** Family taxonomy (presentation-only, local to this experiment).
 *  Three buckets: the two clean ones (helpful assistants, role-play
 *  characters) plus a catch-all for the personas that don't fit either
 *  - the self-aware robots and the running-gag bits. */
const FAMILIES: ReadonlyArray<{ id: string; label: string; blurb: string }> = [
  { id: 'helpful', label: 'Assistants & coaches', blurb: 'Helpful, get something done with you.' },
  { id: 'character', label: 'Characters', blurb: 'A costume, an accent, a whole world.' },
  { id: 'wildcard', label: 'Oddballs & wildcards', blurb: 'Weird, funny, gloriously off-script.' },
];

const FAMILY_BY_ID: Record<string, string> = {
  // Assistants & coaches: actually try to help you do something.
  'builtin:default': 'helpful',
  'builtin:chess_coach': 'helpful',
  'builtin:hype_bot': 'helpful',
  // Characters: a clear role / costume / accent to play along with.
  'builtin:noir_detective': 'character',
  'builtin:victorian_butler': 'character',
  'builtin:captain_circuit': 'character',
  'builtin:mad_scientist': 'character',
  'builtin:time_traveler': 'character',
  'builtin:bored_teenager': 'character',
  'builtin:nature_documentarian': 'character',
  // Oddballs & wildcards: self-aware robots + the running-gag bit.
  'builtin:mars_rover': 'wildcard',
  'builtin:cosmic_kitchen': 'wildcard',
  'builtin:sorry_bro': 'wildcard',
};

export function PersonalityStore({ onClose, onEdit, onCreate }: PersonalityStoreProps) {
  const catalog = usePersonalitiesCatalog();
  const active = useActivePersonality();

  const customs = catalog.filter(p => p.kind === 'custom');
  const byFamily = (familyId: string) =>
    catalog.filter(p => p.kind === 'builtin' && FAMILY_BY_ID[p.id] === familyId);

  const pick = (id: string) => {
    if (id !== active.id) setActivePersonality(id);
    onClose();
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
      {/* SCROLL BODY. No internal header/close: the persistent
          personality band above (PersonalityPill) owns the identity
          + the toggle back to the orb. */}
      <Box sx={{ flex: 1, minHeight: 0, overflowY: 'auto', pt: 2, pb: 4 }}>
        <Stack spacing={4}>
          {/* CREATE: dedicated CTA card, pinned above the rails. The
              persistent band no longer carries a "+", so authoring a
              new persona starts here. */}
          <Box sx={{ px: 3 }}>
            <CreateCard onCreate={onCreate} />
          </Box>

          {/* YOURS: custom personas rail (only when the user has any).
              The "create" entry lives in the persistent personality
              band above (PersonalityPill's "+"), not here, so an empty
              "Yours" rail never wastes vertical room above the
              catalog. Each custom tile carries an always-visible edit
              pencil; deletion lives inside the editor. */}
          {customs.length > 0 && (
            <Rail label="Yours" blurb="The personalities you created.">
              {customs.map(p => (
                <PersonaTile
                  key={p.id}
                  persona={p}
                  active={p.id === active.id}
                  onClick={() => pick(p.id)}
                  onEdit={() => onEdit(p)}
                />
              ))}
            </Rail>
          )}

          {/* FAMILY RAILS. */}
          {FAMILIES.map(family => {
            const members = byFamily(family.id);
            if (members.length === 0) return null;
            return (
              <Rail key={family.id} label={family.label} blurb={family.blurb}>
                {members.map(p => (
                  <PersonaTile
                    key={p.id}
                    persona={p}
                    active={p.id === active.id}
                    onClick={() => pick(p.id)}
                  />
                ))}
              </Rail>
            );
          })}
        </Stack>
      </Box>
    </Box>
  );
}

/* ──────────────────────────────────────────────────────────────────
 * Create CTA card: full-width tappable surface above the rails. Dashed
 * primary outline + "+" disc so it reads as an "add" affordance rather
 * than a selectable persona tile.
 * ────────────────────────────────────────────────────────────────── */

function CreateCard({ onCreate }: { onCreate: () => void }) {
  const theme = useTheme();
  return (
    <Box
      component="button"
      type="button"
      onClick={onCreate}
      aria-label="Create a personality"
      sx={{
        width: '100%',
        appearance: 'none',
        cursor: 'pointer',
        font: 'inherit',
        textAlign: 'left',
        display: 'flex',
        alignItems: 'center',
        gap: 1.75,
        px: 2,
        py: 1.75,
        borderRadius: `${RADIUS.lg}px`,
        color: 'primary.main',
        bgcolor: alpha(theme.palette.primary.main, 0.06),
        border: `1.5px dashed ${alpha(theme.palette.primary.main, 0.5)}`,
        transition: 'transform 0.1s ease, background-color 0.15s ease',
        '&:hover': { bgcolor: alpha(theme.palette.primary.main, 0.1) },
        '&:active': { transform: 'scale(0.99)' },
        WebkitTapHighlightColor: 'transparent',
      }}
    >
      <Box
        sx={{
          width: 44,
          height: 44,
          flexShrink: 0,
          borderRadius: '50%',
          display: 'grid',
          placeItems: 'center',
          bgcolor: alpha(theme.palette.primary.main, 0.12),
        }}
      >
        <AddRoundedIcon sx={{ fontSize: 26 }} />
      </Box>
      <Stack sx={{ minWidth: 0 }}>
        <Typography
          sx={{
            fontWeight: FONT_WEIGHT.semibold,
            fontSize: TYPO.md,
            lineHeight: 1.2,
            color: 'text.primary',
          }}
        >
          Create a personality
        </Typography>
        <Typography sx={{ fontSize: TYPO.xs, color: 'text.secondary', mt: 0.25 }}>
          Author your own - name, vibe, voice.
        </Typography>
      </Stack>
    </Box>
  );
}

/* ──────────────────────────────────────────────────────────────────
 * Horizontal rail: header (label + blurb) over a snap-scroll track.
 * Local to this component (the apps `AppRail` carries app-specific
 * "See all" / count chrome we don't want here).
 * ────────────────────────────────────────────────────────────────── */

function Rail({ label, blurb, children }: { label: string; blurb?: string; children: ReactNode }) {
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
      <Box
        sx={theme => ({
          display: 'flex',
          gap: 2.25,
          overflowX: 'auto',
          overflowY: 'hidden',
          scrollbarWidth: 'none',
          '::-webkit-scrollbar': { display: 'none' },
          scrollSnapType: 'x proximity',
          scrollPaddingInlineStart: theme.spacing(3),
          '& > *': { scrollSnapAlign: 'start' },
          // Vertical padding so the tiles' drop shadow isn't clipped
          // by the horizontal scroll container.
          px: 3,
          py: 1,
        })}
      >
        {children}
      </Box>
    </Box>
  );
}

/* ──────────────────────────────────────────────────────────────────
 * Persona tile: avatar + name + tagline. Sober (paper bg + hairline /
 * primary ring when active). Custom personas get an always-visible
 * edit pencil (top-right); built-ins don't.
 * ────────────────────────────────────────────────────────────────── */

interface PersonaTileProps {
  persona: Personality;
  active: boolean;
  onClick: () => void;
  onEdit?: () => void;
}

function PersonaTile({ persona, active, onClick, onEdit }: PersonaTileProps) {
  const theme = useTheme();
  return (
    <Box
      component="button"
      type="button"
      onClick={onClick}
      aria-pressed={active}
      aria-label={`Use personality ${persona.name}`}
      sx={{
        flexShrink: 0,
        width: 146,
        appearance: 'none',
        cursor: 'pointer',
        font: 'inherit',
        color: 'text.primary',
        textAlign: 'center',
        position: 'relative',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 1.25,
        px: 2,
        pt: 3,
        pb: 1.5,
        borderRadius: `${RADIUS.lg}px`,
        // App-Store-style tile: white (paper) surface, light hairline
        // border, subtle drop shadow. Active state keeps the white bg
        // and adds a primary inset ring (no reflow, no tint wash).
        bgcolor: 'background.paper',
        border: `1px solid ${active ? 'transparent' : theme.palette.divider}`,
        boxShadow: active
          ? `inset 0 0 0 2px ${theme.palette.primary.main}, 0 1px 4px ${alpha('#000', 0.06)}`
          : `0 1px 4px ${alpha('#000', 0.05)}`,
        transition: 'transform 0.1s ease, box-shadow 0.18s ease',
        '&:active': { transform: 'scale(0.97)' },
        WebkitTapHighlightColor: 'transparent',
      }}
    >
      <Box
        sx={{
          width: 116,
          height: 116,
          borderRadius: '50%',
          position: 'relative',
          overflow: 'visible',
          bgcolor: theme.palette.mode === 'dark'
            ? 'rgba(255,255,255,0.04)'
            : 'rgba(0,0,0,0.025)',
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
            width: '152%',
            height: 'auto',
            left: '50%',
            top: '50%',
            transform: 'translate(-50%, -57%)',
            pointerEvents: 'none',
            userSelect: 'none',
          }}
        />
      </Box>
      <Typography
        sx={{
          fontWeight: FONT_WEIGHT.semibold,
          fontSize: TYPO.sm,
          lineHeight: 1.2,
          color: active ? 'primary.main' : 'text.primary',
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          width: '100%',
        }}
      >
        {persona.name}
      </Typography>
      <Typography
        sx={{
          fontSize: TYPO.tiny,
          fontStyle: 'italic',
          color: 'text.secondary',
          lineHeight: 1.35,
          display: '-webkit-box',
          WebkitLineClamp: 2,
          WebkitBoxOrient: 'vertical',
          overflow: 'hidden',
          minHeight: '2.7em',
        }}
      >
        {persona.tagline}
      </Typography>

      {/* Edit affordance (customs only): always visible, primary
          outlined. Editing one's own creation is a frequent, non-
          destructive action so it sits right on the card. Deletion is
          intentionally elsewhere (inside the editor, behind a confirm)
          because it destroys the user's work. */}
      {onEdit && (
        <Box
          component="span"
          role="button"
          tabIndex={0}
          aria-label={`Edit ${persona.name}`}
          onClick={e => {
            e.stopPropagation();
            onEdit();
          }}
          onKeyDown={e => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              e.stopPropagation();
              onEdit();
            }
          }}
          sx={{
            position: 'absolute',
            top: 10,
            right: 10,
            width: 30,
            height: 30,
            borderRadius: '50%',
            display: 'grid',
            placeItems: 'center',
            // Primary outlined: paper fill so it reads on the white tile,
            // primary hairline ring + primary glyph.
            color: 'primary.main',
            bgcolor: 'background.paper',
            border: `1.5px solid ${theme.palette.primary.main}`,
            boxShadow: `0 1px 4px ${alpha('#000', 0.08)}`,
            '&:hover': {
              bgcolor: alpha(theme.palette.primary.main, 0.1),
            },
          }}
        >
          <EditRoundedIcon sx={{ fontSize: 16 }} />
        </Box>
      )}
    </Box>
  );
}
