/**
 * Tests for `mapToOrb`, the pure collapse from the engine's two FSMs
 * (ConnectionState + ConversationState) onto the smaller visual
 * vocabulary the orb chrome knows (OrbState, 8 states).
 *
 * Pinning this mapping prevents a future engine state from silently
 * displaying the wrong glyph (or worse: defaulting to a blank
 * indicator if the switch fell through).
 */
import { describe, expect, it } from 'vitest';

import type {
  ConnectionState,
  ConversationState,
} from '@/features/conversation/engine/conversation-engine';

import { mapToOrb } from './ConversationPanel';

describe('mapToOrb', () => {
  it("maps connecting / selecting / starting connection to 'connecting'", () => {
    expect(mapToOrb('connecting', 'idle')).toBe('connecting');
    expect(mapToOrb('selecting', 'idle')).toBe('connecting');
    expect(mapToOrb('starting', 'idle')).toBe('connecting');
  });

  it("maps a live connection with an idle conversation to 'ready'", () => {
    expect(mapToOrb('live', 'idle')).toBe('ready');
  });

  it.each<ConversationState>(['listening', 'user-speaking', 'processing', 'ai-speaking'])(
    'passes the live conversation state %s through verbatim',
    (state) => {
      expect(mapToOrb('live', state)).toBe(state);
    },
  );

  it("maps a live connection with a starting / stopping conversation to 'connecting'", () => {
    expect(mapToOrb('live', 'starting')).toBe('connecting');
    expect(mapToOrb('live', 'stopping')).toBe('connecting');
  });

  it("maps 'error' connection to 'error' regardless of conversation", () => {
    expect(mapToOrb('error', 'idle')).toBe('error');
    expect(mapToOrb('error', 'listening')).toBe('error');
  });

  it.each<ConnectionState>(['signed-out', 'authenticated', 'connected', 'released'])(
    "collapses neutral / pre-session connection %s to 'idle'",
    (state) => {
      expect(mapToOrb(state, 'idle')).toBe('idle');
    },
  );

  it("falls through to 'idle' on a future / unknown connection state", () => {
    expect(mapToOrb('whatever-comes-next' as ConnectionState, 'idle')).toBe(
      'idle',
    );
  });
});
