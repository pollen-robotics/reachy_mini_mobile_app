/**
 * Tests for `mapAppStateToOrb`, the pure collapse from the engine's
 * full FSM (AppState, ~12 states) onto the smaller visual vocabulary
 * the orb chrome knows (OrbState, 8 states).
 *
 * Pinning this mapping prevents a future engine state from silently
 * displaying the wrong glyph (or worse: defaulting to a blank
 * indicator if the switch fell through).
 */
import { describe, expect, it } from 'vitest';

import type { AppState } from '@/conversation/engine/conversation-engine';

import { mapAppStateToOrb } from './ConversationPanel';

describe('mapAppStateToOrb', () => {
  it("maps connecting / starting / auto-selecting to 'connecting'", () => {
    expect(mapAppStateToOrb('connecting')).toBe('connecting');
    expect(mapAppStateToOrb('starting')).toBe('connecting');
    expect(mapAppStateToOrb('auto-selecting')).toBe('connecting');
  });

  it.each<AppState>(['ready', 'listening', 'user-speaking', 'processing', 'ai-speaking'])(
    'passes the live conversation state %s through verbatim',
    (state) => {
      expect(mapAppStateToOrb(state)).toBe(state);
    },
  );

  it("maps 'error' through verbatim", () => {
    expect(mapAppStateToOrb('error')).toBe('error');
  });

  it.each<AppState>(['signed-out', 'authenticated', 'connected', 'released'])(
    "collapses neutral / pre-session state %s to 'idle'",
    (state) => {
      expect(mapAppStateToOrb(state)).toBe('idle');
    },
  );

  it("falls through to 'idle' on a future / unknown engine state", () => {
    expect(mapAppStateToOrb('whatever-comes-next' as AppState)).toBe('idle');
  });
});
