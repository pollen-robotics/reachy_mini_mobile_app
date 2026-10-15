/**
 * Tests for the persistent connection journal.
 *
 * The properties that must hold:
 *   - events survive a reload (re-read from storage);
 *   - the journal is capped, keeping the most recent entries;
 *   - a throwing / missing storage never breaks recording;
 *   - the clipboard dump is oldest-first with the header on top.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  formatConnectionJournal,
  readConnectionJournal,
  recordConnectionEvent,
  resetConnectionJournalCacheForTests,
} from './connection-journal';

function memoryStorage(): Storage {
  const data = new Map<string, string>();
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
    clear: () => data.clear(),
    key: () => null,
    get length() {
      return data.size;
    },
  };
}

beforeEach(() => {
  vi.stubGlobal('localStorage', memoryStorage());
  resetConnectionJournalCacheForTests();
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetConnectionJournalCacheForTests();
});

describe('connection journal', () => {
  it('persists events across a reload', () => {
    recordConnectionEvent('redialing', 'attempt 1/5: ICE stuck');
    resetConnectionJournalCacheForTests();

    const events = readConnectionJournal();
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe('redialing');
    expect(events[0].detail).toBe('attempt 1/5: ICE stuck');
  });

  it('keeps only the 50 most recent events', () => {
    for (let i = 0; i < 60; i++) recordConnectionEvent('degraded', `#${i}`);

    const events = readConnectionJournal();
    expect(events).toHaveLength(50);
    expect(events[0].detail).toBe('#10');
    expect(events[49].detail).toBe('#59');
  });

  it('keeps recording in memory when storage throws', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('quota');
      },
    });
    resetConnectionJournalCacheForTests();

    expect(() => recordConnectionEvent('fatal', 'boom')).not.toThrow();
    expect(readConnectionJournal()).toHaveLength(1);
  });

  it('formats oldest first under the header', () => {
    recordConnectionEvent('fatal', 'lost');
    recordConnectionEvent('auto-recover');

    const text = formatConnectionJournal(readConnectionJournal(), ['App v1']);
    const lines = text.split('\n');
    expect(lines[0]).toBe('App v1');
    expect(lines[1]).toMatch(/ fatal: lost$/);
    expect(lines[2]).toMatch(/ auto-recover$/);
  });
});
