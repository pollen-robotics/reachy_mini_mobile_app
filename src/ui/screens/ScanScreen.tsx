/**
 * Unified discovery screen.
 *
 * Reached only after the auth gate at the App root, so a HF token
 * is always available here. Renders the user's robots that have
 * registered with Hugging Face central signaling (polled with the
 * gate-issued token).
 *
 * Layout (Option C - "compte en haut, robots au centre")
 * ──────────────────────────────────────────────────────
 *   ┌──────────────────────────────────────────┐
 *   │  [◉ tfrere  · Sign out]            [?]   │  ← HfAccountBar (top)
 *   │  ────────────────────────────────────────│
 *   │                                          │
 *   │              ╭──╮                        │
 *   │             (·_·)    ← reachy-buste     │
 *   │             /│  │\      hero illu        │
 *   │                                          │
 *   │          Your Reachies   [ ↻ ]           │  ← refresh (right of title)
 *   │       N online · tap to connect          │
 *   │   ┌────────────────────────────────┐     │
 *   │   │ [reachy]  ● Name               │     │
 *   │   │           Wi-Fi  · #ab12    >  │     │
 *   │   └────────────────────────────────┘     │   ← scrollable
 *   │   ┌────────────────────────────────┐     │
 *   │   │ [reachy]  ● Other              │     │
 *   │   │           Wi-Fi  · #cd34    >  │     │
 *   │   └────────────────────────────────┘     │
 *   │                                          │
 *   │  ────────────────────────────────────────│
 *   │         +  Set up a new Reachy           │  ← sticky bottom bar
 *   └──────────────────────────────────────────┘
 *
 *   - HF account bar: avatar + username + Sign out grouped on
 *     the left as ONE auth block (so "what account am I signed
 *     in as?" and "how do I leave?" are physically adjacent).
 *     The Help (?) button sits alone on the right, away from the
 *     auth cluster - it's not an account-level action. A bottom
 *     divider anchors the bar so when the Help overlay opens
 *     below, the topbar reads as the persistent chrome.
 *   - Help overlay: mounted in the same idiom as the session
 *     `RobotInfoPanel` - a `position: fixed` overlay pinned BELOW
 *     the topbar, covering body + sticky refresh bar but NOT the
 *     topbar itself. The Help (?) glyph swaps to (✕) while the
 *     overlay is open, so a second tap in the same spot dismisses
 *     it. We deliberately moved away from the earlier bottom-sheet
 *     `Drawer` so the user keeps eye contact with the auth block
 *     (and the close affordance) while reading the support panel.
 *   - Hero illustration: the reachy-buste from the splash, 95%
 *     opaque, gives the screen a brand identity beyond the cards.
 *   - Refresh indicator: a discreet, non-interactive spinner to the
 *     RIGHT of the "Your Reachies" title. NOT a button - the list
 *     refreshes on its own (realtime SSE + a 60 s safety-net poll),
 *     so this is pure feedback: it shows ONLY while a fetch is in
 *     flight (with a minimum-visible floor so a fast fetch isn't
 *     clipped) and is absent otherwise.
 *   - Add a Reachy: a single borderless, labelled CTA pinned at
 *     the bottom (with safe-area inset), out of the scrollable
 *     area so the entry point to BLE setup is always one tap
 *     away regardless of how many robots are listed.
 *   - Empty / error states: the list area collapses to a
 *     centred message (the hero illu still sits at the top); the
 *     auto-poll / SSE keep retrying on their own.
 *
 * Parked surfaces
 * ───────────────
 * Earlier revisions also exposed a "Local USB" section (loopback
 * daemon probe). It is intentionally NOT rendered in the mobile
 * shell right now - the focus is the Central listing path.
 */

import { useEffect, useRef, useState } from 'react';
import {
  alpha,
  Avatar,
  Box,
  Button,
  CircularProgress,
  IconButton,
  keyframes,
  List,
  ListItemButton,
  Stack,
  Tooltip,
  Typography,
} from '@mui/material';
import AccountCircleIcon from '@mui/icons-material/AccountCircle';
import AddIcon from '@mui/icons-material/Add';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import CloseIcon from '@mui/icons-material/Close';
import HelpOutlineIcon from '@mui/icons-material/HelpOutlineOutlined';
import LockIcon from '@mui/icons-material/Lock';
import LogoutIcon from '@mui/icons-material/Logout';
import RefreshIcon from '@mui/icons-material/Refresh';

import reachyBusteSvg from '@/assets/reachy-buste.svg';
import RobotAvatar from '@/ui/design/RobotAvatar';
import {
  extractRobotActiveApp,
  extractRobotBusy,
  extractRobotHardwareId,
  extractRobotId,
  extractRobotName,
  extractRobotTransport,
  type CentralRobotEntry,
} from '@/features/auth/fetchRobotsFromCentral';
import { useHfProfile } from '@/features/auth/useHfProfile';
import { useRemoteRobots } from '@/features/auth/useRemoteRobots';
import { VariantTag } from '@/ui/design/MetaPill';
import { FONT_WEIGHT, LAYOUT, TYPO } from '@/ui/design/tokens';
import HelpAndSupportOverlay from './scan/HelpAndSupportOverlay';
import FirstReachyInvite from './scan/FirstReachyInvite';

interface ScanScreenProps {
  onRemotePicked: (robot: CentralRobotEntry) => void;
  /** Open the first-time setup wizard (BLE Wi-Fi provisioning). */
  onStartSetup: () => void;
  /** Open the standalone "update over Bluetooth" maintenance tool. */
  onOpenBleUpdate: () => void;
  onSignOutRemote: () => void;
  /**
   * HF token is guaranteed to be present here (the App-level auth
   * gate renders RemoteSignInScreen otherwise). We still pass it
   * through so the remote section can display the username and
   * forward it to `useRemoteRobots`.
   */
  token: string;
  username: string | null;
}

export default function ScanScreen({
  onRemotePicked,
  onStartSetup,
  onOpenBleUpdate,
  onSignOutRemote,
  token,
  username,
}: ScanScreenProps) {
  // Poll cadence is the safety net for the SSE listener now that
  // central pushes busy/free transitions in real time. Letting the
  // hook own the default keeps the cadence consistent across the
  // whole app.
  const remote = useRemoteRobots(token);
  // Pull the avatar URL (and a freshly-confirmed username) from
  // /api/whoami-v2. Falls back gracefully to the gate-issued
  // username + initial-letter avatar while the request is in
  // flight or if it fails - the top bar always renders.
  const profile = useHfProfile(token);
  const displayName = profile.username ?? username;
  const robots = remote.state.kind !== 'no-token' ? remote.state.robots : [];
  const hasRobots = robots.length > 0;
  // "Loaded, but zero robots linked" → show the dedicated onboarding
  // invitation (a prominent CTA to register a first Reachy) instead of
  // the terse empty card. Loading / error keep their own states. When the
  // invite is up we hide the sticky bottom bar so the screen shows a
  // single, unambiguous call to action rather than two identical buttons.
  const showEmptyInvite =
    !hasRobots && remote.state.kind !== 'loading' && remote.state.kind !== 'error';
  // Initial fetch with no robots yet: the whole screen collapses to a single
  // centered spinner (no hero illustration, no "Your Reachies" header, no
  // sticky add bar) so the first paint is quiet while we wait on central -
  // matching the lightweight loading treatment used elsewhere in the app.
  const isInitialLoading = !hasRobots && remote.state.kind === 'loading';
  // Fleet-listing chrome (hero + header) only makes sense once there's a list
  // to head, or on the error state that keeps its message in place. The
  // loading and empty-invite states are deliberately chrome-free.
  const showListChrome = hasRobots || remote.state.kind === 'error';
  // The refresh icon spins for ANY in-flight fetch (initial load
  // included). Both the refresh icon (right of the list) and the
  // bottom add bar stay mounted in every state: conditionally
  // hiding either used to make the body shift vertically the
  // moment central returned the list, because they change the
  // available height for the `m: 'auto'` centring trick above, so
  // the content jumps. Keeping them permanently mounted (the icon
  // just spinning while a fetch is pending) keeps the layout
  // dimensions stable across every state (loading → empty → 1
  // robot → N robots → error).
  const isRefreshing = remote.state.kind === 'loading';

  // Help & Support overlay is the contact-information surface
  // required by Apple guideline 1.2 (UGC) and Google Play's UGC
  // policy. It's hosted from this screen because `ScanScreen` is
  // the lobby the user lands on every time the app boots (no
  // in-flight session to disrupt), and because the `HfAccountBar`
  // up here is the natural anchor for settings / contact entries.
  // The state lives here (not inside the bar) so the topbar can
  // mirror the overlay's open state (icon swap `?` -> `✕`) and
  // the host can mount the overlay as a `position: fixed` sibling
  // below the bar, same idiom as `RobotInfoPanel` in the session
  // screen.
  const [helpOpen, setHelpOpen] = useState(false);
  const toggleHelp = () => setHelpOpen(open => !open);
  const closeHelp = () => setHelpOpen(false);

  return (
    <Stack
      sx={{
        height: '100%',
        width: '100%',
        bgcolor: 'background.default',
        position: 'relative',
      }}
    >
      <HfAccountBar
        username={displayName}
        avatarUrl={profile.avatarUrl}
        onSignOut={onSignOutRemote}
        onToggleHelp={toggleHelp}
        isHelpOpen={helpOpen}
      />
      {/* Inner scroll container. `m: 'auto'` on the column distributes
          free space equally on all four sides → fully centred (both
          axes) when the cards fit within the viewport, and falls back
          to top-aligned scrolling when they don't (the `auto` margins
          collapse to zero once the content overflows, and the parent's
          `overflowY` then takes over). */}
      <Stack
        sx={{
          flex: 1,
          minHeight: 0,
          width: '100%',
          overflowY: 'auto',
        }}
      >
        <Stack
          spacing={3}
          sx={{
            m: 'auto',
            width: '100%',
            maxWidth: LAYOUT.contentMaxWidth,
            px: 3,
            py: 4,
          }}
        >
          {/* Hero illustration + "Your Reachies" header are the
              fleet-listing chrome. They only show once there's a list to
              head (has-robots) or on the error state; the loading and
              empty-invite states are chrome-free so each reads as a single,
              dedicated view (a quiet spinner, then the onboarding invite). */}
          {showListChrome && (
            <Stack
              spacing={2}
              sx={{
                alignItems: 'center',
              }}
            >
              <HeroBuste />
              <RobotsHeader
                state={remote.state.kind}
                count={robots.length}
                hasRobots={hasRobots}
                isRefreshing={isRefreshing}
              />
            </Stack>
          )}

          {hasRobots ? (
            <List
              disablePadding
              sx={{
                width: '100%',
                display: 'flex',
                flexDirection: 'column',
                // Doubled from the previous 1.25 (10 px) to give
                // each Reachy card more breathing room - the
                // earlier tighter rhythm made the list read as a
                // dense settings menu rather than a small fleet
                // of distinct devices.
                gap: 2.5,
              }}
            >
              {robots.map((robot: CentralRobotEntry) => {
                const id = extractRobotId(robot);
                // Gate the tap on `busy` as well as `!id`: a busy
                // robot would just round-trip to a `sessionRejected`
                // error after the user spent ~3 s on the connecting
                // overlay. Surfacing it BEFORE the tap is a better
                // user experience than reactively explaining the
                // failure. Pre-feature centrals don't emit `busy`,
                // so `extractRobotBusy()` defaults to `false` and
                // the row stays tappable on legacy deploys.
                const busy = extractRobotBusy(robot);
                return (
                  <RemoteRobotCard
                    key={id ?? Math.random()}
                    robot={robot}
                    disabled={!id || busy}
                    onTap={() => onRemotePicked(robot)}
                  />
                );
              })}
            </List>
          ) : isInitialLoading ? (
            <Box
              sx={{
                width: '100%',
                display: 'flex',
                justifyContent: 'center',
                py: 6,
              }}
            >
              <CircularProgress thickness={2.5} sx={{ color: theme => alpha(theme.palette.text.primary, 0.3) }} />
            </Box>
          ) : remote.state.kind === 'error' ? (
            <CenteredMessageState
              title="Couldn't reach Hugging Face"
              subtitle={remote.state.reason}
            />
          ) : (
            <FirstReachyInvite onStartSetup={onStartSetup} />
          )}
        </Stack>
      </Stack>
      {/* Sticky bottom action bar. Sits outside the scrollable area
          so the single "set up a new Reachy" entry point stays one
          tap away regardless of how many robots are listed (and in
          every state - empty / error included). Always mounted, so
          the available height of the centred content above never
          changes. */}
      {!showEmptyInvite && !isInitialLoading && <StickyAddBar onStartSetup={onStartSetup} />}
      {/* App-Store-1.2 compliance: Help & Support overlay reachable
          from the HfAccountBar's "?" button, providing Apple- and
          Google-mandated contact channels for UGC-bearing apps.
          Mounted as a `position: fixed` overlay pinned BELOW the
          `HfAccountBar` so the topbar (avatar + username + Sign
          out + the help-icon-turned-cross) stays visible while
          the overlay is up. Same idiom as `RobotInfoPanel` in
          the session screen.
            - `top: max(64px, safe-area + 64px)` matches the
              total height of the `HfAccountBar`:
                safe-area-top + 12 (pt) + 38 (avatar) + 12 (pb)
                + 1 (divider) ≈ safe-area + 63 px on iPhones,
                64 px on no-notch platforms.
            - zIndex 1200 keeps the overlay above the body /
              sticky refresh bar but below any future
              full-screen transition layer (1300+). */}
      {helpOpen && (
        <Box
          sx={{
            position: 'fixed',
            top: 'max(64px, calc(env(safe-area-inset-top, 0px) + 64px))',
            left: 0,
            right: 0,
            bottom: 0,
            zIndex: 1200,
          }}
        >
          <HelpAndSupportOverlay
            onClose={closeHelp}
            onStartBleUpdate={() => {
              closeHelp();
              onOpenBleUpdate();
            }}
          />
        </Box>
      )}
    </Stack>
  );
}

/* --- HF account top bar --------------------------------------------- */

/**
 * Top bar.
 *
 * Two clusters separated by a flex gap so the user reads "auth"
 * on the left and "support" on the right:
 *
 *   ┌──────────────────────────────────────────────────────┐
 *   │       SIGNED IN AS                                   │
 *   │ [◉]  @tfrere               [ ⎋ ]              [ ? ]  │
 *   │ ────────────────────────────────────────────────────│
 *   └──────────────────────────────────────────────────────┘
 *
 * Left "auth cluster"
 * ───────────────────
 * Avatar + a two-line identity column ("Signed in as" kicker +
 * `@username`) + a sign-out icon, all sitting flush on the topbar
 * with NO surrounding pill / card chrome - on a bar this small a
 * nested rounded container just adds visual noise. Grouping is
 * carried by simple proximity (everything on the same row at
 * `spacing={1}`).
 *
 * The kicker frames the row below as the account name in one
 * glance - without it the cluster reads as just "@tfrere [⎋]"
 * and new users have to infer the meaning from the avatar alone.
 *
 * The sign-out icon is a borderless `IconButton`; primary tint
 * on the glyph is the only colour cue that this is the
 * actionable element. Significantly lighter than the earlier
 * outlined-primary `[Sign out]` button while keeping the logout
 * affordance visible AND unambiguous: it lives RIGHT next to the
 * identity it terminates, so it can't be misread as "disconnect
 * from the robot list" like the old toolbar icon could.
 *
 * Right "support" slot
 * ────────────────────
 * Single `?` icon, on its own (no container). The visual contrast
 * between the contained left pill and the free-floating right
 * icon helps the two clusters read as different categories of
 * action (account vs help). The icon toggles the
 * `HelpAndSupportOverlay` and swaps to `✕` while the overlay is
 * open, matching the session screen's info-button idiom: same
 * slot for open AND close.
 *
 * Bottom divider
 * ──────────────
 * Conditional hairline: only visible while the help overlay is
 * open. The closed-state topbar already sits on the same
 * `background.default` as the body below it, so the divider
 * would just add visual noise without serving any anchoring
 * role. When the overlay opens, however, its matte body would
 * otherwise melt into the topbar - the hairline fades in to
 * reinforce the "the help panel is a layer on top of the lobby"
 * mental model. The border slot stays in the box model at all
 * times (transparent ↔ divider colour) so toggling help never
 * shifts the topbar's height nor the overlay's `top` offset.
 */
function HfAccountBar({
  username,
  avatarUrl,
  onSignOut,
  onToggleHelp,
  isHelpOpen,
}: {
  username: string | null;
  avatarUrl: string | null;
  onSignOut: () => void;
  onToggleHelp: () => void;
  /**
   * Mirror of the host's `helpOpen` state. Drives the icon swap
   * (`?` -> `✕`) and the aria-label so the same button reads as
   * "Open" when closed and "Close" when open.
   */
  isHelpOpen: boolean;
}) {
  // First letter of the username for the fallback avatar (used
  // while the whoami-v2 request is in flight, when the user has
  // no profile picture set, or if the avatar URL fails to load).
  const initial = (username ?? '').slice(0, 1).toUpperCase() || null;
  return (
    <Stack
      direction="row"
      spacing={1.5}
      sx={{
        alignItems: 'center',
        justifyContent: 'space-between',
        width: '100%',
        pt: `calc(${LAYOUT.safeAreaTop} + 12px)`,
        pb: 1.5,
        px: 2,
        bgcolor: 'background.default',

        // 1 px hairline always present (transparent when the help
        // overlay is closed, divider colour when it's open). Kept
        // in the box model at all times so the topbar's height -
        // and therefore the overlay's `top` offset - never shifts
        // when help is toggled. Only the colour transitions.
        borderBottom: theme => `1px solid ${isHelpOpen ? theme.palette.divider : 'transparent'}`,

        transition: theme =>
          theme.transitions.create('border-bottom-color', {
            duration: theme.transitions.duration.shortest,
          }),

        // Stay above the help overlay so the topbar remains the
        // persistent chrome the user closes the overlay from. The
        // overlay's zIndex is 1200; we sit just above.
        position: 'relative',

        zIndex: 1201,
      }}
    >
      {/* Auth cluster. Sits flush on the topbar with no surrounding
          card / pill chrome: the topbar itself is already the
          container, and a nested pill on a bar this small read as
          visual noise. The grouping is now carried by simple
          proximity (avatar + identity column + sign-out icon all
          on the same row at `spacing={1}`). */}
      <Stack
        direction="row"
        spacing={1}
        sx={{
          alignItems: 'center',
          minWidth: 0,
          flexShrink: 1,
        }}
      >
        <Avatar
          src={avatarUrl ?? undefined}
          alt={username ?? 'Hugging Face user'}
          sx={{
            width: 32,
            height: 32,
            flexShrink: 0,
            fontSize: TYPO.sm,
            fontWeight: FONT_WEIGHT.semibold,
            bgcolor: theme =>
              theme.palette.mode === 'dark' ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)',
            color: 'text.secondary',
          }}
        >
          {initial ?? <AccountCircleIcon sx={{ color: 'text.secondary', fontSize: 24 }} />}
        </Avatar>
        {/* Two-line identity column inside the pill.
            Row 1 is the "Signed in as" label, styled exactly
            like every other label in the app (cf. `Section`'s
            header: TYPO.tiny, semibold, secondary, uppercase,
            letterSpacing 0.6 px). Aligning on this canonical
            label style means the eye reads the kicker as "this
            is a label, not content" without any extra cognitive
            tax. Row 2 carries the `@handle` itself - same `@`
            prefix convention as `RobotInfoPanel`'s "Signed in"
            row. Tight `lineHeight` on both lines keeps the
            column compact enough to fit the pill's vertical
            rhythm without bloating the topbar. */}
        <Stack spacing={0} sx={{ minWidth: 0, flexShrink: 1, pr: 0.5 }}>
          <Typography
            sx={{
              // `nano` is the floor of the type scale, reserved
              // for kicker labels living INSIDE a chip / pill.
              // `Section`'s canonical free-standing header label
              // uses `tiny` (0.7rem), one step smaller is `micro`
              // (0.65rem), and `nano` (0.6rem) is the dedicated
              // size for "label that subtitles a single line of
              // content inside an already-bounded container."
              // Anything bigger here visually competes with the
              // `@handle` instead of framing it.
              fontSize: TYPO.nano,
              fontWeight: FONT_WEIGHT.semibold,
              color: 'text.secondary',
              letterSpacing: '0.5px',
              textTransform: 'uppercase',
              lineHeight: 1.2,
            }}
            noWrap
          >
            Signed in as
          </Typography>
          <Typography
            sx={{
              fontSize: TYPO.sm,
              fontWeight: FONT_WEIGHT.semibold,
              color: 'text.primary',
              lineHeight: 1.2,
            }}
            noWrap
          >
            {username ? `@${username}` : 'Hugging Face'}
          </Typography>
        </Stack>
        {/* Sign-out icon. Lives INSIDE the auth pill so the
            affordance is unambiguous - "leave THIS account."
            Compact IconButton, no border, no label, no extra
            visual weight. The primary tint on the glyph is the
            only colour cue that this is an actionable item. No
            tooltip on mobile (touch users would need to long-
            press to surface it, which nobody discovers); the
            `aria-label` still feeds screen readers. */}
        <IconButton
          aria-label="Sign out of Hugging Face"
          onClick={onSignOut}
          size="small"
          color="primary"
          sx={{
            flexShrink: 0,
            p: 0.5,
          }}
        >
          <LogoutIcon sx={{ fontSize: 18 }} />
        </IconButton>
      </Stack>
      {/* Help (?) / close (✕) toggle. Free-floating on the right,
          deliberately NOT wrapped in a pill so it reads as a
          different category of action (support, not account).
          No tooltip - the glyph is universal and the dynamic icon
          swap on open (`?` → `✕`) already telegraphs the state
          change. `aria-label` carries the wording for screen
          readers.
          ────────────────
          Pattern mirrors the session screen's info / close
          toggle (cf. `RobotSessionScreen`): the "open" state
          uses the *outlined ringed* glyph that has the circle
          baked into the SVG itself (`HelpOutline` here,
          `InfoOutlined` there), and the "close" state uses the
          bare `Close` glyph (no ring). Same `fontSize: 22` on
          both glyphs keeps the box footprint identical between
          states, so the only visual delta on toggle is the ring
          fading in / out alongside the `?` ↔ `✕` swap - no
          width / height jump. */}
      <IconButton
        aria-label={isHelpOpen ? 'Close help and support' : 'Open help and support'}
        onClick={onToggleHelp}
        color="primary"
        sx={{ p: 1, flexShrink: 0 }}
      >
        {isHelpOpen ? (
          <CloseIcon sx={{ fontSize: 22 }} />
        ) : (
          <HelpOutlineIcon sx={{ fontSize: 22 }} />
        )}
      </IconButton>
    </Stack>
  );
}

/* --- Hero illustration (reachy-buste) ------------------------------- */

/**
 * Branded hero displayed above the title.
 *
 * Uses the same `reachy-buste` SVG as the splash, sized down to
 * 120px so it never dominates the cards underneath. Static
 * (no float animation) - the screen is a destination, not a
 * loading transition.
 */
function HeroBuste() {
  return (
    <Box
      sx={{
        width: 144,
        height: 144,
        flexShrink: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <img
        src={reachyBusteSvg}
        alt=""
        aria-hidden
        style={{
          width: '100%',
          height: '100%',
          objectFit: 'contain',
          userSelect: 'none',
          pointerEvents: 'none',
        }}
      />
    </Box>
  );
}

/* --- Refresh activity indicator ------------------------------------- */

// Floor we keep the indicator on screen once a refresh starts, so an
// instant (cached) fetch still shows a complete, smooth turn instead
// of a one-frame flash that reads as "cut off".
const MIN_VISIBLE_MS = 900;

// Trailing debounce: a single logical refresh often fires two fetches
// back-to-back (the poll/refetch plus an SSE-driven invalidation), so
// `isRefreshing` flips true→false→true. We hold the spinner for this
// long after activity STOPS; any follow-up fetch within the window
// re-arms it, coalescing the burst into one continuous spinner
// instead of two flashes.
const TAIL_DEBOUNCE_MS = 600;

// Single clean linear turn for the arrows glyph. The icon only exists
// while visible, so the loop runs uninterrupted for its whole lifetime
// and unmounts cleanly - no mid-rotation snap.
const refreshSpinKeyframes = keyframes`
  from {
    transform: rotate(0deg);
  }
  to {
    transform: rotate(360deg);
  }
`;

/**
 * Discreet, non-interactive refresh indicator sitting to the right of
 * the title. NOT a button: there's nothing to tap. The list refreshes
 * on its own (realtime SSE push + a 60 s safety-net poll), so this is
 * pure feedback - it shows the slowly-spinning refresh arrows ONLY
 * while refresh activity is happening and is absent otherwise.
 *
 * Two timers shape the lifetime: a minimum visibility floor
 * (`MIN_VISIBLE_MS`) so a fast fetch isn't clipped, and a trailing
 * debounce (`TAIL_DEBOUNCE_MS`) that merges the back-to-back fetch
 * bursts of one refresh into a single spin. It lives in a fixed-width
 * slot so the title stays optically centered whether or not the
 * indicator is showing (no layout shift).
 */
// Opacity cross-fade applied on enter / leave so the glyph eases in
// and out instead of popping. The icon stays mounted (still spinning)
// through the fade-out, then unmounts once it's fully transparent.
const FADE_MS = 320;
const REST_OPACITY = 0.32;

function RefreshIndicator({ isRefreshing }: { isRefreshing: boolean }) {
  const [visible, setVisible] = useState(false);
  const startedAtRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (isRefreshing) {
      // Activity (re)started: cancel any pending hide so a follow-up
      // fetch keeps the existing spinner alive rather than spawning a
      // second one.
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      if (!visible) {
        startedAtRef.current = Date.now();
        setVisible(true);
      }
    } else if (visible && !timerRef.current) {
      // Activity stopped: hide once BOTH the min-visible floor and the
      // trailing debounce have elapsed, whichever is longer.
      const sinceStart = Date.now() - startedAtRef.current;
      const delay = Math.max(MIN_VISIBLE_MS - sinceStart, TAIL_DEBOUNCE_MS);
      timerRef.current = setTimeout(() => {
        setVisible(false);
        timerRef.current = null;
      }, delay);
    }
  }, [isRefreshing, visible]);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  // Fade layer: `mounted` keeps the glyph in the DOM through its
  // fade-out, `shown` drives the opacity target. Toggling `shown` one
  // frame after mount lets the CSS transition animate the enter.
  const [mounted, setMounted] = useState(false);
  const [shown, setShown] = useState(false);
  const fadeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (fadeTimerRef.current) {
      clearTimeout(fadeTimerRef.current);
      fadeTimerRef.current = null;
    }
    if (visible) {
      setMounted(true);
      const id = requestAnimationFrame(() => setShown(true));
      return () => cancelAnimationFrame(id);
    }
    setShown(false);
    fadeTimerRef.current = setTimeout(() => setMounted(false), FADE_MS);
    return () => {
      if (fadeTimerRef.current) clearTimeout(fadeTimerRef.current);
    };
  }, [visible]);

  return (
    <Box
      sx={{
        width: 40,
        flexShrink: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
      aria-hidden={!visible}
    >
      {mounted && (
        <RefreshIcon
          aria-label="Refreshing robot list"
          sx={{
            fontSize: 22,
            color: 'text.disabled',
            opacity: shown ? REST_OPACITY : 0,
            transition: `opacity ${FADE_MS}ms ease`,
            transformOrigin: 'center',
            animation: `${refreshSpinKeyframes} 1.4s linear infinite`,
          }}
        />
      )}
    </Box>
  );
}

/* --- Sticky bottom add bar ------------------------------------------ */

/**
 * Single entry point to BLE Wi-Fi setup, pinned at the bottom.
 *
 * Borderless text button with an explicit label (not a bare `+`): on
 * a lobby screen the action "add a robot to my account" deserves a
 * legible CTA, and the borderless treatment keeps it from competing
 * with the robot cards above. Always mounted (in every state) so the
 * centred body never changes height and the entry stays one tap away.
 */
function StickyAddBar({ onStartSetup }: { onStartSetup: () => void }) {
  return (
    <Stack
      sx={{
        alignItems: 'center',
        width: '100%',
        flexShrink: 0,
        pt: 1.5,
        pb: `calc(${LAYOUT.safeAreaBottom} + 12px)`,
        px: 2,
        bgcolor: 'background.default',
      }}
    >
      <Button
        variant="text"
        color="primary"
        onClick={onStartSetup}
        startIcon={<AddIcon sx={{ fontSize: 22 }} />}
        sx={{
          textTransform: 'none',
          fontSize: TYPO.md,
          fontWeight: FONT_WEIGHT.semibold,
          borderRadius: 999,
          px: 3,
          py: 1,
        }}
      >
        Set up a new Reachy
      </Button>
    </Stack>
  );
}

/* --- Section header (title + live count) ---------------------------- */

function RobotsHeader({
  state,
  count,
  hasRobots,
  isRefreshing,
}: {
  state: ReturnType<typeof useRemoteRobots>['state']['kind'];
  count: number;
  hasRobots: boolean;
  isRefreshing: boolean;
}) {
  const subtitle = (() => {
    if (!hasRobots && state === 'loading') return 'Looking for your Reachies…';
    if (!hasRobots && state === 'error') return 'Connection lost - retrying';
    if (!hasRobots) return 'None linked to your Hugging Face account are online';
    if (count === 1) return '1 online · linked to your Hugging Face account';
    return `${count} online · linked to your Hugging Face account`;
  })();

  return (
    <Stack
      spacing={0.5}
      sx={{
        alignItems: 'center',
        width: '100%',
      }}
    >
      {/* Title row. The title sits centered, flanked by two equal
          fixed-width slots: a mirror spacer on the left and the
          discreet refresh indicator slot on the right. Because both
          slots keep their width whether or not the spinner shows, the
          title stays optically centred with no layout shift when a
          refresh starts or ends. The "set up a new Reachy" entry
          point lives separately in the sticky bottom bar. */}
      <Box
        sx={{
          width: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 1,
        }}
      >
        {/* Left spacer mirrors the indicator slot's footprint so the
            title stays centered on the screen. */}
        <Box sx={{ width: 40, flexShrink: 0 }} aria-hidden />
        <Typography
          component="h1"
          sx={{
            m: 0,
            textAlign: 'center',
            fontSize: TYPO.display,
            fontWeight: FONT_WEIGHT.semibold,
            color: 'text.primary',
            letterSpacing: '-0.3px',
          }}
        >
          Your Reachies
        </Typography>
        <RefreshIndicator isRefreshing={isRefreshing} />
      </Box>
      <Typography
        sx={{
          fontSize: TYPO.sm,
          color: 'text.secondary',
          textAlign: 'center',
          // Reserve enough vertical space for the longest
          // subtitle wrap (two lines on narrow phone widths,
          // e.g. "None linked to your Hugging Face account are
          // online"). Shorter strings just sit on a single line
          // inside the reserved box. Without this, the header
          // would visibly grow/shrink as the user transitions
          // between states (loading → empty → has robots), and
          // the body slot below would jitter accordingly.
          lineHeight: 1.5,
          minHeight: '3em',
        }}
      >
        {subtitle}
      </Typography>
    </Stack>
  );
}

/* --- Robot card ----------------------------------------------------- */

function RemoteRobotCard({
  robot,
  disabled,
  onTap,
}: {
  robot: CentralRobotEntry;
  disabled: boolean;
  onTap: () => void;
}) {
  const id = extractRobotId(robot);
  const transport = extractRobotTransport(robot);
  const hardwareId = extractRobotHardwareId(robot);
  const idTag = (hardwareId ?? id ?? '').slice(0, 5);
  const idLabel = idTag ? `#${idTag}` : '—';
  // Central reports an active session in flight on this producer.
  // We gate `disabled` on this from the parent and surface the
  // state on-card here so the user knows BEFORE tapping that the
  // session would be rejected. `activeApp` is best-effort and may
  // be null if the consumer never advertised a meta.name.
  const busy = extractRobotBusy(robot);
  const activeApp = extractRobotActiveApp(robot);

  return (
    <ListItemButton
      disabled={disabled}
      onClick={onTap}
      sx={{
        p: 2,
        pr: 2.5,
        // Pin the row height to the same value the loading /
        // empty / error state cards use, so the "your Reachies"
        // body slot doesn't snap to a different height as the
        // user transitions between states (loading → 1 robot →
        // 0 robots → error). The 72 px avatar would already
        // give us ~104 px naturally, but stating it explicitly
        // here keeps the contract visible if anyone tweaks
        // `<CardAvatar />` later.
        minHeight: STATE_CARD_MIN_HEIGHT,
        borderRadius: '14px',
        bgcolor: 'background.paper',
        // Light, neutral border + soft shadow. The card reads as a
        // discreet container; the call-to-action signal moves to
        // the trailing primary-coloured chevron, which is what
        // mobile users actually scan when looking for "tap here to
        // enter". Earlier saturated-primary border made every card
        // shout for attention even before the user picked one.
        border: theme => `1px solid ${theme.palette.divider}`,
        boxShadow: theme =>
          theme.palette.mode === 'dark'
            ? '0 1px 0 rgba(255,255,255,0.04) inset, 0 2px 6px rgba(0,0,0,0.35)'
            : '0 1px 0 rgba(255,255,255,0.6) inset, 0 1px 2px rgba(15,23,42,0.04), 0 2px 6px rgba(15,23,42,0.05)',
        transition: theme =>
          theme.transitions.create(['transform'], {
            duration: theme.transitions.duration.shortest,
          }),
        // No hover override: mobile-first; the press feedback
        // (`scale(0.99)` on `:active`) is what users expect.
        '&:hover': {
          bgcolor: 'background.paper',
        },
        '&:active': {
          transform: 'scale(0.99)',
        },
      }}
    >
      <Stack
        direction="row"
        spacing={2}
        sx={{
          alignItems: 'center',
          width: '100%',
        }}
      >
        <CardAvatar />
        {/* Two-row identity grid, both rows left-aligned hugging
            the avatar. Mirrors the post-connect `<IdentityChipBar>`
            so a user who picked a robot keeps recognising the same
            visual taxonomy in the toolbar afterwards. The version
            cell from the toolbar is omitted here: we don't have a
            DataChannel before the user picks the robot, so
            `daemonVersion` is always unknown at this stage. */}
        <Stack sx={{ flex: 1, minWidth: 0 }} spacing={0.25}>
          <Stack
            direction="row"
            spacing={1}
            sx={{
              alignItems: 'center',
              minWidth: 0,
            }}
          >
            <Typography
              sx={{
                minWidth: 0,
                fontSize: TYPO.lg,
                fontWeight: FONT_WEIGHT.bold,
                color: 'text.primary',
                letterSpacing: '-0.1px',
                lineHeight: 1.2,
                flexShrink: 1,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
              noWrap
            >
              {extractRobotName(robot)}
            </Typography>
            <Box sx={{ flexShrink: 0 }}>
              <VariantTag transport={transport} />
            </Box>
          </Stack>
          <Typography
            component="span"
            title="Hardware id"
            sx={{
              fontSize: TYPO.xs,
              fontFamily: 'monospace',
              color: theme =>
                theme.palette.mode === 'dark' ? 'rgba(255,255,255,0.40)' : 'rgba(0,0,0,0.36)',
              whiteSpace: 'nowrap',
            }}
          >
            {idLabel}
          </Typography>
        </Stack>
        {/* Trailing affordance: chevron when the row is tappable,
            lock when the robot already has an active session on the
            central. The icon swap is the *only* on-card busy signal -
            no extra row, no chip - so the layout stays calm and the
            disabled fade carries the rest of the meaning. The lock
            tooltip surfaces `activeApp` when the consumer
            advertised a meta.name, so a curious user can still read
            "who's holding it" without us blowing up the card height
            with a chip. */}
        {busy ? (
          <Tooltip title={activeApp ? `In use · ${activeApp}` : 'In use'} placement="left">
            <LockIcon
              aria-label={activeApp ? `In use - ${activeApp}` : 'In use'}
              sx={{
                color: 'text.disabled',
                flexShrink: 0,
                fontSize: 20,
              }}
            />
          </Tooltip>
        ) : (
          <ChevronRightIcon
            sx={{
              color: 'primary.main',
              flexShrink: 0,
              fontSize: 22,
            }}
          />
        )}
      </Stack>
    </ListItemButton>
  );
}

/**
 * Card-sized avatar for a discovery row. Pins the discovery-card
 * sizing in one place. (Personas live on the robot now, so the phone
 * no longer dresses robots up with a remembered persona face.)
 */
function CardAvatar() {
  return <RobotAvatar size={72} />;
}

/* --- States: loading / empty / error ---------------------------------- */

/**
 * Shared minimum height for every "single-card" state (loading,
 * empty, error). Tuned to match the natural height of a populated
 * `RemoteRobotCard`: the 72×72 avatar + `p: 2` padding (16 px on
 * each side) → 72 + 32 = 104 px.
 *
 * Pinning every state card to the same height keeps the layout
 * dimensions stable as the user transitions between "loading →
 * empty → 1 robot → N robots": the body slot under the
 * `RobotsHeader` never resizes, so the hero illustration and the
 * sticky refresh bar stay in the same place. Without this, the
 * spinner (~32 px tall) would visibly snap to the much taller
 * robot card the moment central returns the list.
 */
const STATE_CARD_MIN_HEIGHT = 104;

/**
 * Shared card chrome for the loading / empty / error states.
 *
 * Mirrors the surface used by `RemoteRobotCard` (paper bg,
 * theme divider border, the same dual inset + drop shadow) so
 * the three states form a coherent visual family with the
 * actual robot rows below them. Centred content (both axes) so
 * the spinner and the empty-state copy sit visually balanced
 * within the 104 px box.
 *
 * Co-localised with `LoadingState` + `CenteredMessageState`
 * rather than hoisted to a design tokens module because the
 * sizing is intentionally married to the local RemoteRobotCard
 * geometry above - changing one without the other would re-
 * introduce the layout jitter this wrapper was built to fix.
 */
function StateCard({ children }: { children: React.ReactNode }) {
  return (
    <Box
      sx={{
        width: '100%',
        minHeight: STATE_CARD_MIN_HEIGHT,
        px: 3,
        py: 2,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: '14px',
        bgcolor: 'background.paper',
        border: theme => `1px solid ${theme.palette.divider}`,
        boxShadow: theme =>
          theme.palette.mode === 'dark'
            ? '0 1px 0 rgba(255,255,255,0.04) inset, 0 2px 6px rgba(0,0,0,0.35)'
            : '0 1px 0 rgba(255,255,255,0.6) inset, 0 1px 2px rgba(15,23,42,0.04), 0 2px 6px rgba(15,23,42,0.05)',
      }}
    >
      {children}
    </Box>
  );
}

/**
 * Error state rendered as a card.
 *
 * Visually matches the robot cards (same border, radius, soft
 * shadow) via the shared `StateCard` wrapper so it slots into the
 * same grid instead of floating as a bare paragraph. Content is
 * centred on both axes by `StateCard`; the inner Stack just owns
 * the typographic stack.
 */
function CenteredMessageState({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <StateCard>
      <Stack
        spacing={0.75}
        sx={{
          alignItems: 'center',
          textAlign: 'center',
          maxWidth: 280,
        }}
      >
        <Typography
          sx={{
            fontSize: TYPO.lg,
            fontWeight: FONT_WEIGHT.semibold,
            color: 'text.primary',
          }}
        >
          {title}
        </Typography>
        {subtitle ? (
          <Typography
            sx={{
              fontSize: TYPO.sm,
              color: 'text.secondary',
              lineHeight: 1.5,
            }}
          >
            {subtitle}
          </Typography>
        ) : null}
      </Stack>
    </StateCard>
  );
}
