/**
 * `formatConversationError` maps raw engine/SDK failure strings to the
 * copy shown on the orb caption and the session error view. The
 * classification order matters: only genuine auth rejections may say
 * "sign in", busy must never be masked as "connection lost", and the
 * fallback differs by layer (conversation vs connection).
 */
import { describe, expect, it } from 'vitest';

import { formatConversationError } from './conversation-error';

describe('formatConversationError', () => {
  describe('sign-in cases (the only ones allowed to say "sign in")', () => {
    it('classifies a missing HF token', () => {
      expect(
        formatConversationError(
          'no HF token in sessionStorage; sign in to Hugging Face first',
        ),
      ).toBe('Sign in to Hugging Face to start the conversation.');
    });

    it.each([401, 403])('classifies an allocator %s as expired sign-in', (status) => {
      expect(
        formatConversationError(`HF realtime session allocator failed (${status}): nope`),
      ).toBe('Hugging Face sign-in expired. Sign in again and retry.');
    });
  });

  describe('transient backend cases', () => {
    it('classifies an allocator 429 as rate limiting', () => {
      expect(
        formatConversationError('HF realtime session allocator failed (429): slow down'),
      ).toBe('Rate limit reached. Wait a moment and retry.');
    });

    it('classifies other allocator statuses as a busy backend, not a sign-in issue', () => {
      expect(
        formatConversationError('HF realtime session allocator failed (503): cold start'),
      ).toBe('The Hugging Face realtime backend is busy. Retry in a moment.');
    });

    it('classifies a dropped realtime websocket as transient', () => {
      expect(formatConversationError('realtime websocket closed (1006)')).toBe(
        'Lost the realtime connection. Retry in a moment.',
      );
    });
  });

  describe('robot busy (central concurrency gate)', () => {
    it('surfaces the busy state instead of masking it as a connection loss', () => {
      // Wording produced by the SDK's `_failSessionRejected`.
      expect(
        formatConversationError('Robot is busy: "Web Host" is already connected'),
      ).toBe('Your Reachy is busy with another app. Close it there, then try again.');
    });

    it('matches the raw central reason code too', () => {
      expect(formatConversationError('session rejected: robot_busy')).toBe(
        'Your Reachy is busy with another app. Close it there, then try again.',
      );
    });
  });

  describe('fallback', () => {
    it('defaults to the conversation-layer copy for unknown details', () => {
      expect(formatConversationError('some opaque engine failure')).toBe(
        'Could not start the conversation. Retry in a moment.',
      );
    });

    it('uses the caller-provided fallback (connection layer passes transport copy)', () => {
      expect(
        formatConversationError('some opaque engine failure', 'Robot link lost.'),
      ).toBe('Robot link lost.');
    });

    it('classified cases ignore the custom fallback', () => {
      expect(
        formatConversationError(
          'Robot is busy: "Web Host" is already connected',
          'Robot link lost.',
        ),
      ).toBe('Your Reachy is busy with another app. Close it there, then try again.');
    });
  });
});
