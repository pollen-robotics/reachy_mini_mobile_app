/**
 * First-visit store intro: a one-shot overlay shown the first time
 * the user opens the store sub-view.
 *
 * Replaces the old inline hero panel: onboarding gets one proper,
 * focused moment (app-icon marquee + pitch + the three catalog
 * actions with real explanations) and the browse layout stays
 * permanently clean (sticky bar, search, rails - no dismissible
 * chrome).
 *
 * Lifecycle: in PROD the host (`AppsTabView`) persists a seen-flag
 * (`reachy.apps.storeIntroSeen`) on the CTA tap, so the intro only
 * ever greets once (and a user who kills the app mid-intro is
 * greeted again next launch). In DEV nothing is persisted and the
 * intro re-arms on every store entrance.
 *
 * Visual contract: an OPAQUE page-background cover of the store
 * area only (absolutely positioned inside the tab body, so the
 * app's top bar and bottom nav stay visible and untouched). It
 * reads as "the store's first page" rather than a modal: no
 * dimming, no sheet. The COVER is fully opaque from the first frame
 * (a transparent cover would flicker the view mounting underneath);
 * only the CONTENT fades in, slightly delayed so the marquee images
 * have decode time. The whole overlay fades OUT on dismissal. The
 * CTA is the only way through - there's nothing meaningful to reach
 * behind it until the user knows what Try / Pin / Like do.
 */
import { useState } from 'react';
import { Box, Button, Stack, Typography } from '@mui/material';
import FavoriteBorderIcon from '@mui/icons-material/FavoriteBorder';
import PlayArrowOutlinedIcon from '@mui/icons-material/PlayArrowOutlined';
import StarOutlineIcon from '@mui/icons-material/StarBorder';

import iconConversation from '@/assets/app-icons/conversation.svg';
import iconCookaiware from '@/assets/app-icons/cookaiware.svg';
import iconEmotions from '@/assets/app-icons/emotions.svg';
import iconMarionette from '@/assets/app-icons/marionette.svg';
import iconMorse from '@/assets/app-icons/morse.png';
import iconTelepresence from '@/assets/app-icons/telepresence.svg';
// Persona stickers: copies of the carousel's `reachies/top-sided/*`
// set, pre-cropped to their alpha bounding box (plus a 4% margin) so
// they fill the marquee tile like the app glyphs do. The carousel
// originals keep their canvas-centred padding - don't reuse them
// here, they'd render ~30% smaller at the same box size.
import reachyCaptain from '@/assets/app-icons/reachy-captain.webp';
import reachyCowboy from '@/assets/app-icons/reachy-cowboy.webp';
import reachyExplorer from '@/assets/app-icons/reachy-explorer.webp';
import reachyFarmer from '@/assets/app-icons/reachy-farmer.webp';
import reachyHacker from '@/assets/app-icons/reachy-hacker.webp';
import reachyMonk from '@/assets/app-icons/reachy-monk.webp';
import { FONT_WEIGHT, RADIUS, TYPO } from '@/ui/design/tokens';

import { COLUMN_SX } from './layout';

/**
 * Mix of real `icon.svg` glyphs from published community Spaces (same
 * set the pollen-robotics.com apps gallery shows) and carousel persona
 * stickers, bundled so the very first screen a new user sees never
 * waits on the network. The flattest community glyphs were swapped for
 * personas - the band reads better when every tile has an
 * illustration-grade glyph.
 *
 * The two rows get DISJOINT sets: with a shared set, the
 * counter-scrolling rows periodically drift into alignment and show
 * the same glyph twice in a vertical pair, which reads as a bug.
 * Six tiles per row keeps each looping sequence wider than any phone
 * viewport, so a glyph also never appears twice within its own row.
 */
const MARQUEE_ROW_A: readonly string[] = [
  iconConversation,
  reachyCowboy,
  iconTelepresence,
  reachyMonk,
  iconMorse,
  reachyExplorer,
];

const MARQUEE_ROW_B: readonly string[] = [
  iconCookaiware,
  reachyHacker,
  iconMarionette,
  reachyCaptain,
  iconEmotions,
  reachyFarmer,
];

/** Square plate size + rhythm of the marquee band. */
const MARQUEE_TILE_PX = 76;
const MARQUEE_ICON_PX = 52;
const MARQUEE_GAP_PX = 15;

/**
 * One endlessly-scrolling row of app-icon tiles.
 *
 * The icon sequence is rendered twice inside a single flex track and
 * the track animates between `translateX(0)` and `translateX(-50%)`:
 * because both copies are pixel-identical (each tile carries its own
 * right margin, no `gap` that would break the -50% symmetry), the
 * loop point is invisible. `reverse` plays the same keyframes
 * backwards, so two stacked rows drift in opposite directions from
 * one shared animation.
 */
function MarqueeRow({
  icons,
  reverse,
  durationS = 30,
}: {
  icons: readonly string[];
  reverse?: boolean;
  /** Loop duration - the depth parallax gives each row its own speed. */
  durationS?: number;
}) {
  return (
    <Box
      sx={{
        display: 'flex',
        width: 'max-content',
        animation: `store-intro-marquee ${durationS}s linear infinite${reverse ? ' reverse' : ''}`,
        '@keyframes store-intro-marquee': {
          from: { transform: 'translateX(0)' },
          to: { transform: 'translateX(-50%)' },
        },
        '@media (prefers-reduced-motion: reduce)': {
          animation: 'none',
        },
      }}
    >
      {[0, 1].map(copy =>
        icons.map((src, i) => (
          <Box
            key={`${copy}-${i}`}
            sx={theme => ({
              width: MARQUEE_TILE_PX,
              height: MARQUEE_TILE_PX,
              mr: `${MARQUEE_GAP_PX}px`,
              flexShrink: 0,
              borderRadius: `${RADIUS.md}px`,
              // Solid surface plate: white in light mode, the dark
              // surface in dark mode - keeps the tiles readable over
              // the page background in both themes.
              bgcolor: 'background.paper',
              border: `1px solid ${theme.palette.divider}`,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            })}
          >
            <Box
              component="img"
              src={src}
              alt=""
              sx={{
                width: MARQUEE_ICON_PX,
                height: MARQUEE_ICON_PX,
                objectFit: 'contain',
                display: 'block',
                // No-op for transparent stickers; rounds the corners
                // of glyphs that ship their own opaque background so
                // they read as mini app icons instead of pasted
                // squares.
                borderRadius: '10px',
              }}
            />
          </Box>
        ))
      )}
    </Box>
  );
}

/**
 * Two stacked counter-scrolling rows of app-icon tiles, each with its
 * own disjoint glyph set (see the row constants above). Edges dissolve
 * via a mask gradient so tiles slide in from nothing instead of
 * popping at the viewport border. Decorative only (`aria-hidden`); the
 * animation is dropped entirely under `prefers-reduced-motion`.
 *
 * The 3D treatment is a TILTED DEPTH-PARALLAX SHELF (visionOS-style
 * layering): the whole band leans back (rotateX shelf tilt), and on
 * top of that the two rows live on DIFFERENT PLANES. Three cues sell
 * the depth together:
 *
 *   1. Plane separation: inside one shared `perspective`, the top row
 *      sits BEHIND the screen plane (`translateZ` negative -> smaller)
 *      and the bottom row slightly in front (bigger).
 *   2. Focus: the far row is gently blurred and dimmed, like an
 *      out-of-focus background; the near row stays crisp.
 *   3. Motion parallax: the near row loops noticeably FASTER than the
 *      far one (24s vs 38s) - nearer objects move faster, which is
 *      what makes the eye accept the whole thing as physical space.
 *
 * The 3D lives on an inner wrapper: the outer box keeps the overflow
 * clip and the mask fade screen-aligned, so the edge dissolve stays
 * vertical no matter the transforms, and its vertical padding gives
 * the projected planes room in the clip.
 */
function AppIconsMarquee() {
  // Narrow fade: just softens the hard crop at the viewport edges
  // without eating into the tiles (a wider fade visually shrinks the
  // whole band).
  const fade = 'linear-gradient(90deg, transparent, #000 7%, #000 93%, transparent)';
  return (
    <Box
      aria-hidden
      sx={{
        // Full-bleed: escape the centred column's 24px gutter so the
        // band runs edge-to-edge under the mask fade.
        mx: -3,
        py: 1.5,
        overflow: 'hidden',
        maskImage: fade,
        WebkitMaskImage: fade,
        pointerEvents: 'none',
      }}
    >
      <Box
        sx={{
          display: 'flex',
          flexDirection: 'column',
          // Wider than the tile gap: the projection pulls the far row
          // down towards the front one, so the extra layout gap is
          // what keeps both rows FULLY visible - the near plane must
          // never overlap the far one.
          gap: `${MARQUEE_GAP_PX * 2.6}px`,
          // The leading translateY re-centres the projected band in
          // its layout box - the perspective projection shifts both
          // planes towards the (centre) vanishing point, which reads
          // as dead space above the band otherwise.
          transform: 'translateY(-10px) perspective(1100px) rotateX(22deg) rotateZ(-2deg) scale(1.155)',
          transformStyle: 'preserve-3d',
        }}
      >
        {/* Far plane: pushed behind the screen. The Z offsets are
            sized so the projected rows stay clear of each other (no
            covering) while still reading as two planes. NO blur - the
            depth cue is carried by size, the opacity dim and the
            speed parallax alone (crisper, and cheaper on mobile
            WebViews too). */}
        <Box sx={{ transform: 'translateZ(-48px)', opacity: 0.8 }}>
          <MarqueeRow icons={MARQUEE_ROW_A} durationS={38} />
        </Box>
        {/* Near plane: floats just in front of the screen, crisp, and
            loops faster than the far row (motion parallax). */}
        <Box sx={{ transform: 'translateZ(20px)' }}>
          <MarqueeRow icons={MARQUEE_ROW_B} reverse durationS={24} />
        </Box>
      </Box>
    </Box>
  );
}

interface IntroAction {
  icon: typeof PlayArrowOutlinedIcon;
  title: string;
  body: string;
}

const ACTIONS: readonly IntroAction[] = [
  {
    icon: PlayArrowOutlinedIcon,
    title: 'Try',
    body: 'Run any app on your robot.',
  },
  {
    icon: StarOutlineIcon,
    title: 'Pin',
    body: 'Keep favorites one tap away.',
  },
  {
    icon: FavoriteBorderIcon,
    title: 'Like',
    body: 'Send love to the makers.',
  },
];

export default function StoreIntroOverlay({ onDismiss }: { onDismiss: () => void }) {
  // Two-layer entrance/exit choreography:
  //
  //   IN  - the opaque page-background COVER is there from the very
  //         first frame (it mounts together with the store view
  //         underneath, so any transparency would flash that
  //         half-built view through). Only the CONTENT fades in, with
  //         a short delay that doubles as decode time for the marquee
  //         images - so the intro never pops in with half-loaded
  //         tiles.
  //   OUT - the whole overlay (cover included) fades out on
  //         dismissal, revealing the by-then settled store, and only
  //         unmounts after the transition completes.
  const [closing, setClosing] = useState(false);
  const handleDismiss = () => {
    if (!closing) setClosing(true);
  };
  return (
    <Box
      role="dialog"
      aria-modal="true"
      aria-labelledby="store-intro-title"
      onTransitionEnd={e => {
        if (e.propertyName === 'opacity' && closing) onDismiss();
      }}
      sx={{
        position: 'absolute',
        inset: 0,
        // Above the sticky header bar (zIndex 3) so the intro owns
        // the whole store surface while mounted.
        zIndex: 4,
        bgcolor: 'background.default',
        display: 'flex',
        flexDirection: 'column',
        overflowY: 'auto',
        opacity: closing ? 0 : 1,
        transition: 'opacity 0.25s ease-out',
        pointerEvents: closing ? 'none' : 'auto',
        // Content-only entrance: both direct children (centred block
        // + CTA plate) fade in together over the opaque cover -
        // opacity only, no motion. `backwards` keeps them invisible
        // through the delay.
        '& > *': {
          animation: 'store-intro-content-in 0.45s ease-out 0.15s backwards',
        },
        '@keyframes store-intro-content-in': {
          from: { opacity: 0 },
          to: { opacity: 1 },
        },
        '@media (prefers-reduced-motion: reduce)': {
          '& > *': { animation: 'none' },
        },
      }}
    >
      {/* Middle block: fills the leftover height and centres the
          persona + pitch + legend, while the CTA below stays pinned
          to the overlay's bottom edge. */}
      <Box
        sx={{
          ...COLUMN_SX,
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'center',
          py: 4,
        }}
      >
        {/* Figurehead: a scrolling line of real community app icons -
            shows the catalog's diversity at a glance, which sells the
            store better than a mascot ever did. */}
        <AppIconsMarquee />

        <Typography
          id="store-intro-title"
          sx={{
            mt: 4.5,
            textAlign: 'center',
            fontSize: 24,
            fontWeight: FONT_WEIGHT.bold,
            letterSpacing: '-0.5px',
            lineHeight: 1.2,
            // Balanced wrapping instead of a manual <br>: the browser
            // evens out the two lines whatever the viewport width.
            textWrap: 'balance',
          }}
        >
          Community-made apps, built for your Reachy.
        </Typography>

        {/* The three catalog actions as an iOS-onboarding feature
            list: bare primary glyph + one caption line per action,
            stacked. Glyphs mirror the app tiles (Try play, pin star,
            like heart) so the legend maps 1:1 to what the user will
            tap.

            Deliberately BOX-FREE: earlier iterations put each glyph
            on a tinted square plate, but three squares directly under
            a band of square tiles read as a competing second marquee.
            Plain glyphs + single text lines keep the trio a caption;
            the marquee stays the page's only "tiles" moment. The
            block hugs its content width and centres as a unit, while
            the lines inside stay left-aligned for list rhythm. */}
        <Stack spacing={1.5} useFlexGap sx={{ mt: 4.5, mx: 'auto', width: 'fit-content' }}>
          {ACTIONS.map(({ icon: Icon, title, body }) => (
            <Stack
              key={title}
              direction="row"
              spacing={1.25}
              useFlexGap
              sx={{ alignItems: 'center' }}
            >
              <Icon sx={{ fontSize: 20, color: 'primary.main', flexShrink: 0 }} />
              <Typography sx={{ fontSize: TYPO.sm, lineHeight: 1.4 }}>
                <Box component="span" sx={{ fontWeight: FONT_WEIGHT.semibold }}>
                  {title}
                </Box>
                <Box component="span" sx={{ color: 'text.secondary' }}>
                  {' · '}
                  {body}
                </Box>
              </Typography>
            </Stack>
          ))}
        </Stack>

      </Box>

      {/* CTA plate: pinned to the overlay's bottom edge, outside the
          centred block, iOS onboarding style. No explicit variant:
          inherits the theme's outlined default. */}
      <Box sx={{ ...COLUMN_SX, pb: 3, flexShrink: 0 }}>
        <Button
          fullWidth
          size="large"
          onClick={handleDismiss}
          sx={{
            borderRadius: `${RADIUS.lg}px`,
            fontWeight: FONT_WEIGHT.semibold,
          }}
        >
          Got it
        </Button>
      </Box>
    </Box>
  );
}
