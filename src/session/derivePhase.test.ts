/**
 * Tests for `derivePhase`, the pure mapping that decides which
 * top-level session phase the host should display given:
 *
 *   - the engine's `AppState` (the FSM state machine we observe
 *     through `onStateChange`);
 *   - the `phaseHint` we set ourselves around release / reacquire
 *     / teardown transitions (the engine doesn't track those).
 */
import { describe, expect, it } from 'vitest';

import type { AppState } from '../conversation/engine/types';

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
    ])('hint %s overrides any engine state', (hint) => {
      // Even if the engine says "ready" (= live), an explicit hint
      // wins because the hint represents an in-flight transition
      // the engine itself doesn't track.
      expect(derivePhase('ready', hint)).toBe(hint);
    });

    it("ignores the 'idle' hint and falls through to engine state", () => {
      // 'idle' is the post-teardown reset value of the hint -
      // we want subsequent engine transitions to drive the UI
      // again, not stick on 'idle' forever.
      expect(derivePhase('ready', 'idle')).toBe('live');
    });

    it('falls through to engine state when hint is null', () => {
      expect(derivePhase('listening', null)).toBe('live');
    });
  });

  describe('engine-state mapping (no hint)', () => {
    const bringingUpStates: AppState[] = [
      'signed-out',
      'authenticated',
      'connecting',
      'connected',
      'auto-selecting',
      'starting',
    ];
    const liveStates: AppState[] = [
      'ready',
      'listening',
      'user-speaking',
      'processing',
      'ai-speaking',
    ];

    it.each(bringingUpStates)("maps %s -> 'bringing-up'", (state) => {
      expect(derivePhase(state, null)).toBe('bringing-up');
    });

    it.each(liveStates)("maps %s -> 'live'", (state) => {
      expect(derivePhase(state, null)).toBe('live');
    });

    it("maps 'released' to 'released'", () => {
      expect(derivePhase('released', null)).toBe('released');
    });

    it("maps 'error' to 'error'", () => {
      expect(derivePhase('error', null)).toBe('error');
    });

    it("falls through to 'bringing-up' on a future / unknown engine state", () => {
      // Cast through unknown so we can probe the default branch.
      expect(derivePhase('something-new' as AppState, null)).toBe(
        'bringing-up',
      );
    });
  });
});
