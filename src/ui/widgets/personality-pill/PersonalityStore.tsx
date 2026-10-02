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
 * applies a pick live, then signals the host via `onPicked` so it can
 * close the picker (after letting the selection feedback play). The
 * family taxonomy lives here (not in the shared model) on purpose -
 * it's a presentation concern of this surface, and keeping it local
 * means the data layer stays untouched.
 *
 * Creating: when the user has NO custom personas yet, a prominent
 * illustrated CTA card sits above the catalog. Once they have at least
 * one, that card gives way to a compact "+ New" button on the right of
 * the "Yours" rail title (the create entry follows the customs).
 *
 * Curating (edit mode): the "Yours" rail carries an Edit/Done toggle
 * (mirroring the apps launcher's edit mode). While editing:
 *   - each custom tile grows a drag handle (top-left) and becomes
 *     reorderable within the rail via dnd-kit (order persists through
 *     `reorderCustomPersonalities`),
 *   - the selection checkmark gives way to a pencil badge on EVERY
 *     custom tile, and tapping a tile opens the editor instead of
 *     picking the persona,
 *   - the create entries hide - editing is about curating the existing
 *     set, not growing it.
 * Deletion is tucked inside the editor (see `CreatePersonalityModal`)
 * behind an explicit confirmation.
 */
import { type ReactNode, useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { Box, Button, ButtonBase, Stack, Typography, alpha, useTheme } from '@mui/material';
import AddRoundedIcon from '@mui/icons-material/AddRounded';
import CheckRoundedIcon from '@mui/icons-material/CheckRounded';
import DragIndicatorIcon from '@mui/icons-material/DragIndicator';
import EditOutlinedIcon from '@mui/icons-material/EditOutlined';
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  arrayMove,
  horizontalListSortingStrategy,
  sortableKeyboardCoordinates,
  useSortable,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import reachyCreateProfile from '@/assets/reachy-create-profile.svg';

import {
  type Personality,
  presentationKey,
  reorderCustomPersonalities,
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
  /** Open the editor for a custom persona. Wired to the pencil badge
   *  on custom tiles (built-ins aren't editable, so their tiles never
   *  show one). */
  onEdit: (persona: Personality) => void;
  /** Fired on EVERY tile tap (including re-picking the already-active
   *  persona). The host uses it to close the picker after a short
   *  delay, so the tile's selection pop + check badge get to play
   *  before the grid swaps back to the orb. */
  onPicked?: () => void;
  /**
   * "Yours" rail curate mode (drag handles + pencil badges). OWNED BY
   * THE HOST, not local state: opening a persona's editor unmounts this
   * store (the form takes the body slot), so a local flag would reset
   * and closing the form would strand the user back in browse mode
   * mid-curation. The host keeps it alive across that round-trip and
   * resets it when the picker itself closes.
   */
  editMode: boolean;
  onEditModeChange: (editMode: boolean) => void;
}

/** Family taxonomy (presentation-only, local to this experiment).
 *  Two buckets: helpful assistants & coaches, and everything with a
 *  role / costume / character (incl. Reachy itself and the self-aware
 *  robots). */
const FAMILIES: ReadonlyArray<{ id: string; label: string; blurb: string }> = [
  { id: 'character', label: 'Characters', blurb: 'A costume, an accent, a whole world.' },
  { id: 'helpful', label: 'Assistants & coaches', blurb: 'Helpful, get something done with you.' },
];

/** Deterministic per-tile seed for the edit-mode wiggle (mirrors the
 *  apps launcher): each card gets a slightly different phase/duration
 *  so the rail shimmers organically instead of marching in lockstep. */
function tileSeed(id: string): number {
  let s = 0;
  for (let i = 0; i < id.length; i++) {
    s = (s * 31 + id.charCodeAt(i)) | 0;
  }
  return Math.abs(s);
}

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
    'builtin:nature_documentarian', // Nature Doc - third
    'builtin:mars_rover',
    'builtin:noir_detective',
    'builtin:mad_scientist',
    'builtin:time_traveler',
    'builtin:victorian_butler',
    'builtin:bored_teenager',
    'builtin:tiny_anxious_robot', // Tiny Worry - last
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

export function PersonalityStore({
  onCreate,
  onEdit,
  onPicked,
  editMode,
  onEditModeChange,
}: PersonalityStoreProps) {
  const catalog = usePersonalitiesCatalog();
  const active = useActivePersonality();

  // Newest-first: the store appends new customs (oldest -> newest) and edits
  // keep their slot, so reversing the insertion order surfaces the persona
  // the user just made at the head of the "Yours" rail. (A manual reorder
  // in edit mode rewrites the STORAGE order so this reversal still yields
  // exactly what the user arranged - see `handleDragEnd`.)
  const customs = catalog.filter(p => p.kind === 'custom').reverse();

  // Drag-to-reorder sensors (edit mode only). Drags start ONLY from a
  // tile's dedicated handle (see `SortablePersonaTile`) because the rail
  // is itself a horizontal scroller - a whole-card drag would fight the
  // pan gesture. The small distance threshold still lets the handle
  // distinguish a stray tap from a deliberate drag; the keyboard sensor
  // gives arrow-key reordering for free (a11y).
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  // Persona currently being dragged, mirrored into the DragOverlay. The
  // overlay is what the user actually sees moving: the rail track is a
  // scroll container (overflow hidden), so the in-list tile would get
  // CLIPPED the moment the drag leaves the track's box. The overlay is
  // portalled to <body>, escaping every clipping ancestor, while the
  // original stays in the rail as a dimmed placeholder marking the slot.
  const [dragId, setDragId] = useState<string | null>(null);
  const draggedPersona = dragId ? (customs.find(p => p.id === dragId) ?? null) : null;

  const handleDragStart = useCallback((event: DragStartEvent) => {
    setDragId(String(event.active.id));
  }, []);

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      setDragId(null);
      const { active: dragged, over } = event;
      if (!over || dragged.id === over.id) return;
      const displayIds = customs.map(p => p.id);
      const from = displayIds.indexOf(String(dragged.id));
      const to = displayIds.indexOf(String(over.id));
      if (from === -1 || to === -1) return;
      // The rail displays customs REVERSED (newest first), so the new
      // display order is flipped back before persisting: storage keeps
      // its oldest->newest convention and `addCustomPersonality` can
      // keep appending (new personas still land at the rail's head).
      const reordered = arrayMove(displayIds, from, to);
      reorderCustomPersonalities([...reordered].reverse());
    },
    [customs],
  );

  // Auto-exit edit mode once the last custom is gone (deleting it from
  // the editor would otherwise leave a dangling "Done" over an empty
  // rail - which unmounts entirely below).
  useEffect(() => {
    if (customs.length === 0 && editMode) onEditModeChange(false);
  }, [customs.length, editMode, onEditModeChange]);
  // The rails are keyed on the phone's own `builtin:<slug>` ids, while the
  // catalog now carries the robot's names (`bored_teenager`,
  // `mad_scientist_assistant`). `presentationKey` is the bridge. A robot
  // profile the phone has no family for lands with the characters, last.
  const familyKey = (p: Personality) => `builtin:${presentationKey(p.id)}`;
  const byFamily = (familyId: string) => {
    const order = FAMILY_ORDER[familyId] ?? [];
    const rank = (key: string) => {
      const i = order.indexOf(key);
      return i === -1 ? Number.MAX_SAFE_INTEGER : i;
    };
    return catalog
      .filter(p => p.kind === 'builtin' && (FAMILY_BY_ID[familyKey(p)] ?? 'character') === familyId)
      .sort((a, b) => rank(familyKey(a)) - rank(familyKey(b)));
  };

  // Apply the pick live, then let the host close the picker: tapping a
  // persona means "use this one", so the user lands back on the orb
  // ready to talk instead of having to find the band toggle to exit.
  // `onPicked` fires even when re-picking the active persona - the
  // intent ("use this one") is the same either way.
  const pick = (id: string) => {
    if (id !== active.id) setActivePersonality(id);
    onPicked?.();
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
              title and an Edit/Done toggle for curating (reorder +
              edit). Deletion lives inside the editor. */}
          {customs.length > 0 && (
            <Rail
              label="Yours"
              blurb={
                editMode
                  ? 'Drag to reorder, tap a card to edit.'
                  : 'The personalities you created.'
              }
              count={customs.length}
              disableSnap={editMode}
              // Title actions:
              //   - "+ New" appears once the user owns 3+ customs (below
              //     that, a vertical create tile lives in the rail
              //     instead) and hides in edit mode - curating is about
              //     the existing set, not growing it.
              //   - Edit/Done toggles the curate mode (drag handles +
              //     pencil badges on every card).
              action={
                <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
                  {customs.length >= 3 && !editMode && (
                    <NewPersonaButton onClick={onCreate} />
                  )}
                  <Button
                    variant="outlined"
                    color="primary"
                    size="small"
                    onClick={() => onEditModeChange(!editMode)}
                    aria-pressed={editMode}
                    aria-label={
                      editMode ? 'Done editing your personalities' : 'Edit your personalities'
                    }
                    startIcon={
                      editMode ? (
                        <CheckRoundedIcon sx={{ fontSize: 16 }} />
                      ) : (
                        <EditOutlinedIcon sx={{ fontSize: 16 }} />
                      )
                    }
                    sx={{ ...railActionButtonSx, '& .MuiButton-startIcon': { ml: -0.25, mr: 0.5 } }}
                  >
                    {editMode ? 'Done' : 'Edit'}
                  </Button>
                </Stack>
              }
            >
              {editMode ? (
                // Edit mode: the rail becomes a sortable surface. Drops
                // persist the new order to the personalities store; the
                // create tile is omitted while curating.
                <DndContext
                  sensors={sensors}
                  collisionDetection={closestCenter}
                  // Edge auto-scroll: holding the dragged card against
                  // the rail's left/right edge pans the track, so a
                  // persona can travel across the whole (scrollable)
                  // set in one drag. Wider x threshold than the default
                  // so it kicks in comfortably; y disabled - reordering
                  // is strictly horizontal and the vertical store body
                  // scrolling under a drag would just be noise.
                  autoScroll={{ threshold: { x: 0.25, y: 0 } }}
                  onDragStart={handleDragStart}
                  onDragEnd={handleDragEnd}
                  onDragCancel={() => setDragId(null)}
                >
                  <SortableContext
                    items={customs.map(p => p.id)}
                    strategy={horizontalListSortingStrategy}
                  >
                    {customs.map(p => (
                      <SortablePersonaTile
                        key={p.id}
                        persona={p}
                        active={p.id === active.id}
                        onEdit={() => onEdit(p)}
                      />
                    ))}
                  </SortableContext>
                  {/* The floating card: portalled to <body> so it can
                      travel outside the rail's scroll clipping. Slight
                      lift (scale + shadow) so it reads as "picked up". */}
                  {createPortal(
                    <DragOverlay adjustScale={false}>
                      {draggedPersona ? (
                        <Box
                          sx={{
                            transform: 'scale(1.04)',
                            filter: `drop-shadow(0 8px 20px ${alpha('#000', 0.25)})`,
                          }}
                        >
                          <PersonaTile
                            persona={draggedPersona}
                            active={draggedPersona.id === active.id}
                            editMode
                            onClick={() => {}}
                          />
                        </Box>
                      ) : null}
                    </DragOverlay>,
                    document.body,
                  )}
                </DndContext>
              ) : (
                <>
                  {customs.map(p => (
                    <PersonaTile
                      key={p.id}
                      persona={p}
                      active={p.id === active.id}
                      onClick={() => pick(p.id)}
                    />
                  ))}
                  {customs.length < 3 && <CreatePersonaTile onCreate={onCreate} />}
                </>
              )}
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
      aria-label="Create your own personality"
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
          Create your own personality
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
      aria-label="Create your own personality"
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
      aria-label="Create your own personality"
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
        Dream up a personality
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
  disableSnap = false,
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
  /** Turn off the track's scroll snapping. Needed while drag-reordering:
   *  snap fights dnd-kit's edge auto-scroll (every programmatic scroll
   *  gets re-snapped, so the pan stalls). */
  disableSnap?: boolean;
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
          scrollSnapType: disableSnap ? 'none' : 'x proximity',
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
 * primary ring when active). In the "Yours" rail's edit mode
 * (`editMode`) the tile flips from "pick" to "curate": the selection
 * check disappears, a pencil badge appears on the disc's lower-right
 * (the check's spot) on EVERY custom tile, and tapping the card opens
 * the editor instead of activating the persona. The drag handle lives
 * on the sortable wrapper (see `SortablePersonaTile`), not here.
 * ────────────────────────────────────────────────────────────────── */

interface PersonaTileProps {
  persona: Personality;
  active: boolean;
  onClick: () => void;
  /** Curate mode: swap the selection affordances (check, pop) for the
   *  edit ones (pencil badge, "Edit" semantics). The host guarantees
   *  `onClick` opens the editor when this is set. */
  editMode?: boolean;
}

function PersonaTile({ persona, active, onClick, editMode = false }: PersonaTileProps) {
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
    // No selection pop while curating: the tap opens the editor, so
    // playing the "picked!" spring would be a false signal.
    if (!editMode) setPopKey(k => k + 1);
    onClick();
  };
  return (
    <ButtonBase
      onClick={handleClick}
      aria-pressed={editMode ? undefined : active}
      aria-label={editMode ? `Edit ${persona.name}` : `Use personality ${persona.name}`}
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
        {/* Edit pencil (curate mode): sits exactly where the selection
            check normally lives (disc lower-right, same 30px
            outlined-paper treatment) - the check gives way to it on
            EVERY custom tile while editing. Purely decorative
            (aria-hidden): the whole tile already opens the editor in
            this mode, the badge just labels the gesture. */}
        {editMode && (
          <Box
            aria-hidden
            sx={{
              position: 'absolute',
              bottom: 2,
              right: 2,
              width: 30,
              height: 30,
              borderRadius: '50%',
              bgcolor: 'background.paper',
              color: 'primary.main',
              display: 'grid',
              placeItems: 'center',
              border: `1.5px solid ${alpha(theme.palette.primary.main, 0.55)}`,
              boxShadow: `0 1px 4px ${alpha('#000', 0.15)}`,
            }}
          >
            <EditOutlinedIcon sx={{ fontSize: 16 }} />
          </Box>
        )}
        {/* Selection check. It's shown on every active tile (outside
            curate mode - the pencil takes its spot there), but the
            pop-in spring only plays on an actual user pick (`popKey >
            0`): when the panel opens with a persona already selected the
            badge appears statically, no animation. A paper ring lifts it
            off the orange disc edge. */}
        {active && !editMode && (
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
          // Always text.primary, even when active: the selection is
          // already carried by the primary ring + check badge, and a
          // primary title would fight with them for attention.
          color: 'text.primary',
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

/* ──────────────────────────────────────────────────────────────────
 * Sortable wrapper for a persona tile (edit mode only). dnd-kit's
 * sort transform/transition live on THIS wrapper (translate as
 * neighbours shuffle) while the inner `PersonaTile` stays untouched.
 *
 * Unlike the apps launcher (whole card = drag handle), the drag here
 * starts ONLY from the dedicated dots handle at the card's top-left:
 * the rail is itself a horizontal scroller, so a whole-card drag
 * would be indistinguishable from a pan. The handle sits as a SIBLING
 * overlay of the tile's ButtonBase (not inside it), so its presses
 * never trigger the tile's ripple or its "open editor" tap.
 * ────────────────────────────────────────────────────────────────── */

function SortablePersonaTile({
  persona,
  active,
  onEdit,
}: {
  persona: Personality;
  active: boolean;
  onEdit: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: persona.id });
  // Edit-mode wiggle, same recipe as the apps launcher: seeded per-tile
  // phase offset / duration / variant so neighbouring cards never
  // tremble in sync.
  const { wiggleDelayMs, wiggleDurationMs, wiggleVariant } = useMemo(() => {
    const seed = tileSeed(persona.id);
    return {
      wiggleDelayMs: -(seed % 560),
      wiggleDurationMs: 480 + ((seed >>> 3) % 160),
      wiggleVariant: seed % 2 === 0 ? 'a' : 'b',
    } as const;
  }, [persona.id]);
  return (
    <Box
      ref={setNodeRef}
      // Inline style (not sx) for the drag transform: it changes every
      // frame while dragging, and emotion would mint a new class per
      // frame.
      style={{ transform: CSS.Transform.toString(transform), transition }}
      sx={{
        flexShrink: 0,
        // While dragging, the VISIBLE card is the portalled DragOverlay
        // (which escapes the rail's scroll clipping); this in-list
        // original stays as a dimmed ghost marking the drop slot.
        opacity: isDragging ? 0.35 : 1,
      }}
    >
      {/* Wiggle layer: the CSS rotate lives on its own element between
          the dnd translate (outer wrapper) and the tile, so the two
          transforms compose instead of clobbering each other - exactly
          the apps launcher's structure. The lifted card stops wiggling
          (its ghost holds still too): the overlay is the one flying. */}
      <Box
        sx={{
          position: 'relative',
          transformOrigin: 'center',
          animation: isDragging
            ? 'none'
            : `persona-card-wiggle-${wiggleVariant} ${wiggleDurationMs}ms ease-in-out ${wiggleDelayMs}ms infinite`,
          '@keyframes persona-card-wiggle-a': {
            '0%, 100%': { transform: 'rotate(-0.8deg)' },
            '25%': { transform: 'rotate(0.8deg)' },
            '50%': { transform: 'rotate(-0.5deg)' },
            '75%': { transform: 'rotate(0.8deg)' },
          },
          '@keyframes persona-card-wiggle-b': {
            '0%, 100%': { transform: 'rotate(0.8deg)' },
            '25%': { transform: 'rotate(-0.8deg)' },
            '50%': { transform: 'rotate(0.5deg)' },
            '75%': { transform: 'rotate(-0.8deg)' },
          },
          '@media (prefers-reduced-motion: reduce)': {
            animation: 'none',
          },
        }}
      >
        <PersonaTile persona={persona} active={active} editMode onClick={onEdit} />
        {/* Drag handle: the classic 2x3 dots, top-left of the card.
            `touchAction: none` is what actually frees the gesture from
            the rail's horizontal pan on touch devices. */}
        <Box
          component="span"
          {...attributes}
          {...listeners}
          aria-label={`Reorder ${persona.name}`}
          sx={{
            position: 'absolute',
            top: 4,
            left: 4,
            zIndex: 2,
            width: 36,
            height: 36,
            display: 'grid',
            placeItems: 'center',
            color: 'text.secondary',
            opacity: 0.65,
            borderRadius: '50%',
            touchAction: 'none',
            cursor: isDragging ? 'grabbing' : 'grab',
            WebkitTapHighlightColor: 'transparent',
            '&:focus-visible': {
              outline: t => `2px solid ${t.palette.primary.main}`,
              outlineOffset: 1,
            },
          }}
        >
          <DragIndicatorIcon sx={{ fontSize: 20 }} />
        </Box>
      </Box>
    </Box>
  );
}
