/**
 * PersonalityCoverflow - experimental "character select" picker.
 *
 * An alternative to `PersonalityGrid`: instead of a flat 2-column
 * grid, the catalog is presented as a coverflow carousel. The
 * centred persona is large and fully opaque; its neighbours peek in
 * from the sides, scaled down + faded + slightly rotated for depth.
 * The whole stage is tinted with the centred persona's accent
 * (`glow`) colour so browsing feels alive rather than flat.
 *
 * Interaction
 * ───────────
 *   - Drag / swipe horizontally to move between personas (pointer
 *     events, works for touch + mouse).
 *   - Tap a side card to bring it to the centre.
 *   - Tap the centre card OR the bottom CTA to select it (sets the
 *     active personality + closes the picker).
 *   - The last "card" is a CREATE affordance: selecting it opens the
 *     `CreatePersonalityModal` instead of activating a persona.
 *
 * This is wired in as a drop-in replacement for `PersonalityGrid`
 * while we evaluate the design - it reads the same store and exposes
 * the same `onClose` contract, so swapping back is a one-line change
 * in `ConversationPanel`.
 */
import { useEffect, useRef, useState } from 'react';
import { Box, Button, Stack, Typography, alpha, useTheme } from '@mui/material';
import AddRoundedIcon from '@mui/icons-material/AddRounded';
import ChevronLeftRoundedIcon from '@mui/icons-material/ChevronLeftRounded';
import ChevronRightRoundedIcon from '@mui/icons-material/ChevronRightRounded';
import KeyboardArrowUpRoundedIcon from '@mui/icons-material/KeyboardArrowUpRounded';

import {
  type Personality,
  setActivePersonality,
  useActivePersonality,
  usePersonalitiesCatalog,
} from '@/features/personalities';
import { FONT_WEIGHT, RADIUS, TYPO } from '@/ui/design/tokens';

import { CreatePersonalityModal } from './CreatePersonalityModal';

interface PersonalityCoverflowProps {
  /** Fired after the user commits a pick (or after a create), so the
   *  host can swap the orb area back in. */
  onClose: () => void;
}

/** Sentinel item appended to the end of the deck: selecting it opens
 *  the create flow rather than activating a persona. */
const CREATE_SLOT = '__create__';

type DeckItem = Personality | typeof CREATE_SLOT;

export function PersonalityCoverflow({ onClose }: PersonalityCoverflowProps) {
  const catalog = usePersonalitiesCatalog();
  const active = useActivePersonality();

  const deck: DeckItem[] = [...catalog, CREATE_SLOT];

  // Centre on the active persona when the picker opens.
  const initialIndex = Math.max(
    0,
    catalog.findIndex(p => p.id === active.id),
  );
  const [index, setIndex] = useState(initialIndex);
  const [creating, setCreating] = useState(false);

  // Live drag offset in "cards" (fractional). 0 when settled.
  const [drag, setDrag] = useState(0);
  const dragging = drag !== 0;

  // Measure the stage so card geometry scales with viewport width.
  const stageRef = useRef<HTMLDivElement | null>(null);
  const [stageW, setStageW] = useState(360);
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const ro = new ResizeObserver(entries => {
      for (const e of entries) setStageW(e.contentRect.width);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const cardW = Math.min(Math.max(stageW * 0.46, 150), 210);
  const cardH = cardW;
  const spacing = cardW * 0.82;

  // Pointer drag bookkeeping.
  const pointerStartX = useRef<number | null>(null);
  const lastDragCards = useRef(0);
  // True once a press has moved past the tap threshold and become a
  // real drag. Until then we DON'T capture the pointer, so taps on
  // child controls (arrows, cards) keep firing their own `click`.
  const draggingRef = useRef(false);
  // Set right after a drag ends so the synthetic `click` that follows
  // pointerup doesn't get interpreted as a tap (which would commit or
  // recentre a card the user only meant to swipe past).
  const justDraggedRef = useRef(false);

  /** Tap-vs-drag threshold in px before we treat a press as a swipe. */
  const DRAG_THRESHOLD = 6;

  const clamp = (i: number) => Math.max(0, Math.min(deck.length - 1, i));

  const goTo = (i: number) => setIndex(clamp(i));

  const onPointerDown = (e: React.PointerEvent) => {
    pointerStartX.current = e.clientX;
    draggingRef.current = false;
    lastDragCards.current = 0;
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (pointerStartX.current === null) return;
    const dx = e.clientX - pointerStartX.current;
    if (!draggingRef.current) {
      if (Math.abs(dx) < DRAG_THRESHOLD) return;
      // Promote to a real drag now (not on pointerdown): capture the
      // pointer so the swipe keeps tracking even if the finger drifts
      // off the stage bounds.
      draggingRef.current = true;
      (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    }
    const cards = dx / spacing;
    lastDragCards.current = cards;
    setDrag(cards);
  };
  const endDrag = () => {
    if (pointerStartX.current === null) return;
    const wasDragging = draggingRef.current;
    pointerStartX.current = null;
    draggingRef.current = false;
    if (!wasDragging) return; // a plain tap: let the child's onClick run
    justDraggedRef.current = true;
    const settled = clamp(Math.round(index - lastDragCards.current));
    lastDragCards.current = 0;
    setDrag(0);
    setIndex(settled);
  };

  // The persona currently under the centre (ignoring live drag so the
  // caption text doesn't flicker mid-swipe). Null on the create slot.
  const centred = deck[index];
  const centredPersona = centred === CREATE_SLOT ? null : centred;

  const handleCommit = () => {
    const item = deck[index];
    if (item === CREATE_SLOT) {
      setCreating(true);
      return;
    }
    if (item.id !== active.id) setActivePersonality(item.id);
    onClose();
  };

  return (
    <Box
      sx={{
        flex: 1,
        minHeight: 0,
        width: '100vw',
        mx: 'calc(50% - 50vw)',
        position: 'relative',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'center',
        overflow: 'hidden',
        bgcolor: 'background.default',
        // The whole picker is a gesture surface: never let a swipe
        // start a text/image selection or flash the native tap
        // highlight, which made the module look like it was being
        // "selected" while dragging.
        userSelect: 'none',
        WebkitUserSelect: 'none',
        WebkitTouchCallout: 'none',
        WebkitTapHighlightColor: 'transparent',
      }}
    >
      {/* CLOSE: collapse the picker back to the orb. Replaces the
          top band's chevron (the band is hidden while open). */}
      <Box
        component="button"
        type="button"
        aria-label="Close personality picker"
        onClick={onClose}
        sx={{
          position: 'absolute',
          top: 8,
          right: 12,
          zIndex: 300,
          appearance: 'none',
          border: 0,
          width: 36,
          height: 36,
          borderRadius: '50%',
          display: 'grid',
          placeItems: 'center',
          cursor: 'pointer',
          bgcolor: 'transparent',
          color: 'text.secondary',
          '&:active': { transform: 'scale(0.92)' },
        }}
      >
        <KeyboardArrowUpRoundedIcon />
      </Box>

      {/* COVERFLOW STAGE - content-height (not flex:1) so the caption
          + CTA sit right under the centred illustration rather than
          floating a screen away. */}
      <Box
        ref={stageRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        sx={{
          height: cardH + 40,
          position: 'relative',
          touchAction: 'pan-y',
          cursor: dragging ? 'grabbing' : 'grab',
          // 3D perspective so the side illustrations' rotateY reads as
          // depth rather than a flat skew.
          perspective: '1200px',
        }}
      >
        {deck.map((item, i) => {
          const rel = i - index + drag;
          const abs = Math.abs(rel);
          // Cull far-away cards for perf - only the centre +/- 2 are
          // ever visible enough to matter.
          if (abs > 2.6) return null;

          const translateX = rel * spacing;
          const scale = Math.max(0.48, 1 - abs * 0.26);
          const opacity = Math.max(0, 1 - abs * 0.62);
          const rotateY = Math.max(-24, Math.min(24, -rel * 14));
          const z = Math.round(100 - abs * 40);

          const isCentre = Math.round(index - drag) === i;

          return (
            <Box
              key={item === CREATE_SLOT ? CREATE_SLOT : item.id}
              onClick={() => {
                // Swallow the click that trails a swipe so dragging
                // past a card never selects / recentres it.
                if (justDraggedRef.current) {
                  justDraggedRef.current = false;
                  return;
                }
                if (!isCentre) {
                  goTo(i);
                } else {
                  handleCommit();
                }
              }}
              sx={{
                position: 'absolute',
                top: '50%',
                left: '50%',
                width: cardW,
                height: cardH,
                mt: `-${cardH / 2}px`,
                ml: `-${cardW / 2}px`,
                transform: `translateX(${translateX}px) scale(${scale}) rotateY(${rotateY}deg)`,
                opacity,
                zIndex: z,
                transition: dragging
                  ? 'none'
                  : 'transform 0.4s cubic-bezier(0.22, 1, 0.36, 1), opacity 0.4s ease',
                transformStyle: 'preserve-3d',
                willChange: 'transform, opacity',
                cursor: 'pointer',
              }}
            >
              {item === CREATE_SLOT ? (
                <CreateCard />
              ) : (
                <PersonaCard persona={item} active={item.id === active.id} />
              )}
            </Box>
          );
        })}

        {/* Side nav arrows: secondary affordance for non-swipers. */}
        <NavArrow
          dir="left"
          disabled={index <= 0}
          onClick={() => goTo(index - 1)}
        />
        <NavArrow
          dir="right"
          disabled={index >= deck.length - 1}
          onClick={() => goTo(index + 1)}
        />
      </Box>

      {/* CAPTION: name + tagline (+ a quiet position counter). Kept
          tight so the CTA hugs the illustration above. */}
      <Box sx={{ px: 3, pt: 0.25, textAlign: 'center' }}>
        {centredPersona ? (
          <Stack spacing={0.25} sx={{ alignItems: 'center' }}>
            {active.id === centredPersona.id && (
              <Typography
                sx={{
                  fontSize: TYPO.nano,
                  fontWeight: FONT_WEIGHT.bold,
                  letterSpacing: '0.6px',
                  textTransform: 'uppercase',
                  color: 'text.secondary',
                }}
              >
                Active
              </Typography>
            )}
            <Typography sx={{ fontSize: TYPO.lg, fontWeight: FONT_WEIGHT.bold, lineHeight: 1.15 }}>
              {centredPersona.name}
            </Typography>
            <Typography
              sx={{ fontSize: TYPO.xs, fontStyle: 'italic', color: 'text.secondary' }}
            >
              {centredPersona.tagline}
            </Typography>
          </Stack>
        ) : (
          <Stack spacing={0.25} sx={{ alignItems: 'center' }}>
            <Typography sx={{ fontSize: TYPO.lg, fontWeight: FONT_WEIGHT.bold, lineHeight: 1.15 }}>
              Create your own
            </Typography>
            <Typography
              sx={{ fontSize: TYPO.xs, color: 'text.secondary', maxWidth: 280 }}
            >
              Define how Reachy talks and behaves.
            </Typography>
          </Stack>
        )}

        {/* Position counter replaces the row of dots: compact and
            readable even with a long catalog. The create slot reads
            as a "+" at the end. */}
        <Typography
          sx={{
            mt: 0.75,
            fontSize: TYPO.tiny,
            color: 'text.disabled',
            fontVariantNumeric: 'tabular-nums',
            letterSpacing: '0.5px',
          }}
        >
          {centredPersona ? `${index + 1} / ${catalog.length}` : '+'}
        </Typography>
      </Box>

      {/* PRIMARY CTA - outlined + close to the illustration. */}
      <Box sx={{ px: 3, pb: 2, pt: 1, display: 'flex', justifyContent: 'center' }}>
        <Button
          variant="outlined"
          color="primary"
          onClick={handleCommit}
          sx={{
            textTransform: 'none',
            fontSize: TYPO.md,
            fontWeight: FONT_WEIGHT.semibold,
            py: 1.1,
            px: 3.5,
            borderRadius: `${RADIUS.md}px`,
            borderWidth: '1.5px',
            '&:hover': { borderWidth: '1.5px' },
            minWidth: 200,
          }}
        >
          {centredPersona
            ? active.id === centredPersona.id
              ? 'Continue'
              : 'Use this personality'
            : 'Create your own'}
        </Button>
      </Box>

      {creating && (
        <CreatePersonalityModal
          onCancel={() => setCreating(false)}
          onCreated={() => {
            setCreating(false);
            onClose();
          }}
        />
      )}
    </Box>
  );
}

/* ──────────────────────────────────────────────────────────────────
 * Persona "card": no card at all - just the bare illustration on the
 * stage. The SVG carries the whole identity; the active state is
 * conveyed by the caption below (not a badge here).
 * ────────────────────────────────────────────────────────────────── */

function PersonaCard({ persona }: { persona: Personality; active: boolean }) {
  return (
    <Box sx={{ width: '100%', height: '100%', position: 'relative' }}>
      <Box
        component="img"
        src={persona.avatar}
        alt=""
        aria-hidden
        draggable={false}
        sx={{
          position: 'absolute',
          width: '118%',
          height: 'auto',
          left: '50%',
          top: '50%',
          transform: 'translate(-50%, -52%)',
          pointerEvents: 'none',
          userSelect: 'none',
        }}
      />
    </Box>
  );
}

/* ──────────────────────────────────────────────────────────────────
 * Create card: distinct dashed-plate affordance, last in the deck.
 * ────────────────────────────────────────────────────────────────── */

function CreateCard() {
  const theme = useTheme();
  return (
    <Box
      sx={{
        width: '100%',
        height: '100%',
        display: 'grid',
        placeItems: 'center',
      }}
    >
      <Box
        sx={{
          width: '64%',
          aspectRatio: '1 / 1',
          borderRadius: '50%',
          display: 'grid',
          placeItems: 'center',
          color: 'primary.main',
          bgcolor: alpha(theme.palette.primary.main, 0.08),
          border: `2px dashed ${alpha(theme.palette.primary.main, 0.4)}`,
        }}
      >
        <AddRoundedIcon sx={{ fontSize: 38 }} />
      </Box>
    </Box>
  );
}

/* ──────────────────────────────────────────────────────────────────
 * Side navigation arrow.
 * ────────────────────────────────────────────────────────────────── */

function NavArrow({
  dir,
  disabled,
  onClick,
}: {
  dir: 'left' | 'right';
  disabled: boolean;
  onClick: () => void;
}) {
  const theme = useTheme();
  return (
    <Box
      component="button"
      type="button"
      aria-label={dir === 'left' ? 'Previous personality' : 'Next personality'}
      disabled={disabled}
      onPointerDown={e => e.stopPropagation()}
      onClick={e => {
        e.stopPropagation();
        onClick();
      }}
      sx={{
        position: 'absolute',
        top: '50%',
        [dir]: 8,
        transform: 'translateY(-50%)',
        zIndex: 200,
        appearance: 'none',
        border: 0,
        width: 40,
        height: 40,
        borderRadius: '50%',
        display: 'grid',
        placeItems: 'center',
        cursor: disabled ? 'default' : 'pointer',
        color: 'text.secondary',
        bgcolor: alpha(theme.palette.background.paper, 0.7),
        backdropFilter: 'blur(4px)',
        boxShadow: `0 2px 8px ${alpha('#000', 0.15)}`,
        opacity: disabled ? 0 : 0.9,
        transition: 'opacity 0.2s ease',
        '&:active': { transform: 'translateY(-50%) scale(0.92)' },
      }}
    >
      {dir === 'left' ? <ChevronLeftRoundedIcon /> : <ChevronRightRoundedIcon />}
    </Box>
  );
}
