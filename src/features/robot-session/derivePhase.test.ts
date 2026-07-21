/**
 * Tests for `derivePhase`, the pure mapping that decides which
 * top-level session phase the host should display given:
 *
 *   - the engine's `ConnectionState` (the transport FSM we observe
 *     through `onConnectionStateChange`);
 *   - the `phaseHint` we set ourselves around release / reacquire
 *     / teardown transitions (the engine doesn't track those).
 */
import { describe, expect, it } from 'vitest';

import type { ConnectionState } from '@/features/conversation/engine/types';

import { derivePhase, type SessionPhase } from './phase';

describe('derivePhase', () => {
  describe('phaseHint precedence', () => {
    it.each<SessionPhase>([
      'releasing',
      'released',
      'reacquiring',
      'tearing-down',
      'live',
      'bringing-up',
      'error',
    ])('hint %s overrides any connection state', (hint) => {
      // Even if the connection says "live", an explicit hint
      // wins because the hint represents an in-flight transition
      // the engine itself doesn't track.
      expect(derivePhase('live', hint)).toBe(hint);
    });

    it("ignores the 'idle' hint and falls through to connection state", () => {
      // 'idle' is the post-teardown reset value of the hint -
      // we want subsequent connection transitions to drive the UI
      // again, not stick on 'idle' forever.
      expect(derivePhase('live', 'idle')).toBe('live');
    });

    it('falls through to connection state when hint is null', () => {
      expect(derivePhase('live', null)).toBe('live');
    });
  });

  describe('connection-state mapping (no hint)', () => {
    const bringingUpStates: ConnectionState[] = [
      'signed-out',
      'authenticated',
      'connecting',
      'connected',
      'selecting',
      'starting',
    ];

    it.each(bringingUpStates)("maps %s -> 'bringing-up'", (state) => {
      expect(derivePhase(state, null)).toBe('bringing-up');
    });

    it("maps 'live' to 'live'", () => {
      expect(derivePhase('live', null)).toBe('live');
    });

    it("maps 'released' to 'released'", () => {
      expect(derivePhase('released', null)).toBe('released');
    });

    it("maps 'error' to 'error'", () => {
      expect(derivePhase('error', null)).toBe('error');
    });

    it("falls through to 'bringing-up' on a future / unknown connection state", () => {
      // Cast through unknown so we can probe the default branch.
      expect(derivePhase('something-new' as ConnectionState, null)).toBe(
        'bringing-up',
      );
    });
  });
});
