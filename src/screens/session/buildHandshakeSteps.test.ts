/**
 * Tests for the `buildHandshakeSteps` helper that turns the FSM's
 * `(stepLabels, stepDetails, activeStep, errored)` tuple into the
 * `StepRow[]` shape consumed by `HandshakeStepList`.
 *
 * The helper is pure: every test below is a single call + a deep
 * equality check on the result. No mocks needed.
 */
import { describe, expect, it } from 'vitest';

import { buildHandshakeSteps } from './HandshakeViews';

const LABELS = ['Bluetooth', 'Network', 'Daemon', 'Wake up'] as const;

describe('buildHandshakeSteps', () => {
  it('marks all preceding steps as completed and the active one as active', () => {
    const rows = buildHandshakeSteps({
      labels: LABELS,
      details: [null, '192.168.1.42', null, null],
      activeStep: 2,
      errored: false,
    });
    expect(rows.map((r) => r.status)).toEqual([
      'completed',
      'completed',
      'active',
      'pending',
    ]);
  });

  it('flips the active row to errored when `errored` is true', () => {
    const rows = buildHandshakeSteps({
      labels: LABELS,
      details: [null, '192.168.1.42', 'v1.7.4', null],
      activeStep: 2,
      errored: true,
    });
    // Steps 0-1 stay completed (they happened cleanly), step 2 fails,
    // step 3 stays pending. We never paint future steps red.
    expect(rows.map((r) => r.status)).toEqual([
      'completed',
      'completed',
      'errored',
      'pending',
    ]);
  });

  it('preserves details verbatim, including for completed steps', () => {
    const rows = buildHandshakeSteps({
      labels: LABELS,
      details: [null, '192.168.1.42', 'v1.7.4', null],
      activeStep: 3,
      errored: false,
    });
    expect(rows.map((r) => r.detail)).toEqual([
      null,
      '192.168.1.42',
      'v1.7.4',
      null,
    ]);
  });

  it('treats a missing detail entry as null (defensive)', () => {
    const rows = buildHandshakeSteps({
      labels: LABELS,
      details: [], // shorter than labels
      activeStep: 0,
      errored: false,
    });
    expect(rows.every((r) => r.detail === null)).toBe(true);
  });

  it('returns all-pending when activeStep is past the end (e.g. completed run)', () => {
    // The FSM should flip phase to 'ready' once activeStep > length,
    // but we still want a sane fallback. All rows are `completed` in
    // that case since they all happened.
    const rows = buildHandshakeSteps({
      labels: LABELS,
      details: [null, null, null, null],
      activeStep: 99,
      errored: false,
    });
    expect(rows.every((r) => r.status === 'completed')).toBe(true);
  });

  it('keeps label and detail aligned by index', () => {
    const rows = buildHandshakeSteps({
      labels: ['A', 'B', 'C'],
      details: ['a-detail', null, 'c-detail'],
      activeStep: 1,
      errored: false,
    });
    expect(rows).toEqual([
      { label: 'A', detail: 'a-detail', status: 'completed' },
      { label: 'B', detail: null, status: 'active' },
      { label: 'C', detail: 'c-detail', status: 'pending' },
    ]);
  });
});
