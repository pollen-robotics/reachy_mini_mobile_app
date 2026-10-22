import { describe, expect, it } from 'vitest';

import { deriveNfcState, describeTagError, needsFullErase } from './nfcState';
import type { NfcStatus, NfcTag } from './nfcState';

const connected: NfcStatus = { connected: true, chip_detected: true, driver_available: true };

describe('deriveNfcState', () => {
  it('is unavailable until the daemon has answered', () => {
    expect(deriveNfcState(null, null)).toBe('unavailable');
  });

  it('is unavailable when the driver or the board is missing', () => {
    expect(
      deriveNfcState({ connected: false, chip_detected: false, driver_available: false }, null)
    ).toBe('unavailable');
    expect(
      deriveNfcState({ connected: false, chip_detected: false, driver_available: true }, null)
    ).toBe('unavailable');
  });

  it('ignores a stale tag once the reader is gone', () => {
    const tag: NfcTag = { present: true, uid: '04A1B2C3' };
    expect(deriveNfcState({ ...connected, connected: false }, tag)).toBe('unavailable');
  });

  it('is disabled when switched off, whatever the reader reports', () => {
    expect(deriveNfcState({ ...connected, enabled: false }, { present: true })).toBe('disabled');
  });

  it('treats a daemon without the switch as switched on', () => {
    expect(deriveNfcState(connected, null)).toBe('idle');
  });

  it('reports a tag on the antenna, blank or not', () => {
    expect(deriveNfcState(connected, { present: false })).toBe('idle');
    expect(deriveNfcState(connected, { present: true, blank: true })).toBe('tag');
    expect(deriveNfcState(connected, { present: true, content: 'badge42' })).toBe('tag');
  });
});

describe('needsFullErase', () => {
  it('is false without a tag, or for an NDEF tag', () => {
    expect(needsFullErase(null)).toBe(false);
    expect(needsFullErase({ present: false })).toBe(false);
    expect(
      needsFullErase({ present: true, records: [{ kind: 'text', value: 'hi' }], raw_hex: null })
    ).toBe(false);
  });

  it('is true for a bare code written outside NDEF', () => {
    expect(needsFullErase({ present: true, records: [], raw_hex: '42414447' })).toBe(true);
  });
});

describe('describeTagError', () => {
  it('explains known codes and passes unknown ones through', () => {
    expect(describeTagError('LOCKED')).toMatch(/locked/i);
    expect(describeTagError('NFC reader disabled')).toMatch(/switched off/i);
    expect(describeTagError('SOMETHING_NEW')).toBe('SOMETHING_NEW');
    expect(describeTagError(null)).toBe('Unknown error');
  });
});
