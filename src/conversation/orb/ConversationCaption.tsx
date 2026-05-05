/**
 * Discreet micro-label below the orb. Replaces the engine's imperative
 * `setCaption()` + `#circle-caption` ref with a state-derived React
 * component.
 *
 * Caption text is sparse on purpose: actionable / transitional states
 * get a short hint ("Connecting", "Tap to retry"), live conversation
 * states stay empty so the orb's animation is the single source of
 * truth - which keeps the UI quiet once the user is actually talking.
 */
import { useTheme } from '@mui/material';

import type { OrbState } from './ConversationOrb';

export interface ConversationCaptionProps {
  state: OrbState;
  /** Optional override (used by error state to surface details). */
  message?: string | null;
}

export function ConversationCaption({ state, message }: ConversationCaptionProps) {
  const theme = useTheme();
  const fallback = CAPTION_BY_STATE[state] ?? '';
  const text = message ?? fallback;
  const empty = text.length === 0;
  const tone: 'default' | 'error' = state === 'error' ? 'error' : 'default';

  return (
    <p
      className="convo-caption"
      data-empty={empty ? 'true' : 'false'}
      data-tone={tone}
      role="status"
      style={{
        color:
          tone === 'error'
            ? theme.palette.error.main
            : theme.palette.text.secondary,
      }}
    >
      {text}
    </p>
  );
}

const CAPTION_BY_STATE: Record<OrbState, string> = {
  idle: '',
  connecting: 'Connecting',
  ready: 'Tap to start',
  listening: '',
  'user-speaking': '',
  processing: '',
  'ai-speaking': '',
  error: 'Tap to retry',
};
