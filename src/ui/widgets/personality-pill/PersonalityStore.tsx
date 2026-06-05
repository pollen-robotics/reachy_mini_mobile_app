/**
 * PersonalityStore - "App-Store-style" personality picker.
 *
 * The catalog is laid out as a vertical scroll of horizontal rails,
 * one per personality "family" (Assistants & coaches, Characters),
 * plus a "Yours" rail for custom personas.
 *
 * This mirrors the apps tab's rail rhythm (`AppRail` /
 * `AppCompactTile`) so the two browse surfaces of the app feel like
 * siblings.
 *
 * Self-contained + isolated: it reads the personalities store and
 * applies a pick live (no auto-close), so the host (`ConversationPanel`)
 * can swap it in/out in one line. The family taxonomy lives here (not
 * in the shared model) on purpose - it's a presentation concern of
 * this surface, and keeping it local means the data layer stays
 * untouched.
 *
 * Creating: when the user has NO custom personas yet, a prominent
 * illustrated CTA card sits above the catalog. Once they have at least
 * one, that card gives way to a compact "+ New" button on the right of
 * the "Yours" rail title (the create entry follows the customs). Editing
 * a custom persona happens from the personality band's pencil (the
 * active "select"); deletion is tucked inside the editor (see
 * `CreatePersonalityModal`) behind an explicit confirmation.
 */
import { type ReactNode, useState } from 'react';
import { Box, Button, ButtonBase, Stack, Typography, alpha, useTheme } from '@mui/material';
import AddRoundedIcon from '@mui/icons-material/AddRounded';
import CheckRoundedIcon from '@mui/icons-material/CheckRounded';
import reachyCreateProfile from '@/assets/reachy-create-profile.svg';

import {
  type Personality,
  setActivePersonality,
  useActivePersonality,
  useIsAvatarPending,
  usePersonalitiesCatalog,
} from '@/features/personalities';
import PersonaAvatar from '@/ui/design/PersonaAvatar';
import { railActionButtonSx } from '@/ui/design/railActionButtonSx';
import { FONT_WEIGHT, RADIUS, TYPO } from '@/ui/design/tokens';

interface PersonalityStoreProps {
  /** Open the "author a new persona" form. Surfaced as a dedicated CTA
   *  card at the top of the store (the band no longer carries a "+"). */
  onCreate: () => void;
}

/** Family taxonomy (presentation-only, local to this experiment).
 *  Two buckets: helpful assistants & coaches, and everything with a
 *  role / costume / character (incl. Reachy itself and the self-aware
 *  robots). */
const FAMILIES: ReadonlyArray<{ id: string; label: string; blurb: string }> = [
  { id: 'character', label: 'Characters', blurb: 'A costume, an accent, a whole world.' },
  { id: 'helpful', label: 'Assistants & coaches', blurb: 'Helpful, get something done with you.' },
];

const FAMILY_BY_ID: Record<string, string> = {
  // Assistants & coaches: actually try to help you do something.
  'builtin:chess_coach': 'helpful',
  'builtin:hype_bot': 'helpful',
  'builtin:quiz_host': 'helpful',
  'builtin:language_buddy': 'helpful',
  'builtin:zen_guide': 'helpful',
  'builtin:bedtime_storyteller': 'helpful',
  // Characters: a clear role / costume / accent to play along with -
  // plus Reachy itself (first, via catalog order) and the self-aware
  // robots, which the user grouped here.
  'builtin:default': 'character',
  'builtin:noir_detective': 'character',
  'builtin:victorian_butler': 'character',
  'builtin:captain_circuit': 'character',
  'builtin:mad_scientist': 'character',
  'builtin:time_traveler': 'character',
  'builtin:bored_teenager': 'character',
  'builtin:nature_documentarian': 'character',
  'builtin:mars_rover': 'character',
  'builtin:tiny_anxious_robot': 'character',
};

/** Explicit display order within each family rail. Ids not listed here
 *  fall back to the end of the rail, in catalog order. Hard constraints:
 *  Reachy is ALWAYS the first character, Captain Circuit second; Language
 *  Buddy opens the assistants rail. The rest is editorial. */
const FAMILY_ORDER: Record<string, string[]> = {
  character: [
    'builtin:default', // Reachy - always first
    'builtin:captain_circuit', // Captain Circuit - second
    'builtin:mars_rover',
    'builtin:tiny_anxious_robot',
    'builtin:noir_detective',
    'builtin:mad_scientist',
    'builtin:time_traveler',
    'builtin:victorian_butler',
    'builtin:bored_teenager',
    'builtin:nature_documentarian',
  ],
  helpful: [
    'builtin:language_buddy', // first
    'builtin:chess_coach',
    'builtin:zen_guide',
    'builtin:quiz_host',
    'builtin:hype_bot',
    'builtin:bedtime_storyteller',
  ],
};

export function PersonalityStore({ onCreate }: PersonalityStoreProps) {
  const catalog = usePersonalitiesCatalog();
  const active = useActivePersonality();

  // Newest-first: the store appends new customs (oldest -> newest) and edits
  // keep their slot, so reversing the insertion order surfaces the persona
  // the user just made at the head of the "Yours" rail.
  const customs = catalog.filter(p => p.kind === 'custom').reverse();
  const byFamily = (familyId: string) => {
    const order = FAMILY_ORDER[familyId] ?? [];
    const rank = (id: string) => {
      const i = order.indexOf(id);
      return i === -1 ? Number.MAX_SAFE_INTEGER : i;
    };
    return catalog
      .filter(p => p.kind === 'builtin' && FAMILY_BY_ID[p.id] === familyId)
      .sort((a, b) => rank(a.id) - rank(b.id));
  };

  // Apply the pick live and stay open: the store behaves like a gallery,
  // so selecting a persona updates the active one immediately (the band
  // above reflects it) while the user keeps browsing. Closing is an
  // explicit action via the band's chevron.
  const pick = (id: string) => {
    if (id !== active.id) setActivePersonality(id);
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
          + the toggle back to the orb.
          `pt: 6` (48px) gives the first rail ("Yours") clear breathing
          room below the band - the persona avatar disc now spills ~30px
          down into the top of this scroll body, so a smaller pad made the
          rail title start too high, tucked under the overflowing disc. */}
      <Box sx={{ flex: 1, minHeight: 0, overflowY: 'auto', pt: 6, pb: 4 }}>
        <Stack spacing={3}>
          {/* CREATE: a prominent illustrated CTA card, but ONLY until the
              user has made their first persona. After that it would just
              push the catalog down on every visit, so it collapses into a
              compact "+ New" button on the "Yours" rail title instead. */}
          {customs.length === 0 && (
            <Box sx={{ px: 3 }}>
              <CreateCard onCreate={onCreate} />
            </Box>
          )}

          {/* YOURS: custom personas rail (only when the user has any),
              with the create entry living as a "+ New" action on its
              title. Editing a custom persona happens from the band's
              pencil (the active "select"); deletion lives inside the
              editor. */}
          {customs.length > 0 && (
            <Rail
              label="Yours"
              blurb="The personalities you created."
              count={customs.length}
              // Three-state create entry, scaling with how many customs
              // the user owns:
              //   1-2  -> a vertical "create" card tacked on as the last
              //           tile in the rail (an in-between between the big
              //           hero card and the bare button).
              //   3+   -> the compact "+ New" button back on the title,
              //           since by then the rail is busy enough that an
              //           extra tile would just crowd it.
              action={
                customs.length >= 3 ? <NewPersonaButton onClick={onCreate} /> : undefined
              }
            >
              {customs.map(p => (
                <PersonaTile
                  key={p.id}
                  persona={p}
                  active={p.id === active.id}
                  onClick={() => pick(p.id)}
                />
              ))}
              {customs.length < 3 && <CreatePersonaTile onCreate={onCreate} />}
            </Rail>
          )}

          {/* FAMILY RAILS. */}
          {FAMILIES.map(family => {
            const members = byFamily(family.id);
            if (members.length === 0) return null;
            return (
              <Rail key={family.id} label={family.label} blurb={family.blurb} count={members.length}>
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
 * Create CTA card: full-width tappable surface shown above the rails
 * ONLY before the first custom persona exists (afterwards a compact
 * "+ New" button on the "Yours" rail takes over). Dashed primary outline
 * + an on-brand rotating-Reachy illustration so it reads as a warm "make
 * your own" invitation rather than a selectable persona tile.
 * ────────────────────────────────────────────────────────────────── */

function CreateCard({ onCreate }: { onCreate: () => void }) {
  const theme = useTheme();
  return (
    <Box
      component="button"
      type="button"
      onClick={onCreate}
      aria-label="Create your own agent"
      sx={{
        width: '100%',
        appearance: 'none',
        cursor: 'pointer',
        font: 'inherit',
        textAlign: 'left',
        display: 'flex',
        alignItems: 'center',
        gap: 2,
        px: 2.5,
        py: 2.5,
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
      {/* On-brand illustration (Reachy at a create-your-profile desk). */}
      <Box
        component="img"
        src={reachyCreateProfile}
        alt=""
        aria-hidden
        draggable={false}
        sx={{ width: 76, height: 76, flexShrink: 0, objectFit: 'contain', userSelect: 'none' }}
      />
      <Stack sx={{ minWidth: 0, flex: 1, gap: 0.25 }}>
        <Typography
          sx={{
            fontWeight: FONT_WEIGHT.semibold,
            fontSize: TYPO.lg,
            lineHeight: 1.2,
            color: 'text.primary',
          }}
        >
          Create your own agent
        </Typography>
        <Typography sx={{ fontSize: TYPO.sm, color: 'text.secondary' }}>
          Toss out an idea and watch Reachy bring it to life.
        </Typography>
      </Stack>
      {/* "+" disc as the action cue, pinned right. */}
      <Box
        sx={{
          width: 40,
          height: 40,
          flexShrink: 0,
          borderRadius: '50%',
          display: 'grid',
          placeItems: 'center',
          bgcolor: alpha(theme.palette.primary.main, 0.12),
        }}
      >
        <AddRoundedIcon sx={{ fontSize: 24 }} />
      </Box>
    </Box>
  );
}

/* ──────────────────────────────────────────────────────────────────
 * Compact "+ New" create button, pinned to the right of the "Yours"
 * rail title once the user owns at least one custom persona.
 * ────────────────────────────────────────────────────────────────── */

function NewPersonaButton({ onClick }: { onClick: () => void }) {
  // Mirrors the apps tab's "See all" rail button (AppRail) so the two
  // browse surfaces share one button language: outlined primary, small,
  // sentence-case, with the trailing glyph tucked in close.
  return (
    <Button
      onClick={onClick}
      variant="outlined"
      color="primary"
      size="small"
      aria-label="Create your own agent"
      endIcon={<AddRoundedIcon sx={{ fontSize: TYPO.lg }} />}
      sx={railActionButtonSx}
    >
      New
    </Button>
  );
}

/* ──────────────────────────────────────────────────────────────────
 * Vertical "create" tile: a persona-tile-shaped CTA tacked onto the end
 * of the "Yours" rail while the user owns 1-2 customs. Same footprint as
 * a PersonaTile (so it aligns in the track) but dashed + primary-tinted
 * with a "+" disc where the avatar would be, so it reads as "add one
 * more" rather than a selectable persona. Above 2 customs the compact
 * "+ New" title button takes over instead (see PersonalityStore).
 * ────────────────────────────────────────────────────────────────── */

function CreatePersonaTile({ onCreate }: { onCreate: () => void }) {
  const theme = useTheme();
  return (
    <ButtonBase
      onClick={onCreate}
      aria-label="Create your own agent"
      focusRipple
      sx={{
        flexShrink: 0,
        width: 146,
        color: 'primary.main',
        textAlign: 'center',
        display: 'flex',
        flexDirection: 'column',
        // Match PersonaTile's box metrics so the tile lines up with its
        // neighbours in the rail (top-anchored, same paddings + gap).
        alignItems: 'center',
        justifyContent: 'flex-start',
        gap: 1.25,
        px: 2,
        pt: 3,
        pb: 1.5,
        borderRadius: `${RADIUS.lg}px`,
        bgcolor: alpha(theme.palette.primary.main, 0.06),
        border: `1.5px dashed ${alpha(theme.palette.primary.main, 0.5)}`,
        transition: 'background-color 0.15s ease, transform 0.1s ease',
        '&:hover': { bgcolor: alpha(theme.palette.primary.main, 0.1) },
        '&:active': { transform: 'scale(0.99)' },
        WebkitTapHighlightColor: 'transparent',
      }}
    >
      {/* "+" disc sized like the 116px persona avatar so the caption
          block below lines up across tiles. */}
      <Box
        sx={{
          width: 116,
          height: 116,
          flexShrink: 0,
          borderRadius: '50%',
          display: 'grid',
          placeItems: 'center',
          bgcolor: alpha(theme.palette.primary.main, 0.1),
          border: `1.5px dashed ${alpha(theme.palette.primary.main, 0.5)}`,
        }}
      >
        <AddRoundedIcon sx={{ fontSize: 44 }} />
      </Box>
      <Typography
        sx={{
          fontWeight: FONT_WEIGHT.semibold,
          fontSize: TYPO.sm,
          lineHeight: 1.2,
          color: 'primary.main',
          whiteSpace: 'nowrap',
        }}
      >
        New
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
        Dream up a character
      </Typography>
    </ButtonBase>
  );
}

/* ──────────────────────────────────────────────────────────────────
 * Horizontal rail: header (label + blurb) over a snap-scroll track.
 * Local to this component (the apps `AppRail` carries app-specific
 * "See all" / count chrome we don't want here).
 * ────────────────────────────────────────────────────────────────── */

function Rail({
  label,
  blurb,
  count,
  action,
  children,
}: {
  label: string;
  blurb?: string;
  /** Number of personalities in this rail; rendered as a quiet,
   *  low-opacity counter next to the title. */
  count?: number;
  /** Optional control pinned to the right of the title row (e.g. the
   *  "+ New" create button on the "Yours" rail). */
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Box>
      <Stack sx={{ px: 3, mb: 1.25 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75 }}>
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
          {count !== undefined && (
            <Typography
              aria-hidden
              sx={{
                fontSize: TYPO.sm,
                fontWeight: FONT_WEIGHT.semibold,
                lineHeight: 1.2,
                color: 'text.primary',
                opacity: 0.35,
                fontVariantNumeric: 'tabular-nums',
              }}
            >
              {count}
            </Typography>
          )}
          {action && <Box sx={{ ml: 'auto' }}>{action}</Box>}
        </Box>
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
 * primary ring when active). Editing is NOT on the tile - it lives on
 * the personality band (the "select"), which exposes a pencil for the
 * active custom persona.
 * ────────────────────────────────────────────────────────────────── */

interface PersonaTileProps {
  persona: Personality;
  active: boolean;
  onClick: () => void;
}

function PersonaTile({ persona, active, onClick }: PersonaTileProps) {
  const theme = useTheme();
  // Click counter for the avatar "pop": each tap bumps it, which
  // remounts the avatar wrapper via `key` and replays the spring
  // keyframe (assigning the same animation name doesn't re-fire on its
  // own). Same retrigger technique as the star pulse / like pop, and the
  // same signature spring curve, so selecting a persona feels of-a-piece
  // with the rest of the app. `> 0` skips the very first render so tiles
  // don't pop on initial mount.
  const [popKey, setPopKey] = useState(0);
  // Is this persona's avatar baking? Custom personas only ever cook
  // (built-ins ship a fixed avatar), but the hook is cheap so we just
  // ask for any id. Drives the cooking ring over the tile's portrait.
  const cooking = useIsAvatarPending(persona.id);
  const handleClick = () => {
    setPopKey(k => k + 1);
    onClick();
  };
  return (
    <ButtonBase
      onClick={handleClick}
      aria-pressed={active}
      aria-label={`Use personality ${persona.name}`}
      focusRipple
      sx={{
        flexShrink: 0,
        width: 146,
        color: 'text.primary',
        textAlign: 'center',
        position: 'relative',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        // Top-anchored: the avatar's illustration spills slightly toward
        // the top edge, and a fixed gap keeps the name/tagline block
        // stable across tiles.
        justifyContent: 'flex-start',
        gap: 1.25,
        px: 2,
        pt: 3,
        pb: 1.5,
        borderRadius: `${RADIUS.lg}px`,
        // App-Store-style tile: white (paper) surface, light hairline
        // border, subtle drop shadow. Active state keeps the white bg
        // and adds a primary inset ring. The base border stays a
        // constant 1px in BOTH states (only its colour changes,
        // transparent <-> divider) and the active ring is an inset
        // box-shadow, so selecting a tile never changes its box size -
        // no content reflow / flicker. ButtonBase clips its ripple to
        // this rounded rect via its own `overflow: hidden`.
        bgcolor: 'background.paper',
        border: `1px solid ${active ? 'transparent' : theme.palette.divider}`,
        boxShadow: active
          ? `inset 0 0 0 2px ${theme.palette.primary.main}, 0 1px 4px ${alpha('#000', 0.06)}`
          : `0 1px 4px ${alpha('#000', 0.05)}`,
        // The tile itself never press-scales (that would reflow
        // neighbours); the tap feedback is the ripple + the avatar pop
        // below, both of which stay within the avatar's own box.
        transition: 'box-shadow 0.18s ease',
        WebkitTapHighlightColor: 'transparent',
      }}
    >
      {/* Avatar + selection check, on a relative box so the check badge
          can pin to the disc's lower-right corner. The inner wrapper is
          remounted by `key={popKey}` on every tap to replay the pop. */}
      <Box sx={{ position: 'relative', lineHeight: 0 }}>
        <Box
          key={popKey}
          sx={{
            // Quick spring pop on tap: the face bounces to 112 % and
            // settles. `overflow: visible` on the avatar means this
            // scales the spilling illustration too, so the whole
            // persona "kicks" rather than just the disc.
            animation:
              popKey > 0 ? 'persona-pop 420ms cubic-bezier(0.34, 1.56, 0.64, 1)' : 'none',
            '@keyframes persona-pop': {
              '0%': { transform: 'scale(1)' },
              '35%': { transform: 'scale(1.12)' },
              '100%': { transform: 'scale(1)' },
            },
          }}
        >
          <PersonaAvatar
            src={persona.avatar}
            size={116}
            imageScale={1.52}
            cooking={cooking}
            name={persona.name}
          />
        </Box>
        {/* Selection check. It's shown on every active tile, but the
            pop-in spring only plays on an actual user pick (`popKey >
            0`): when the panel opens with a persona already selected the
            badge appears statically, no animation. A paper ring lifts it
            off the orange disc edge. */}
        {active && (
          <Box
            aria-hidden
            sx={{
              position: 'absolute',
              bottom: 2,
              right: 2,
              width: 30,
              height: 30,
              borderRadius: '50%',
              // Outlined treatment matching the edit pencil: paper fill so
              // it reads on the orange disc, primary hairline ring + primary
              // glyph (rather than a solid primary fill).
              bgcolor: 'background.paper',
              color: 'primary.main',
              display: 'grid',
              placeItems: 'center',
              border: `1.5px solid ${theme.palette.primary.main}`,
              boxShadow: `0 1px 4px ${alpha('#000', 0.15)}`,
              animation:
                popKey > 0 ? 'persona-check-pop 360ms cubic-bezier(0.34, 1.56, 0.64, 1)' : 'none',
              '@keyframes persona-check-pop': {
                '0%': { transform: 'scale(0)', opacity: 0 },
                '60%': { transform: 'scale(1.15)', opacity: 1 },
                '100%': { transform: 'scale(1)', opacity: 1 },
              },
            }}
          >
            <CheckRoundedIcon sx={{ fontSize: 18 }} />
          </Box>
        )}
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
      {/* Always the tagline - the avatar's cooking donut already signals
          image generation, so we don't hijack the caption with a
          "Generating image…" status. */}
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

    </ButtonBase>
  );
}
