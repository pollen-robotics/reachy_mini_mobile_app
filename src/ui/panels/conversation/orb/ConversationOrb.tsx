/**
 * ConversationOrb - the central animated indicator of the conversation
 * surface, refactored from the engine's injected DOM markup into a
 * pure React component.
 *
 * Why this exists
 * ───────────────
 * The previous implementation rendered the orb via
 * `dangerouslySetInnerHTML` + a state-class on a button (`.state-X`)
 * and revealed indicators via CSS opacity. If a state arrived that
 * wasn't covered by a CSS rule, OR if the DOM ref fell out of the
 * live tree (StrictMode, HMR, parent remount), the button silently
 * kept the previous look - blank circle, no indicator. React state
 * said one thing, the DOM showed another.
 *
 * Here every visual state maps to a single JSX branch. If `state` is
 * unset, we fall on `idle` explicitly. The orb cannot end up "blank
 * but mounted": either we render an indicator, or React itself failed
 * to mount, which is a much louder bug.
 *
 * The 7 visual buckets are deliberately fewer than the engine's full
 * `AppState` union: `signed-out`, `authenticated`, `connected` and
 * `auto-selecting` look identical to the user (idle ring breathing or
 * yellow spinner) and never need their own UI on mobile, where auth
 * is gated upstream and robot selection is done via Bluetooth.
 *
 * Audio reactivity
 * ────────────────
 * The component exposes `audioRef` which the parent wires into the
 * engine via `options.audioLevelsTarget`. The engine then writes
 * `--audio-level`, `--ai-audio-level`, `--bar0..--bar4` directly on
 * this DOM node (no React re-render per frame). CSS rules in `orb.css`
 * read the variables and drive the rings/core/bars. This keeps the
 * 60Hz audio loop entirely off the React reconciler.
 */
import MicIcon from '@/ui/design/icons/MicIcon';

import './orb.css';

export type OrbState =
  | 'idle'
  | 'connecting'
  | 'ready'
  | 'listening'
  | 'user-speaking'
  | 'processing'
  | 'ai-speaking'
  | 'error';

export interface ConversationOrbProps {
  state: OrbState;
  disabled?: boolean;
  ariaLabel?: string;
  onClick?: () => void;
  /**
   * Ref attached to the orb's root `<button>`. The conversation engine
   * writes audio-reactive CSS custom properties on this element via
   * `options.audioLevelsTarget`, so the rings/core/bars can react to
   * the live audio without re-rendering React.
   */
  audioRef?: React.Ref<HTMLButtonElement>;
}

export function ConversationOrb({
  state,
  disabled = false,
  ariaLabel = 'Conversation status',
  onClick,
  audioRef,
}: ConversationOrbProps) {
  return (
    <button
      ref={audioRef}
      type="button"
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={onClick}
      data-state={state}
      className="convo-orb"
      style={{ '--glow': GLOW_BY_STATE[state] } as React.CSSProperties}
    >
      <span className="convo-orb__glow" aria-hidden="true" />
      <span className="convo-orb__ring" aria-hidden="true" />
      <span className="convo-orb__ring-outer" aria-hidden="true" />
      <span className="convo-orb__core">
        <span className="convo-orb__indicator" aria-hidden="true">
          {renderIndicator(state)}
        </span>
      </span>
    </button>
  );
}

/**
 * Per-state glow accent. The "warming up" states (`idle`,
 * `connecting`, `ready`) all use the app's primary orange
 * (Pollen) so the orb's pre-conversation sequence reads as one
 * continuous CTA: the spinner inside `connecting` and the
 * caption ("Connecting" → "Tap to start conversation") carry
 * the state distinction without needing a colour change. Mid-
 * conversation states keep their own colour identity:
 *
 *   - `listening` / `user-speaking` (cyan) reads as "your mic
 *     is the focus"
 *   - `processing` (amber) reads as "AI is thinking"
 *   - `ai-speaking` (violet) reads as "AI is the focus"
 *   - `error` (red) reads as "something broke"
 *
 * Keep `#FF9500` in sync with `theme.ts`'s `ACCENT` constant if
 * the brand colour ever moves.
 */
const GLOW_BY_STATE: Record<OrbState, string> = {
  idle: '#FF9500',
  connecting: '#FF9500',
  ready: '#FF9500',
  listening: '#22d3ee',
  'user-speaking': '#22d3ee',
  processing: '#f59e0b',
  'ai-speaking': '#8b7dff',
  error: '#ff6a75',
};

function renderIndicator(state: OrbState): React.ReactNode {
  switch (state) {
    case 'connecting':
      return <span className="convo-orb__spinner" />;
    case 'ready':
      // Mic icon (not Play) so the affordance reads as "tap to
      // talk" - the conversation is voice-first, the mic is the
      // truth. Same icon as `idle` for consistency: both are
      // "waiting for the user to start speaking" states.
      // Passing the orb's CSS class so `orb.css` rules (size,
      // ink colour, opacity hooks) still bind to the inner SVG.
      return <MicIcon className="convo-orb__mic-icon" />;
    case 'listening':
    case 'user-speaking':
      return <Bars />;
    case 'processing':
      return <ThinkingDots />;
    case 'ai-speaking':
      return <VoiceWave />;
    case 'error':
      return <ErrorIcon />;
    case 'idle':
    default:
      return <MicIcon className="convo-orb__mic-icon" />;
  }
}

function Bars() {
  return (
    <span className="convo-orb__bars">
      <span className="convo-orb__bar" />
      <span className="convo-orb__bar" />
      <span className="convo-orb__bar" />
      <span className="convo-orb__bar" />
      <span className="convo-orb__bar" />
    </span>
  );
}

function ThinkingDots() {
  return (
    <span className="convo-orb__thinking">
      <span className="convo-orb__thinking-dot" />
      <span className="convo-orb__thinking-dot" />
      <span className="convo-orb__thinking-dot" />
    </span>
  );
}

function VoiceWave() {
  return (
    <svg
      className="convo-orb__voice"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path
        d="M3 10v4a1 1 0 0 0 1 1h3l5 4V5L7 9H4a1 1 0 0 0-1 1z"
        fill="currentColor"
        stroke="none"
      />
      <path className="wave wave-1" d="M16 8a5 5 0 0 1 0 8" />
      <path className="wave wave-2" d="M19 5a9 9 0 0 1 0 14" />
    </svg>
  );
}

// `MicIcon` is now shared with the bottom-nav (and any future
// voice surface) via `@/ui/design/icons/MicIcon`. It's a MUI
// `SvgIcon` under the hood, so the orb's `convo-orb__mic-icon`
// CSS rules in `orb.css` still bind via the className passed
// through at the call sites below.

function ErrorIcon() {
  return (
    <svg
      className="convo-orb__error-icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="9" />
      <line x1="12" y1="8" x2="12" y2="13" />
      <line x1="12" y1="16" x2="12" y2="16" />
    </svg>
  );
}
